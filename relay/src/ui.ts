/**
 * The relay's web look, after the mcp-gateway portal (gateway.huynle.com): IBM Plex, teal accent,
 * cards, a top bar, light and dark (follows the system). One stylesheet and the fonts are served
 * from /static; pages carry no scripts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./http.js";

const REPO = "https://github.com/huynle/tabcrew";

export const CSS = `
:root{color-scheme:light;--bg:#f6f7f9;--panel:#fff;--surface:#eef0f3;--fg:#16181d;--muted:#5a606c;--line:#e1e4e9;--line-strong:#cdd1d8;--input-border:#80868f;--accent:#0e7268;--accent-fg:#fff;--accent-soft:#e3f2f0;--danger:#b42318;--danger-fg:#fff;--danger-soft:#fcebe9;--ok:#16793a;--ok-soft:#e5f4ea;--warn:#865500;--warn-soft:#faf0da;--focus:#0e7268;--shadow:#10182814}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d0f12;--panel:#14171c;--surface:#1a1e24;--fg:#e6e8ec;--muted:#9aa1ac;--line:#262b33;--line-strong:#353b45;--input-border:#69717d;--accent:#3ad3bf;--accent-fg:#04201c;--accent-soft:#0f2c29;--danger:#ff8e82;--danger-fg:#2b0a06;--danger-soft:#341613;--ok:#62d48c;--ok-soft:#11291b;--warn:#efb851;--warn-soft:#2e2411;--focus:#3ad3bf;--shadow:#00000066}}
@font-face{font-family:"Plex Sans";src:url("/static/fonts/plex-sans-400.woff2") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Plex Sans";src:url("/static/fonts/plex-sans-500.woff2") format("woff2");font-weight:500;font-display:swap}
@font-face{font-family:"Plex Sans";src:url("/static/fonts/plex-sans-600.woff2") format("woff2");font-weight:600 700;font-display:swap}
@font-face{font-family:"Plex Mono";src:url("/static/fonts/plex-mono-400.woff2") format("woff2");font-weight:400;font-display:swap}
:root{--sans:"Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--text-xs:.75rem;--text-sm:.8125rem;--text-md:.875rem;--text-lg:1.0625rem;--text-xl:1.375rem;--radius-sm:5px;--radius:8px;--radius-lg:12px;--elev-1:0 1px 2px var(--shadow);--elev-2:0 1px 2px var(--shadow),0 8px 24px -8px var(--shadow)}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;font:400 var(--text-md)/1.55 var(--sans);color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
main{width:100%;max-width:60rem;margin:0 auto;padding:2rem 1.5rem 3rem;flex:1}
main.narrow{max-width:30rem}
h1,h2,h3{line-height:1.25;font-weight:600;letter-spacing:-.01em}
h1{font-size:var(--text-xl);margin:0 0 .4rem;letter-spacing:-.02em}
h2{font-size:var(--text-lg);margin:0 0 .75rem}
h3{font-size:var(--text-md);margin:1.5rem 0 .5rem}
p{margin:0 0 .75rem}
a{color:var(--accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 35%,transparent);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
code,pre{font-family:var(--mono);font-size:.8125rem}
:not(pre)>code{padding:.05rem .35rem;border-radius:4px;background:var(--surface);border:1px solid var(--line)}
pre{padding:.75rem 1rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);overflow-x:auto}
.muted{color:var(--muted)}.small{font-size:var(--text-sm)}
.icon{width:1.1rem;height:1.1rem;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.brand{display:inline-flex;align-items:center;gap:.6rem;color:var(--fg);text-decoration:none;font-weight:600;font-size:.95rem;letter-spacing:-.01em}
.brand .icon{width:1.6rem;height:1.6rem;stroke-width:2}
.brand .brand-tile{fill:var(--accent);stroke:none}
.brand .brand-mark{stroke:var(--accent-fg);stroke-width:2}
.sr-only{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
body.app{display:grid;grid-template-columns:15.5rem minmax(0,1fr);grid-template-rows:auto 1fr auto;background:linear-gradient(to right,var(--surface) calc(15.5rem - 1px),var(--line) calc(15.5rem - 1px) 15.5rem,var(--bg) 15.5rem)}
body.app>.sidebar{grid-column:1;grid-row:1/-1;align-self:start}
body.app>main,body.app>.site-footer,body.app>.topbar{grid-column:2}
body.app>.topbar{grid-row:1}body.app>main{grid-row:2}body.app>.site-footer{grid-row:3}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--line);z-index:30}
.sidebar-head{padding:1rem 1rem .75rem}
.site-nav{flex:1;overflow-y:auto;padding:.25rem .75rem 1rem;display:grid;align-content:start;gap:.75rem}
.nav-group{display:grid;gap:1px}
.nav-label{margin:0 0 .25rem;padding:0 .5rem;font-size:var(--text-xs);font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.nav-link{display:flex;align-items:center;gap:.65rem;padding:.3rem .5rem;border-radius:var(--radius-sm);color:var(--fg);text-decoration:none;font-size:var(--text-md)}
.nav-link .icon{color:var(--muted);width:1.05rem;height:1.05rem}
.nav-link:hover{background:color-mix(in srgb,var(--fg) 6%,transparent)}
.nav-link:hover .icon{color:var(--fg)}
.nav-link[aria-current=page]{background:var(--panel);font-weight:500;box-shadow:var(--elev-1),inset 0 0 0 1px var(--line)}
.nav-link[aria-current=page] .icon{color:var(--accent)}
.sidebar-foot{border-top:1px solid var(--line);padding:.75rem .75rem 1rem;display:grid;gap:.6rem}
.sidebar-foot form{margin:0}
.who{display:flex;align-items:center;gap:.6rem;min-width:0;padding:0 .25rem}
.avatar{flex:none;width:1.9rem;height:1.9rem;display:grid;place-items:center;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:600;font-size:var(--text-sm)}
.who-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar{display:none;align-items:center;gap:.75rem;padding:.6rem 1rem;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);position:sticky;top:0;z-index:20}
.topbar.public{display:flex;padding:.75rem 1.5rem}
.menu-button{display:inline-grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:var(--radius-sm);border:1px solid var(--line-strong);background:var(--panel);color:var(--fg);cursor:pointer}
.drawer-toggle{display:none;position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.drawer-toggle:focus-visible~.topbar .menu-button{outline:2px solid var(--focus);outline-offset:2px}
.drawer-scrim{display:none}
@media (max-width:64rem){
body.app{display:block;background:var(--bg)}
body.app>.topbar{display:flex}
.drawer-toggle{display:block}
.sidebar{position:fixed;inset:0 auto 0 0;width:min(18rem,85vw);transform:translateX(-102%);visibility:hidden;transition:transform .22s cubic-bezier(.2,.7,.2,1),visibility 0s linear .22s;box-shadow:var(--elev-2)}
.sidebar-head{display:none}
.site-nav{padding-top:1rem}
.drawer-toggle:checked~.sidebar{transform:none;visibility:visible;transition:transform .22s cubic-bezier(.2,.7,.2,1),visibility 0s}
.drawer-toggle:checked~.drawer-scrim{display:block;position:fixed;inset:0;z-index:25;background:color-mix(in srgb,#000 40%,transparent)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.page-head{margin-bottom:1.5rem}
.page-desc{color:var(--muted);margin:.25rem 0 0;max-width:44rem}
.eyebrow{font-family:var(--mono);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:.6rem}
.hero{padding:1.5rem 0 1rem;max-width:44rem}
.hero h1{font-size:clamp(1.75rem,3.5vw,2.4rem);letter-spacing:-.03em}
.hero .lede{font-size:var(--text-lg);color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--elev-1);padding:1rem 1.5rem;margin:0 0 1rem}
.card>:last-child{margin-bottom:0}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.75rem}
.card-head h2{margin:0}
.card-foot{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:1rem -1.5rem -1rem;padding:.75rem 1.5rem;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 45%,var(--panel));border-radius:0 0 var(--radius-lg) var(--radius-lg)}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))}
.grid>.card{margin:0}
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;padding:.7rem 0;border-top:1px solid var(--line)}
.list>li:first-child{border-top:0;padding-top:0}
.list form{margin:0}
.list>li.empty{display:block}
.btn .icon,button .icon{width:1rem;height:1rem}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:2.1rem;padding:.35rem .9rem;font:500 var(--text-md)/1.2 var(--sans);color:var(--fg);background:var(--panel);border:1px solid var(--line-strong);border-radius:var(--radius-sm);box-shadow:var(--elev-1);cursor:pointer;text-decoration:none}
.btn:hover,button:hover{background:var(--surface);border-color:var(--input-border)}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover,button.primary:hover{background:color-mix(in srgb,var(--accent) 88%,var(--fg))}
.btn.danger,button.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line-strong))}
.btn.danger:hover,button.danger:hover{background:var(--danger);border-color:var(--danger);color:var(--danger-fg)}
.btn.ghost,button.ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--muted)}
.btn.block,button.block{width:100%}
.btn.small,button.small{min-height:1.75rem;padding:.2rem .6rem;font-size:var(--text-sm)}
.stack{display:grid;gap:.6rem}
label{display:grid;gap:.3rem;font-weight:500;font-size:var(--text-sm)}
.field{display:grid;gap:.3rem;margin-bottom:1rem;align-content:start}
.field .hint{color:var(--muted);font-size:var(--text-sm);font-weight:400}
.row{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))}
input:where([type=text],[type=password],[type=url]),select{width:100%;min-height:2.2rem;padding:.4rem .65rem;font:400 var(--text-md)/1.4 var(--sans);color:var(--fg);background:var(--panel);border:1px solid var(--line-strong);border-radius:var(--radius-sm)}
input:hover,select:hover{border-color:var(--input-border)}
input:focus-visible,select:focus-visible{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 25%,transparent)}
select{appearance:none;padding-right:2rem;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px;background-repeat:no-repeat}
.mono{font-family:var(--mono);font-size:var(--text-sm)}
textarea{width:100%;min-height:3.5rem;padding:.45rem .65rem;font:400 var(--text-sm)/1.5 var(--mono);color:var(--fg);background:var(--panel);border:1px solid var(--line-strong);border-radius:var(--radius-sm);resize:vertical}
input[type=checkbox]{accent-color:var(--accent);width:1rem;height:1rem;margin:0}
dl.kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;margin:0 0 .75rem;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
dl.kv>dt{padding:.5rem 1rem;color:var(--muted);font-size:var(--text-sm);border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 55%,var(--panel))}
dl.kv>dd{margin:0;padding:.5rem 1rem;border-top:1px solid var(--line);min-width:0}
dl.kv>dt:first-of-type,dl.kv>dt:first-of-type+dd{border-top:0}
.card-foot button{margin:0}
.pill{display:inline-flex;align-items:center;gap:.35rem;padding:.05rem .5rem;border-radius:999px;font-size:var(--text-xs);font-weight:500;border:1px solid var(--line);background:var(--surface);color:var(--muted);white-space:nowrap}
.pill::before{content:"";width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
.pill.ok{color:var(--ok);background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.pill.warn{color:var(--warn);background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.alert{padding:.7rem 1rem;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface);margin:0 0 1rem}
.alert.ok{background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.alert.error{background:var(--danger-soft);border-color:color-mix(in srgb,var(--danger) 35%,transparent)}
.alert.warn{background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.legal{max-width:46rem;line-height:1.7}
.legal table{border-collapse:collapse;font-size:var(--text-sm);margin:1rem 0;width:100%}
.legal th,.legal td{border:1px solid var(--line-strong);padding:.35rem .6rem;vertical-align:top;text-align:left}
.legal th{background:var(--surface)}
.site-footer{padding:1rem 1.5rem 1.5rem;color:var(--muted);font-size:var(--text-sm)}
.site-footer nav{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;max-width:60rem;margin:0 auto;padding-top:1rem;border-top:1px solid var(--line)}
.site-footer a{color:var(--muted);text-decoration:none}
.site-footer a:hover{color:var(--fg)}
@media (max-width:40rem){main{padding:1.25rem 1rem 2rem}}
`;

/** Changes with the stylesheet, so browsers never keep an old one (it is cached for a day). */
export const CSS_VERSION = createHash("sha256").update(CSS).digest("hex").slice(0, 10);

export type NavKey = "home" | "settings" | "account" | "privacy" | null;

/** Inline icons, drawn like the mcp-gateway portal's (strokes in currentColor, 24x24). */
const ICONS: Record<string, string> = {
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
  signout: `<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10"/>`,
  settings: `<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.5"/><circle cx="10" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/>`,
  machines: `<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>`,
  connections: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  audit: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 3l5 5h-5z"/><circle cx="16.5" cy="16.5" r="3"/><path d="M19 19l2.5 2.5"/>`,
  external: `<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>`,
  account: `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>`,
  home: `<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>`,
  brand: `<rect class="brand-tile" x="1" y="1" width="22" height="22" rx="6"/><path class="brand-mark" d="M6 9h4l1.5-2.5H17a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/>`,
};

function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ""}</svg>`;
}

export interface ShellOptions {
  readonly title: string;
  readonly body: string;
  readonly nav?: NavKey;
  /** Signed in: the sidebar shows who and a Sign out button (needs the CSRF token). */
  readonly signedIn?: { readonly csrf: string; readonly name?: string | null } | null;
  /** narrow: a centered single card with a slim top bar (sign-in, errors); legal: wide prose. */
  readonly layout?: "default" | "narrow" | "legal";
}

const BRAND = `<a class="brand" href="/">${icon("brand")}<span>TabCrew Online</span></a>`;

export function shell(o: ShellOptions): string {
  const title = o.title === "TabCrew Online" ? o.title : `${o.title} · TabCrew Online`;
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/tabcrew.css?v=${CSS_VERSION}"></head>`;
  const content = o.layout === "legal" ? `<div class="legal">${o.body}</div>` : o.body;
  const footer = `<footer class="site-footer"><nav aria-label="Footer"><a href="/privacy">Privacy</a><a href="${REPO}">Source code</a><a href="${REPO}/issues">Support</a><span>Not affiliated with Google.</span></nav></footer>`;
  if (o.layout === "narrow") {
    return `${head}<body><header class="topbar public">${BRAND}</header><main class="narrow">${content}</main>${footer}</body></html>`;
  }
  const link = (key: NavKey, href: string, name: string, label: string, external = false) =>
    `<a class="nav-link" href="${href}"${o.nav === key && key ? ' aria-current="page"' : ""}${external ? ' rel="noopener"' : ""}>${icon(name)}${label}</a>`;
  const who = o.signedIn
    ? `<div class="who"><span class="avatar" aria-hidden="true">${escapeHtml((o.signedIn.name ?? "?").trim().charAt(0).toUpperCase() || "?")}</span><span class="who-name">${escapeHtml(o.signedIn.name?.trim() || "Signed in")}</span></div>
<form method="post" action="/account/logout"><input type="hidden" name="csrf" value="${escapeHtml(o.signedIn.csrf)}"><button class="ghost small" type="submit">${icon("signout")}Sign out</button></form>`
    : `<a class="btn small block" href="/account">${icon("account")}Sign in</a>`;
  return `${head}<body class="app">
<input type="checkbox" id="nav-drawer" class="drawer-toggle" aria-label="Show navigation" aria-controls="sidebar">
<header class="topbar"><label for="nav-drawer" class="menu-button" title="Menu">${icon("menu")}<span class="sr-only">Menu</span></label>${BRAND}</header>
<aside class="sidebar" id="sidebar"><div class="sidebar-head">${BRAND}</div>
<nav class="site-nav" aria-label="Main">
<div class="nav-group">${link("home", "/", "home", "Home")}</div>
<div class="nav-group"><p class="nav-label">Your account</p>${link("settings", "/settings", "settings", "Model settings")}${link("account", "/account", "machines", "Browsers &amp; agents")}</div>
<div class="nav-group"><p class="nav-label">Help</p>${link("privacy", "/privacy", "audit", "Privacy")}${link(null, REPO, "external", "Source code", true)}${link(null, `${REPO}/issues`, "connections", "Support", true)}</div>
</nav>
<div class="sidebar-foot">${who}</div></aside>
<label for="nav-drawer" class="drawer-scrim" aria-hidden="true"></label>
<main>${content}</main>
${footer}
</body></html>`;
}

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
const FONT_FILES = new Set(["plex-sans-400.woff2", "plex-sans-500.woff2", "plex-sans-600.woff2", "plex-mono-400.woff2"]);
const fontCache = new Map<string, Buffer>();

/** /static/tabcrew.css and /static/fonts/<plex font>. True when handled. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.pathname.startsWith("/static/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  const headers = { "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" };
  if (url.pathname === "/static/tabcrew.css") {
    res.writeHead(200, { ...headers, "content-type": "text/css; charset=utf-8" }).end(req.method === "HEAD" ? undefined : CSS);
    return true;
  }
  const name = url.pathname.slice("/static/fonts/".length);
  if (url.pathname.startsWith("/static/fonts/") && FONT_FILES.has(name)) {
    let data = fontCache.get(name);
    if (!data) {
      data = readFileSync(join(STATIC_DIR, "fonts", name));
      fontCache.set(name, data);
    }
    res.writeHead(200, { ...headers, "content-type": "font/woff2" }).end(req.method === "HEAD" ? undefined : data);
    return true;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  return true;
}
