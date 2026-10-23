import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge, type BridgeDeps } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { FakeSocket } from "./test/fakes.js";

const MODEL_CALL = {
  type: "model_call",
  id: "m1",
  purpose: "chat_decision",
  body: { messages: [{ role: "user", content: "{}" }], max_tokens: 100, response_format: { type: "json_object" } },
  timeout_ms: 30_000,
};

function onlineConfig(accessToken = "tca.access-1", url = "wss://tabcrew.huynle.com/ext"): BridgeConfig {
  return { token: "daemon-token", port: 0, mode: "online", online: { url, accessToken } };
}

function makeBridge(config: { current: BridgeConfig }, overrides: Partial<BridgeDeps> = {}) {
  const deps = {
    loadConfig: async () => config.current,
    createSocket: (url: string) => new FakeSocket(url),
    extensionVersion: "0.6.0",
    onRequest: vi.fn(),
    onWelcome: vi.fn(),
    onModelCall: vi.fn(),
    onStatus: vi.fn(),
    ...overrides,
  } satisfies BridgeDeps;
  return { bridge: new Bridge(deps), deps };
}

async function opened(bridge: Bridge): Promise<FakeSocket> {
  await bridge.start();
  const ws = FakeSocket.instances.at(-1)!;
  ws.serverOpen();
  return ws;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Bridge online mode", () => {
  it("dials the relay URL and sends the access token (never the daemon token) in hello", async () => {
    const { bridge } = makeBridge({ current: onlineConfig() });
    const ws = await opened(bridge);
    expect(ws.url).toBe("wss://tabcrew.huynle.com/ext");
    const hello = ws.frames()[0]!;
    expect(hello).toMatchObject({ type: "hello", protocol: 2, token: "tca.access-1", extension_version: "0.6.0" });
    expect(hello.features).toEqual(expect.arrayContaining(["model_call", "groups"]));
    expect(hello.mode).toBeUndefined();
    expect(JSON.stringify(ws.frames())).not.toContain("daemon-token");
  });

  it("is connected after welcome and handles requests and model calls", async () => {
    const { bridge, deps } = makeBridge({ current: onlineConfig() });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], features: [] });
    expect(bridge.status).toBe("connected");
    ws.serverSend({ type: "request", id: "r1", op: "tab_list", session: { short_id: "abcd1234", label: "a" }, args: {} });
    expect(deps.onRequest).toHaveBeenCalledTimes(1);
    ws.serverSend(MODEL_CALL);
    expect(deps.onModelCall).toHaveBeenCalledTimes(1);
  });

  it("without a signed-in account it does not connect and reports signed_out", async () => {
    const { bridge } = makeBridge({ current: { token: null, port: 0, mode: "online", online: null } });
    await bridge.start();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(bridge.status).toBe("signed_out");
  });

  it("a 4401 (expired or revoked token) stops retries until a new token arrives", async () => {
    const config = { current: onlineConfig("tca.old") };
    const { bridge } = makeBridge(config);
    const ws = await opened(bridge);
    ws.onclose?.({ code: 4401 });
    expect(bridge.status).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    config.current = onlineConfig("tca.new");
    await bridge.reconfigure();
    const next = FakeSocket.instances.at(-1)!;
    next.serverOpen();
    expect(next.frames()[0]!.token).toBe("tca.new");
  });

  it("an ordinary drop reconnects with backoff", async () => {
    const { bridge } = makeBridge({ current: onlineConfig() });
    const ws = await opened(bridge);
    ws.onclose?.({ code: 1006 });
    expect(bridge.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("daemon mode still refuses model calls", async () => {
    const { bridge, deps } = makeBridge({ current: { token: "t", port: 8771, mode: "daemon" } });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    ws.serverSend(MODEL_CALL);
    expect(deps.onModelCall).not.toHaveBeenCalled();
  });
});
