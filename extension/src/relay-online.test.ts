import { describe, expect, it, vi } from "vitest";
import type { V2ModelCall } from "@tabcrew/shared/v2";
import { OffscreenHost } from "./offscreen/host.js";
import { BridgeRelay, PAUSED_MESSAGE, type RelayDeps } from "./relay.js";
import { FakePort, FakeSocket, createPortPair, flush } from "./test/fakes.js";

const CALL: V2ModelCall = {
  type: "model_call",
  id: "m1",
  purpose: "chat_decision",
  body: { messages: [{ role: "user", content: "{}" }], max_tokens: 100, response_format: { type: "json_object" } },
  timeout_ms: 30_000,
};
const REQUEST = { type: "request", id: "r1", op: "tab_list", session: { short_id: "abcd1234", label: "a" }, args: {} };

function setup(overrides: Partial<RelayDeps> = {}) {
  const deps: RelayDeps = {
    loadConfig: async () => ({ token: "daemon-tok", port: 0, mode: "online", online: { url: "wss://tabcrew.huynle.com/ext", accessToken: "tca.a" } }),
    handleRequest: vi.fn(async () => ({ tabs: [] })),
    handleModelCall: vi.fn(async () => ({ ok: true as const, result: { status: 200, json: {}, model: "m" } })),
    onWelcome: vi.fn(),
    ensureOffscreen: vi.fn(async () => undefined),
    ...overrides,
  };
  const relay = new BridgeRelay(deps);
  const attach = async (): Promise<FakePort> => {
    const [offscreen, sw] = createPortPair("v2-bridge");
    relay.attach(sw);
    await flush();
    return offscreen;
  };
  return { relay, deps, attach };
}

describe("BridgeRelay online mode", () => {
  it("pushes the relay URL and access token, never the daemon token", async () => {
    const offscreen = await setup().attach();
    expect(offscreen.messages()).toEqual([
      { type: "config", token: null, port: 0, reconfigure: false, mode: "online", online: { url: "wss://tabcrew.huynle.com/ext", access_token: "tca.a", own_model: false } },
    ]);
  });

  it("passes on the browser's own-provider choice (own_model)", async () => {
    const online = { url: "wss://tabcrew.huynle.com/ext", accessToken: "tca.a", ownModel: true };
    const offscreen = await setup({ loadConfig: async () => ({ token: null, port: 0, mode: "online", online }) }).attach();
    expect(offscreen.messages()[0]).toMatchObject({ mode: "online", online: { url: online.url, access_token: "tca.a", own_model: true } });
  });

  it("pushes online: null when signed out", async () => {
    const offscreen = await setup({ loadConfig: async () => ({ token: null, port: 0, mode: "online", online: null }) }).attach();
    expect(offscreen.messages()[0]).toMatchObject({ mode: "online", online: null });
  });
});

describe("Pause agents", () => {
  it("refuses requests and model calls without running them", async () => {
    const { deps, attach } = setup({ isPaused: async () => true });
    const offscreen = await attach();
    offscreen.postMessage({ type: "status", status: "connected" });
    offscreen.postMessage({ type: "request", request: REQUEST });
    offscreen.postMessage({ type: "model_call", call: CALL });
    await flush();
    await flush();
    expect(deps.handleRequest).not.toHaveBeenCalled();
    expect(deps.handleModelCall).not.toHaveBeenCalled();
    const sent = offscreen.messages<Record<string, any>>();
    expect(sent.find((m) => m.type === "frame")?.frame).toMatchObject({ id: "r1", ok: false, error: { code: "stopped_by_user", message: PAUSED_MESSAGE } });
    expect(sent.find((m) => m.type === "model_result")?.result).toMatchObject({ id: "m1", ok: false, error: { code: "stopped_by_user" } });
  });

  it("fails closed when the setting cannot be read", async () => {
    const { deps, attach } = setup({
      isPaused: async () => {
        throw new Error("storage gone");
      },
    });
    const offscreen = await attach();
    offscreen.postMessage({ type: "request", request: REQUEST });
    await flush();
    await flush();
    expect(deps.handleRequest).not.toHaveBeenCalled();
  });

  it("runs requests normally when not paused", async () => {
    const { deps, attach } = setup({ isPaused: async () => false });
    const offscreen = await attach();
    offscreen.postMessage({ type: "request", request: REQUEST });
    await flush();
    await flush();
    expect(deps.handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("OffscreenHost online config", () => {
  function host() {
    const [sw, offscreen] = createPortPair("v2-bridge");
    const h = new OffscreenHost({ connect: () => offscreen, createSocket: (url) => new FakeSocket(url), extensionVersion: "0.6.0" });
    FakeSocket.instances = [];
    h.start();
    return { h, sw };
  }
  const config = (access: string, url = "wss://tabcrew.huynle.com/ext", reconfigure = false, own_model?: boolean) => ({
    type: "config",
    token: null,
    port: 0,
    reconfigure,
    mode: "online",
    online: { url, access_token: access, ...(own_model !== undefined && { own_model }) },
  });

  it("announces own_model in the hello when this browser uses its own provider", async () => {
    const { sw } = host();
    sw.postMessage(config("tca.1", undefined, false, true));
    await flush();
    const ws = FakeSocket.instances.at(-1)!;
    ws.serverOpen();
    expect(ws.frames()[0]!.features).toContain("own_model");
  });

  it("reconnects with a new hello when the own-provider choice changes", async () => {
    const { sw } = host();
    sw.postMessage(config("tca.1"));
    await flush();
    const first = FakeSocket.instances[0]!;
    first.serverOpen();
    expect(first.frames()[0]!.features).not.toContain("own_model");
    first.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    sw.postMessage(config("tca.1", undefined, false, true));
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.serverOpen();
    expect(second.frames()[0]!.features).toContain("own_model");
  });

  it("a rotated access token keeps the connection; a new relay reconnects", async () => {
    const { sw } = host();
    sw.postMessage(config("tca.1"));
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toBe("wss://tabcrew.huynle.com/ext");
    const first = FakeSocket.instances[0]!;
    first.serverOpen();
    first.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    sw.postMessage(config("tca.2"));
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(first.closed).toBeNull();
    sw.postMessage(config("tca.2", "ws://127.0.0.1:8790/ext"));
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toBe("ws://127.0.0.1:8790/ext");
  });

  it("reconfigure (after a refused token) reconnects with the new token", async () => {
    const { sw } = host();
    sw.postMessage(config("tca.1"));
    await flush();
    sw.postMessage(config("tca.2", undefined, true));
    await flush();
    const latest = FakeSocket.instances.at(-1)!;
    latest.serverOpen();
    expect(latest.frames()[0]!.token).toBe("tca.2");
  });
});
