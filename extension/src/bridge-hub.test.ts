import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExtProofInput, v2HubProofInput, type V2ModelCall } from "@tabcrew/shared/v2";
import { Bridge, HUB_MAX_BACKOFF_MS, hmacSha256Hex, type BridgeDeps } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { FakeSocket, flush } from "./test/fakes.js";

const SECRET = "11".repeat(32);
const NONCE_H = "bb".repeat(16);
const session = { short_id: "abcd1234", label: "agent" };
const MODEL_CALL = {
  type: "model_call",
  id: "m1",
  purpose: "chat_decision",
  body: { messages: [{ role: "user", content: "{}" }], max_tokens: 100, response_format: { type: "json_object" } },
  timeout_ms: 30_000,
};

const hmac = (input: string, secret = SECRET) => createHmac("sha256", Buffer.from(secret, "hex")).update(input, "utf8").digest("hex");

function hubConfig(confirmed: boolean, secret = SECRET): BridgeConfig {
  return { token: "daemon-token", port: 8775, mode: "hub", hubPin: { secret, confirmed } };
}

function makeBridge(config: { current: BridgeConfig }, overrides: Partial<BridgeDeps> = {}) {
  const deps = {
    loadConfig: async () => config.current,
    createSocket: (url: string) => new FakeSocket(url),
    extensionVersion: "0.6.0",
    onRequest: vi.fn(),
    onWelcome: vi.fn(),
    onPing: vi.fn(),
    onModelCall: vi.fn(),
    onHubPinStored: vi.fn(),
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

/** The hub's correct challenge for the hello `ws` sent. */
function challengeFor(ws: FakeSocket, secret = SECRET) {
  const nonce_e = (ws.frames()[0]!.pin as { nonce_e: string }).nonce_e;
  return { state: "challenge", nonce_h: NONCE_H, hub_proof: hmac(v2HubProofInput({ nonce_e, nonce_h: NONCE_H }), secret) };
}

async function pinnedAndVerified(bridge: Bridge): Promise<FakeSocket> {
  const ws = await opened(bridge);
  ws.serverSend({ type: "welcome", protocol: 2, sessions: [], features: ["hub"], pin: challengeFor(ws) });
  await vi.waitFor(() => expect(bridge.status).toBe("connected"));
  return ws;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hmacSha256Hex (WebCrypto)", () => {
  it("matches the shared reference vectors", async () => {
    const nonces = { nonce_e: "aa".repeat(16), nonce_h: NONCE_H };
    expect(await hmacSha256Hex(SECRET, v2HubProofInput(nonces))).toBe("ec437cae1b4eaa52ed910d9b77485e6c735684cb608756170f70447464dc8be2");
    expect(await hmacSha256Hex(SECRET, v2ExtProofInput(nonces))).toBe("07da2add5751f467195f45aa121ba9305158beeeb3f12f0af92e8e989ee58fdc");
  });
});

describe("Bridge hub mode: hello", () => {
  it("connects to the hub port and sends a tokenless hub hello handing over a new pin", async () => {
    const { bridge } = makeBridge({ current: hubConfig(false) });
    const ws = await opened(bridge);
    expect(ws.url).toBe("ws://127.0.0.1:8775");
    expect(ws.frames()[0]).toEqual({
      type: "hello",
      protocol: 2,
      extension_version: "0.6.0",
      mode: "hub",
      features: ["model_call", "groups"],
      pin: { state: "new", secret: SECRET },
    });
    expect(ws.frames()[0]).not.toHaveProperty("token");
  });

  it("challenges the hub with a fresh nonce once the pin is confirmed", async () => {
    const { bridge } = makeBridge({ current: hubConfig(true) });
    const ws = await opened(bridge);
    const hello = ws.frames()[0]!;
    expect(hello).toMatchObject({ type: "hello", mode: "hub", features: ["model_call", "groups"], pin: { state: "pinned" } });
    expect((hello.pin as { nonce_e: string }).nonce_e).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(hello)).not.toContain(SECRET);
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = FakeSocket.instances.at(-1)!;
    ws2.serverOpen();
    expect((ws2.frames()[0]!.pin as { nonce_e: string }).nonce_e).not.toBe((hello.pin as { nonce_e: string }).nonce_e);
  });

  it("does not need a token in hub mode", async () => {
    const { bridge } = makeBridge({ current: { ...hubConfig(false), token: null } });
    await bridge.start();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("Bridge hub mode: new pin", () => {
  it("is connected once the hub stored the pin, and reports the stored secret", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(false) });
    const ws = await opened(bridge);
    const welcome = { type: "welcome", protocol: 2, sessions: [], features: ["hub"], pin: { state: "stored" } };
    ws.serverSend(welcome);
    await vi.waitFor(() => expect(bridge.status).toBe("connected"));
    expect(deps.onHubPinStored).toHaveBeenCalledWith(SECRET);
    expect(deps.onWelcome).toHaveBeenCalledWith(welcome);
    expect(ws.frames().some((f) => f.type === "auth")).toBe(false);
    ws.serverSend({ type: "request", id: "r1", op: "tab_list", session, args: {} });
    expect(deps.onRequest).toHaveBeenCalledTimes(1);
  });

  it("challenges the hub after a stored pin even if the config still says unconfirmed", async () => {
    const { bridge } = makeBridge({ current: hubConfig(false) });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin: { state: "stored" } });
    await vi.waitFor(() => expect(bridge.status).toBe("connected"));
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = FakeSocket.instances.at(-1)!;
    ws2.serverOpen();
    expect(ws2.frames()[0]).toMatchObject({ pin: { state: "pinned" } });
  });

  it.each([
    ["no pin", undefined],
    ["a challenge", { state: "challenge", nonce_h: NONCE_H, hub_proof: "cd".repeat(32) }],
  ])("treats a welcome with %s as an untrusted hub", async (_name, pin) => {
    const { bridge, deps } = makeBridge({ current: hubConfig(false) });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin });
    await vi.waitFor(() => expect(bridge.status).toBe("untrusted_hub"));
    expect(ws.closed).not.toBeNull();
    expect(deps.onWelcome).not.toHaveBeenCalled();
    expect(deps.onHubPinStored).not.toHaveBeenCalled();
  });
});

describe("Bridge hub mode: challenge", () => {
  it("verifies the hub proof, then sends auth with the extension proof and is connected", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await opened(bridge);
    const nonce_e = (ws.frames()[0]!.pin as { nonce_e: string }).nonce_e;
    const welcome = { type: "welcome", protocol: 2, sessions: [], features: ["hub"], pin: challengeFor(ws) };
    ws.serverSend(welcome);
    await vi.waitFor(() => expect(bridge.status).toBe("connected"));
    expect(ws.frames()[1]).toEqual({ type: "auth", ext_proof: hmac(v2ExtProofInput({ nonce_e, nonce_h: NONCE_H })) });
    expect(deps.onWelcome).toHaveBeenCalledWith(welcome);
    expect(deps.onHubPinStored).not.toHaveBeenCalled();
    expect(bridge.isReady).toBe(true);
  });

  it("drops every frame that arrives before the hub proof is verified", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await opened(bridge);
    ws.serverSend({ type: "request", id: "r0", op: "tab_list", session, args: {} }); // before welcome
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin: challengeFor(ws) });
    // While the HMAC is being checked:
    ws.serverSend({ type: "request", id: "r1", op: "tab_list", session, args: {} });
    ws.serverSend(MODEL_CALL);
    ws.serverSend({ type: "ping", t: 1 });
    await vi.waitFor(() => expect(bridge.status).toBe("connected"));
    expect(deps.onRequest).not.toHaveBeenCalled();
    expect(deps.onModelCall).not.toHaveBeenCalled();
    expect(ws.frames().map((f) => f.type)).toEqual(["hello", "auth"]);
    ws.serverSend({ type: "request", id: "r2", op: "tab_list", session, args: {} });
    expect(deps.onRequest).toHaveBeenCalledTimes(1);
    expect(deps.onRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "r2" }));
  });

  it("rejects a wrong hub proof: no auth, socket closed, untrusted_hub and no retries until reconfigured", async () => {
    const config = { current: hubConfig(true) };
    const { bridge, deps } = makeBridge(config);
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin: challengeFor(ws, "22".repeat(32)) });
    ws.serverSend({ type: "request", id: "r1", op: "tab_list", session, args: {} });
    await vi.waitFor(() => expect(bridge.status).toBe("untrusted_hub"));
    expect(ws.frames().map((f) => f.type)).toEqual(["hello"]);
    expect(ws.closed).not.toBeNull();
    expect(deps.onWelcome).not.toHaveBeenCalled();
    expect(deps.onRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await bridge.ensureConnected();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(bridge.status).toBe("untrusted_hub");

    config.current = hubConfig(false, "33".repeat(32)); // "Trust this hub"
    await bridge.reconfigure();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("refuses a hub that answers a pinned hello with stored (downgrade)", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin: { state: "stored" } });
    await vi.waitFor(() => expect(bridge.status).toBe("untrusted_hub"));
    expect(deps.onWelcome).not.toHaveBeenCalled();
    expect(deps.onHubPinStored).not.toHaveBeenCalled();
  });

  it("treats a later welcome on a verified socket as a session refresh (no new auth)", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await pinnedAndVerified(bridge);
    const refresh = { type: "welcome", protocol: 2, sessions: [session], features: ["hub"] };
    ws.serverSend(refresh);
    await flush();
    expect(deps.onWelcome).toHaveBeenCalledTimes(2);
    expect(deps.onWelcome).toHaveBeenLastCalledWith(refresh);
    expect(ws.frames().filter((f) => f.type === "auth")).toHaveLength(1);
    expect(bridge.status).toBe("connected");
  });
});

describe("Bridge hub mode: closes and reconnects", () => {
  it("stops retrying after 4403 until reconfigured", async () => {
    const { bridge } = makeBridge({ current: hubConfig(true) });
    const ws = await opened(bridge);
    ws.serverClose(4403);
    expect(bridge.status).toBe("untrusted_hub");
    await vi.advanceTimersByTimeAsync(60_000);
    await bridge.ensureConnected();
    expect(FakeSocket.instances).toHaveLength(1);
    await bridge.start(); // the same pin again
    expect(FakeSocket.instances).toHaveLength(1);
    await bridge.reconfigure();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops retrying after 4401 (not a hub) until reconfigured", async () => {
    const { bridge } = makeBridge({ current: hubConfig(false) });
    const ws = await opened(bridge);
    ws.serverClose(4401);
    expect(bridge.status).toBe("unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects quickly (backoff capped at 3 s) and stays offline between attempts", async () => {
    const statuses: string[] = [];
    const { bridge } = makeBridge({ current: hubConfig(true) }, { onStatus: (s) => void statuses.push(s) });
    await bridge.start();
    expect(HUB_MAX_BACKOFF_MS).toBe(3_000);
    for (let i = 0; i < 6; i++) {
      FakeSocket.instances.at(-1)!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(FakeSocket.instances).toHaveLength(7);
    expect(statuses).toEqual(["connecting", "offline"]);
  });
});

describe("Bridge hub mode: model calls", () => {
  it("hands a verified model_call (allowed fields only) to onModelCall and writes the result once", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await pinnedAndVerified(bridge);
    ws.serverSend({ ...MODEL_CALL, url: "https://evil.example/", body: { ...MODEL_CALL.body, model: "x/y" } });
    expect(deps.onModelCall).toHaveBeenCalledWith(MODEL_CALL as V2ModelCall);
    const result = { type: "model_result", id: "m1", ok: true, result: { status: 200, json: { a: 1 }, model: "gpt" } } as const;
    expect(bridge.sendModelResult(result)).toBe(true);
    expect(bridge.sendModelResult(result)).toBe(false);
    expect(bridge.sendModelResult({ ...result, id: "never" })).toBe(false);
    expect(ws.frames().filter((f) => f.type === "model_result")).toEqual([result]);
  });

  it("answers a malformed model_call with model_error", async () => {
    const { bridge, deps } = makeBridge({ current: hubConfig(true) });
    const ws = await pinnedAndVerified(bridge);
    ws.serverSend({ ...MODEL_CALL, id: "bad", purpose: "jev" });
    expect(deps.onModelCall).not.toHaveBeenCalled();
    expect(ws.frames().at(-1)).toEqual({
      type: "model_result",
      id: "bad",
      ok: false,
      error: { code: "model_error", message: expect.stringMatching(/malformed/) },
    });
  });

  it("does not write results for calls of a closed socket", async () => {
    const { bridge } = makeBridge({ current: hubConfig(true) });
    const ws = await pinnedAndVerified(bridge);
    ws.serverSend(MODEL_CALL);
    ws.serverClose(1006);
    expect(bridge.sendModelResult({ type: "model_result", id: "m1", ok: false, error: { code: "model_not_configured", message: "x" } })).toBe(false);
  });

  it("ignores model_call in daemon mode", async () => {
    const onModelCall = vi.fn();
    const { bridge } = makeBridge({ current: { token: "t", port: 8771 } }, { onModelCall });
    const ws = await opened(bridge);
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [] });
    ws.serverSend(MODEL_CALL);
    expect(onModelCall).not.toHaveBeenCalled();
    expect(ws.frames()[0]).toEqual({ type: "hello", protocol: 2, token: "t", extension_version: "0.6.0", features: ["groups"] });
  });
});
