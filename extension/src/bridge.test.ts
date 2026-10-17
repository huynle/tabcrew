import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Request, V2Response } from "@tabcrew/shared/v2";
import { Bridge, type BridgeDeps } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { FakeSocket, flush } from "./test/fakes.js";

const session = { short_id: "abcd1234", label: "agent" };

function makeBridge(config: { current: BridgeConfig }, overrides: Partial<BridgeDeps> = {}) {
  const deps: BridgeDeps = {
    loadConfig: async () => config.current,
    createSocket: (url) => new FakeSocket(url),
    extensionVersion: "0.3.0",
    onRequest: vi.fn(),
    onWelcome: vi.fn(),
    onPing: vi.fn(),
    ...overrides,
  };
  return { bridge: new Bridge(deps), deps };
}

function request(id: string, op: V2Request["op"] = "tab_list", args: object = {}): V2Request {
  return { type: "request", id, op, session, args } as V2Request;
}

async function connected(bridge: Bridge): Promise<FakeSocket> {
  await bridge.start();
  const ws = FakeSocket.instances.at(-1)!;
  ws.serverOpen();
  ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
  await flush();
  return ws;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Bridge", () => {
  it("sends hello with the token as the first frame", async () => {
    const { bridge } = makeBridge({ current: { token: "secret-token", port: 8771 } });
    await bridge.start();
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:8771");
    expect(bridge.status).toBe("connecting");
    ws.serverOpen();
    expect(ws.frames()[0]).toEqual({ type: "hello", protocol: 2, token: "secret-token", extension_version: "0.3.0" });
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    expect(bridge.status).toBe("connected");
  });

  it("uses the configured port", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 9999 } });
    await bridge.start();
    expect(FakeSocket.instances[0]!.url).toBe("ws://127.0.0.1:9999");
  });

  it("does not connect without a token", async () => {
    const { bridge } = makeBridge({ current: { token: null, port: 8771 } });
    await bridge.start();
    await bridge.ensureConnected();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(bridge.status).toBe("needs_token");
  });

  it("stops retrying after 4401 until the token changes", async () => {
    const config = { current: { token: "wrong", port: 8771 } as BridgeConfig };
    const { bridge } = makeBridge(config);
    await bridge.start();
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverClose(4401);
    expect(bridge.status).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(120_000);
    await bridge.ensureConnected(); // the keepalive alarm
    expect(FakeSocket.instances).toHaveLength(1);
    expect(bridge.status).toBe("unauthorized");

    config.current = { token: "right", port: 8771 };
    await bridge.reconfigure();
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverOpen();
    expect(FakeSocket.instances[1]!.frames()[0]).toMatchObject({ type: "hello", token: "right" });
  });

  it("reconnects with capped exponential backoff after a normal close", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    await bridge.start();
    FakeSocket.instances[0]!.serverClose(1006);
    expect(bridge.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    // second failure waits 2 s
    FakeSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
    // many failures: never more than 30 s
    for (let i = 0; i < 10; i++) {
      FakeSocket.instances.at(-1)!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(FakeSocket.instances).toHaveLength(13);
  });

  it("replies pong to ping itself, then notifies onPing", async () => {
    const { bridge, deps } = makeBridge({ current: { token: "t", port: 8771 } });
    const ws = await connected(bridge);
    ws.serverSend({ type: "ping", t: 42 });
    expect(ws.frames().at(-1)).toEqual({ type: "pong", t: 42 });
    expect(deps.onPing).toHaveBeenCalledTimes(1);
    expect(deps.onRequest).not.toHaveBeenCalled();
  });

  it("calls onWelcome after welcome", async () => {
    const { bridge, deps } = makeBridge({ current: { token: "t", port: 8771 } });
    await connected(bridge);
    expect(deps.onWelcome).toHaveBeenCalledWith({ type: "welcome", protocol: 2, sessions: [] });
  });

  it("forwards requests without waiting and writes each response by id", async () => {
    const forwarded: string[] = [];
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } }, { onRequest: (req) => void forwarded.push(req.id) });
    const ws = await connected(bridge);
    ws.serverSend(request("r1"));
    ws.serverSend(request("r2"));
    expect(forwarded).toEqual(["r1", "r2"]);

    expect(bridge.sendResponse({ type: "response", id: "r2", ok: true, result: { tabs: [] } } as V2Response)).toBe(true);
    expect(bridge.sendResponse({ type: "response", id: "r1", ok: false, error: { code: "internal", message: "boom" } })).toBe(true);
    expect(ws.frames().filter((f) => f.type === "response")).toEqual([
      { type: "response", id: "r2", ok: true, result: { tabs: [] } },
      { type: "response", id: "r1", ok: false, error: { code: "internal", message: "boom" } },
    ]);
  });

  it("answers each request once, and only on the socket it arrived on", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    const ws = await connected(bridge);
    ws.serverSend(request("r1"));
    ws.serverSend(request("r2"));
    const ok = (id: string) => ({ type: "response", id, ok: true, result: {} }) as V2Response;
    expect(bridge.sendResponse(ok("r1"))).toBe(true);
    expect(bridge.sendResponse(ok("r1"))).toBe(false);
    expect(bridge.sendResponse(ok("never-asked"))).toBe(false);

    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = FakeSocket.instances.at(-1)!;
    ws2.serverOpen();
    ws2.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    expect(bridge.sendResponse(ok("r2"))).toBe(false); // r2 belonged to the closed socket
    expect(ws2.frames().filter((f) => f.type === "response")).toEqual([]);
  });

  it("ignores requests without an id", async () => {
    const { bridge, deps } = makeBridge({ current: { token: "t", port: 8771 } });
    const ws = await connected(bridge);
    ws.serverSend({ type: "request", op: "tab_list", session, args: {} });
    expect(deps.onRequest).not.toHaveBeenCalled();
  });

  it("records send timing", async () => {
    let clock = 0;
    const durations = [5, 250, 1200, 0];
    const { bridge } = makeBridge(
      { current: { token: "t", port: 8771 } },
      {
        now: () => clock,
        createSocket: (url) => {
          const ws = new FakeSocket(url);
          const send = ws.send.bind(ws);
          ws.send = (data) => {
            clock += durations.shift() ?? 0;
            send(data);
          };
          return ws;
        },
      },
    );
    const ws = await connected(bridge); // hello: 5 ms
    ws.serverSend({ type: "ping", t: 1 }); // 250 ms
    bridge.sendEvent({ type: "event", event: "stop", short_id: null }); // 1200 ms
    expect(bridge.stats()).toEqual({ sends: 3, slow_sends_over_200ms: 2, max_send_ms: 1200 });
  });

  it("drops events when not connected", async () => {
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } });
    await bridge.start();
    FakeSocket.instances[0]!.serverOpen();
    expect(bridge.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(false); // before welcome
    FakeSocket.instances[0]!.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    expect(bridge.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(true);
  });
});

describe("Bridge extension requests", () => {
  const extRequest = (id: string) => ({ type: "ext_request" as const, id, op: "settings_get" as const, args: {} });

  it("sends ext_request only when connected and hands ext_response to onExtResponse", async () => {
    const onExtResponse = vi.fn();
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } }, { onExtResponse });
    expect(bridge.sendExtRequest(extRequest("x0"))).toBe(false);
    const ws = await connected(bridge);
    expect(bridge.sendExtRequest(extRequest("x1"))).toBe(true);
    expect(ws.frames().at(-1)).toEqual(extRequest("x1"));
    const response = { type: "ext_response", id: "x1", ok: true, result: { a: 1 } };
    ws.serverSend(response);
    expect(onExtResponse).toHaveBeenCalledWith(response);
  });

  it("fails ext requests still pending when the socket closes", async () => {
    const onExtResponse = vi.fn();
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } }, { onExtResponse });
    const ws = await connected(bridge);
    bridge.sendExtRequest(extRequest("x1"));
    bridge.sendExtRequest(extRequest("x2"));
    ws.serverSend({ type: "ext_response", id: "x1", ok: true, result: {} });
    ws.serverClose(1006);
    expect(onExtResponse).toHaveBeenLastCalledWith({
      type: "ext_response",
      id: "x2",
      ok: false,
      error: { code: "extension_offline", message: expect.stringMatching(/connection.*lost/i) },
    });
    expect(onExtResponse).toHaveBeenCalledTimes(2);
  });
});
