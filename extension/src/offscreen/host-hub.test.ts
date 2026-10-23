import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v2HubProofInput } from "@tabcrew/shared/v2";
import { FakePort, FakeSocket, createPortPair, flush } from "../test/fakes.js";
import { OffscreenHost } from "./host.js";

const SECRET = "11".repeat(32);
const OTHER = "22".repeat(32);
const NONCE_H = "bb".repeat(16);
const MODEL_CALL = {
  type: "model_call",
  id: "m1",
  purpose: "text",
  body: { messages: [{ role: "user", content: "hi" }], max_tokens: 50 },
  timeout_ms: 10_000,
};

function setup() {
  const swEnds: FakePort[] = [];
  const host = new OffscreenHost({
    connect: () => {
      const [mine, theirs] = createPortPair("v2-bridge");
      swEnds.push(theirs);
      return mine;
    },
    createSocket: (url) => new FakeSocket(url),
    extensionVersion: "0.6.0",
  });
  host.start();
  return { host, sw: () => swEnds.at(-1)! };
}

async function hubConfig(sw: FakePort, secret = SECRET, confirmed = false, reconfigure = false, port = 8775) {
  sw.postMessage({ type: "config", token: null, port, reconfigure, mode: "hub", hub_pin: { secret, confirmed } });
  await flush();
}

async function verifiedHub() {
  const ctx = setup();
  await hubConfig(ctx.sw(), SECRET, true);
  const ws = FakeSocket.instances.at(-1)!;
  ws.serverOpen();
  const nonce_e = (ws.frames()[0]!.pin as { nonce_e: string }).nonce_e;
  const hub_proof = createHmac("sha256", Buffer.from(SECRET, "hex")).update(v2HubProofInput({ nonce_e, nonce_h: NONCE_H }), "utf8").digest("hex");
  ws.serverSend({ type: "welcome", protocol: 2, sessions: [], features: ["hub"], pin: { state: "challenge", nonce_h: NONCE_H, hub_proof } });
  await vi.waitFor(() => expect(ctx.host.bridge.status).toBe("connected"));
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

describe("OffscreenHost hub mode", () => {
  it("connects with a tokenless hub hello on the pushed port", async () => {
    const { sw } = setup();
    await hubConfig(sw());
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:8775");
    ws.serverOpen();
    expect(ws.frames()[0]).toMatchObject({ type: "hello", mode: "hub", features: ["model_call", "groups"], pin: { state: "new", secret: SECRET } });
    expect(ws.frames()[0]).not.toHaveProperty("token");
  });

  it("tells the service worker when the hub stored the pin", async () => {
    const { sw } = setup();
    await hubConfig(sw());
    const ws = FakeSocket.instances[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "welcome", protocol: 2, sessions: [], pin: { state: "stored" } });
    await vi.waitFor(() => expect(sw().messages()).toContainEqual({ type: "hub_pin_stored", secret: SECRET }));
    expect(sw().messages()).toContainEqual({ type: "status", status: "connected" });
  });

  it("keeps the connection when only the pin's confirmed flag changes, reconnects for a new secret", async () => {
    const { sw } = setup();
    await hubConfig(sw(), SECRET, false);
    await hubConfig(sw(), SECRET, true);
    expect(FakeSocket.instances).toHaveLength(1);
    await hubConfig(sw(), OTHER, false);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]!.closed).toEqual({ code: 1000 });
  });

  it("reconnects when the mode changes", async () => {
    const { sw } = setup();
    sw().postMessage({ type: "config", token: "tok", port: 8771, reconfigure: false });
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    await hubConfig(sw(), SECRET, false, false, 8771); // same port, now hub mode
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverOpen();
    expect(FakeSocket.instances[1]!.frames()[0]).toMatchObject({ mode: "hub" });
  });

  it("reports untrusted_hub after 4403 and waits for a new pin", async () => {
    const { sw } = setup();
    await hubConfig(sw(), SECRET, true);
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverClose(4403);
    await flush();
    expect(sw().messages().at(-1)).toEqual({ type: "status", status: "untrusted_hub" });
    sw().postMessage({ type: "ensure" });
    await hubConfig(sw(), SECRET, true); // a restarted service worker re-sends the same config
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await hubConfig(sw(), OTHER, false); // "Trust this hub"
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("forwards model_call to the service worker and writes its model_result to the socket", async () => {
    const { sw, ws } = await verifiedHub();
    ws.serverSend(MODEL_CALL);
    await flush();
    expect(sw().messages().at(-1)).toEqual({ type: "model_call", call: MODEL_CALL });
    const result = { type: "model_result", id: "m1", ok: false, error: { code: "model_not_configured", message: "set a model provider" } };
    sw().postMessage({ type: "model_result", result });
    await flush();
    expect(ws.frames().at(-1)).toEqual(result);
  });
});
