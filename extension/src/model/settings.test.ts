import { beforeEach, describe, expect, it } from "vitest";
import { createFakeChrome, type FakeChrome } from "../test/fakes.js";
import {
  PROVIDER_KEY,
  PROVIDER_PRESETS,
  clearProviderSettings,
  keyHint,
  loadProviderSettings,
  modelFor,
  normalizeBaseUrl,
  originPattern,
  parseProviderSettings,
  presetFor,
  saveProviderSettings,
  validateHeaders,
  type ProviderSettings,
} from "./settings.js";

const PROVIDER_FIXTURE: ProviderSettings = {
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  api_key: "sk-provider-secret-1234",
  headers: { "OpenAI-Organization": "org-1" },
  decision_model: "gemini-3.6-flash",
  text_model: "gemini-3.1-flash-lite",
};

describe("presets", () => {
  it("offers Provider A, Provider B, OpenRouter and Custom", () => {
    expect(PROVIDER_PRESETS.map((p) => [p.id, p.label, p.base_url])).toEqual([
      ["provider-a", "Provider A", "https://llm.example.com/v1"],
      ["provider-b", "Provider B", "https://llm2.example.com/v1"],
      ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1"],
      ["custom", "Custom", null],
    ]);
  });

  it("maps a base URL back to its preset (trailing slash ignored), anything else is custom", () => {
    expect(presetFor("https://llm.example.com/v1")).toBe("provider-a");
    expect(presetFor("https://llm2.example.com/v1/")).toBe("provider-b");
    expect(presetFor("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(presetFor("https://example.com/v1")).toBe("custom");
    expect(presetFor("")).toBe("custom");
  });
});

describe("normalizeBaseUrl", () => {
  it("accepts https and strips trailing slashes", () => {
    expect(normalizeBaseUrl(" https://llm.example.com/v1/ ")).toEqual({ ok: true, url: "https://llm.example.com/v1", origin: "https://llm.example.com" });
    expect(normalizeBaseUrl("https://host.example:8443/")).toEqual({ ok: true, url: "https://host.example:8443", origin: "https://host.example:8443" });
  });

  it("allows plain http only for localhost and 127.0.0.1", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toMatchObject({ ok: true, origin: "http://localhost:11434" });
    expect(normalizeBaseUrl("http://127.0.0.1:8080/v1")).toMatchObject({ ok: true, origin: "http://127.0.0.1:8080" });
    expect(normalizeBaseUrl("http://example.com/v1")).toEqual({ ok: false, error: "Use an https:// URL (http:// only for localhost)." });
  });

  it("rejects non-URLs, other schemes, credentials, query strings and fragments", () => {
    expect(normalizeBaseUrl("")).toEqual({ ok: false, error: "Enter the provider's base URL." });
    expect(normalizeBaseUrl("not a url").ok).toBe(false);
    expect(normalizeBaseUrl("ftp://example.com").ok).toBe(false);
    expect(normalizeBaseUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeBaseUrl("https://user:pw@example.com/v1")).toEqual({ ok: false, error: "The URL must not contain a user name or password." });
    expect(normalizeBaseUrl("https://example.com/v1?x=1")).toEqual({ ok: false, error: "The URL must not contain ? or #." });
    expect(normalizeBaseUrl("https://example.com/v1#x")).toEqual({ ok: false, error: "The URL must not contain ? or #." });
  });

  it("gives the permission pattern for an origin", () => {
    expect(originPattern("https://llm.example.com")).toBe("https://llm.example.com/*");
  });
});

describe("validateHeaders", () => {
  it("accepts ordinary headers", () => {
    expect(validateHeaders({ "OpenAI-Organization": "org-1", "X-Title": "TabCrew" })).toBeNull();
    expect(validateHeaders({})).toBeNull();
  });

  it("rejects CR/LF/NUL in names or values and invalid header names", () => {
    expect(validateHeaders({ "X-A": "a\r\nInjected: 1" })).toBe('Header "X-A" has an invalid value (line breaks are not allowed).');
    expect(validateHeaders({ "X-A\n": "a" })).toMatch(/invalid header name/);
    expect(validateHeaders({ "X A": "a" })).toMatch(/invalid header name/);
    expect(validateHeaders({ "": "a" })).toMatch(/invalid header name/);
    expect(validateHeaders({ "X-A": "a\u0000" })).toMatch(/invalid value/);
  });

  it("refuses to override reserved headers, case-insensitively", () => {
    for (const name of ["Authorization", "host", "COOKIE", "Content-Length", "origin", "Content-Type"]) {
      expect(validateHeaders({ [name]: "x" })).toBe(`Header "${name}" is set by TabCrew and can't be overridden.`);
    }
  });

  it("limits the number and size of headers", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    expect(validateHeaders(many)).toBe("At most 20 custom headers.");
    expect(validateHeaders({ "X-Big": "v".repeat(4097) })).toMatch(/too long/);
  });
});

describe("parseProviderSettings", () => {
  it("round-trips valid settings (optional fallback)", () => {
    expect(parseProviderSettings(PROVIDER_FIXTURE)).toEqual(PROVIDER_FIXTURE);
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, fallback_text_model: "claude-haiku-4-5" })).toEqual({ ...PROVIDER_FIXTURE, fallback_text_model: "claude-haiku-4-5" });
  });

  it("drops unknown fields and blank optional models", () => {
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, extra: 1, fallback_text_model: "  " })).toEqual(PROVIDER_FIXTURE);
  });

  it("rejects missing key, bad URL, bad headers or an unknown kind", () => {
    expect(parseProviderSettings(null)).toBeNull();
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, api_key: "" })).toBeNull();
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, base_url: "http://evil.example" })).toBeNull();
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, headers: { Authorization: "x" } })).toBeNull();
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, headers: { "X-A": 1 } })).toBeNull();
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, kind: "anthropic" })).toBeNull();
  });

  it("keeps empty model names as empty (configured later per purpose)", () => {
    expect(parseProviderSettings({ ...PROVIDER_FIXTURE, text_model: "" })).toEqual({ ...PROVIDER_FIXTURE, text_model: "" });
  });
});

describe("modelFor", () => {
  it("maps each purpose to its model, null when unset", () => {
    const s = { ...PROVIDER_FIXTURE, fallback_text_model: "claude-haiku-4-5" };
    expect(modelFor(s, "chat_decision")).toBe("gemini-3.6-flash");
    expect(modelFor(s, "text")).toBe("gemini-3.1-flash-lite");
    expect(modelFor(s, "text_fallback")).toBe("claude-haiku-4-5");
    expect(modelFor(PROVIDER_FIXTURE, "text_fallback")).toBeNull();
    expect(modelFor({ ...PROVIDER_FIXTURE, decision_model: "" }, "chat_decision")).toBeNull();
  });
});

describe("keyHint", () => {
  it("shows only the last 4 characters", () => {
    expect(keyHint("sk-provider-secret-1234")).toBe("1234");
    expect(keyHint("abc")).toBe("");
  });
});

describe("storage (chrome.storage.local v2:provider)", () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = createFakeChrome();
    fake.install();
  });

  it("saves, loads and clears the provider", async () => {
    expect(await loadProviderSettings()).toBeNull();
    await saveProviderSettings(PROVIDER_FIXTURE);
    expect(fake.chrome.storage.local._data()[PROVIDER_KEY]).toEqual(PROVIDER_FIXTURE);
    expect(await loadProviderSettings()).toEqual(PROVIDER_FIXTURE);
    await clearProviderSettings();
    expect(await loadProviderSettings()).toBeNull();
  });

  it("refuses to save invalid settings and ignores corrupt stored values", async () => {
    await expect(saveProviderSettings({ ...PROVIDER_FIXTURE, base_url: "http://evil.example" })).rejects.toThrow(/https/);
    await fake.chrome.storage.local.set({ [PROVIDER_KEY]: { kind: "openai-compatible", base_url: 5 } });
    expect(await loadProviderSettings()).toBeNull();
  });
});
