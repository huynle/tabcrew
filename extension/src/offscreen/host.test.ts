import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePort, FakeSocket, createPortPair, flush } from "../test/fakes.js";
import { OffscreenHost, PORT_RECONNECT_MS } from "./host.js";

const session = { short_id: "abcd1234", label: "agent" };
const WELCOME = { type: "welcome", protocol: 2, sessions: [], daemon_version: "0.5.0", features: ["settings"] };

/** `sw` is the service worker's end of the current port. */
function setup() {
  const swEnds: FakePort[] = [];
  const host = new OffscreenHost({
    connect: () => {
      const [mine, theirs] = createPortPair("v2-bridge");
      swEnds.push(theirs);
      return mine;
    },
    createSocket: (url) => new FakeSocket(url),
    extensionVersion: "0.3.0",
  });
  host.start();
  return { host, swEnds, sw: () => swEnds.at(-1)! };
}

async function sendConfig(sw: FakePort, token: string | null, port = 8771, reconfigure = false) {
  sw.postMessage({ type: "config", token, port, reconfigure });
  await flush();
}

async function connected() {
  const ctx = setup();
  await sendConfig(ctx.sw(), "secret-token");
  const ws = FakeSocket.instances.at(-1)!;
  ws.serverOpen();
  ws.serverSend(WELCOME);
  await flush();
  return { ...ctx, ws };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OffscreenHost", () => {
  it("waits for config from the service worker, then sends hello with the token first", async () => {
    const { sw } = setup();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(sw().messages()).toEqual([{ type: "status", status: "offline" }]);

    await sendConfig(sw(), "secret-token", 9999);
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:9999");
    ws.serverOpen();
    expect(ws.frames()[0]).toEqual({ type: "hello", protocol: 2, token: "secret-token", extension_version: "0.3.0" });
  });

  it("posts status changes and welcome to the service worker", async () => {
    const { sw } = await connected();
    expect(sw().messages()).toEqual([
      { type: "status", status: "offline" },
      { type: "status", status: "connecting" },
      { type: "status", status: "connected" },
      { type: "welcome", welcome: WELCOME },
    ]);
  });

  it("reports needs_token without a token", async () => {
    const { sw } = setup();
    await sendConfig(sw(), null);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(sw().messages().at(-1)).toEqual({ type: "status", status: "needs_token" });
  });

  it("stops retrying after 4401 until the token changes", async () => {
    const { sw } = setup();
    await sendConfig(sw(), "wrong");
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverClose(4401);
    await flush();
    expect(sw().messages().at(-1)).toEqual({ type: "status", status: "unauthorized" });

    await vi.advanceTimersByTimeAsync(120_000);
    sw().postMessage({ type: "ensure" }); // keepalive alarm
    await sendConfig(sw(), "wrong"); // a restarted service worker re-sends the same config
    expect(FakeSocket.instances).toHaveLength(1);

    await sendConfig(sw(), "right");
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverOpen();
    expect(FakeSocket.instances[1]!.frames()[0]).toMatchObject({ type: "hello", token: "right" });
  });

  it("answers ping without involving the service worker beyond a keepalive", async () => {
    const { sw, ws } = await connected();
    const before = sw().messages().length;
    ws.serverSend({ type: "ping", t: 42 });
    expect(ws.frames().at(-1)).toEqual({ type: "pong", t: 42 }); // synchronously, before any port traffic
    await flush();
    expect(sw().messages().slice(before)).toEqual([{ type: "keepalive" }]);
  });

  it("forwards request frames over the port and writes responses from the port to the socket", async () => {
    const { sw, ws } = await connected();
    const r1 = { type: "request", id: "r1", op: "tab_list", session, args: {} };
    const r2 = { type: "request", id: "r2", op: "tab_list", session, args: {} };
    ws.serverSend(r1);
    ws.serverSend(r2);
    await flush();
    expect(sw().messages().filter((m) => m.type === "request")).toEqual([
      { type: "request", request: r1 },
      { type: "request", request: r2 },
    ]);

    sw().postMessage({ type: "frame", frame: { type: "response", id: "r2", ok: true, result: { tabs: [] } } });
    sw().postMessage({ type: "frame", frame: { type: "event", event: "stop", short_id: null } });
    sw().postMessage({ type: "frame", frame: { type: "response", id: "r1", ok: false, error: { code: "internal", message: "x" } } });
    await flush();
    expect(ws.frames().slice(1)).toEqual([
      { type: "response", id: "r2", ok: true, result: { tabs: [] } },
      { type: "event", event: "stop", short_id: null },
      { type: "response", id: "r1", ok: false, error: { code: "internal", message: "x" } },
    ]);
  });

  it("forces a reconnect when the service worker says the stored config changed", async () => {
    const { sw, ws } = await connected();
    await sendConfig(sw(), "secret-token", 8771, true);
    expect(ws.closed).toEqual({ code: 1000 });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("reopens the port when the service worker restarts and reports the current status", async () => {
    const { swEnds, ws } = await connected();
    swEnds[0]!.disconnect(); // service worker terminated
    await vi.advanceTimersByTimeAsync(PORT_RECONNECT_MS);
    expect(swEnds).toHaveLength(2);
    await flush();
    // The new service worker also learns what the daemon supports (it missed the welcome).
    expect(swEnds[1]!.messages()).toEqual([
      { type: "status", status: "connected" },
      { type: "service", service: { version: "0.5.0", features: ["settings"] } },
    ]);

    // The socket was untouched; requests flow over the new port.
    ws.serverSend({ type: "request", id: "r9", op: "tab_list", session, args: {} });
    await flush();
    expect(swEnds[1]!.messages().at(-1)).toMatchObject({ type: "request", request: { id: "r9" } });
  });

  it("does not replay a service after the socket dropped", async () => {
    const { swEnds, ws } = await connected();
    ws.serverClose(1006);
    await flush();
    swEnds[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(PORT_RECONNECT_MS);
    await flush();
    expect(swEnds.at(-1)!.messages().some((m) => (m as { type: string }).type === "service")).toBe(false);
  });

  it("reopens the port immediately when a request arrives while it is down", async () => {
    const { swEnds, ws } = await connected();
    swEnds[0]!.disconnect();
    ws.serverSend({ type: "request", id: "r1", op: "tab_list", session, args: {} });
    await flush();
    expect(swEnds).toHaveLength(2);
    expect(swEnds[1]!.messages()).toEqual([
      { type: "status", status: "connected" },
      { type: "service", service: { version: "0.5.0", features: ["settings"] } },
      { type: "request", request: { type: "request", id: "r1", op: "tab_list", session, args: {} } },
    ]);
    await vi.advanceTimersByTimeAsync(PORT_RECONNECT_MS * 4);
    expect(swEnds).toHaveLength(2); // no duplicate port from the pending timer
  });

  it("exposes send stats", async () => {
    const { host, ws } = await connected();
    ws.serverSend({ type: "ping", t: 1 });
    expect(host.stats()).toMatchObject({ sends: 2, slow_sends_over_200ms: 0 });
  });
});

describe("OffscreenHost extension requests", () => {
  it("forwards ext_request from the service worker to the socket and the ext_response back", async () => {
    const { sw, ws } = await connected();
    const req = { type: "ext_request", id: "x1", op: "settings_get", args: {} };
    sw().postMessage({ type: "ext_request", request: req });
    await flush();
    expect(ws.frames().at(-1)).toEqual(req);
    const res = { type: "ext_response", id: "x1", ok: true, result: { a: 1 } };
    ws.serverSend(res);
    await flush();
    expect(sw().messages().at(-1)).toEqual({ type: "ext_response", response: res });
  });

  it("answers at once with extension_offline when the socket is not connected", async () => {
    const { sw } = setup();
    await sendConfig(sw(), "secret-token"); // connecting, not welcomed
    sw().postMessage({ type: "ext_request", request: { type: "ext_request", id: "x9", op: "settings_get", args: {} } });
    await flush();
    expect(sw().messages().at(-1)).toEqual({
      type: "ext_response",
      response: { type: "ext_response", id: "x9", ok: false, error: { code: "extension_offline", message: expect.any(String) } },
    });
  });
});
