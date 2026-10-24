import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, flush, stubFetch, type FakeChrome } from "../test/fakes.js";
import { PROVIDER_KEY } from "./settings.js";

const KEY = "sk-test-very-secret-key-9876";
const CALL = {
  type: "model_call",
  id: "m1",
  purpose: "text",
  body: { messages: [{ role: "user", content: "hi" }], max_tokens: 50, model: "evil/model" },
  timeout_ms: 10_000,
};
const REPLY = { choices: [{ message: { content: "hello" } }], usage: { cost: { input_cost: 1, output_cost: 2, total_cost: 3 } } };

let fake: FakeChrome;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
});
afterEach(() => vi.unstubAllGlobals());

describe("service worker model_call wiring (hub mode)", () => {
  it("answers model_call through the provider proxy with the stored settings", async () => {
    const stub = stubFetch(() => REPLY);
    vi.stubGlobal("fetch", stub.fetch);
    await fake.chrome.storage.local.set({
      [PROVIDER_KEY]: {
        kind: "openai-compatible",
        base_url: "https://llm.example.com/v1",
        api_key: KEY,
        headers: {},
        decision_model: "gemini-3.6-flash",
        text_model: "gemini-3.1-flash-lite",
      },
    });
    fake.grantedOrigins.add("https://llm.example.com/*");
    vi.resetModules();
    await import("../service-worker.js");
    await settle();
    const port = fake.chrome.runtime.connect({ name: "v2-bridge" });
    port.postMessage({ type: "status", status: "connected" });
    port.postMessage({ type: "model_call", call: CALL });
    await settle();
    expect(port.messages().filter((m) => m.type === "model_result")).toEqual([
      { type: "model_result", result: { type: "model_result", id: "m1", ok: true, result: { status: 200, json: REPLY, model: "gemini-3.1-flash-lite" } } },
    ]);
    expect(stub.calls.map((c) => c.url)).toEqual(["https://llm.example.com/v1/chat/completions"]);
    expect(JSON.parse(stub.calls[0].body!).model).toBe("gemini-3.1-flash-lite");
    expect(JSON.stringify(port.messages())).not.toContain(KEY);
  });

  it("asks for the host permission when it was not granted", async () => {
    const stub = stubFetch(() => REPLY);
    vi.stubGlobal("fetch", stub.fetch);
    await fake.chrome.storage.local.set({
      [PROVIDER_KEY]: {
        kind: "openai-compatible",
        base_url: "https://llm.example.com/v1",
        api_key: KEY,
        headers: {},
        decision_model: "d",
        text_model: "t",
      },
    });
    vi.resetModules();
    await import("../service-worker.js");
    await settle();
    const port = fake.chrome.runtime.connect({ name: "v2-bridge" });
    port.postMessage({ type: "model_call", call: CALL });
    await settle();
    expect(port.messages().filter((m) => m.type === "model_result")).toMatchObject([
      { result: { ok: false, error: { code: "model_not_configured", message: expect.stringContaining("grant access") } } },
    ]);
    expect(stub.calls).toEqual([]);
  });
});
