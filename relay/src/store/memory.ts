import { newId } from "../crypto.js";
import type { Browser, IdentityInput, OAuthClient, RefreshRecord, Store, Taken, User } from "./types.js";

/** In-process store for tests and `RELAY_STORE=memory` development runs. */
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly identities = new Map<string, string>();
  private readonly clients = new Map<string, OAuthClient>();
  private readonly txns = new Map<string, Taken<unknown>>();
  private readonly codes = new Map<string, Taken<unknown>>();
  private readonly refresh = new Map<string, Required<RefreshRecord>>();
  private readonly browsers = new Map<string, Browser>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertIdentity(i: IdentityInput): Promise<User> {
    const key = `${i.provider}\u0000${i.subject}`;
    const id = this.identities.get(key) ?? newId("u");
    this.identities.set(key, id);
    const previous = this.users.get(id);
    const user: User = { id, email: i.email ?? null, name: i.name ?? null, disabled: previous?.disabled ?? false };
    this.users.set(id, user);
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.id, { ...client, redirectUris: [...client.redirectUris] });
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    return this.clients.get(id) ?? null;
  }

  async putTxn(id: string, data: unknown, expiresAt: number): Promise<void> {
    this.txns.set(id, { data, expiresAt });
  }

  async takeTxn(id: string): Promise<Taken<unknown> | null> {
    return take(this.txns, id);
  }

  async putCode(hash: string, data: unknown, expiresAt: number): Promise<void> {
    this.codes.set(hash, { data, expiresAt });
  }

  async takeCode(hash: string): Promise<Taken<unknown> | null> {
    return take(this.codes, hash);
  }

  async putRefresh(r: RefreshRecord): Promise<void> {
    this.refresh.set(r.hash, { ...r, used: r.used ?? false, revoked: r.revoked ?? false });
  }

  async getRefresh(hash: string): Promise<RefreshRecord | null> {
    const r = this.refresh.get(hash);
    return r ? { ...r } : null;
  }

  async markRefreshUsed(hash: string): Promise<boolean> {
    const r = this.refresh.get(hash);
    if (!r || r.used || r.revoked) return false;
    this.refresh.set(hash, { ...r, used: true });
    return true;
  }

  async revokeFamily(family: string): Promise<void> {
    for (const [hash, r] of this.refresh) if (r.family === family) this.refresh.set(hash, { ...r, revoked: true });
  }

  async upsertBrowser(userId: string, name: string): Promise<Browser> {
    for (const b of this.browsers.values()) if (b.userId === userId && b.name === name) return b;
    const b: Browser = { id: newId("b"), userId, name };
    this.browsers.set(b.id, b);
    return b;
  }
}

function take<T>(map: Map<string, T>, key: string): T | null {
  const value = map.get(key);
  if (value === undefined) return null;
  map.delete(key);
  return value;
}
