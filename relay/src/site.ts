/**
 * Public pages: the home page (/) and the privacy policy (/privacy, rendered from
 * docs/privacy.md). Google's OAuth consent screen links to both.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, sendHtml } from "./http.js";
import { PRIVACY_HTML } from "./privacy.generated.js";
import { shell } from "./ui.js";

const REPO = "https://github.com/huynle/tabcrew";

export function sitePage(req: IncomingMessage, res: ServerResponse, url: URL, publicUrl: string): boolean {
  if (url.pathname !== "/" && url.pathname !== "/privacy") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  const html =
    url.pathname === "/"
      ? shell({ title: "TabCrew Online", nav: "home", body: home(publicUrl) })
      : shell({ title: "TabCrew privacy policy", layout: "legal", body: PRIVACY_HTML });
  sendHtml(res, 200, req.method === "HEAD" ? "" : html, { headers: { "cache-control": "public, max-age=300" } });
  return true;
}

function home(publicUrl: string): string {
  const mcp = escapeHtml(`${publicUrl}/mcp`);
  return `<section class="hero"><p class="eyebrow">TabCrew Online</p>
<h1>Your browsers, for your agents, from anywhere.</h1>
<p class="lede">TabCrew lets AI agents use your real browser, each in its own isolated tabs. TabCrew Online connects all your browsers to one address, so any MCP client or MCP gateway can use them.</p>
<p><a class="btn primary" href="/settings">Set up models</a> <a class="btn" href="/account">Browsers &amp; agents</a></p></section>
<div class="grid">
<div class="card"><h2>1. Connect a browser</h2><p>Install the TabCrew extension (<a href="${REPO}#install">instructions</a>). In its popup, set <b>Connection</b> to <b>Online</b>, name the browser and sign in with GitHub or Google.</p></div>
<div class="card"><h2>2. Add your agents</h2><p>Add the MCP server <code>${mcp}</code> with OAuth to your agent or gateway, and sign in with the same account.</p></div>
<div class="card"><h2>3. Pick your models</h2><p>Set one model provider, key and models for <code>browse</code> on <a href="/settings">Model settings</a>. Every connected browser uses them.</p></div>
</div>`;
}
