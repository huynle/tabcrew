import type { V2ModelCall } from "@tabcrew/shared/v2";
import { describe, expect, it, vi } from "vitest";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "../relay.js";
import { stubFetch } from "../test/fakes.js";
import { MAX_TOKENS_CAP, createModelProxy, redactSecrets, type ModelProxyDeps } from "./proxy.js";
import type { ProviderSettings } from "./settings.js";

const KEY = "sk-provider-very-secret-key-9876";
const SETTINGS: ProviderSettings = {
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  api_key: KEY,
  headers: { "OpenAI-Organization": "org-42" },
  decision_model: "gemini-3.6-flash",
  text_model: "gemini-3.1-flash-lite",
  fallback_text_model: "claude-haiku-4-5",
};
const CALL: V2ModelCall = {
  type: "model_call",
  id: "m1",
  purpose: "chat_decision",
  body: { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], max_tokens: 300, response_format: { type: "json_object" } },
  timeout_ms: 5_000,
};
const REPLY = { id: "c1", choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } };

function setup(overrides: Partial<ModelProxyDeps> & { settings?: unknown; granted?: boolean; reply?: (c: unknown) => unknown } = {}) {
  const stub = stubFetch(overrides.reply ?? (() => REPLY));
  const hasPermission = vi.fn(async (_pattern: string) => overrides.granted ?? true);
  const deps: ModelProxyDeps = {
    loadSettings: async () => ("settings" in overrides ? overrides.settings : SETTINGS) as ProviderSettings | null,
    hasPermission,
    fetch: stub.fetch,
    ...overrides,
  };
  return { proxy: createModelProxy(deps), calls: stub.calls, hasPermission };
}

describe("model_call proxy: configuration", () => {
  it("is model_not_configured without a provider, and never fetches", async () => {
    const { proxy, calls } = setup({ settings: null });
    expect(await proxy(CALL)).toEqual({ ok: false, error: { code: "model_not_configured", message: MODEL_NOT_CONFIGURED_MESSAGE } });
    expect(calls).toEqual([]);
  });

  it("is model_not_configured when the purpose has no model", async () => {
    const { proxy, calls } = setup({ settings: { ...SETTINGS, fallback_text_model: undefined } });
    expect(await proxy({ ...CALL, purpose: "text_fallback" })).toEqual({
      ok: false,
      error: { code: "model_not_configured", message: "no fallback text model set: set one in the TabCrew popup (Model provider)" },
    });
    const empty = setup({ settings: { ...SETTINGS, decision_model: "" } });
    expect(await empty.proxy(CALL)).toMatchObject({ ok: false, error: { code: "model_not_configured", message: expect.stringContaining("decision model") } });
    expect(calls).toEqual([]);
  });

  it("re-validates stored settings: foreign http URL or reserved/CRLF headers are refused before fetching", async () => {
    for (const settings of [
      { ...SETTINGS, base_url: "http://evil.example/v1" },
      { ...SETTINGS, base_url: "https://api.example/v1?redirect=evil" },
      { ...SETTINGS, headers: { Authorization: "Bearer other" } },
      { ...SETTINGS, headers: { Host: "evil.example" } },
      { ...SETTINGS, headers: { "X-A": "v\r\nCookie: x" } },
      { ...SETTINGS, api_key: "" },
    ]) {
      const { proxy, calls } = setup({ settings });
      const outcome = await proxy(CALL);
      expect(outcome, JSON.stringify(settings)).toMatchObject({ ok: false, error: { code: "model_not_configured" } });
      expect(calls).toEqual([]);
    }
  });

  it("checks the host permission for the base URL's origin first", async () => {
    const { proxy, calls, hasPermission } = setup({ granted: false });
    expect(await proxy(CALL)).toEqual({
      ok: false,
      error: { code: "model_not_configured", message: "grant access to https://llm.example.com in the TabCrew popup (Model provider → Save)" },
    });
    expect(hasPermission).toHaveBeenCalledWith("https://llm.example.com/*");
    expect(calls).toEqual([]);
  });

  it("treats a failing permission check as missing permission", async () => {
    const { proxy, calls } = setup({ hasPermission: async () => Promise.reject(new Error("boom")) });
    expect(await proxy(CALL)).toMatchObject({ ok: false, error: { code: "model_not_configured", message: expect.stringContaining("grant access") } });
    expect(calls).toEqual([]);
  });
});

describe("model_call proxy: request lockdown", () => {
  it("POSTs only to {base_url}/chat/completions with the model, key and custom headers injected", async () => {
    const { proxy, calls } = setup();
    expect(await proxy(CALL)).toEqual({ ok: true, result: { status: 200, json: REPLY, model: "gemini-3.6-flash" } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({
      "openai-organization": "org-42",
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(call.init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(JSON.parse(call.body!)).toEqual({
      model: "gemini-3.6-flash",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
  });

  it("injects the model per purpose", async () => {
    const { proxy, calls } = setup();
    const text = await proxy({ ...CALL, purpose: "text" });
    const fallback = await proxy({ ...CALL, purpose: "text_fallback" });
    expect(text).toMatchObject({ ok: true, result: { model: "gemini-3.1-flash-lite" } });
    expect(fallback).toMatchObject({ ok: true, result: { model: "claude-haiku-4-5" } });
    expect(calls.map((c) => JSON.parse(c.body!).model)).toEqual(["gemini-3.1-flash-lite", "claude-haiku-4-5"]);
  });

  it("whitelists the body: drops model/stream/tools/reasoning and extra message fields, caps max_tokens", async () => {
    const { proxy, calls } = setup();
    const hostile = {
      ...CALL,
      body: {
        messages: [{ role: "user", content: "hi", name: "x", tool_calls: [] }],
        max_tokens: 32_000,
        model: "openai/gpt-expensive",
        stream: true,
        tools: [{ type: "function" }],
        reasoning: { effort: "high" },
        response_format: { type: "text", json_schema: {} },
      },
      url: "https://evil.example",
      headers: { Authorization: "Bearer stolen" },
    } as unknown as V2ModelCall;
    await proxy(hostile);
    expect(calls[0].url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].body!)).toEqual({
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: MAX_TOKENS_CAP,
      response_format: { type: "text" },
    });
    expect(MAX_TOKENS_CAP).toBe(4096);
  });

  it("omits response_format when the hub sent none", async () => {
    const { proxy, calls } = setup();
    await proxy({ ...CALL, body: { messages: [{ role: "user", content: "hi" }], max_tokens: 10 } });
    expect(JSON.parse(calls[0].body!)).toEqual({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  });
});

describe("model_call proxy: replies", () => {
  it("returns ok:true with the status for any HTTP status, json null when not JSON", async () => {
    const err = { error: { message: "invalid api key" } };
    const a = setup({ reply: () => new Response(JSON.stringify(err), { status: 401 }) });
    expect(await a.proxy(CALL)).toEqual({ ok: true, result: { status: 401, json: err, model: "gemini-3.6-flash" } });
    const b = setup({ reply: () => new Response("<html>bad gateway</html>", { status: 502 }) });
    expect(await b.proxy(CALL)).toEqual({ ok: true, result: { status: 502, json: null, model: "gemini-3.6-flash" } });
    const c = setup({ reply: () => new Response(null, { status: 429 }) });
    expect(await c.proxy(CALL)).toEqual({ ok: true, result: { status: 429, json: null, model: "gemini-3.6-flash" } });
  });

  it("passes Provider' usage.cost object through untouched", async () => {
    const provider = { ...REPLY, usage: { prompt_tokens: 5, completion_tokens: 3, cost: { input_cost: 0.0001, output_cost: 0.0002, total_cost: 0.0003 } } };
    const { proxy } = setup({ reply: () => provider });
    expect(await proxy(CALL)).toEqual({ ok: true, result: { status: 200, json: provider, model: "gemini-3.6-flash" } });
  });

  it("aborts at timeout_ms with model_error", async () => {
    const { proxy, calls } = setup({ reply: () => ({ hang: true }) });
    const started = Date.now();
    expect(await proxy({ ...CALL, timeout_ms: 40 })).toEqual({ ok: false, error: { code: "model_error", message: "model call timed out after 40 ms" } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("caps the reply size", async () => {
    const big = setup({ maxReplyBytes: 100, reply: () => new Response("x".repeat(500), { status: 200 }) });
    expect(await big.proxy(CALL)).toEqual({ ok: false, error: { code: "model_error", message: "model reply larger than 100 bytes" } });
    const declared = setup({ maxReplyBytes: 100, reply: () => new Response("{}", { status: 200, headers: { "content-length": "5000" } }) });
    expect(await declared.proxy(CALL)).toMatchObject({ ok: false, error: { code: "model_error" } });
  });

  it("turns network/TLS failures into model_error with the key and header values redacted", async () => {
    const { proxy } = setup({
      reply: () => {
        throw new TypeError(`Failed to fetch: Authorization: Bearer ${KEY} org-42 net::ERR_CERT_AUTHORITY_INVALID`);
      },
    });
    const outcome = await proxy(CALL);
    expect(outcome).toMatchObject({ ok: false, error: { code: "model_error" } });
    const message = (outcome as { error: { message: string } }).error.message;
    expect(message).toContain("https://llm.example.com");
    expect(message).toContain("ERR_CERT_AUTHORITY_INVALID");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("org-42");
  });
});

describe("model_call proxy: rate limit", () => {
  it("allows at most 8 calls at once", async () => {
    const gates: (() => void)[] = [];
    const { proxy } = setup({ reply: () => new Promise((resolve) => gates.push(() => resolve(REPLY))) });
    const running = Array.from({ length: 8 }, (_, i) => proxy({ ...CALL, id: `m${i}` }));
    await vi.waitFor(() => expect(gates).toHaveLength(8));
    expect(await proxy({ ...CALL, id: "m9" })).toEqual({
      ok: false,
      error: { code: "model_error", message: "too many model calls at once (TabCrew allows 8 concurrent, 120 per minute)" },
    });
    gates.forEach((open) => open());
    expect((await Promise.all(running)).every((o) => o.ok)).toBe(true);
    const after = proxy({ ...CALL, id: "m10" });
    await vi.waitFor(() => expect(gates).toHaveLength(9));
    gates[8]();
    expect(await after).toMatchObject({ ok: true });
  });

  it("allows at most 120 calls per minute", async () => {
    let now = 1_000_000;
    const { proxy } = setup({ now: () => now });
    for (let i = 0; i < 120; i++) expect((await proxy(CALL)).ok).toBe(true);
    expect(await proxy(CALL)).toMatchObject({ ok: false, error: { code: "model_error", message: expect.stringContaining("120 per minute") } });
    now += 60_001;
    expect((await proxy(CALL)).ok).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret of at least 4 characters", () => {
    expect(redactSecrets("a KEY1234 b KEY1234", ["KEY1234"])).toBe("a [redacted] b [redacted]");
    expect(redactSecrets("ab c", ["ab", ""])).toBe("ab c");
  });
});
