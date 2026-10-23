import type { AddressInfo } from "node:net";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createCore, type TabcrewCore } from "./core.js";
import { Limiter, type JevRuntime } from "./jev/browse.js";
import { callTool } from "./mcp/tools.js";
import { FakeExtension, until } from "./testing/helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function jevRuntime(): JevRuntime {
  return { settings: { jevModel: "test/jev", textModel: "test/text" }, limiter: new Limiter(1) } as JevRuntime;
}

/** A core with a relay bridge, plus a front server that attaches extension sockets to it. */
async function relayCore(opts: { idleTimeoutMs?: number; modelViaExtension?: boolean } = {}) {
  const core = createCore({
    bridge: { auth: { kind: "relay" }, offlineWaitMs: 300, pingIntervalMs: 60_000 },
    jev: jevRuntime(),
    modelViaExtension: opts.modelViaExtension,
    idleTimeoutMs: opts.idleTimeoutMs ?? 0,
  });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket: WebSocket) => {
    socket.once("message", (data) => core.bridge.attach(socket, JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  cleanups.push(
    () => new Promise<void>((resolve) => wss.close(() => resolve())),
    () => core.close(),
  );
  const ext = await FakeExtension.connect((wss.address() as AddressInfo).port, "relay-access-token");
  await until(() => core.bridge.connected);
  return { core, ext };
}

async function tool(core: TabcrewCore, name: string, args: Record<string, unknown> = {}) {
  const result = (await callTool(core.ctx, name, args)) as CallToolResult;
  const text = result.content.find((c) => c.type === "text");
  return { isError: !!result.isError, value: text && text.type === "text" ? JSON.parse(text.text) : undefined };
}

describe("createCore", () => {
  it("serves the tools with no home, token or port: sessions live in memory", async () => {
    const { core, ext } = await relayCore();
    const opened = await tool(core, "session_open", { label: "agent" });
    expect(opened.isError).toBe(false);
    const handle = opened.value.session as string;
    const created = await tool(core, "tab_create", { session: handle, url: "https://example.com" });
    expect(created.isError).toBe(false);
    const listed = await tool(core, "tab_list", { session: handle });
    expect(listed.value.tabs).toHaveLength(1);
    expect(core.registry.size).toBe(1);
    expect(ext.requests.map((r) => r.op)).toContain("tab_create");
  });

  it("routes browse model calls through the extension only when asked to", async () => {
    const plain = await relayCore();
    expect(plain.core.jev.transport).toBeUndefined();
    const viaExt = await relayCore({ modelViaExtension: true });
    expect(viaExt.core.jev.transport).toBeDefined();
  });

  it("applies extension events to the registry (stop)", async () => {
    const { core, ext } = await relayCore();
    const opened = await tool(core, "session_open", {});
    const [session] = core.registry.refs();
    ext.send({ type: "event", event: "stop", short_id: session!.short_id });
    await until(() => core.registry.getByShortId(session!.short_id)?.stopped === true);
    const after = await tool(core, "tab_list", { session: opened.value.session });
    expect(after.isError).toBe(true);
    expect(after.value.code).toBe("stopped_by_user");
  });

  it("sweepIdle ends sessions past the idle timeout", async () => {
    const { core } = await relayCore({ idleTimeoutMs: 1 });
    await tool(core, "session_open", {});
    expect(core.registry.size).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    await core.sweepIdle();
    expect(core.registry.size).toBe(0);
  });

  it("close() disconnects the extension", async () => {
    const { core, ext } = await relayCore();
    await core.close();
    await ext.closed;
    expect(core.bridge.connected).toBe(false);
  });
});
