import type { IncomingMessage, ServerResponse } from "node:http";
import { PROVIDER_PRESETS, keyHint, presetFor, recommendedModels, type PresetId, type ProviderSettings } from "@tabcrew/shared/provider";
import { V2_EXT_FEATURE_ACCOUNT_MODEL, V2_EXT_FEATURE_OWN_MODEL } from "@tabcrew/shared/v2";
import { ACCOUNT_COOKIE, EXTENSION_CLIENT_ID, type AuthServer } from "./auth/server.js";
import type { Provider } from "./auth/providers.js";
import { hmac, safeEqual } from "./crypto.js";
import { escapeHtml, readBody, sendHtml } from "./http.js";
import { checkAccountSettings, type AccountModels } from "./modelSettings.js";
import type { Store } from "./store/types.js";
import type { TenantManager } from "./tenants.js";
import { shell, type NavKey } from "./ui.js";

export interface AccountDeps {
  readonly publicUrl: string;
  readonly store: Store;
  readonly auth: AuthServer;
  readonly providers: readonly Provider[];
  readonly tenants: TenantManager;
  readonly signingKey: Buffer;
  readonly models: AccountModels;
  /** Refresh token lifetime: a grant's last sign-in or refresh was this long before its expiry. */
  readonly refreshTtlMs: number;
  /** End a client's access at once: its access tokens stop working and its MCP sessions close. */
  revokeClient(userId: string, clientId: string): void;
  readonly now?: () => number;
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

const POSTS = new Set(["/account/revoke-browser", "/account/revoke-client", "/account/logout", "/settings"]);
const NOTICE_MS = 60_000;
const MODEL_LIST_MS = 30 * 60_000;

type Notice = { readonly tone: "ok" | "error" | "warn"; readonly text: string; readonly at: number };
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

/**
 * Signed-in web pages:
 * - /account: the browsers and agents (MCP clients) signed in to this account, with Revoke.
 * - /settings: the account's model provider, key and models for `browse` (relay-side model calls).
 * Sign-in is a 12 h HttpOnly, SameSite=Lax cookie. Every change is a POST with a CSRF token bound
 * to the cookie and a same-origin check. Pages carry no scripts; Load models and Test run here.
 */
export class AccountPages {
  private readonly notices = new Map<string, Notice>();
  private readonly modelLists = new Map<string, { at: number; baseUrl: string; models: string[] }>();
  private readonly now: () => number;

  constructor(private readonly d: AccountDeps) {
    this.now = d.now ?? Date.now;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const area = url.pathname.startsWith("/account") ? "account" : url.pathname === "/settings" ? "settings" : null;
    if (!area) return false;
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /account/login") {
      await this.d.auth.startWebLogin(res, url.searchParams.get("provider") ?? "", url.searchParams.get("next") ?? "/account");
      return true;
    }
    const cookie = cookieValue(req, ACCOUNT_COOKIE);
    const claims = this.d.auth.verify(cookie, "web");
    if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/settings")) {
      if (!claims || !cookie) this.signInPage(res, area);
      else if (area === "account") await this.accountPage(res, claims.sub, cookie);
      else await this.settingsPage(res, claims.sub, cookie);
      return true;
    }
    if (req.method !== "POST" || !POSTS.has(url.pathname)) return false;
    if (!claims || !cookie) return this.forbidden(res, "Sign in again.");
    if (!this.sameOrigin(req)) return this.forbidden(res, "Cross-site request refused.");
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(String((await readBody(req, 64 * 1024, "text")) ?? ""));
    } catch {
      return this.forbidden(res, "Unreadable request.");
    }
    if (!safeEqual(form.get("csrf") ?? "", this.csrf(cookie))) return this.forbidden(res, "This form expired. Reload the page.");

    const userId = claims.sub;
    switch (url.pathname) {
      case "/account/logout":
        res.writeHead(303, { location: "/", "set-cookie": this.d.auth.clearCookie, "cache-control": "no-store" }).end();
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
      case "/settings":
        await this.saveSettings(userId, form);
        res.writeHead(303, { location: "/settings", "cache-control": "no-store" }).end();
        return true;
    }
    res.writeHead(303, { location: "/account", "cache-control": "no-store" }).end();
    return true;
  }

  // ---------------------------------------------------------------------------------- settings

  private notice(userId: string, tone: Notice["tone"], text: string): void {
    this.notices.set(userId, { tone, text, at: this.now() });
  }

  private async saveSettings(userId: string, form: URLSearchParams): Promise<void> {
    const action = form.get("action") ?? "save";
    if (!this.d.models.enabled) return this.notice(userId, "error", "Model settings are not enabled on this relay.");
    if (action === "remove") {
      await this.d.models.remove(userId);
      this.modelLists.delete(userId);
      return this.notice(userId, "ok", "Model settings removed. Browsers use their own provider again, if they have one.");
    }
    const saved = await this.d.models.get(userId);
    const presetId = (form.get("preset") ?? "custom") as PresetId;
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    const baseUrl = (preset?.base_url ?? form.get("base_url") ?? "").trim();
    const typedKey = (form.get("api_key") ?? "").trim();
    let apiKey = typedKey;
    if (!apiKey && saved) {
      const sameOrigin = safeOrigin(saved.base_url) !== null && safeOrigin(saved.base_url) === safeOrigin(baseUrl);
      if (!sameOrigin) {
        return this.notice(userId, "error", `Paste the API key for ${safeOrigin(baseUrl) ?? "this provider"} (the saved key belongs to ${safeOrigin(saved.base_url)}).`);
      }
      apiKey = saved.api_key;
    }
    const headerText = (form.get("headers") ?? "").trim();
    const headers = form.get("clear_headers") ? {} : headerText ? parseHeaderLines(headerText) : (saved?.headers ?? {});
    if (headers === null) return this.notice(userId, "error", 'Write one header per line as "Name: value".');
    const check = checkAccountSettings({
      base_url: baseUrl,
      api_key: apiKey,
      headers,
      decision_model: (form.get("decision_model") ?? "").trim(),
      text_model: (form.get("text_model") ?? "").trim(),
      fallback_text_model: (form.get("fallback_text_model") ?? "").trim(),
    });
    if (!check.ok) return this.notice(userId, "error", check.error);
    let settings: ProviderSettings = check.settings;

    if (action === "load") {
      const list = await this.d.models.listModels(settings);
      if (!list.ok) {
        await this.d.models.save(userId, settings);
        return this.notice(userId, "error", `Saved, but the models could not be loaded: ${list.error}`);
      }
      this.modelLists.set(userId, { at: this.now(), baseUrl: settings.base_url, models: list.models });
      const rec = recommendedModels(settings.base_url);
      const listed = (m?: string) => (m && list.models.includes(m) ? m : "");
      let picked = false;
      if (rec) {
        const next = {
          ...settings,
          decision_model: settings.decision_model || listed(rec.decision_model),
          text_model: settings.text_model || listed(rec.text_model),
          ...(settings.fallback_text_model || listed(rec.fallback_text_model) ? { fallback_text_model: settings.fallback_text_model || listed(rec.fallback_text_model) } : {}),
        };
        picked = next.decision_model !== settings.decision_model || next.text_model !== settings.text_model;
        settings = next;
      }
      await this.d.models.save(userId, settings);
      return this.notice(
        userId,
        list.models.length ? "ok" : "warn",
        list.models.length
          ? `Saved. ${list.models.length} chat model${list.models.length === 1 ? "" : "s"} from ${new URL(settings.base_url).host}${picked ? "; recommended models picked" : ""}. Choose your models below.`
          : `Saved, but ${new URL(settings.base_url).host} listed no chat models. Type the model ids below.`,
      );
    }
    await this.d.models.save(userId, settings);
    if (action === "test") {
      const result = await this.d.models.test(settings);
      return this.notice(userId, result.ok ? "ok" : "error", result.ok ? `Saved and tested: ${result.message}` : `Saved, but the test failed: ${result.message}`);
    }
    const missing = !settings.decision_model || !settings.text_model;
    this.notice(userId, missing ? "warn" : "ok", missing ? "Saved. Choose a decision model and a text model before browse can run." : "Saved. Every browser of this account uses these settings.");
  }

  private async settingsPage(res: ServerResponse, userId: string, cookie: string): Promise<void> {
    const csrf = this.csrf(cookie);
    const saved = await this.d.models.get(userId);
    const notice = this.takeNotice(userId);
    const list = this.modelLists.get(userId);
    const models = list && saved && list.baseUrl === saved.base_url && this.now() - list.at < MODEL_LIST_MS ? list.models : [];
    const presetId = saved ? presetFor(saved.base_url) : PROVIDER_PRESETS[0]!.id;
    const ownBrowsers = this.d.tenants
      .ofUser(userId)
      .filter((t) => t.core.bridge.connected && t.core.bridge.features.includes(V2_EXT_FEATURE_OWN_MODEL))
      .map((t) => t.name);

    if (!this.d.models.enabled) {
      return this.send(res, userId, "Model settings", "settings", csrf, `${head("Model settings", "")}<div class="alert warn">Account model settings are not enabled on this relay. Set the provider in each browser's TabCrew popup instead.</div>`);
    }

    const presetOptions = PROVIDER_PRESETS.map(
      (p) => `<option value="${p.id}"${p.id === presetId ? " selected" : ""}>${escapeHtml(p.base_url ? `${p.label} (${new URL(p.base_url).host})` : "Custom (any public OpenAI-compatible URL)")}</option>`,
    ).join("");
    const rec = saved ? recommendedModels(saved.base_url) : null;
    const datalist = models.length ? `<datalist id="models">${models.map((m) => `<option value="${escapeHtml(m)}"${rec && Object.values(rec).includes(m) ? ' label="recommended"' : ""}>`).join("")}</datalist>` : "";
    const modelField = (name: keyof ProviderSettings, label: string, hint: string, value: string) =>
      `<label class="field">${label}<input type="text" name="${name}" value="${escapeHtml(value)}" ${models.length ? 'list="models" ' : ""}autocomplete="off" spellcheck="false" placeholder="${models.length ? "Choose or type a model id" : "Load models, or type a model id"}"><span class="hint">${hint}</span></label>`;
    const headerNames = saved ? Object.keys(saved.headers) : [];

    const status = saved
      ? `<div class="card"><div class="card-head"><h2>Used by browse</h2><span class="pill ${saved.decision_model && saved.text_model ? "ok" : "warn"}"${saved.decision_model && saved.text_model ? ' title="Provider, key and models are set. Save &amp; test checks that they work."' : ""}>${saved.decision_model && saved.text_model ? "Set up" : "Models missing"}</span></div>
<dl class="kv"><dt>Provider</dt><dd>${escapeHtml(new URL(saved.base_url).host)} <span class="muted mono">${escapeHtml(saved.base_url)}</span></dd>
<dt>API key</dt><dd class="mono">…${escapeHtml(keyHint(saved.api_key) || "set")}</dd>
<dt>Decision model</dt><dd class="mono">${escapeHtml(saved.decision_model || "—")}</dd>
<dt>Text model</dt><dd class="mono">${escapeHtml(saved.text_model || "—")}</dd>
<dt>Fallback</dt><dd class="mono">${escapeHtml(saved.fallback_text_model || "none")}</dd></dl>
${ownBrowsers.length ? `<p class="small muted">Using their own provider instead (set in their popup): ${ownBrowsers.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ")}.</p>` : ""}</div>`
      : `<div class="alert warn">No model provider yet: <code>browse</code> is off for browsers in Online mode until you add one (other tools work without it).</div>`;

    const body = `${head("Model settings", "One provider, key and set of models for <code>browse</code> on every browser connected to this account. The relay calls the provider for you; your key is stored encrypted and never sent to a browser.")}
${notice ? `<div class="alert ${notice.tone}" role="status">${escapeHtml(notice.text)}</div>` : ""}
${status}
<form method="post" action="/settings" class="card" autocomplete="off">${hidden("csrf", csrf)}
<div class="card-head"><h2>Provider</h2></div>
<div class="row"><label class="field">Provider<select name="preset">${presetOptions}</select><span class="hint">Any OpenAI-compatible provider on the public internet.</span></label>
<label class="field">Base URL (Custom only)<input type="url" name="base_url" value="${escapeHtml(saved && presetId === "custom" ? saved.base_url : "")}" placeholder="https://api.example.com/v1" spellcheck="false"><span class="hint">https only. Private or LAN addresses can't be reached from the relay; use a browser's own provider for those.</span></label></div>
<label class="field">API key<input type="password" name="api_key" placeholder="${saved ? `Saved (…${escapeHtml(keyHint(saved.api_key))}). Leave empty to keep it.` : "Paste the provider's API key"}" spellcheck="false"><span class="hint">Write-only: it is never shown again.</span></label>
<label class="field">Extra headers (optional)<textarea name="headers" rows="2" placeholder="OpenAI-Organization: org-123" spellcheck="false"></textarea><span class="hint">One "Name: value" per line. ${headerNames.length ? `Saved: ${headerNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(", ")}; leave empty to keep them. <label style="display:inline-flex;gap:.3rem;align-items:center"><input type="checkbox" name="clear_headers" value="1"> remove saved headers</label>` : "Authorization, Host, Cookie and Content-Type are set by TabCrew."}</span></label>
<h3>Models</h3>${datalist}
<div class="row">${modelField("decision_model", "Decision model", "Picks each browse step. Use a fast model that reliably returns JSON.", saved?.decision_model ?? "")}
${modelField("text_model", "Text model", "Writes the values browse types. A small, cheap model is fine.", saved?.text_model ?? "")}
${modelField("fallback_text_model", "Fallback text model (optional)", "Tried once if the text model fails.", saved?.fallback_text_model ?? "")}</div>
<div class="card-foot"><button class="primary" name="action" value="save">Save</button><button name="action" value="load">Save &amp; load models</button><button name="action" value="test">Save &amp; test</button>
${saved ? `<button class="danger" name="action" value="remove" style="margin-left:auto">Remove</button>` : ""}</div>
</form>
<p class="small muted">Each browser can still use its own provider: in its TabCrew popup (Online), turn on <b>Use this browser's own provider</b>. Daemon and Hub modes always use the popup's settings.</p>`;
    await this.send(res, userId, "Model settings", "settings", csrf, body);
  }

  private takeNotice(userId: string): Notice | null {
    const n = this.notices.get(userId);
    this.notices.delete(userId);
    return n && this.now() - n.at < NOTICE_MS ? n : null;
  }

  // ---------------------------------------------------------------------------------- account

  private async accountPage(res: ServerResponse, userId: string, cookie: string): Promise<void> {
    const csrf = this.csrf(cookie);
    const live = new Map(this.d.tenants.ofUser(userId).map((t) => [t.browserId, t]));
    const browsers = await this.d.store.listBrowsers(userId);
    const hasSettings = (await this.d.models.get(userId)) !== null;
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

    const browserRows = browsers.length
      ? browsers
          .map((b) => {
            const t = live.get(b.id);
            const online = t?.core.bridge.connected === true;
            const features = online ? t!.core.bridge.features : [];
            const version = online ? t!.core.bridge.version : null;
            // What browse uses for this browser (relayModelTransport's rule); unknown while offline.
            const source = !online
              ? ""
              : features.includes(V2_EXT_FEATURE_OWN_MODEL)
                ? "uses its own model provider"
                : features.includes(V2_EXT_FEATURE_ACCOUNT_MODEL)
                  ? hasSettings
                    ? "uses the account's model settings"
                    : "no model provider yet (set one in Model settings)"
                  : `uses its popup's provider (update the extension to use the account's model settings)`;
            const meta = [version ? `extension ${escapeHtml(version)}` : "", source].filter(Boolean).join(" · ");
            return `<li><div><b>${escapeHtml(b.name)}</b> <span class="pill${online ? " ok" : ""}">${online ? "online" : "offline"}</span>
${meta ? `<div class="small muted">${meta}</div>` : ""}</div>
<form method="post" action="/account/revoke-browser">${hidden("csrf", csrf)}${hidden("browser_id", b.id)}<button class="small danger">Revoke</button></form></li>`;
          })
          .join("\n")
      : `<li class="muted empty">No browsers yet. In the TabCrew popup, set Connection to Online and sign in.</li>`;
    const clientRows = clients.length
      ? clients
          .map(
            (c) => `<li><div><b>${escapeHtml(c.name)}</b><div class="small muted">signed in or refreshed ${when(lastActive.get(c.id) ?? 0)} · <span class="mono">…${escapeHtml(c.id.slice(-6))}</span></div></div>
<form method="post" action="/account/revoke-client">${hidden("csrf", csrf)}${hidden("client_id", c.id)}<button class="small danger">Revoke</button></form></li>`,
          )
          .join("\n")
      : `<li class="muted empty">No agents yet. Add <code>${escapeHtml(this.d.publicUrl)}/mcp</code> to your MCP client and sign in.</li>`;
    const body = `${head("Browsers & agents", "Everything signed in to your TabCrew Online account. Revoking signs it out at once; it has to sign in again to come back.")}
<div class="grid"><div class="card"><div class="card-head"><h2>Browsers</h2><span class="muted small">${browsers.length}</span></div><ul class="list">${browserRows}</ul></div>
<div class="card"><div class="card-head"><h2>Agents</h2><span class="muted small">${clients.length}</span></div><ul class="list">${clientRows}</ul></div></div>`;
    await this.send(res, userId, "Browsers & agents", "account", csrf, body);
  }

  // ---------------------------------------------------------------------------------- shared

  /** The POST came from this site's own page (Origin, or Sec-Fetch-Site when Origin is withheld). */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === new URL(this.d.publicUrl).origin) return true;
    return (origin === undefined || origin === "null") && req.headers["sec-fetch-site"] === "same-origin";
  }

  private csrf(cookie: string): string {
    return hmac(this.d.signingKey, `csrf|${cookie}`);
  }

  private async send(res: ServerResponse, userId: string, title: string, nav: NavKey, csrf: string, body: string): Promise<void> {
    const user = await this.d.store.getUser(userId);
    // same-origin (not no-referrer): Chrome then sends the real Origin with these forms.
    sendHtml(res, 200, shell({ title, nav, signedIn: { csrf, name: user?.name || user?.email || null }, body }), {
      forms: true,
      headers: { "referrer-policy": "same-origin" },
    });
  }

  private forbidden(res: ServerResponse, message: string): true {
    sendHtml(res, 403, shell({ title: "TabCrew account", layout: "narrow", body: `<div class="card"><p>${escapeHtml(message)}</p><p><a href="/account">Back</a></p></div>` }));
    return true;
  }

  private notFound(res: ServerResponse): true {
    sendHtml(res, 404, shell({ title: "TabCrew account", layout: "narrow", body: `<div class="card"><p>Not found.</p><p><a href="/account">Back</a></p></div>` }));
    return true;
  }

  private signInPage(res: ServerResponse, area: "account" | "settings"): void {
    const next = area === "settings" ? "/settings" : "/account";
    const buttons = this.d.providers
      .map((p, i) => `<a class="btn block${i === 0 ? " primary" : ""}" href="/account/login?provider=${p.id}&amp;next=${next}">Continue with ${escapeHtml(p.label)}</a>`)
      .join("\n");
    const what = area === "settings" ? "set the model provider, key and models every browser of your account uses" : "see and revoke the browsers and agents signed in to your account";
    sendHtml(
      res,
      200,
      shell({
        title: "Sign in",
        nav: area,
        layout: "narrow",
        body: `<div class="card"><h1>Sign in to TabCrew Online</h1><p class="muted">Sign in to ${what}. Use the same provider as in your browsers: GitHub and Google are separate accounts.</p><div class="stack">${buttons}</div></div>`,
      }),
    );
  }
}

function head(title: string, desc: string): string {
  return `<div class="page-head"><h1>${escapeHtml(title)}</h1>${desc ? `<p class="page-desc">${desc}</p>` : ""}</div>`;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** "Name: value" lines to a header map; null when a line has no colon. Empty text: null. */
function parseHeaderLines(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at <= 0) return null;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}
