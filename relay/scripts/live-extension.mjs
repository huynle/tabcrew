#!/usr/bin/env node
// Live check: an MCP agent drives the REAL TabCrew extension through a running relay.
//   node live-extension.mjs login   prints a sign-in URL, waits for the loopback callback and keeps
//                                   the agent's refresh token in a 0600 file (TABCREW_LIVE_TOKEN_FILE)
//   node live-extension.mjs run     refreshes, then runs real tool calls in the signed-in browser
// The extension must be in Online mode and signed in to the same relay and account.
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const RELAY = (process.env.RELAY_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const FILE = process.env.TABCREW_LIVE_TOKEN_FILE ?? join(tmpdir(), "tabcrew-live-agent.json");
const CALLBACK = "http://127.0.0.1:8791/callback";

const form = async (body) => {
  const r = await fetch(`${RELAY}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  return { status: r.status, json: await r.json() };
};

if (process.argv[2] === "login") {
  const reg = await (await fetch(`${RELAY}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "TabCrew live extension check", redirect_uris: [CALLBACK] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s" });
  const code = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, CALLBACK);
      res.end("Signed in. You can close this tab.");
      server.close();
      resolve(u.searchParams.get("code"));
    }).listen(8791, "127.0.0.1", () => console.log(`OPEN ${RELAY}/authorize?${q}`));
  });
  const tok = await form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: CALLBACK, code_verifier: verifier });
  if (tok.status !== 200) throw new Error(`token: ${JSON.stringify(tok.json)}`);
  writeFileSync(FILE, JSON.stringify({ client_id: reg.client_id, refresh_token: tok.json.refresh_token }), { mode: 0o600 });
  console.log(`saved agent sign-in to ${FILE}`);
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const saved = JSON.parse(readFileSync(FILE, "utf8"));
const tok = await form({ grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id });
check("agent refresh", tok.status === 200, tok.status === 200 ? "" : JSON.stringify(tok.json));
writeFileSync(FILE, JSON.stringify({ ...saved, refresh_token: tok.json.refresh_token }), { mode: 0o600 });

const client = new Client({ name: "live-extension", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${RELAY}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.json.access_token}` } } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text");
  return { isError: !!r.isError, value: text ? JSON.parse(text.text) : null, raw: r };
};

const s = await call("session_open", { label: "online live check" });
check("session_open", !s.isError);
const S = s.value.session;
const tab = await call("tab_create", { session: S });
check("tab_create in the real browser", !tab.isError, tab.isError ? JSON.stringify(tab.value) : `tab ${tab.value.tab_id}`);
const id = tab.value?.tab_id;
const nav = await call("navigate", { session: S, tab_id: id, url: "https://example.com/" });
check("navigate (waits for the load)", !nav.isError, nav.isError ? JSON.stringify(nav.value) : nav.value?.url);
const obs = await call("observe", { session: S, tab_id: id });
check("observe sees Example Domain", !obs.isError && /Example Domain/.test(`${obs.value?.title} ${obs.value?.text}`), JSON.stringify(obs.value).slice(0, 120));
const text = await call("read_text", { session: S, tab_id: id });
check("read_text", !text.isError && /documentation examples/i.test(text.value?.text ?? ""), JSON.stringify(text.value).slice(0, 120));
const shot = await client.callTool({ name: "screenshot", arguments: { session: S, tab_id: id } });
check("screenshot comes back through the relay", !shot.isError && shot.content.some((c) => c.type === "image"));
const list = await call("tab_list", { session: S });
check("tab_list scoped to the session", !list.isError && list.value.tabs.length === 1);
const closed = await call("session_close", { session: S, tabs: "close" });
check("session_close (tabs closed)", !closed.isError, JSON.stringify(closed.value).slice(0, 80));
await client.close();

if (process.argv[2] === "run-and-forget" && !failed) rmSync(FILE, { force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall live extension checks passed");
process.exit(failed ? 1 : 0);
