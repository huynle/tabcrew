#!/usr/bin/env node
// Live check of a running relay (default http://127.0.0.1:8790) with a REAL sign-in provider.
// Prints two sign-in URLs to open in a browser (one as an MCP agent, one as the extension) and
// waits for each code:
//   - MCP: the relay redirects to this script's loopback callback (127.0.0.1:8791).
//   - extension: the relay redirects to https://<dev id>.chromiumapp.org/cb?code=..., which a normal
//     tab cannot load; POST that final URL to http://127.0.0.1:8791/ext (curl -d "$URL").
// Then it connects to /ext as a stand-in extension and checks MCP tool calls reach it.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { WebSocket } = require("ws");

const RELAY = (process.env.RELAY_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const PROVIDER = process.env.PROVIDER ?? "github";
const EXT_ID = "aejgcpbbemekfbmmkabpbgdkgmddfamo";
const EXT_REDIRECT = `https://${EXT_ID}.chromiumapp.org/cb`;
const CALLBACK = "http://127.0.0.1:8791/callback";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authUrl = (clientId, redirect, challenge, state, extra = {}) =>
  `${RELAY}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, ...extra })}`;
const token = async (form) => {
  const r = await fetch(`${RELAY}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return { status: r.status, json: await r.json() };
};

// One local server catches both codes.
const waiters = { mcp: null, ext: null };
const got = { mcp: new Promise((r) => (waiters.mcp = r)), ext: new Promise((r) => (waiters.ext = r)) };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8791");
  if (url.pathname === "/callback") {
    res.writeHead(200, { "content-type": "text/plain" }).end("TabCrew live check: signed in, you can close this tab.");
    waiters.mcp(url);
    return;
  }
  if (url.pathname === "/ext" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok\n");
      waiters.ext(new URL(body.trim()));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(8791, "127.0.0.1", r));

const meta = await (await fetch(`${RELAY}/.well-known/oauth-authorization-server`)).json();
check("relay serves authorization server metadata", meta.issuer === RELAY, meta.issuer);

// 1. MCP agent
const reg = await (await fetch(`${RELAY}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "TabCrew live check", redirect_uris: [CALLBACK] }) })).json();
check("dynamic client registration", typeof reg.client_id === "string");
const a = pkce();
console.log(`OPEN_MCP ${authUrl(reg.client_id, CALLBACK, a.challenge, "mcp-state")}`);
const mcpBack = await got.mcp;
check(`MCP sign-in through ${PROVIDER} returned a code and our state`, !!mcpBack.searchParams.get("code") && mcpBack.searchParams.get("state") === "mcp-state", mcpBack.searchParams.get("error") ?? "");
const mcpTok = await token({ grant_type: "authorization_code", code: mcpBack.searchParams.get("code"), client_id: reg.client_id, redirect_uri: CALLBACK, code_verifier: a.verifier });
check("MCP token exchange", mcpTok.status === 200, mcpTok.status === 200 ? "" : JSON.stringify(mcpTok.json));
const refreshed = await token({ grant_type: "refresh_token", refresh_token: mcpTok.json.refresh_token, client_id: reg.client_id });
check("refresh rotates", refreshed.status === 200 && refreshed.json.refresh_token !== mcpTok.json.refresh_token);
const access = refreshed.json.access_token;

// 2. extension
const b = pkce();
console.log(`OPEN_EXT ${authUrl("tabcrew-extension", EXT_REDIRECT, b.challenge, "ext-state", { browser_name: "live-check" })}`);
const extBack = await got.ext;
check("extension sign-in redirected to the dev ID's chromiumapp.org URL", `${extBack.origin}${extBack.pathname}` === EXT_REDIRECT && extBack.searchParams.get("state") === "ext-state");
const extTok = await token({ grant_type: "authorization_code", code: extBack.searchParams.get("code"), client_id: "tabcrew-extension", redirect_uri: EXT_REDIRECT, code_verifier: b.verifier });
check("extension token exchange gives a browser id", extTok.status === 200 && /^b_/.test(extTok.json.browser_id ?? ""));

// 3. stand-in extension on /ext
const ops = [];
const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/ext`, { headers: { origin: `chrome-extension://${EXT_ID}` } });
const welcome = await new Promise((resolve, reject) => {
  ws.once("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 2, token: extTok.json.access_token, extension_version: "live-check", features: [] })));
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    if (f.type === "welcome") return resolve(f);
    if (f.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: f.t }));
    if (f.type === "request") {
      ops.push(f.op);
      const result = f.op === "tab_create" ? { tab_id: 7, url: f.args.url ?? "about:blank", title: "" } : f.op === "tab_list" ? { tabs: [{ tab_id: 7, url: "https://example.com/", title: "" }] } : {};
      ws.send(JSON.stringify({ type: "response", id: f.id, ok: true, result }));
    }
  });
  ws.once("close", (code) => reject(new Error(`ext socket closed ${code}`)));
  ws.once("unexpected-response", (_q, res) => reject(new Error(`ext upgrade ${res.statusCode}`)));
});
check("relay welcomed the extension", welcome.protocol === 2);

const client = new Client({ name: "live-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${RELAY}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
const callTool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, value: JSON.parse(r.content.find((c) => c.type === "text").text) };
};
const tools = await client.listTools();
check("MCP tools listed over the relay", tools.tools.some((t) => t.name === "browse"), `${tools.tools.length} tools`);
const s = await callTool("session_open", { label: "live-check" });
const tab = await callTool("tab_create", { session: s.value.session, url: "https://example.com/" });
check("tab_create reached the signed-in browser", !tab.isError && ops.includes("tab_create"), JSON.stringify(tab.value).slice(0, 80));
const closed = await callTool("session_close", { session: s.value.session, tabs: "keep" });
check("session_close", !closed.isError);

const bad = await fetch(`${RELAY}/mcp`, { method: "POST", headers: { authorization: `Bearer ${extTok.json.access_token}` }, body: "{}" });
check("extension token refused on /mcp", bad.status === 401);

await client.close();
ws.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall live relay checks passed");
process.exit(failed ? 1 : 0);
