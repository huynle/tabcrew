import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2ModelCallBody, V2ModelPurpose } from "@tabcrew/shared/v2";
import { ModelCallUnavailableError, type ExtensionBridge, type ModelCallResult } from "../bridge.js";
import { DaemonError } from "../errors.js";
import { actionSpace } from "../observe.js";
import { flightsSnapshot } from "../testing/fixtures.js";
import { CHAT_DECISION, chooseChat, decider, missingDecisionKey } from "./chat.js";
import { TEXT_VALUE } from "./questions.js";
import { fieldContext, fieldText } from "./text.js";
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
  it("reads OpenRouter's number and an object-shaped {total_cost}", () => {
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

// ---------------------------------------------------------------------------
// Hub mode decisions (chat only, via model_call)
// ---------------------------------------------------------------------------

/** A chat completion: usage.cost is an object. */
function objectCostCompletion(content: string, model = "gemini-3.6-flash"): ModelCallResult {
  return {
    status: 200,
    model,
    json: {
      id: "chatcmpl-1",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1200, completion_tokens: 25, total_tokens: 1225, cost: { input_cost: 0.0001, output_cost: 0.0002, total_cost: 0.0003 } },
    },
  };
}

function hubSettings(bridge: Pick<ExtensionBridge, "modelCall">, extra: Partial<ModelSettings> = {}): ModelSettings {
  // Hub config carries no keys and (by default) the jev provider: the transport alone selects hub behaviour.
  return {
    jevModel: "typesafe/jev-1.13",
    textModel: "inception/mercury-2.5",
    openrouterApiKey: undefined,
    textModelReasoning: "none",
    retryBaseMs: 1,
    transport: modelCallTransport(bridge),
    ...extra,
  };
}

describe("hub-mode chat decisions", () => {
  const snap = flightsSnapshot();
  const space = actionSpace(snap.actions);

  it("needs no key, whatever decision provider the config names", () => {
    const { bridge } = fakeBridge(() => objectCostCompletion("{}"));
    for (const decisionProvider of ["jev", "chat", "auto"] as const) {
      expect(missingDecisionKey(hubSettings(bridge, { decisionProvider }))).toBe(false);
    }
  });

  it("always decides by chat over model_call: purpose chat_decision, no model/reasoning, model and object-shaped cost from the reply", async () => {
    const { bridge, calls } = fakeBridge(() =>
      objectCostCompletion('```json\n{"operation": "CLICK", "target": "1", "confidence": 0.7, "reason": "open picker"}\n```'),
    );
    const decide = decider(hubSettings(bridge, { decisionProvider: "jev", decisionModel: "placeholder" }));
    const d = await decide(snap, space, "Open the origin picker", []);
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe("chat_decision");
    expect(Object.keys(calls[0].body)).toEqual(["messages", "max_tokens", "response_format"]);
    expect(calls[0].body.max_tokens).toBe(400);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.messages[0]).toEqual({ role: "system", content: CHAT_DECISION });
    expect(JSON.parse(calls[0].body.messages[1].content)).toMatchObject({ goal: "Open the origin picker" });
    expect(calls[0].timeoutMs).toBe(25_000);
    expect(d).toMatchObject({
      provider: "chat",
      model: "gemini-3.6-flash",
      operation: "CLICK",
      target: "1",
      reason: "open picker",
      usage: { input_tokens: 1200, output_tokens: 25, cost: 0.0003 },
    });
  });

  it("turns model_not_configured into a model_error that points at the popup", async () => {
    const { bridge } = fakeBridge(() => {
      throw new DaemonError("model_not_configured", "set a model provider in the TabCrew popup");
    });
    const err = await rejection(chooseChat(snap, space, "g", [], hubSettings(bridge)));
    expect(err).toMatchObject({ code: "model_error", message: expect.stringContaining("TabCrew popup (Model provider)") });
    expect((err as Error).message).not.toMatch(/OpenRouter|\.tabcrew/);
  });

  it("keeps unavailability errors as ModelUnavailableError", async () => {
    const { bridge } = fakeBridge(() => {
      throw new ModelCallUnavailableError("offline", "TabCrew extension is not connected; no model call made.");
    });
    await expect(chooseChat(snap, space, "g", [], hubSettings(bridge))).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe("hub-mode text helper", () => {
  const context = () => fieldContext("Fly to Zurich", flightsSnapshot().actions[0], flightsSnapshot(), []);
  const timedOut = () => new ModelCallUnavailableError("timeout", "Model request timed out; no action executed.");
  const notConfigured = () => new DaemonError("model_not_configured", "set a model provider in the TabCrew popup");

  it("asks purpose text with only messages/max_tokens/response_format, 8 s per attempt; model and object-shaped cost from the reply", async () => {
    const { bridge, calls } = fakeBridge(() => objectCostCompletion('```json\n{"text": "Zurich"}\n```', "claude-haiku-4-5"));
    const r = await fieldText(context(), hubSettings(bridge));
    expect(r).toMatchObject({ text: "Zurich", model: "claude-haiku-4-5", cost: 0.0003 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "text", timeoutMs: 8_000 });
    expect(Object.keys(calls[0].body)).toEqual(["messages", "max_tokens", "response_format"]);
    expect(calls[0].body.max_tokens).toBe(1024);
    expect(calls[0].body.messages[0]).toEqual({ role: "system", content: TEXT_VALUE });
  });

  it("uses an explicit text timeout", async () => {
    const { bridge, calls } = fakeBridge(() => objectCostCompletion('{"text": "a"}'));
    await fieldText(context(), hubSettings(bridge, { textModelTimeoutMs: 1500 }));
    expect(calls[0].timeoutMs).toBe(1500);
  });

  it("falls back to text_fallback once when text fails", async () => {
    const { bridge, calls } = fakeBridge((purpose) => {
      if (purpose === "text") throw timedOut();
      return objectCostCompletion('{"text": "London"}', "gemini-3.1-flash-lite");
    });
    expect(await fieldText(context(), hubSettings(bridge))).toMatchObject({ text: "London", model: "gemini-3.1-flash-lite" });
    expect(calls.map((c) => c.purpose)).toEqual(["text", "text_fallback"]);
  });

  it("no fallback configured (model_not_configured): surfaces the first error", async () => {
    const { bridge, calls } = fakeBridge((purpose) => {
      if (purpose === "text") return { status: 401, json: { error: { message: "bad token" } }, model: "m" };
      throw notConfigured();
    });
    const err = await rejection(fieldText(context(), hubSettings(bridge)));
    expect(err).toMatchObject({ code: "model_error", message: expect.stringContaining("HTTP 401") });
    expect(calls.map((c) => c.purpose)).toEqual(["text", "text_fallback"]);
  });

  it("no provider at all: a model_error pointing at the popup", async () => {
    const { bridge, calls } = fakeBridge(() => {
      throw notConfigured();
    });
    const err = await rejection(fieldText(context(), hubSettings(bridge)));
    expect(err).toMatchObject({ code: "model_error", message: expect.stringContaining("TabCrew popup (Model provider)") });
    expect(calls.map((c) => c.purpose)).toEqual(["text", "text_fallback"]);
  });

  it("a failing fallback reports its own error", async () => {
    const { bridge } = fakeBridge((purpose) => {
      if (purpose === "text") throw timedOut();
      return { status: 500, json: null, model: "m" };
    });
    await expect(fieldText(context(), hubSettings(bridge))).rejects.toMatchObject({ code: "model_error", message: expect.stringContaining("HTTP 500") });
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
