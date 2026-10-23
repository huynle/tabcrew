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

  upsertBrowser(userId: string, name: string): Promise<Browser>;
}
