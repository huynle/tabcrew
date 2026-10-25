import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seal, unseal } from "./crypto.js";
import { isPublicAddress, publicHttpsClient, type HttpRequest } from "./egress.js";
import { AccountModels, checkAccountSettings, relayModelTransport } from "./modelSettings.js";
import { MemoryStore } from "./store/memory.js";

const KEY = randomBytes(32);
const SETTINGS = {
  kind: "openai-compatible" as const,
  base_url: "https://llm.example.com/v1",
  api_key: "sk-test-secret-1234",
  headers: {},
  decision_model: "fast-json",
  text_model: "small",
};

describe("seal / unseal", () => {
  it("round-trips, and fails for another user, another key or a changed value", () => {
    const sealed = seal(KEY, "u_1", "hello");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("hello");
    expect(unseal(KEY, "u_1", sealed)).toBe("hello");
    expect(unseal(KEY, "u_2", sealed)).toBeNull();
    expect(unseal(randomBytes(32), "u_1", sealed)).toBeNull();
    expect(unseal(KEY, "u_1", sealed.slice(0, -2) + "AA")).toBeNull();
    expect(seal(KEY, "u_1", "hello")).not.toBe(sealed);
  });
});

describe("egress guard", () => {
  it("only public addresses pass", () => {
    for (const a of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:5", "::ffff:7f00:1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["8.8.8.8", "104.18.2.1", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("refuses http, private literal IPs and names resolving to a private address, before connecting", async () => {
    const lookups: string[] = [];
    const client = publicHttpsClient((host, _o, cb) => {
      lookups.push(host);
      cb(null, [{ address: host === "mixed.example" ? "8.8.8.8" : "10.0.0.5", family: 4 }, ...(host === "mixed.example" ? [{ address: "192.168.0.2", family: 4 }] : [])]);
    });
    const req = (url: string): HttpRequest => ({ method: "GET", url, headers: { authorization: "Bearer sk-secret" }, timeoutMs: 2000 });
    await expect(client(req("http://llm.example.com/v1/models"))).rejects.toThrow(/https/);
    await expect(client(req("https://10.0.0.1/v1/models"))).rejects.toThrow(/not a public address/);
    await expect(client(req("https://[::1]/v1/models"))).rejects.toThrow(/not a public address/);
    await expect(client(req("https://[::ffff:10.0.0.5]/v1/models"))).rejects.toThrow(/not a public address/);
    const err = await client(req("https://internal.example/v1/models")).catch((e: Error) => e);
    expect(String(err)).toMatch(/non-public address/);
    expect(String(err)).not.toContain("sk-secret");
    await expect(client(req("https://mixed.example/v1/models"))).rejects.toThrow(/non-public address/);
    expect(lookups).toEqual(["internal.example", "mixed.example"]);
  });
});

describe("checkAccountSettings", () => {
  it("accepts https providers and rejects http, localhost and missing keys", () => {
    expect(checkAccountSettings(SETTINGS)).toMatchObject({ ok: true, settings: { base_url: "https://llm.example.com/v1" } });
    expect(checkAccountSettings({ ...SETTINGS, base_url: "http://localhost:4000/v1" })).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(checkAccountSettings({ ...SETTINGS, api_key: " " })).toMatchObject({ ok: false, error: expect.stringMatching(/API key/) });
    expect(checkAccountSettings({ ...SETTINGS, headers: { Authorization: "x" } })).toMatchObject({ ok: false });
  });
});

function fakeHttp(reply: (req: HttpRequest) => { status: number; json: unknown }) {
  const calls: HttpRequest[] = [];
  const http = async (req: HttpRequest) => {
    calls.push(req);
    const r = reply(req);
    return { status: r.status, text: JSON.stringify(r.json) };
  };
  return { http, calls };
}

describe("AccountModels", () => {
  it("stores the settings sealed, never in plaintext", async () => {
    const store = new MemoryStore();
    const models = new AccountModels({ store, key: KEY });
    await models.save("u_1", SETTINGS);
    const raw = await store.getModelSettings("u_1");
    expect(raw).not.toContain("sk-test-secret");
    expect(await new AccountModels({ store, key: KEY }).get("u_1")).toEqual(SETTINGS);
    expect(await new AccountModels({ store, key: randomBytes(32) }).get("u_1")).toBeNull();
    await models.remove("u_1");
    expect(await models.get("u_1")).toBeNull();
  });

  it("is off without a key", async () => {
    const models = new AccountModels({ store: new MemoryStore(), key: null });
    expect(models.enabled).toBe(false);
    expect(await models.get("u_1")).toBeNull();
    await expect(models.save("u_1", SETTINGS)).rejects.toThrow(/not enabled/);
  });

  it("lists chat models with the key, and reports provider errors without the key", async () => {
    const { http, calls } = fakeHttp((req) =>
      req.headers.authorization === "Bearer sk-test-secret-1234"
        ? { status: 200, json: { data: [{ id: "b-chat" }, { id: "text-embedding-3" }, { id: "a-chat" }] } }
        : { status: 401, json: { error: { message: "bad key" } } },
    );
    const models = new AccountModels({ store: new MemoryStore(), key: KEY, http });
    expect(await models.listModels(SETTINGS)).toEqual({ ok: true, models: ["a-chat", "b-chat"] });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://llm.example.com/v1/models" });
    const bad = await models.listModels({ ...SETTINGS, api_key: "sk-wrong-key-0000" });
    expect(bad).toEqual({ ok: false, error: "HTTP 401: bad key (check the API key and headers)" });
  });
});

describe("relayModelTransport", () => {
  const bridge = (features: string[], modelCall = async () => ({ status: 200, json: { from: "browser" }, model: "browser-model" })) =>
    ({ features, modelCall }) as never;

  async function setup(features: string[], settings: typeof SETTINGS | null = SETTINGS) {
    const { http, calls } = fakeHttp(() => ({ status: 200, json: { model: "fast-json-2026", choices: [{ message: { content: "{}" } }] } }));
    const models = new AccountModels({ store: new MemoryStore(), key: KEY, http });
    if (settings) await models.save("u_1", settings);
    let browserCalls = 0;
    const t = relayModelTransport({
      userId: "u_1",
      models,
      bridge: bridge(features, async () => {
        browserCalls++;
        return { status: 200, json: { from: "browser" }, model: "browser-model" };
      }),
      settingsUrl: "https://relay.example/settings",
    });
    return { t, calls, browserCalls: () => browserCalls };
  }

  const request = (purpose: "chat_decision" | "text" | "text_fallback") => ({
    purpose,
    body: { messages: [{ role: "user", content: "hi" }], max_tokens: 99999, response_format: { type: "json_object" }, model: "ignored" },
  });

  it("calls the account's provider with the configured model, capped tokens and only allowed fields", async () => {
    const { t, calls, browserCalls } = await setup(["model_call", "account_model"]);
    const reply = await t.exchange(request("chat_decision"), 5000);
    expect(reply.status).toBe(200);
    expect(reply.model).toBe("fast-json-2026");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://llm.example.com/v1/chat/completions", timeoutMs: 5000 });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ model: "fast-json", messages: [{ role: "user", content: "hi" }], max_tokens: 4096, response_format: { type: "json_object" } });
    expect(browserCalls()).toBe(0);
  });

  it("uses the browser's own provider when it asked for it", async () => {
    const { t, calls, browserCalls } = await setup(["model_call", "account_model", "own_model"]);
    expect((await t.exchange(request("text"), 5000)).model).toBe("browser-model");
    expect(browserCalls()).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("without account settings: older extensions answer themselves, new ones get a clear error", async () => {
    const old = await setup(["model_call", "groups"], null);
    expect((await old.t.exchange(request("chat_decision"), 5000)).model).toBe("browser-model");
    const fresh = await setup(["model_call", "account_model"], null);
    await expect(fresh.t.exchange(request("chat_decision"), 5000)).rejects.toMatchObject({
      code: "model_error",
      message: expect.stringContaining("https://relay.example/settings"),
    });
  });

  it("no fallback model means model_not_configured (the text step then reports the first error)", async () => {
    const { t } = await setup(["model_call", "account_model"]);
    await expect(t.exchange(request("text_fallback"), 5000)).rejects.toMatchObject({ code: "model_not_configured" });
  });
});
