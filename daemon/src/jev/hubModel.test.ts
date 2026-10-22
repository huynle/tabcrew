import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2ModelCallBody, V2ModelPurpose } from "@tabcrew/shared/v2";
import { ModelCallUnavailableError, type ModelCallResult } from "../bridge.js";
import { DaemonError } from "../errors.js";
import {
  httpTransport,
  modelCallTransport,
  ModelUnavailableError,
  parseCost,
  sendModel,
  type ModelSettings,
} from "./decisions.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A stand-in for ExtensionBridge.modelCall: answers each call from `reply` and records it. */
function fakeBridge(reply: (purpose: V2ModelPurpose, n: number) => ModelCallResult | Promise<ModelCallResult>) {
  const calls: { purpose: V2ModelPurpose; body: V2ModelCallBody; timeoutMs: number }[] = [];
  return {
    calls,
    bridge: {
      async modelCall(purpose: V2ModelPurpose, body: V2ModelCallBody, timeoutMs: number): Promise<ModelCallResult> {
        calls.push({ purpose, body, timeoutMs });
        return reply(purpose, calls.length - 1);
      },
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const BODY = { messages: [{ role: "user", content: "hi" }], max_tokens: 10, response_format: { type: "json_object" } };
const OPTS: Pick<ModelSettings, "retryBaseMs" | "timeoutMs"> = { retryBaseMs: 1, timeoutMs: 1234 };

describe("parseCost", () => {
  it("reads OpenRouter's number and Provider' {total_cost} object", () => {
    expect(parseCost({ cost: 0.0005 })).toBe(0.0005);
    expect(parseCost({ cost: { input_cost: 0.0001, output_cost: 0.0002, total_cost: 0.0003 } })).toBe(0.0003);
  });

  it("is 0 for anything else", () => {
    expect(parseCost(undefined)).toBe(0);
    expect(parseCost(null)).toBe(0);
    expect(parseCost({})).toBe(0);
    expect(parseCost({ cost: "0.1" })).toBe(0);
    expect(parseCost({ cost: Number.NaN })).toBe(0);
    expect(parseCost({ cost: { total_cost: "x" } })).toBe(0);
    expect(parseCost({ cost: { input_cost: 1 } })).toBe(0);
  });
});

describe("sendModel over model_call", () => {
  it("sends purpose, only messages/max_tokens/response_format, and the per-attempt timeout; returns json and model", async () => {
    const { bridge, calls } = fakeBridge(() => ({ status: 200, json: { ok: 1 }, model: "gemini-3.6-flash" }));
    const result = await sendModel(
      modelCallTransport(bridge),
      { purpose: "text", body: { ...BODY, model: "evil/model", reasoning: { enabled: false }, url: "https://evil" } },
      OPTS,
    );
    expect(result).toEqual({ json: { ok: 1 }, model: "gemini-3.6-flash" });
    expect(calls).toEqual([{ purpose: "text", body: BODY, timeoutMs: 1234 }]);
    expect(Object.keys(calls[0].body)).toEqual(["messages", "max_tokens", "response_format"]);
  });

  it("retries 429/503/529 at most twice, then fails with model_error", async () => {
    const { bridge, calls } = fakeBridge((_p, n) => ({ status: [429, 503, 529][n] ?? 200, json: {}, model: "m" }));
    const err = await rejection(sendModel(modelCallTransport(bridge), { purpose: "chat_decision", body: BODY }, OPTS));
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: "model_error", message: expect.stringContaining("HTTP 529") });
    expect(calls).toHaveLength(3);
  });

  it("returns the reply after a retried 429", async () => {
    const { bridge, calls } = fakeBridge((_p, n) => (n === 0 ? { status: 429, json: null, model: "m" } : { status: 200, json: { ok: 2 }, model: "m" }));
    await expect(sendModel(modelCallTransport(bridge), { purpose: "text", body: BODY }, OPTS)).resolves.toEqual({ json: { ok: 2 }, model: "m" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry other statuses; 5xx/404 are unavailable, 401 is a plain model_error pointing at the popup", async () => {
    const r500 = fakeBridge(() => ({ status: 500, json: null, model: "m" }));
    const e500 = await rejection(sendModel(modelCallTransport(r500.bridge), { purpose: "text", body: BODY }, OPTS));
    expect(e500).toBeInstanceOf(ModelUnavailableError);
    expect(r500.calls).toHaveLength(1);

    const r401 = fakeBridge(() => ({ status: 401, json: { error: { message: "invalid token" } }, model: "m" }));
    const e401 = await rejection(sendModel(modelCallTransport(r401.bridge), { purpose: "text", body: BODY }, OPTS));
    expect(e401).not.toBeInstanceOf(ModelUnavailableError);
    expect(e401).toMatchObject({ code: "model_error", message: expect.stringContaining("HTTP 401") });
    expect((e401 as Error).message).toContain("TabCrew popup (Model provider)");
    expect((e401 as Error).message).toContain("invalid token");
    expect((e401 as Error).message).not.toMatch(/OpenRouter|\.tabcrew/);

    const r404 = fakeBridge(() => ({ status: 404, json: null, model: "m" }));
    const e404 = await rejection(sendModel(modelCallTransport(r404.bridge), { purpose: "text", body: BODY }, OPTS));
    expect(e404).toBeInstanceOf(ModelUnavailableError);
    expect((e404 as Error).message).toContain("TabCrew popup (Model provider)");
  });

  it("treats a 2xx reply without a JSON body as invalid JSON", async () => {
    const { bridge } = fakeBridge(() => ({ status: 200, json: null, model: "m" }));
    await expect(sendModel(modelCallTransport(bridge), { purpose: "text", body: BODY }, OPTS)).rejects.toMatchObject({
      code: "model_error",
      message: expect.stringContaining("invalid JSON"),
    });
  });

  it("passes the bridge's errors through (unavailable stays unavailable, model_not_configured keeps its code)", async () => {
    const offline = fakeBridge(() => {
      throw new ModelCallUnavailableError("timeout", "Model request timed out; no action executed.");
    });
    const e1 = await rejection(sendModel(modelCallTransport(offline.bridge), { purpose: "text", body: BODY }, OPTS));
    expect(e1).toBeInstanceOf(ModelUnavailableError);
    expect(offline.calls).toHaveLength(1);

    const none = fakeBridge(() => {
      throw new DaemonError("model_not_configured", "set a model provider in the TabCrew popup");
    });
    await expect(sendModel(modelCallTransport(none.bridge), { purpose: "text", body: BODY }, OPTS)).rejects.toMatchObject({
      code: "model_not_configured",
    });
  });

  it("refuses a request without a model_call purpose", async () => {
    const { bridge, calls } = fakeBridge(() => ({ status: 200, json: {}, model: "m" }));
    await expect(sendModel(modelCallTransport(bridge), { body: BODY }, OPTS)).rejects.toBeInstanceOf(DaemonError);
    expect(calls).toHaveLength(0);
  });
});

describe("sendModel over HTTP", () => {
  it("POSTs the full body with bearer auth and reports no model", async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return Response.json({ ok: 3 });
    });
    const body = { ...BODY, model: "x/y" };
    await expect(sendModel(httpTransport, { url: "https://x.test/v1/chat/completions", key: "k", body }, OPTS)).resolves.toEqual({
      json: { ok: 3 },
      model: undefined,
    });
    expect(seen).toEqual([{ url: "https://x.test/v1/chat/completions", auth: "Bearer k", body }]);
  });
});
