import { describe, expect, it } from "vitest";
import { stubFetch } from "../test/fakes.js";
import { checkChat, listModels, probeProvider, type ProbeInput } from "./probe.js";

const KEY = "sk-provider-very-secret-key-9876";
const INPUT: ProbeInput = {
  base_url: "https://llm.example.com/v1",
  api_key: KEY,
  headers: { "OpenAI-Organization": "org-42" },
  decision_model: "gemini-3.6-flash",
};
const MODELS = { object: "list", data: [{ id: "gemini-3.6-flash" }, { id: "claude-haiku-4-5" }, { id: "gemini-3.6-flash" }, { nope: 1 }] };
const CHAT = { choices: [{ message: { role: "assistant", content: '{"ok":true}' } }], usage: { cost: { total_cost: 0.0001 } } };

function clock() {
  let t = 0;
  return () => (t += 250);
}

describe("probeProvider", () => {
  it("lists /models and runs a tiny json chat call with the decision model", async () => {
    const { fetch, calls } = stubFetch((c) => (c.url.endsWith("/models") ? MODELS : CHAT));
    expect(await probeProvider(INPUT, { fetch, now: clock() })).toEqual({
      models: ["claude-haiku-4-5", "gemini-3.6-flash"],
      models_error: null,
      chat: { ok: true, model: "gemini-3.6-flash", ms: 250 },
    });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://llm.example.com/v1/models"],
      ["POST", "https://llm.example.com/v1/chat/completions"],
    ]);
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(c.headers["openai-organization"]).toBe("org-42");
      expect(c.init).toMatchObject({ credentials: "omit", redirect: "error" });
    }
    expect(calls[0].body).toBeNull();
    expect(JSON.parse(calls[1].body!)).toMatchObject({ model: "gemini-3.6-flash", max_tokens: 20, response_format: { type: "json_object" } });
  });

  it("skips the chat call without a decision model", async () => {
    const { fetch, calls } = stubFetch(() => MODELS);
    expect(await probeProvider({ ...INPUT, decision_model: "" }, { fetch, now: clock() })).toEqual({
      models: ["claude-haiku-4-5", "gemini-3.6-flash"],
      models_error: null,
      chat: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports HTTP errors with the provider's message and a hint, key redacted", async () => {
    const { fetch } = stubFetch((c) =>
      c.url.endsWith("/models")
        ? new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 })
        : new Response(JSON.stringify({ error: { message: "model gemini-x not found" } }), { status: 404 }),
    );
    const result = await probeProvider(INPUT, { fetch, now: clock() });
    expect(result.models).toEqual([]);
    expect(result.models_error).toBe("HTTP 401: invalid key [redacted] (check the API key and headers)");
    expect(result.chat).toEqual({ ok: false, error: "HTTP 404: model gemini-x not found (check the model name and base URL)" });
  });

  it("still tries the chat call when /models is missing", async () => {
    const { fetch } = stubFetch((c) => (c.url.endsWith("/models") ? new Response("not found", { status: 404 }) : CHAT));
    const result = await probeProvider(INPUT, { fetch, now: clock() });
    expect(result.models_error).toBe("HTTP 404: not found (check the model name and base URL)");
    expect(result.chat).toMatchObject({ ok: true });
  });

  it("reports network failures and timeouts without the key", async () => {
    const { fetch } = stubFetch((c) => {
      if (c.url.endsWith("/models")) throw new TypeError(`Failed to fetch ${KEY}`);
      return { hang: true };
    });
    const result = await probeProvider(INPUT, { fetch, now: clock(), timeoutMs: 30 });
    expect(result.models_error).toBe("model request to https://llm.example.com failed: Failed to fetch [redacted]");
    expect(result.chat).toEqual({ ok: false, error: "model call timed out after 30 ms" });
  });

  it("refuses an invalid base URL without fetching", async () => {
    const { fetch, calls } = stubFetch(() => MODELS);
    const result = await probeProvider({ ...INPUT, base_url: "http://evil.example" }, { fetch });
    expect(result).toEqual({ models: [], models_error: "Use an https:// URL (http:// only for localhost).", chat: null });
    expect(calls).toEqual([]);
  });
});

describe("listModels", () => {
  const CONN = { base_url: INPUT.base_url, api_key: KEY, headers: INPUT.headers };

  it("needs only the URL, key and headers: one GET /models, sorted unique ids", async () => {
    const { fetch, calls } = stubFetch(() => MODELS);
    expect(await listModels(CONN, { fetch })).toEqual({ ok: true, models: ["claude-haiku-4-5", "gemini-3.6-flash"] });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://llm.example.com/v1/models"]]);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers["openai-organization"]).toBe("org-42");
    expect(calls[0].init).toMatchObject({ credentials: "omit", redirect: "error" });
  });

  it("reports HTTP and network errors with hints, key redacted", async () => {
    const denied = stubFetch(() => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 403 }));
    expect(await listModels(CONN, { fetch: denied.fetch })).toEqual({
      ok: false,
      error: "HTTP 403: bad key [redacted] (check the API key and headers)",
    });
    const offline = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await listModels(CONN, { fetch: offline.fetch })).toEqual({
      ok: false,
      error: "model request to https://llm.example.com failed: Failed to fetch",
    });
  });

  it("refuses an invalid base URL without fetching", async () => {
    const { fetch, calls } = stubFetch(() => MODELS);
    expect(await listModels({ ...CONN, base_url: "ftp://x" }, { fetch })).toEqual({
      ok: false,
      error: "Use an https:// URL (http:// only for localhost).",
    });
    expect(calls).toEqual([]);
  });
});

describe("checkChat", () => {
  it("sends one json_object chat call with the decision model", async () => {
    const { fetch, calls } = stubFetch(() => CHAT);
    expect(await checkChat(INPUT, { fetch, now: clock() })).toEqual({ ok: true, model: "gemini-3.6-flash", ms: 250 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["POST", "https://llm.example.com/v1/chat/completions"]]);
  });

  it("is null without a decision model", async () => {
    const { fetch, calls } = stubFetch(() => CHAT);
    expect(await checkChat({ ...INPUT, decision_model: " " }, { fetch })).toBeNull();
    expect(calls).toEqual([]);
  });
});
