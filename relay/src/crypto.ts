import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Prefixed random id, e.g. `u_…` for users, `b_…` for browsers. */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);
}

export interface AccessClaims {
  /** User id. */
  readonly sub: string;
  readonly aud: "mcp" | "ext";
  /** OAuth client id. */
  readonly cid: string;
  /** Browser id (extension tokens only). */
  readonly bid?: string;
  readonly iat: number;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
}

/** Self-contained access token: `tca.<base64url JSON claims>.<base64url HMAC-SHA256>`. */
export function signAccess(claims: AccessClaims, key: Buffer): string {
  const body = `tca.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The claims of a valid, unexpired token for `aud`, else null. */
export function verifyAccess(token: string, aud: "mcp" | "ext", key: Buffer, nowMs: number): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "tca") return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(createHmac("sha256", key).update(body).digest("base64url"), parts[2]!)) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    return null;
  }
  if (claims.aud !== aud || typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
  return claims.exp * 1000 > nowMs ? claims : null;
}
