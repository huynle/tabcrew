import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Prefixed random id, e.g. `u_…` for users, `b_…` for browsers. */
export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** HMAC-SHA256 as base64url (e.g. the account page's CSRF token, bound to the session cookie). */
export function hmac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
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
  /** mcp: MCP clients; ext: a browser extension; web: the account page cookie. */
  readonly aud: "mcp" | "ext" | "web";
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
export function verifyAccess(token: string, aud: AccessClaims["aud"], key: Buffer, nowMs: number): AccessClaims | null {
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

/**
 * AES-256-GCM for secrets at rest (account model settings). `context` (e.g. the user id) is bound
 * as additional data, so a sealed value cannot be moved to another user. Format: `v1.<iv>.<ct+tag>`.
 */
export function seal(key: Buffer, context: string, plaintext: string): string {
  if (key.length !== 32) throw new Error("secrets key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** The plaintext of `seal(key, context, …)`, or null if it was tampered with or sealed elsewhere. */
export function unseal(key: Buffer, context: string, sealed: string): string | null {
  const [v, ivText, ctText] = sealed.split(".");
  if (v !== "v1" || !ivText || !ctText) return null;
  try {
    const ct = Buffer.from(ctText, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
