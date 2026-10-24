import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "@tabcrew/daemon/dist/log.js";
import { FakeExtension } from "../../daemon/src/testing/helpers.js";
import { EXT_ORIGIN, extLogin, mcpClient, mcpLogin, startTestRelay, type FakeUser, type TestRelay } from "./testing/harness.js";

const ALICE: FakeUser = { id: "1001", login: "alice", email: "alice@example.com", name: "Alice" };

let t: TestRelay;
const cleanups: (() => unknown)[] = [];
const lines: string[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await t.close();
  setLogSink(null);
  lines.length = 0;
});

async function setup() {
  setLogSink((level, line) => lines.push(`${level} ${line}`));
  t = await startTestRelay({ slowCallMs: 100 });
  const tok = await extLogin(t, ALICE, "home-mac");
  const ext = await FakeExtension.connect(t.port, tok.access_token, {}, { origin: EXT_ORIGIN, path: "/ext" });
  cleanups.push(() => ext.close());
  const { access_token } = await mcpLogin(t, ALICE);
  return { ext, access_token };
}

const json = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe("slow and lost MCP replies are logged", () => {
  it("logs a tool call slower than slowCallMs, by tool, short id and browser, never the handle", async () => {
    const { ext, access_token } = await setup();
    const client = await mcpClient(t.url, access_token);
    cleanups.push(() => client.close());
    const s = json((await client.callTool({ name: "session_open", arguments: {} })) as CallToolResult);
    const simulate = ext.handler;
    ext.handler = async (req) => {
      if (req.op === "tab_create") await new Promise((r) => setTimeout(r, 250));
      return simulate(req);
    };
    await client.callTool({ name: "tab_create", arguments: { session: s.session } });
    const slow = lines.filter((l) => l.includes("slow tool call"));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatch(/^info relay: slow tool call tab_create \d+ ms \(session [\w-]{8}, browser home-mac\)/);
    expect(slow[0]).not.toContain(s.session);
  });

  it("logs a tool call whose HTTP reply was cut off before it was sent", async () => {
    const { ext, access_token } = await setup();
    const headers: Record<string, string> = {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const post = (body: unknown, signal?: AbortSignal) => fetch(`${t.url}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal });
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
    await init.text();
    await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
    const opened = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_open", arguments: {} } })).text();
    const session = /"session\\":\\"([^\\]+)\\"/.exec(opened)![1];
    const simulate = ext.handler;
    ext.handler = async (req) => {
      if (req.op === "tab_list") await new Promise((r) => setTimeout(r, 400));
      return simulate(req);
    };
    const abort = new AbortController();
    const call = post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tab_list", arguments: { session } } }, abort.signal).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await call;
    await new Promise((r) => setTimeout(r, 600));
    expect(lines.some((l) => /^warn relay: MCP reply cut off after \d+ ms \(tools\/call tab_list\)/.test(l))).toBe(true);
    expect(lines.join("\n")).not.toContain(session);
  });
});

describe("keep-alive behind a reverse proxy", () => {
  it("keeps idle connections open longer than Traefik's 90 s backend idle timeout", async () => {
    t = await startTestRelay();
    // Node's default (5 s) closes a pooled proxy connection just as the proxy reuses it,
    // and that request is lost (seen through Traefik as "MCP reply cut off after 3 ms").
    expect(t.relay.keepAliveTimeoutMs).toBeGreaterThan(90_000);
    expect(t.relay.headersTimeoutMs).toBeGreaterThan(t.relay.keepAliveTimeoutMs);
  });
});

describe("MCP replies are plain JSON", () => {
  it("answers a POST with application/json and a Content-Length, not an event stream", async () => {
    const { access_token } = await setup();
    const headers: Record<string, string> = { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(`${t.url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }) });
    expect(init.headers.get("content-type")).toContain("application/json");
    headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
    expect((await init.json()).result.serverInfo.name).toBe("tabcrew");
    const res = await fetch(`${t.url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_list", arguments: {} } }) });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect((await res.json()).result.content[0].text).toContain("home-mac");
  });
});
