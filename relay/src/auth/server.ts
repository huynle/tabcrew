import type { IncomingMessage, ServerResponse } from "node:http";
import { isTabcrewExtensionOrigin } from "@tabcrew/shared/product";
import { newId, pkceMatches, randomToken, sha256, signAccess, verifyAccess, type AccessClaims } from "../crypto.js";
import type { Audience, OAuthClient, Store } from "../store/types.js";
import { readBody, sendHtml, sendJson, escapeHtml } from "../http.js";
import { log } from "@tabcrew/daemon/dist/log.js";
import type { Provider } from "./providers.js";

/** The built-in public client the TabCrew extension signs in with (chrome.identity.launchWebAuthFlow). */
export const EXTENSION_CLIENT_ID = "tabcrew-extension";

export interface AuthOptions {
  readonly publicUrl: string;
  readonly store: Store;
  readonly signingKey: Buffer;
  readonly providers: readonly Provider[];
  /** `chrome-extension://<id>/` origins whose chromiumapp.org redirects the extension client may use. */
  readonly extensionOrigins: readonly string[];
  readonly now?: () => number;
  readonly accessTtlSec?: number;
  readonly refreshTtlSec?: number;
  /** Browsers a user may have signed in (new names beyond it are refused at sign-in). */
  readonly maxBrowsers?: number;
}

/** The account page's session cookie. */
export const ACCOUNT_COOKIE = "tabcrew_account";
const WEB_TTL_SEC = 12 * 3600;

const TXN_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_REDIRECT_URIS = 10;

/** Pending sign-in, between /authorize (or /account/login) and the provider callback. */
interface AuthTxn {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly challenge: string;
  /** "web": signing in to the account page (a cookie instead of a code). */
  readonly audience: Audience | "web";
  readonly browserName: string | null;
  readonly provider: string | null;
}

interface CodeData {
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly audience: Audience;
  readonly browserId: string | null;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const isLoopback = (u: URL) => u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost");

/** A redirect URI a dynamically registered MCP client may use: https anywhere, or http on loopback. */
function validClientRedirect(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.hostname.endsWith(".chromiumapp.org")) return false;
  return u.protocol === "https:" || isLoopback(u);
}

/** Registered `registered` matches `presented` exactly, or (loopback, RFC 8252 §7.3) on everything but the port. */
function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    if (!isLoopback(a) || !isLoopback(b)) return false;
    return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && !b.hash;
  } catch {
    return false;
  }
}

/** The extension client's redirect: `https://<known extension id>.chromiumapp.org/<path>`. */
function extensionRedirectAllowed(raw: string, origins: readonly string[]): boolean {
  try {
    const u = new URL(raw);
    const m = /^([a-p]{32})\.chromiumapp\.org$/.exec(u.hostname);
    return u.protocol === "https:" && !u.hash && !!m && isTabcrewExtensionOrigin(`chrome-extension://${m[1]}`, origins);
  } catch {
    return false;
  }
}

function normaliseBrowserName(raw: string | null): string {
  const name = (raw ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
  return name || "browser";
}

/**
 * OAuth 2.1 authorization server for MCP clients (RFC 8414 metadata, RFC 7591 registration,
 * PKCE S256, rotating refresh tokens) and the TabCrew extension. People sign in with a provider
 * (GitHub, Google); the relay keeps no passwords.
 */
export class AuthServer {
  private readonly now: () => number;
  private readonly accessTtlSec: number;
  private readonly refreshTtlSec: number;

  constructor(private readonly o: AuthOptions) {
    this.now = o.now ?? Date.now;
    this.accessTtlSec = o.accessTtlSec ?? 15 * 60;
    this.refreshTtlSec = o.refreshTtlSec ?? 30 * 24 * 3600;
  }

  get resourceMetadataUrl(): string {
    return `${this.o.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  /** Verified claims of a bearer access token (or account cookie) for `aud`, else null. */
  verify(token: string | null, aud: Audience | "web"): AccessClaims | null {
    return token ? verifyAccess(token, aud, this.o.signingKey, this.now()) : null;
  }

  /** Account page sign-in: straight to the provider, back to /account with a session cookie. */
  async startWebLogin(res: ServerResponse, providerId: string): Promise<void> {
    const provider = this.o.providers.find((p) => p.id === providerId);
    if (!provider) throw new OAuthError("invalid_request", "Unknown sign-in provider.", 404);
    const txn: AuthTxn = {
      clientId: "account",
      redirectUri: `${this.o.publicUrl}/account`,
      state: null,
      challenge: "",
      audience: "web",
      browserName: null,
      provider: provider.id,
    };
    const state = randomToken();
    await this.o.store.putTxn(state, txn, this.now() + TXN_TTL_MS);
    res.writeHead(302, { location: provider.authorizeUrl({ state, redirectUri: this.callbackUrl(provider.id) }), "cache-control": "no-store" });
    res.end();
  }

  /** Set-Cookie value that ends the account session. */
  get clearCookie(): string {
    return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.o.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  }

  /** Handle an auth route; false when `pathname` is not one. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /.well-known/oauth-authorization-server":
          sendJson(res, 200, this.metadata());
          return true;
        case "GET /.well-known/oauth-protected-resource":
        case "GET /.well-known/oauth-protected-resource/mcp":
          sendJson(res, 200, {
            resource: `${this.o.publicUrl}/mcp`,
            authorization_servers: [this.o.publicUrl],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp"],
          });
          return true;
        case "POST /register":
          await this.register(req, res);
          return true;
        case "GET /authorize":
          await this.authorize(res, url);
          return true;
        case "POST /token":
          await this.token(req, res);
          return true;
      }
      const start = /^\/auth\/([a-z]+)$/.exec(url.pathname);
      if (start) {
        // The one-time txn is only spent by the page's POST form: browsers preload GET links (hover,
        // prerender), which would use it up before the person clicks.
        if (req.method === "POST") {
          await this.startProvider(res, await readForm(req).catch(() => ({}) as Record<string, string>), start[1]!);
          return true;
        }
        if (/prefetch|prerender/i.test(String(req.headers["sec-purpose"] ?? req.headers.purpose ?? ""))) {
          res.writeHead(204, { "cache-control": "no-store" }).end();
          return true;
        }
        throw new OAuthError("invalid_request", "Use the sign-in button on the previous page.", 405);
      }
      const callback = /^\/auth\/([a-z]+)\/callback$/.exec(url.pathname);
      if (req.method === "GET" && callback) {
        await this.providerCallback(res, url, callback[1]!);
        return true;
      }
      return false;
    } catch (err) {
      if (err instanceof OAuthError) {
        // Fixed messages only (never codes, tokens or query strings).
        log.warn(`auth: ${req.method} ${url.pathname} -> ${err.status} ${err.code}: ${err.message}`);
        if (url.pathname === "/token" || url.pathname === "/register") sendJson(res, err.status, { error: err.code, error_description: err.message });
        else this.errorPage(res, err.status, err.message);
        return true;
      }
      throw err;
    }
  }

  private metadata() {
    const u = this.o.publicUrl;
    return {
      issuer: u,
      authorization_endpoint: `${u}/authorize`,
      token_endpoint: `${u}/token`,
      registration_endpoint: `${u}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    };
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
      body = await readBody(req, 64 * 1024);
    } catch {
      throw new OAuthError("invalid_client_metadata", "body must be JSON");
    }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validClientRedirect)) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris must be 1-10 https or loopback http URLs without fragments");
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") throw new OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "MCP client";
    const client: OAuthClient = { id: randomToken(18), name, redirectUris: uris, kind: "mcp" };
    await this.o.store.createClient(client);
    sendJson(res, 201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(this.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  private async client(clientId: string): Promise<OAuthClient | null> {
    if (clientId === EXTENSION_CLIENT_ID) return { id: EXTENSION_CLIENT_ID, name: "TabCrew extension", redirectUris: [], kind: "ext" };
    return this.o.store.getClient(clientId);
  }

  private redirectAllowed(client: OAuthClient, redirectUri: string): boolean {
    if (client.kind === "ext") return extensionRedirectAllowed(redirectUri, this.o.extensionOrigins);
    return client.redirectUris.some((r) => redirectMatches(r, redirectUri));
  }

  /** /authorize: validate the request, then show the sign-in page. Never redirects on a bad client or redirect URI. */
  private async authorize(res: ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = clientId ? await this.client(clientId) : null;
    if (!client) throw new OAuthError("invalid_client", "Unknown application. Start the sign-in again from your app.");
    if (!this.redirectAllowed(client, redirectUri)) throw new OAuthError("invalid_request", "This application asked to return to an address it did not register.");
    if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only the authorization code flow is supported.");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new OAuthError("invalid_request", "PKCE with S256 is required.");
    }
    const resource = q.get("resource");
    if (resource !== null && client.kind === "mcp" && resource.replace(/\/$/, "") !== `${this.o.publicUrl}/mcp`) {
      throw new OAuthError("invalid_target", "Unknown resource.");
    }
    const txn: AuthTxn = {
      clientId,
      redirectUri,
      state: q.get("state"),
      challenge,
      audience: client.kind,
      browserName: client.kind === "ext" ? normaliseBrowserName(q.get("browser_name")) : null,
      provider: null,
    };
    const id = randomToken();
    await this.o.store.putTxn(id, txn, this.now() + TXN_TTL_MS);
    log.info(`auth: sign-in page for a ${client.kind === "ext" ? "browser" : "MCP client"}`);
    this.signInPage(res, client, redirectUri, id, txn);
  }

  private async startProvider(res: ServerResponse, form: Record<string, string>, providerId: string): Promise<void> {
    const provider = this.o.providers.find((p) => p.id === providerId);
    if (!provider) throw new OAuthError("invalid_request", "Unknown sign-in provider.", 404);
    const taken = await this.o.store.takeTxn(form.txn ?? "");
    if (!taken || taken.expiresAt < this.now()) throw new OAuthError("invalid_request", "This sign-in link expired. Start again from your app.");
    // A fresh id for the provider leg, so the link on the sign-in page cannot be replayed.
    const state = randomToken();
    await this.o.store.putTxn(state, { ...(taken.data as AuthTxn), provider: provider.id }, this.now() + TXN_TTL_MS);
    log.info(`auth: to ${provider.label} for a ${(taken.data as AuthTxn).audience === "ext" ? "browser" : "MCP client"}`);
    res.writeHead(302, { location: provider.authorizeUrl({ state, redirectUri: this.callbackUrl(provider.id) }), "cache-control": "no-store" });
    res.end();
  }

  private callbackUrl(providerId: string): string {
    return `${this.o.publicUrl}/auth/${providerId}/callback`;
  }

  private async providerCallback(res: ServerResponse, url: URL, providerId: string): Promise<void> {
    const provider = this.o.providers.find((p) => p.id === providerId);
    if (!provider) throw new OAuthError("invalid_request", "Unknown sign-in provider.", 404);
    const taken = await this.o.store.takeTxn(url.searchParams.get("state") ?? "");
    const txn = taken?.data as AuthTxn | undefined;
    if (!taken || !txn || taken.expiresAt < this.now() || txn.provider !== provider.id) {
      throw new OAuthError("invalid_request", "This sign-in expired or was already used. Start again from your app.");
    }
    const back = new URL(txn.redirectUri);
    if (txn.state !== null) back.searchParams.set("state", txn.state);
    const code = url.searchParams.get("code");
    if (!code) {
      log.info(`auth: ${provider.label} returned no code (${(url.searchParams.get("error") ?? "none").slice(0, 40)})`);
      // The person declined at the provider: tell the client (its redirect was validated in /authorize).
      back.searchParams.set("error", "access_denied");
      res.writeHead(302, { location: back.toString(), "cache-control": "no-store" }).end();
      return;
    }
    let identity;
    try {
      identity = await provider.exchange({ code, redirectUri: this.callbackUrl(provider.id) });
    } catch (err) {
      log.warn(`auth: ${provider.label} code exchange failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      throw new OAuthError("server_error", `${provider.label} sign-in failed. Try again.`, 502);
    }
    const user = await this.o.store.upsertIdentity({ provider: provider.id, ...identity });
    if (user.disabled) throw new OAuthError("access_denied", "This account is disabled.", 403);
    if (txn.audience === "web") {
      const iat = Math.floor(this.now() / 1000);
      const value = signAccess({ sub: user.id, aud: "web", cid: "account", iat, exp: iat + WEB_TTL_SEC }, this.o.signingKey);
      const secure = this.o.publicUrl.startsWith("https:") ? "; Secure" : "";
      res.writeHead(303, {
        location: "/account",
        "set-cookie": `${ACCOUNT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEB_TTL_SEC}${secure}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    let browserId: string | null = null;
    if (txn.audience === "ext") {
      const name = txn.browserName ?? "browser";
      const existing = await this.o.store.listBrowsers(user.id);
      const max = this.o.maxBrowsers ?? Infinity;
      if (!existing.some((b) => b.name === name) && existing.length >= max) {
        throw new OAuthError(
          "access_denied",
          `This account already has ${existing.length} browsers signed in (the most allowed). Revoke one at ${this.o.publicUrl}/account, then sign in again.`,
          403,
        );
      }
      browserId = (await this.o.store.upsertBrowser(user.id, name)).id;
    }
    const authCode = randomToken();
    const data: CodeData = {
      userId: user.id,
      clientId: txn.clientId,
      redirectUri: txn.redirectUri,
      challenge: txn.challenge,
      audience: txn.audience as Audience,
      browserId,
    };
    await this.o.store.putCode(sha256(authCode), data, this.now() + CODE_TTL_MS);
    log.info(`auth: ${provider.label} sign-in ok, code issued to a ${data.audience === "ext" ? "browser" : "MCP client"} (returns to ${back.host})`);
    back.searchParams.set("code", authCode);
    res.writeHead(302, { location: back.toString(), "cache-control": "no-store" }).end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: Record<string, string>;
    try {
      form = await readForm(req);
    } catch {
      throw new OAuthError("invalid_request", "unreadable body");
    }
    const clientId = form.client_id ?? "";
    if (form.grant_type === "authorization_code") {
      const taken = await this.o.store.takeCode(sha256(form.code ?? ""));
      const data = taken?.data as CodeData | undefined;
      if (
        !taken ||
        !data ||
        taken.expiresAt < this.now() ||
        data.clientId !== clientId ||
        data.redirectUri !== form.redirect_uri ||
        !pkceMatches(form.code_verifier ?? "", data.challenge)
      ) {
        throw new OAuthError("invalid_grant", "invalid, expired or already used authorization code");
      }
      sendJson(res, 200, await this.issue(data.userId, clientId, data.audience, data.browserId, newId("f")));
      log.info(`auth: tokens issued (authorization_code, ${data.audience})`);
      return;
    }
    if (form.grant_type === "refresh_token") {
      const hash = sha256(form.refresh_token ?? "");
      const record = await this.o.store.getRefresh(hash);
      if (!record || record.clientId !== clientId || record.expiresAt < this.now()) {
        log.warn(`auth: refresh refused (${!record ? "unknown token" : record.clientId !== clientId ? "wrong client" : "expired"})`);
        throw new OAuthError("invalid_grant", "invalid refresh token");
      }
      if (!(await this.o.store.markRefreshUsed(hash))) {
        // Already used (or revoked): someone else has this token. End the whole sign-in.
        log.warn(`auth: refresh refused (${record.revoked ? "revoked" : "reused: sign-in ended"}; client ${clientId === EXTENSION_CLIENT_ID ? "extension" : "agent"})`);
        await this.o.store.revokeFamily(record.family);
        throw new OAuthError("invalid_grant", "refresh token reused; sign in again");
      }
      const user = await this.o.store.getUser(record.userId);
      if (!user || user.disabled) throw new OAuthError("invalid_grant", "account disabled");
      sendJson(res, 200, await this.issue(record.userId, clientId, record.audience, record.browserId, record.family));
      return;
    }
    throw new OAuthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  private async issue(userId: string, clientId: string, aud: Audience, browserId: string | null, family: string) {
    const iat = Math.floor(this.now() / 1000);
    const access = signAccess(
      { sub: userId, aud, cid: clientId, ...(browserId ? { bid: browserId } : {}), iat, exp: iat + this.accessTtlSec },
      this.o.signingKey,
    );
    const refresh = `tcr_${randomToken()}`;
    await this.o.store.putRefresh({
      hash: sha256(refresh),
      family,
      userId,
      clientId,
      audience: aud,
      browserId,
      expiresAt: this.now() + this.refreshTtlSec * 1000,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.accessTtlSec,
      refresh_token: refresh,
      scope: aud,
      ...(browserId ? { browser_id: browserId } : {}),
    };
  }

  private signInPage(res: ServerResponse, client: OAuthClient, redirectUri: string, txnId: string, txn: AuthTxn): void {
    const target = new URL(redirectUri);
    const what =
      client.kind === "ext"
        ? `Connect this browser (<b>${escapeHtml(txn.browserName ?? "browser")}</b>) to TabCrew Online. Agents you sign in will be able to open and control tabs in it.`
        : `<b>${escapeHtml(client.name)}</b> (returning to <code>${escapeHtml(target.host)}</code>) wants to use TabCrew Online: it will be able to open and control tabs in the browsers you connected.`;
    const buttons = this.o.providers
      .map(
        (p) =>
          `<form method="post" action="/auth/${p.id}"><input type="hidden" name="txn" value="${escapeHtml(txnId)}"><button class="btn">Continue with ${escapeHtml(p.label)}</button></form>`,
      )
      .join("\n");
    sendHtml(res, 200, page("Sign in to TabCrew", `<p>${what}</p>\n${buttons}\n<p class="small">Only continue if you started this yourself.</p>`), {
      forms: true,
      headers: { "referrer-policy": "same-origin" },
    });
  }

  private errorPage(res: ServerResponse, status: number, message: string): void {
    sendHtml(res, status, page("TabCrew sign-in", `<p>${escapeHtml(message)}</p>`));
  }
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    const json = (await readBody(req, 64 * 1024)) as Record<string, unknown> | undefined;
    return Object.fromEntries(Object.entries(json ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  const raw = await readBody(req, 64 * 1024, "text");
  return Object.fromEntries(new URLSearchParams(String(raw ?? "")));
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}
h1{font-size:1.4rem}.btn{display:block;width:100%;font:inherit;background:none;cursor:pointer;text-align:center;margin:.6rem 0;padding:.7rem;border:1px solid #888;border-radius:.5rem;color:inherit;text-decoration:none}
.btn:hover{background:#f2f2f2}.small{font-size:.85rem;color:#666}code{font-size:.9em}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
