import { afterEach, describe, expect, it } from "vitest";
import { v2ParseModelCall, type V2ModelCallBody } from "@tabcrew/shared/v2";
import { ExtensionBridge, ModelCallUnavailableError } from "./bridge.js";
import { DaemonError } from "./errors.js";
import { ModelUnavailableError } from "./jev/decisions.js";
import { MemoryPinStore } from "./pin.js";
import { FakeExtension, HOLD, TEST_EXTENSION_ORIGIN, until, WireError } from "./testing/helpers.js";

const SECRET = "c".repeat(64);
const BODY: V2ModelCallBody = {
  messages: [
    { role: "system", content: "Answer in JSON." },
    { role: "user", content: "hi" },
  ],
  max_tokens: 64,
  response_format: { type: "json_object" },
};

const bridges: ExtensionBridge[] = [];
const extensions: FakeExtension[] = [];

afterEach(async () => {
  for (const e of extensions.splice(0)) e.ws.terminate();
  for (const b of bridges.splice(0)) await b.close();
});

async function hubWith(options: { features?: string[]; offlineWaitMs?: number; connect?: boolean } = {}) {
  const bridge = new ExtensionBridge({
    auth: { kind: "hub", allowedOrigins: [TEST_EXTENSION_ORIGIN], pinStore: new MemoryPinStore(SECRET) },
    port: 0,
    sessions: () => [],
    offlineWaitMs: options.offlineWaitMs ?? 1000,
    modelCallGraceMs: 0,
  });
  bridges.push(bridge);
  const port = await bridge.start();
  let ext: FakeExtension | null = null;
  if (options.connect !== false) {
    ext = await FakeExtension.connectHub(port, { secret: SECRET, features: options.features });
    extensions.push(ext);
    await until(() => bridge.connected);
  }
  return { bridge, port, ext: ext! };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("ExtensionBridge.modelCall", () => {
  it("round-trips a model_call: well-formed frame out, {status, json, model} back", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => ({ status: 200, json: { choices: [{ message: { content: "{}" } }] }, model: "gemini-3.6-flash" });
    const result = await bridge.modelCall("chat_decision", BODY, 5000);
    expect(result).toEqual({ status: 200, json: { choices: [{ message: { content: "{}" } }] }, model: "gemini-3.6-flash" });
    expect(ext.modelCalls).toHaveLength(1);
    const call = ext.modelCalls[0];
    expect(call).toMatchObject({ type: "model_call", purpose: "chat_decision", body: BODY, timeout_ms: 5000 });
    expect(v2ParseModelCall(call)).toEqual(call);
  });

  it("passes non-2xx provider replies through as results (the caller maps statuses)", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => ({ status: 401, json: { error: { message: "bad key" } }, model: "m" });
    await expect(bridge.modelCall("text", BODY, 5000)).resolves.toEqual({ status: 401, json: { error: { message: "bad key" } }, model: "m" });
  });

  it("clamps timeout_ms to 1..120000", async () => {
    const { bridge, ext } = await hubWith();
    await bridge.modelCall("text", BODY, 500_000);
    await bridge.modelCall("text", BODY, 0);
    expect(ext.modelCalls.map((c) => c.timeout_ms)).toEqual([120_000, 1]);
  });

  it("ok:false model_not_configured rejects with that code", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => {
      throw new WireError({ code: "model_not_configured", message: "set a model provider in the TabCrew popup" });
    };
    const err = await rejection(bridge.modelCall("text", BODY, 5000));
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).not.toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_not_configured", message: "set a model provider in the TabCrew popup" });
  });

  it("ok:false model_error (network/TLS) rejects as ModelUnavailableError", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => {
      throw new WireError({ code: "model_error", message: "Model connection failed" });
    };
    const err = await rejection(bridge.modelCall("text", BODY, 5000));
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toBeInstanceOf(ModelCallUnavailableError);
    expect(err).toMatchObject({ code: "model_error", reason: "provider" });
  });

  it("times out as ModelUnavailableError when no model_result arrives", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => HOLD;
    const err = await rejection(bridge.modelCall("text", BODY, 50));
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_error", reason: "timeout", message: expect.stringMatching(/timed out/) });
  });

  it("refuses when the extension did not announce model_call (update the extension)", async () => {
    const { bridge, ext } = await hubWith({ features: [] });
    const err = await rejection(bridge.modelCall("text", BODY, 5000));
    expect(err).not.toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_not_configured", message: expect.stringMatching(/update the TabCrew extension/) });
    await new Promise((r) => setTimeout(r, 20));
    expect(ext.modelCalls).toEqual([]);
  });

  it("losing the extension mid-call rejects as ModelUnavailableError, not extension_offline/outcome_unknown", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => HOLD;
    const pending = rejection(bridge.modelCall("text", BODY, 5000));
    await until(() => ext.modelCalls.length === 1);
    ext.ws.terminate();
    const err = await pending;
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_error", reason: "disconnected" });
  });

  it("no extension within offlineWaitMs rejects as ModelUnavailableError", async () => {
    const { bridge } = await hubWith({ connect: false, offlineWaitMs: 50 });
    const err = await rejection(bridge.modelCall("text", BODY, 5000));
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_error", reason: "offline", message: expect.stringMatching(/not connected/) });
  });

  it("waits for a late extension within offlineWaitMs", async () => {
    const { bridge, port } = await hubWith({ connect: false, offlineWaitMs: 2000 });
    const pending = bridge.modelCall("text", BODY, 5000);
    await new Promise((r) => setTimeout(r, 50));
    const ext = await FakeExtension.connectHub(port, { secret: SECRET });
    extensions.push(ext);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("closing the bridge fails pending model calls as ModelUnavailableError", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => HOLD;
    const pending = rejection(bridge.modelCall("text", BODY, 5000));
    await until(() => ext.modelCalls.length === 1);
    await bridge.close();
    bridges.length = 0;
    expect(await pending).toBeInstanceOf(ModelUnavailableError);
  });

  it("a malformed model_result for a pending id rejects with model_error; unknown ids are ignored", async () => {
    const { bridge, ext } = await hubWith();
    ext.modelHandler = () => HOLD;
    const pending = rejection(bridge.modelCall("text", BODY, 5000));
    await until(() => ext.modelCalls.length === 1);
    ext.send({ type: "model_result", id: "nope", ok: true, result: { status: 200, json: {}, model: "m" } });
    ext.send({ type: "model_result", id: ext.modelCalls[0].id, ok: true, result: { status: 99, json: {}, model: "m" } });
    const err = await pending;
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).not.toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_error" });
    expect(bridge.connected).toBe(true);
  });

  it("keeps several model calls in flight and matches results by id", async () => {
    const { bridge, ext } = await hubWith();
    const release: (() => void)[] = [];
    ext.modelHandler = (call) =>
      new Promise((resolve) => release.push(() => resolve({ status: 200, json: { purpose: call.purpose }, model: "m" })));
    const a = bridge.modelCall("text", BODY, 5000);
    const b = bridge.modelCall("text_fallback", BODY, 5000);
    await until(() => release.length === 2);
    release[1]();
    release[0]();
    expect((await a).json).toEqual({ purpose: "text" });
    expect((await b).json).toEqual({ purpose: "text_fallback" });
  });
});
