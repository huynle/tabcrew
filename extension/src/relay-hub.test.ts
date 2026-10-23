import { describe, expect, it, vi } from "vitest";
import type { V2ModelCall } from "@tabcrew/shared/v2";
import { BridgeRelay, MODEL_NOT_CONFIGURED_MESSAGE, modelNotConfigured, type RelayDeps } from "./relay.js";
import { FakePort, createPortPair, flush } from "./test/fakes.js";

const SECRET = "11".repeat(32);
const CALL: V2ModelCall = {
  type: "model_call",
  id: "m1",
  purpose: "chat_decision",
  body: { messages: [{ role: "user", content: "{}" }], max_tokens: 100, response_format: { type: "json_object" } },
  timeout_ms: 30_000,
};

function setup(overrides: Partial<RelayDeps> = {}) {
  const deps: RelayDeps = {
    loadConfig: async () => ({ token: "tok", port: 8775, mode: "hub", hubPin: { secret: SECRET, confirmed: true } }),
    handleRequest: vi.fn(async () => ({})),
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

async function results(offscreen: FakePort) {
  await flush();
  return offscreen
    .messages<{ type: string; result?: Record<string, unknown> }>()
    .filter((m) => m.type === "model_result")
    .map((m) => m.result);
}

describe("BridgeRelay hub mode", () => {
  it("pushes a hub config with the pin and without the daemon token", async () => {
    const { attach } = setup();
    const offscreen = await attach();
    expect(offscreen.messages()).toEqual([
      { type: "config", token: null, port: 8775, reconfigure: false, mode: "hub", hub_pin: { secret: SECRET, confirmed: true } },
    ]);
  });

  it("keeps the daemon-mode config message shape", async () => {
    const { attach } = setup({ loadConfig: async () => ({ token: "tok", port: 8771, mode: "daemon", hubPin: null }) });
    const offscreen = await attach();
    expect(offscreen.messages()).toEqual([{ type: "config", token: "tok", port: 8771, reconfigure: false }]);
  });

  it("mirrors untrusted_hub", async () => {
    const onStatus = vi.fn();
    const { relay, attach } = setup({ onStatus });
    const offscreen = await attach();
    offscreen.postMessage({ type: "status", status: "untrusted_hub" });
    await flush();
    expect(relay.status).toBe("untrusted_hub");
    expect(onStatus).toHaveBeenCalledWith("untrusted_hub");
  });

  it("hands a stored pin secret to onHubPinStored", async () => {
    const onHubPinStored = vi.fn();
    const { attach } = setup({ onHubPinStored });
    const offscreen = await attach();
    offscreen.postMessage({ type: "hub_pin_stored", secret: SECRET });
    offscreen.postMessage({ type: "hub_pin_stored", secret: "nope" });
    await flush();
    expect(onHubPinStored).toHaveBeenCalledTimes(1);
    expect(onHubPinStored).toHaveBeenCalledWith(SECRET);
  });
});

describe("BridgeRelay model calls", () => {
  it("runs model_call through handleModelCall and posts the model_result", async () => {
    const handleModelCall = vi.fn(async () => ({ ok: true as const, result: { status: 200, json: { choices: [] }, model: "gpt-x" } }));
    const { attach } = setup({ handleModelCall });
    const offscreen = await attach();
    offscreen.postMessage({ type: "model_call", call: CALL });
    expect(await results(offscreen)).toEqual([{ type: "model_result", id: "m1", ok: true, result: { status: 200, json: { choices: [] }, model: "gpt-x" } }]);
    expect(handleModelCall).toHaveBeenCalledWith(CALL);
  });

  it("passes ok:false outcomes through", async () => {
    const { attach } = setup({ handleModelCall: async () => ({ ok: false, error: { code: "model_error", message: "TLS failure" } }) });
    const offscreen = await attach();
    offscreen.postMessage({ type: "model_call", call: CALL });
    expect(await results(offscreen)).toEqual([{ type: "model_result", id: "m1", ok: false, error: { code: "model_error", message: "TLS failure" } }]);
  });

  it("turns a throwing handler or an invalid outcome into model_error", async () => {
    const outcomes = [
      async () => {
        throw new Error("boom");
      },
      async () => ({ ok: true, result: { status: 99999, json: null, model: "" } }),
    ];
    const { attach } = setup({ handleModelCall: (() => outcomes.shift()!()) as RelayDeps["handleModelCall"] });
    const offscreen = await attach();
    offscreen.postMessage({ type: "model_call", call: CALL });
    offscreen.postMessage({ type: "model_call", call: { ...CALL, id: "m2" } });
    const posted = await results(offscreen);
    expect(posted).toEqual([
      { type: "model_result", id: "m1", ok: false, error: { code: "model_error", message: "boom" } },
      { type: "model_result", id: "m2", ok: false, error: { code: "model_error", message: expect.stringMatching(/invalid/) } },
    ]);
  });

  it("answers model_not_configured without a handler", async () => {
    const { attach } = setup();
    const offscreen = await attach();
    offscreen.postMessage({ type: "model_call", call: CALL });
    expect(await results(offscreen)).toEqual([
      { type: "model_result", id: "m1", ok: false, error: { code: "model_not_configured", message: MODEL_NOT_CONFIGURED_MESSAGE } },
    ]);
    expect(MODEL_NOT_CONFIGURED_MESSAGE).toBe("set a model provider in the TabCrew popup");
    expect(await modelNotConfigured(CALL)).toEqual({ ok: false, error: { code: "model_not_configured", message: MODEL_NOT_CONFIGURED_MESSAGE } });
  });

  it("drops malformed model calls from the port without running them", async () => {
    const handleModelCall = vi.fn(modelNotConfigured);
    const { attach } = setup({ handleModelCall });
    const offscreen = await attach();
    offscreen.postMessage({ type: "model_call", call: { ...CALL, purpose: "jev" } });
    offscreen.postMessage({ type: "model_call" });
    expect(await results(offscreen)).toEqual([]);
    expect(handleModelCall).not.toHaveBeenCalled();
  });
});
