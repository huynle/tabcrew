import type { IncomingMessage, ServerResponse } from "node:http";
import { ACCOUNT_COOKIE, EXTENSION_CLIENT_ID, type AuthServer } from "./auth/server.js";
import type { Provider } from "./auth/providers.js";
import { hmac, safeEqual } from "./crypto.js";
import { escapeHtml, readBody, sendHtml } from "./http.js";
import type { Store } from "./store/types.js";
import type { TenantManager } from "./tenants.js";

export interface AccountDeps {
  readonly publicUrl: string;
  readonly store: Store;
  readonly auth: AuthServer;
  readonly providers: readonly Provider[];
  readonly tenants: TenantManager;
  readonly signingKey: Buffer;
  /** Refresh token lifetime: a grant's last sign-in or refresh was this long before its expiry. */
  readonly refreshTtlMs: number;
  /** End a client's access at once: its access tokens stop working and its MCP sessions close. */
  revokeClient(userId: string, clientId: string): void;
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

/**
 * /account: see and revoke the browsers and agents (MCP clients) signed in to this account.
 * Signs in with the same providers (a 12 h HttpOnly, SameSite=Lax cookie). Every change is a POST
 * with a CSRF token bound to the cookie and a same-origin Origin check.
 */
export class AccountPages {
  constructor(private readonly d: AccountDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/account")) return false;
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /account/login") {
      await this.d.auth.startWebLogin(res, url.searchParams.get("provider") ?? "");
      return true;
    }
    const cookie = cookieValue(req, ACCOUNT_COOKIE);
    const claims = this.d.auth.verify(cookie, "web");
    if (route === "GET /account") {
      if (!claims || !cookie) this.signInPage(res);
      else await this.page(res, claims.sub, cookie);
      return true;
    }
    if (req.method !== "POST" || !["/account/revoke-browser", "/account/revoke-client", "/account/logout"].includes(url.pathname)) {
      return false;
    }
    if (!claims || !cookie) return this.forbidden(res, "Sign in again.");
    if (!this.sameOrigin(req)) return this.forbidden(res, "Cross-site request refused.");
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(String((await readBody(req, 16 * 1024, "text")) ?? ""));
    } catch {
      return this.forbidden(res, "Unreadable request.");
    }
    if (!safeEqual(form.get("csrf") ?? "", this.csrf(cookie))) return this.forbidden(res, "This form expired. Reload the page.");

    const userId = claims.sub;
    switch (url.pathname) {
      case "/account/logout":
        res.writeHead(303, { location: "/account", "set-cookie": this.d.auth.clearCookie, "cache-control": "no-store" }).end();
        return true;
      case "/account/revoke-browser": {
        const browserId = form.get("browser_id") ?? "";
        if (!(await this.d.store.revokeBrowser(userId, browserId))) return this.notFound(res);
        await this.d.store.revokeGrants(userId, { browserId });
        this.d.tenants.disconnect(browserId);
        break;
      }
      case "/account/revoke-client": {
        const clientId = form.get("client_id") ?? "";
        if (clientId === EXTENSION_CLIENT_ID || (await this.d.store.revokeGrants(userId, { clientId })) === 0) return this.notFound(res);
        this.d.revokeClient(userId, clientId);
        break;
      }
    }
    res.writeHead(303, { location: "/account", "cache-control": "no-store" }).end();
    return true;
  }

  /**
   * The POST came from this site's own page: Origin is the relay's origin, or (browsers send
   * `Origin: null` under some referrer policies) the browser-set Sec-Fetch-Site says same-origin.
   */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === new URL(this.d.publicUrl).origin) return true;
    return (origin === undefined || origin === "null") && req.headers["sec-fetch-site"] === "same-origin";
  }

  private csrf(cookie: string): string {
    return hmac(this.d.signingKey, `csrf|${cookie}`);
  }

  private forbidden(res: ServerResponse, message: string): true {
    sendHtml(res, 403, layout("TabCrew account", `<p>${escapeHtml(message)}</p><p><a href="/account">Back</a></p>`));
    return true;
  }

  private notFound(res: ServerResponse): true {
    sendHtml(res, 404, layout("TabCrew account", `<p>Not found.</p><p><a href="/account">Back</a></p>`));
    return true;
  }

  private signInPage(res: ServerResponse): void {
    const buttons = this.d.providers
      .map((p) => `<a class="btn" href="/account/login?provider=${p.id}">Sign in with ${escapeHtml(p.label)}</a>`)
      .join("\n");
    sendHtml(res, 200, layout("TabCrew account", `<p>See and revoke the browsers and agents signed in to your TabCrew Online account.</p>\n${buttons}`));
  }

  private async page(res: ServerResponse, userId: string, cookie: string): Promise<void> {
    const csrf = this.csrf(cookie);
    const live = new Map(this.d.tenants.ofUser(userId).map((t) => [t.browserId, t]));
    const browsers = await this.d.store.listBrowsers(userId);
    const grants = await this.d.store.listGrants(userId);
    const lastActive = new Map<string, number>();
    for (const g of grants) {
      if (g.audience !== "mcp") continue;
      lastActive.set(g.clientId, Math.max(lastActive.get(g.clientId) ?? 0, g.expiresAt - this.d.refreshTtlMs));
    }
    const clients = (await Promise.all([...lastActive.keys()].map((id) => this.d.store.getClient(id))))
      .filter((c) => c !== null)
      .sort((a, b) => (lastActive.get(b.id) ?? 0) - (lastActive.get(a.id) ?? 0));
    const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    const browserRows = browsers.length
      ? browsers
          .map((b) => {
            const online = live.get(b.id)?.core.bridge.connected ? "online" : "offline";
            return `<li><b>${escapeHtml(b.name)}</b> <span class="small">${online}</span>
<form method="post" action="/account/revoke-browser">${hidden("csrf", csrf)}${hidden("browser_id", b.id)}<button>Revoke</button></form></li>`;
          })
          .join("\n")
      : `<li class="small">No browsers signed in.</li>`;
    const clientRows = clients.length
      ? clients
          .map(
            (c) => `<li><b>${escapeHtml(c.name)}</b> <span class="small">signed in or refreshed ${when(lastActive.get(c.id) ?? 0)} · …${escapeHtml(c.id.slice(-6))}</span>
<form method="post" action="/account/revoke-client">${hidden("csrf", csrf)}${hidden("client_id", c.id)}<button>Revoke</button></form></li>`,
          )
          .join("\n")
      : `<li class="small">No agents signed in.</li>`;
    const body = `<h2>Browsers</h2><ul>${browserRows}</ul>
<h2>Agents</h2><ul>${clientRows}</ul>
<p class="small">Revoking signs it out at once; it has to sign in again to come back.</p>
<form method="post" action="/account/logout">${hidden("csrf", csrf)}<button>Sign out of this page</button></form>`;
    // same-origin (not no-referrer): Chrome then sends the real Origin with these forms.
    sendHtml(res, 200, layout("Your TabCrew account", body), { forms: true, headers: { "referrer-policy": "same-origin" } });
  }
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}ul{padding:0;list-style:none}li{display:flex;gap:.6rem;align-items:center;padding:.4rem 0;border-bottom:1px solid #eee}
li form{margin-left:auto}.btn{display:block;text-align:center;margin:.6rem 0;padding:.7rem;border:1px solid #888;border-radius:.5rem;color:inherit;text-decoration:none}
.small{font-size:.85rem;color:#666}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
