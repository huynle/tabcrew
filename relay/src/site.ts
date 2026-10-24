/**
 * Public pages: the home page (/) and the privacy policy (/privacy, rendered from
 * docs/privacy.md). Google's OAuth consent screen links to both.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, sendHtml } from "./http.js";
import { PRIVACY_HTML } from "./privacy.generated.js";

const REPO = "https://github.com/huynle/tabcrew";

export function sitePage(req: IncomingMessage, res: ServerResponse, url: URL, publicUrl: string): boolean {
  if (url.pathname !== "/" && url.pathname !== "/privacy") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  const html = url.pathname === "/" ? layout("TabCrew Online", home(publicUrl)) : layout("TabCrew privacy policy", PRIVACY_HTML, true);
  sendHtml(res, 200, req.method === "HEAD" ? "" : html, { headers: { "cache-control": "public, max-age=300" } });
  return true;
}

function home(publicUrl: string): string {
  const mcp = escapeHtml(`${publicUrl}/mcp`);
  return `<p>TabCrew lets AI agents use your real browser, each in its own isolated tabs. <b>TabCrew Online</b> connects your browsers to this relay, so agents anywhere (any MCP client, or an MCP gateway) can use every browser you signed in, from one address.</p>
<h2>Get started</h2>
<ol>
<li>Install the TabCrew extension (<a href="${REPO}#install">instructions</a>).</li>
<li>In its popup, set <b>Connection</b> to <b>Online</b>, name the browser and sign in with GitHub or Google.</li>
<li>Add the MCP server <code>${mcp}</code> (OAuth) to your agent, and sign in with the same account.</li>
</ol>
<p>Your account page lists your browsers and agents, with Revoke buttons.</p>
<p><a class="btn" href="/account">Your account</a></p>
<p class="small"><a href="/privacy">Privacy policy</a> · <a href="${REPO}">Source code</a> · <a href="${REPO}/issues">Support</a></p>
<p class="small">TabCrew is an independent open-source project, not affiliated with Google.</p>`;
}

function layout(title: string, body: string, document = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:${document ? "46rem" : "34rem"};margin:3rem auto;padding:0 1rem;color:#1d1d1f}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:1.8rem}h3{font-size:1rem}code{font-size:.9em;background:#f2f2f2;padding:.1em .3em;border-radius:.25em}
table{border-collapse:collapse;font-size:.9rem;margin:1rem 0}th,td{border:1px solid #ddd;padding:.4rem .5rem;vertical-align:top;text-align:left}
.btn{display:inline-block;padding:.6rem 1rem;border:1px solid #888;border-radius:.5rem;color:inherit;text-decoration:none}
.small{font-size:.85rem;color:#666}a{color:#0b57d0}</style></head>
<body>${document ? "" : `<h1>${escapeHtml(title)}</h1>`}${body}</body></html>`;
}
