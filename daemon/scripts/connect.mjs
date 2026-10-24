// Shared MCP connection for the live scripts (not a check itself; the other scripts import it).
//
// TABCREW_TRANSPORT selects how a script reaches TabCrew:
//   http (default)  the launchd daemon: streamable HTTP on 127.0.0.1:$TABCREW_MCP_PORT (8770),
//                   bearer token from $TABCREW_HOME/token (~/.tabcrew/token).
//   shim            hub mode: runs `node cli/dist/cli.mjs mcp` (stdio), exactly what OpenCode runs. It
//                   connects to the running hub or starts one. No token; nothing is read from ~/.tabcrew.
//                   Extra shim arguments go in TABCREW_SHIM_ARGS, e.g. "--port 9000" (they only apply
//                   when the shim starts the hub).
//   relay           TabCrew Online: streamable HTTP to $RELAY_URL/mcp (default https://tabcrew.huynle.com),
//                   signed in as the agent saved by `node relay/scripts/live-extension.mjs login`
//                   ($TABCREW_LIVE_TOKEN_FILE). The browser must be in Online mode and signed in.
// Every connect() is its own MCP connection; in shim mode that is its own shim process.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const SHIM_CLI = fileURLToPath(new URL("../../cli/dist/cli.mjs", import.meta.url));
const MODES = ["http", "shim", "relay"];

/** "http" or "shim"; exits with code 2 on anything else. `override` wins over TABCREW_TRANSPORT. */
export function transportMode(override) {
  const mode = (override ?? process.env.TABCREW_TRANSPORT ?? "").trim().toLowerCase() || "http";
  if (!MODES.includes(mode)) {
    console.error(`TABCREW_TRANSPORT must be ${MODES.join(" or ")} (got ${JSON.stringify(mode)})`);
    process.exit(2);
  }
  return mode;
}

const httpPort = () => process.env.TABCREW_MCP_PORT ?? process.env.CHROMEUSE_MCP_PORT ?? "8770";
const shimArgs = () => (process.env.TABCREW_SHIM_ARGS ?? "").split(/\s+/).filter(Boolean);

function httpTransport() {
  const home = process.env.TABCREW_HOME ?? process.env.CHROMEUSE_HOME ?? join(homedir(), ".tabcrew");
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort()}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const relayUrl = () => (process.env.RELAY_URL ?? "https://tabcrew.huynle.com").replace(/\/$/, "");
let relayAccess = null;

/** An access token for the saved agent sign-in; refreshes (and saves the rotated token) once per process. */
async function relayToken() {
  if (relayAccess) return relayAccess;
  const file = process.env.TABCREW_LIVE_TOKEN_FILE ?? join(tmpdir(), "tabcrew-live-agent.json");
  if (!existsSync(file)) {
    console.error(`${file} is missing; sign an agent in first: RELAY_URL=${relayUrl()} node relay/scripts/live-extension.mjs login`);
    process.exit(2);
  }
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(`${relayUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    console.error(`relay refresh failed (${res.status} ${json.error ?? ""}); sign in again with live-extension.mjs login`);
    process.exit(2);
  }
  writeFileSync(file, JSON.stringify({ ...saved, refresh_token: json.refresh_token }), { mode: 0o600 });
  relayAccess = json.access_token;
  return relayAccess;
}

async function relayTransport() {
  const token = await relayToken();
  return new StreamableHTTPClientTransport(new URL(`${relayUrl()}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
}

function shimTransport() {
  if (!existsSync(SHIM_CLI)) {
    console.error(`${SHIM_CLI} is missing; build it first: npm run build`);
    process.exit(2);
  }
  // stderr is inherited: the shim's own diagnostics (hub start failures, version warnings) show up here.
  return new StdioClientTransport({ command: process.execPath, args: [SHIM_CLI, "mcp", ...shimArgs()], env: { ...process.env } });
}

/** One line for the script output, e.g. "transport: shim (node .../cli/dist/cli.mjs mcp)". */
export function describeTransport(override) {
  if (transportMode(override) === "relay") return `transport: relay (${relayUrl()}/mcp, saved agent sign-in)`;
  if (transportMode(override) === "shim") return `transport: shim (node ${[SHIM_CLI, "mcp", ...shimArgs()].join(" ")})`;
  return `transport: http (127.0.0.1:${httpPort()}, daemon token)`;
}

/** A connected MCP client over the selected transport (one new connection per call). */
export async function connect(name, override) {
  const mode = transportMode(override);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(mode === "shim" ? shimTransport() : mode === "relay" ? await relayTransport() : httpTransport());
  return client;
}
