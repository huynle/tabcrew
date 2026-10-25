/** Token audience: MCP clients (`/mcp`) or a signed-in browser extension (`/ext`). */
export type Audience = "mcp" | "ext";

export interface User {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly disabled: boolean;
}

export interface IdentityInput {
  readonly provider: string;
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
}

export interface OAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly kind: Audience;
}

export interface Browser {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  /** Revoked on the account page; cleared when that browser signs in again. */
  readonly revoked?: boolean;
}

/** One live sign-in (refresh token family) as the account page lists it. */
export interface Grant {
  readonly family: string;
  readonly clientId: string;
  readonly audience: Audience;
  readonly browserId: string | null;
  /** Expiry of the family's live refresh token (it was issued refresh TTL before this). */
  readonly expiresAt: number;
}

export interface RefreshRecord {
  /** sha256 of the token; the token itself is never stored. */
  readonly hash: string;
  /** All tokens rotated from one sign-in share a family; reuse revokes it. */
  readonly family: string;
  readonly userId: string;
  readonly clientId: string;
  readonly audience: Audience;
  readonly browserId: string | null;
  readonly expiresAt: number;
  readonly used?: boolean;
  readonly revoked?: boolean;
}

export interface Taken<T> {
  readonly data: T;
  readonly expiresAt: number;
}

/**
 * Durable relay state. Single-use records (`take*`, `markRefreshUsed`) must be atomic: of two
 * concurrent callers exactly one wins. Expiry is checked by the caller.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertIdentity(identity: IdentityInput): Promise<User>;
  /** The user's sealed account model settings (see modelSettings.ts), or null. */
  getModelSettings(userId: string): Promise<string | null>;
  putModelSettings(userId: string, sealed: string): Promise<void>;
  deleteModelSettings(userId: string): Promise<void>;
  getUser(id: string): Promise<User | null>;

  createClient(client: OAuthClient): Promise<void>;
  getClient(id: string): Promise<OAuthClient | null>;

  putTxn(id: string, data: unknown, expiresAt: number): Promise<void>;
  takeTxn(id: string): Promise<Taken<unknown> | null>;
  putCode(hash: string, data: unknown, expiresAt: number): Promise<void>;
  takeCode(hash: string): Promise<Taken<unknown> | null>;

  putRefresh(record: RefreshRecord): Promise<void>;
  getRefresh(hash: string): Promise<RefreshRecord | null>;
  /** True only for the caller that flipped an unused, unrevoked token to used. */
  markRefreshUsed(hash: string): Promise<boolean>;
  revokeFamily(family: string): Promise<void>;

  /** Create or find the user's browser by name; clears a revocation. */
  upsertBrowser(userId: string, name: string): Promise<Browser>;
  getBrowser(id: string): Promise<Browser | null>;
  /** The user's browsers that are not revoked. */
  listBrowsers(userId: string): Promise<Browser[]>;
  /** Revoke a browser of this user; false when it is not the user's. */
  revokeBrowser(userId: string, browserId: string): Promise<boolean>;

  /** Live sign-ins: families with an unused, unrevoked, unexpired token. */
  listGrants(userId: string): Promise<Grant[]>;
  /** Revoke the user's tokens of a client or a browser; the number of tokens revoked. */
  revokeGrants(userId: string, which: { readonly clientId: string } | { readonly browserId: string }): Promise<number>;
}
