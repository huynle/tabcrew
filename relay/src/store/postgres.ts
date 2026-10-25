import pg from "pg";
import { newId } from "../crypto.js";
import type { Browser, Grant, IdentityInput, OAuthClient, RefreshRecord, Store, Taken, User } from "./types.js";

/** Idempotent schema; applied by `init()`. Times are epoch milliseconds (bigint). */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text,
  name text,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identities (
  provider text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_txns (id text PRIMARY KEY, data jsonb NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (hash text PRIMARY KEY, data jsonb NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  hash text PRIMARY KEY,
  family text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  audience text NOT NULL,
  browser_id text,
  expires_at bigint NOT NULL,
  used boolean NOT NULL DEFAULT false,
  revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens (family);
CREATE TABLE IF NOT EXISTS browsers (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
ALTER TABLE browsers ADD COLUMN IF NOT EXISTS revoked boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens (user_id);
CREATE TABLE IF NOT EXISTS model_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sealed text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

type Row = Record<string, any>;

const toBrowser = (r: Row): Browser => ({ id: r.id, userId: r.user_id, name: r.name, revoked: r.revoked === true });

const toUser = (r: Row): User => ({ id: r.id, email: r.email, name: r.name, disabled: r.disabled });

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
    // Expired single-use records are useless; drop them at startup.
    const now = Date.now();
    await this.pool.query("DELETE FROM auth_txns WHERE expires_at < $1", [now]);
    await this.pool.query("DELETE FROM auth_codes WHERE expires_at < $1", [now]);
    await this.pool.query("DELETE FROM refresh_tokens WHERE expires_at < $1", [now]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertIdentity(i: IdentityInput): Promise<User> {
    try {
      return await this.upsertIdentityOnce(i);
    } catch (err) {
      // Two first sign-ins of one identity race on the identities primary key: the loser retries
      // and then finds the winner's user.
      if ((err as { code?: string }).code !== "23505") throw err;
      return this.upsertIdentityOnce(i);
    }
  }

  private async upsertIdentityOnce(i: IdentityInput): Promise<User> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT user_id FROM identities WHERE provider = $1 AND subject = $2 FOR UPDATE", [
        i.provider,
        i.subject,
      ]);
      let user: Row;
      if (found.rows[0]) {
        user = (
          await client.query("UPDATE users SET email = $2, name = $3 WHERE id = $1 RETURNING *", [
            found.rows[0].user_id,
            i.email ?? null,
            i.name ?? null,
          ])
        ).rows[0];
      } else {
        user = (
          await client.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3) RETURNING *", [newId("u"), i.email ?? null, i.name ?? null])
        ).rows[0];
        await client.query("INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3)", [i.provider, i.subject, user.id]);
      }
      await client.query("COMMIT");
      return toUser(user);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async getModelSettings(userId: string): Promise<string | null> {
    const r = await this.pool.query("SELECT sealed FROM model_settings WHERE user_id = $1", [userId]);
    return r.rows[0]?.sealed ?? null;
  }

  async putModelSettings(userId: string, sealed: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO model_settings (user_id, sealed) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()",
      [userId, sealed],
    );
  }

  async deleteModelSettings(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM model_settings WHERE user_id = $1", [userId]);
  }

  async createClient(c: OAuthClient): Promise<void> {
    await this.pool.query("INSERT INTO oauth_clients (id, name, redirect_uris, kind) VALUES ($1, $2, $3, $4)", [
      c.id,
      c.name,
      JSON.stringify(c.redirectUris),
      c.kind,
    ]);
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    const r = (await this.pool.query("SELECT * FROM oauth_clients WHERE id = $1", [id])).rows[0];
    return r ? { id: r.id, name: r.name, redirectUris: r.redirect_uris, kind: r.kind } : null;
  }

  async putTxn(id: string, data: unknown, expiresAt: number): Promise<void> {
    await this.pool.query("INSERT INTO auth_txns (id, data, expires_at) VALUES ($1, $2, $3)", [id, JSON.stringify(data), expiresAt]);
  }

  async takeTxn(id: string): Promise<Taken<unknown> | null> {
    return this.take("auth_txns", "id", id);
  }

  async putCode(hash: string, data: unknown, expiresAt: number): Promise<void> {
    await this.pool.query("INSERT INTO auth_codes (hash, data, expires_at) VALUES ($1, $2, $3)", [hash, JSON.stringify(data), expiresAt]);
  }

  async takeCode(hash: string): Promise<Taken<unknown> | null> {
    return this.take("auth_codes", "hash", hash);
  }

  private async take(table: "auth_txns" | "auth_codes", key: "id" | "hash", value: string): Promise<Taken<unknown> | null> {
    const r = (await this.pool.query(`DELETE FROM ${table} WHERE ${key} = $1 RETURNING data, expires_at`, [value])).rows[0];
    return r ? { data: r.data, expiresAt: Number(r.expires_at) } : null;
  }

  async putRefresh(r: RefreshRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (hash, family, user_id, client_id, audience, browser_id, expires_at, used, revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.hash, r.family, r.userId, r.clientId, r.audience, r.browserId, r.expiresAt, r.used ?? false, r.revoked ?? false],
    );
  }

  async getRefresh(hash: string): Promise<RefreshRecord | null> {
    const r = (await this.pool.query("SELECT * FROM refresh_tokens WHERE hash = $1", [hash])).rows[0];
    return r
      ? {
          hash: r.hash,
          family: r.family,
          userId: r.user_id,
          clientId: r.client_id,
          audience: r.audience,
          browserId: r.browser_id,
          expiresAt: Number(r.expires_at),
          used: r.used,
          revoked: r.revoked,
        }
      : null;
  }

  async markRefreshUsed(hash: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE refresh_tokens SET used = true WHERE hash = $1 AND used = false AND revoked = false RETURNING hash",
      [hash],
    );
    return r.rowCount === 1;
  }

  async revokeFamily(family: string): Promise<void> {
    await this.pool.query("UPDATE refresh_tokens SET revoked = true WHERE family = $1", [family]);
  }

  async upsertBrowser(userId: string, name: string): Promise<Browser> {
    const r = (
      await this.pool.query(
        `INSERT INTO browsers (id, user_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, name) DO UPDATE SET revoked = false RETURNING *`,
        [newId("b"), userId, name],
      )
    ).rows[0];
    return toBrowser(r);
  }

  async getBrowser(id: string): Promise<Browser | null> {
    const r = (await this.pool.query("SELECT * FROM browsers WHERE id = $1", [id])).rows[0];
    return r ? toBrowser(r) : null;
  }

  async listBrowsers(userId: string): Promise<Browser[]> {
    const r = await this.pool.query("SELECT * FROM browsers WHERE user_id = $1 AND revoked = false ORDER BY created_at", [userId]);
    return r.rows.map(toBrowser);
  }

  async revokeBrowser(userId: string, browserId: string): Promise<boolean> {
    const r = await this.pool.query("UPDATE browsers SET revoked = true WHERE id = $1 AND user_id = $2", [browserId, userId]);
    return r.rowCount === 1;
  }

  async listGrants(userId: string): Promise<Grant[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (family) family, client_id, audience, browser_id, expires_at FROM refresh_tokens
       WHERE user_id = $1 AND used = false AND revoked = false AND expires_at >= $2`,
      [userId, Date.now()],
    );
    return r.rows.map((x: Row) => ({ family: x.family, clientId: x.client_id, audience: x.audience, browserId: x.browser_id, expiresAt: Number(x.expires_at) }));
  }

  async revokeGrants(userId: string, which: { clientId: string } | { browserId: string }): Promise<number> {
    const [column, value] = "clientId" in which ? ["client_id", which.clientId] : ["browser_id", which.browserId];
    const r = await this.pool.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND ${column} = $2 AND revoked = false`, [userId, value]);
    return r.rowCount ?? 0;
  }
}
