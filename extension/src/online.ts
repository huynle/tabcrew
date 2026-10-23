/**
 * Online mode account (service worker side): sign in to a TabCrew relay with
 * chrome.identity.launchWebAuthFlow (OAuth authorization code + PKCE S256, client
 * `tabcrew-extension`), keep the rotating refresh token in chrome.storage.local (`v2:online`) and
 * hand the offscreen bridge a fresh short-lived access token. Tokens are never logged or shown.
 */

export const ONLINE_KEY = "v2:online";
export const DEFAULT_RELAY_URL = "https://tabcrew.huynle.com";
export const EXTENSION_CLIENT_ID = "tabcrew-extension";
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export interface OnlineAccount {
  /** Normalised relay origin (see `normaliseRelayUrl`). */
  readonly relay_url: string;
  readonly browser_name: string;
  readonly browser_id: string | null;
  readonly refresh_token: string | null;
  readonly access_token: string | null;
  /** Epoch ms. */
  readonly access_expires_at: number;
}

export interface OnlineDeps {
  fetch: typeof fetch;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  /** chrome.identity.getRedirectURL("online"). */
  readonly redirectUrl: string;
  load(): Promise<OnlineAccount | null>;
  save(account: OnlineAccount | null): Promise<void>;
  now(): number;
}

/** An https origin, or http on 127.0.0.1/localhost (a local relay); null otherwise. No path, query or credentials. */
export function normaliseRelayUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return u.origin;
}

export function relaySocketUrl(relayUrl: string): string {
  return `${relayUrl.replace(/^http/, "ws")}/ext`;
}

export function normaliseBrowserName(raw: unknown): string {
  const name = (typeof raw === "string" ? raw : "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
  return name || "browser";
}

export function signedIn(account: OnlineAccount | null | undefined): boolean {
  return !!account?.refresh_token;
}

export function parseOnlineAccount(value: unknown): OnlineAccount | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const relay = normaliseRelayUrl(v.relay_url);
  if (!relay) return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return {
    relay_url: relay,
    browser_name: normaliseBrowserName(v.browser_name),
    browser_id: str(v.browser_id),
    refresh_token: str(v.refresh_token),
    access_token: str(v.access_token),
    access_expires_at: typeof v.access_expires_at === "number" ? v.access_expires_at : 0,
  };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

class RelayRejected extends Error {}

interface TokenReply {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly browser_id?: string;
}

async function tokenRequest(deps: OnlineDeps, relayUrl: string, form: Record<string, string>): Promise<TokenReply> {
  const res = await deps.fetch(`${relayUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 400 && res.status < 500) throw new RelayRejected(String(json?.error_description ?? json?.error ?? `relay answered ${res.status}`));
  if (!res.ok) throw new Error(`relay answered ${res.status}`);
  if (typeof json?.access_token !== "string" || typeof json.refresh_token !== "string") throw new Error("relay returned no tokens");
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : 900,
    browser_id: typeof json.browser_id === "string" ? json.browser_id : undefined,
  };
}

/** Interactive sign-in (must start from a user action: the popup's Sign in button). */
export async function signIn(deps: OnlineDeps, opts: { relayUrl: string; browserName: string }): Promise<OnlineAccount> {
  const relayUrl = normaliseRelayUrl(opts.relayUrl);
  if (!relayUrl) throw new Error("The relay URL must be https:// (or http://127.0.0.1 for a local relay), without a path.");
  const browserName = normaliseBrowserName(opts.browserName);
  const verifier = randomString(32);
  const state = randomString(16);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: EXTENSION_CLIENT_ID,
    redirect_uri: deps.redirectUrl,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    state,
    browser_name: browserName,
  });
  const redirect = await deps.launchWebAuthFlow({ url: `${relayUrl}/authorize?${q}`, interactive: true });
  if (!redirect) throw new Error("Sign-in was closed before it finished.");
  const back = new URL(redirect);
  if (back.searchParams.get("state") !== state) throw new Error("Sign-in failed: the state did not match. Try again.");
  if (back.searchParams.get("error")) throw new Error(`Sign-in was denied (${back.searchParams.get("error")}).`);
  const code = back.searchParams.get("code");
  if (!code) throw new Error("Sign-in returned no code.");
  const reply = await tokenRequest(deps, relayUrl, {
    grant_type: "authorization_code",
    code,
    client_id: EXTENSION_CLIENT_ID,
    redirect_uri: deps.redirectUrl,
    code_verifier: verifier,
  });
  const account: OnlineAccount = {
    relay_url: relayUrl,
    browser_name: browserName,
    browser_id: reply.browser_id ?? null,
    refresh_token: reply.refresh_token,
    access_token: reply.access_token,
    access_expires_at: deps.now() + reply.expires_in * 1000,
  };
  await deps.save(account);
  return account;
}

type Access = { url: string; accessToken: string };

let inflight: Promise<Access | null> | null = null;

/**
 * The relay socket URL and an access token valid for a while, refreshing (rotation) when needed or
 * when `force`d (the relay refused the token). Concurrent callers share one call: a second
 * refresh with the same token would look like token theft to the relay and end the sign-in.
 * Null when signed out, when the relay rejected the refresh (then the tokens are forgotten), or on
 * a network failure (the account is kept; try again later).
 */
export function freshAccess(deps: OnlineDeps, opts: { force?: boolean } = {}): Promise<Access | null> {
  if (!inflight) {
    inflight = accessOnce(deps, opts.force === true).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function accessOnce(deps: OnlineDeps, force: boolean): Promise<Access | null> {
  const account = await deps.load();
  if (!account || !signedIn(account)) return null;
  if (!force && account.access_token && account.access_expires_at - REFRESH_MARGIN_MS > deps.now()) {
    return { url: relaySocketUrl(account.relay_url), accessToken: account.access_token };
  }
  try {
    const reply = await tokenRequest(deps, account.relay_url, {
      grant_type: "refresh_token",
      refresh_token: account.refresh_token!,
      client_id: EXTENSION_CLIENT_ID,
    });
    const next: OnlineAccount = {
      ...account,
      browser_id: reply.browser_id ?? account.browser_id,
      refresh_token: reply.refresh_token,
      access_token: reply.access_token,
      access_expires_at: deps.now() + reply.expires_in * 1000,
    };
    await deps.save(next);
    return { url: relaySocketUrl(next.relay_url), accessToken: reply.access_token };
  } catch (err) {
    if (err instanceof RelayRejected) await deps.save(forget(account));
    return null;
  }
}

function forget(account: OnlineAccount): OnlineAccount {
  return { ...account, refresh_token: null, access_token: null, access_expires_at: 0 };
}

/** Forget the tokens; the relay URL and browser name stay as the popup's defaults. */
export async function signOut(deps: OnlineDeps): Promise<void> {
  const account = await deps.load();
  if (account) await deps.save(forget(account));
}
