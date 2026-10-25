import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeExtension, until } from "../../daemon/src/testing/helpers.js";
import type { HttpRequest } from "./egress.js";
import { EXT_ORIGIN, extLogin, startTestRelay, type FakeUser, type TestRelay } from "./testing/harness.js";

const ALICE: FakeUser = { id: "1001", login: "alice", email: "alice@example.com", name: "Alice" };
const BOB: FakeUser = { id: "2002", login: "bob", email: "bob@example.com", name: "Bob" };
const KEY = "sk-or-test-secret-9876";

let t: TestRelay;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await t.close();
});

/** A fake OpenAI-compatible provider: lists models and answers chat completions (key checked). */
function fakeProvider() {
  const calls: HttpRequest[] = [];
  const http = async (req: HttpRequest) => {
    calls.push(req);
    if (req.headers.authorization !== `Bearer ${KEY}`) return { status: 401, text: JSON.stringify({ error: { message: "invalid key" } }) };
    if (req.url.endsWith("/models")) {
      return { status: 200, text: JSON.stringify({ data: [{ id: "typesafe/jev-1.13" }, { id: "inception/mercury-2.5" }, { id: "text-embedding-3-small" }] }) };
    }
    const body = JSON.parse(req.body ?? "{}");
    return { status: 200, text: JSON.stringify({ model: body.model, choices: [{ message: { content: '{"ok": true}' } }] }) };
  };
  return { http, calls };
}

async function start(withKey = true) {
  const provider = fakeProvider();
  t = await startTestRelay({ secretsKey: withKey ? randomBytes(32) : null, modelHttp: provider.http });
  return provider;
}

async function webLogin(user: FakeUser, next = "/settings"): Promise<string> {
  t.fake.current = user;
  let url = `${t.url}/account/login?provider=github&next=${next}`;
  let cookie = "";
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const loc = res.headers.get("location");
    if (!loc) break;
    url = new URL(loc, url).toString();
    if (cookie) {
      expect(new URL(url).pathname).toBe(next);
      break;
    }
  }
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

async function page(cookie: string) {
  const res = await fetch(`${t.url}/settings`, { headers: { cookie } });
  const html = await res.text();
  return { status: res.status, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

async function submit(cookie: string, form: Record<string, string>) {
  const { csrf } = await page(cookie);
  const res = await fetch(`${t.url}/settings`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: t.url },
    body: new URLSearchParams({ csrf, ...form }).toString(),
  });
  expect(res.status).toBe(303);
  return page(cookie);
}

describe("/settings", () => {
  it("asks to sign in, and signing in returns to /settings", async () => {
    await start();
    const res = await fetch(`${t.url}/settings`);
    const html = await res.text();
    expect(html).toContain("/account/login?provider=github&amp;next=/settings");
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    await webLogin(ALICE);
  });

  it("save, load models (recommended picked), test: the key is never shown, only its last 4", async () => {
    const provider = await start();
    const cookie = await webLogin(ALICE);
    let p = await page(cookie);
    expect(p.html).toContain("No model provider yet");

    p = await submit(cookie, { preset: "openrouter", api_key: KEY, action: "load" });
    expect(p.html).toContain("2 chat models from openrouter.ai; recommended models picked");
    expect(p.html).toContain('<datalist id="models">');
    expect(p.html).not.toContain("text-embedding-3-small");
    expect(p.html).toContain('value="typesafe/jev-1.13"');
    expect(p.html).toContain("Ready");
    expect(p.html).toContain("…9876");
    expect(p.html).not.toContain(KEY);
    expect(provider.calls[0]).toMatchObject({ method: "GET", url: "https://openrouter.ai/api/v1/models" });

    // Saving again without a key keeps the saved one.
    p = await submit(cookie, { preset: "openrouter", api_key: "", decision_model: "typesafe/jev-1.13", text_model: "inception/mercury-2.5", action: "test" });
    expect(p.html).toContain("Saved and tested: typesafe/jev-1.13 answered.");
    const chat = provider.calls.at(-1)!;
    expect(chat.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(chat.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses http and a changed provider without a new key; Remove clears everything", async () => {
    await start();
    const cookie = await webLogin(ALICE);
    let p = await submit(cookie, { preset: "custom", base_url: "http://10.1.10.30:20128/v1", api_key: KEY });
    expect(p.html).toContain("https");
    expect(p.html).toContain("No model provider yet");
    await submit(cookie, { preset: "openrouter", api_key: KEY });
    p = await submit(cookie, { preset: "openai", api_key: "" });
    expect(p.html).toContain("Paste the API key for https://api.openai.com (the saved key belongs to https://openrouter.ai)");
    p = await submit(cookie, { action: "remove" });
    expect(p.html).toContain("Model settings removed");
    expect(p.html).toContain("No model provider yet");
  });

  it("each user has their own settings", async () => {
    await start();
    await submit(await webLogin(ALICE), { preset: "openrouter", api_key: KEY, decision_model: "a", text_model: "b" });
    const bob = await page(await webLogin(BOB));
    expect(bob.html).toContain("No model provider yet");
  });

  it("without RELAY_SECRETS_KEY the page says the feature is off", async () => {
    await start(false);
    const p = await page(await webLogin(ALICE));
    expect(p.html).toContain("not enabled on this relay");
  });
});

describe("browse model calls through the relay", () => {
  async function browser(user: FakeUser, features: string[]) {
    const tok = await extLogin(t, user, "home-mac");
    const ext = await FakeExtension.connect(t.port, tok.access_token, { features }, { origin: EXT_ORIGIN, path: "/ext" });
    cleanups.push(() => ext.close());
    await until(() => t.relay.tenants.ofUser([...t.relay.tenants.all()][0]?.userId ?? "").length > 0);
    const tenant = [...t.relay.tenants.all()].find((x) => x.name === "home-mac")!;
    await until(() => tenant.core.bridge.connected);
    return { ext, tenant };
  }
  const ask = (tenant: { core: { jev: { transport?: { exchange(r: unknown, ms: number): Promise<{ status: number; model?: string }> } } } }) =>
    tenant.core.jev.transport!.exchange({ purpose: "chat_decision", body: { messages: [{ role: "user", content: "hi" }], max_tokens: 10 } }, 5000);

  it("the relay calls the account's provider; a browser with own_model answers itself", async () => {
    const provider = await start();
    const cookie = await webLogin(ALICE);
    await submit(cookie, { preset: "openrouter", api_key: KEY, decision_model: "typesafe/jev-1.13", text_model: "inception/mercury-2.5" });
    const { ext, tenant } = await browser(ALICE, ["model_call", "groups", "account_model"]);
    const before = provider.calls.length;
    const reply = await ask(tenant);
    expect(reply).toMatchObject({ status: 200, model: "typesafe/jev-1.13" });
    expect(provider.calls.length).toBe(before + 1);
    expect(ext.modelCalls).toHaveLength(0);

    const settings = await page(cookie);
    expect(settings.html).not.toContain("Using their own provider instead");
    const account = await (await fetch(`${t.url}/account`, { headers: { cookie } })).text();
    expect(account).toContain("extension test · uses the account's model settings");
    await ext.close();
    const own = await browser(ALICE, ["model_call", "groups", "account_model", "own_model"]);
    expect((await ask(own.tenant)).model).toBe("test/model");
    expect(own.ext.modelCalls).toHaveLength(1);
    expect((await page(cookie)).html).toContain("Using their own provider instead (set in their popup): <b>home-mac</b>");
  });
});

describe("Browsers & agents: what browse uses per browser", () => {
  it("older extensions use their popup's provider; offline browsers say nothing; no settings is flagged", async () => {
    await start();
    const cookie = await webLogin(ALICE, "/account");
    const tok = await extLogin(t, ALICE, "old-laptop");
    const ext = await FakeExtension.connect(t.port, tok.access_token, { features: ["model_call", "groups"] }, { origin: EXT_ORIGIN, path: "/ext" });
    cleanups.push(() => ext.close());
    const tok2 = await extLogin(t, ALICE, "new-laptop");
    const ext2 = await FakeExtension.connect(t.port, tok2.access_token, { features: ["model_call", "groups", "account_model"] }, { origin: EXT_ORIGIN, path: "/ext" });
    cleanups.push(() => ext2.close());
    await until(() => t.relay.tenants.ofUser([...t.relay.tenants.all()][0]!.userId).filter((x) => x.core.bridge.connected).length === 2);
    let html = await (await fetch(`${t.url}/account`, { headers: { cookie } })).text();
    expect(html).toContain("uses its popup's provider");
    expect(html).toContain("no model provider yet");
    await ext.close();
    await until(() => !t.relay.tenants.all().next().value || [...t.relay.tenants.all()].filter((x) => x.core.bridge.connected).length === 1);
    html = await (await fetch(`${t.url}/account`, { headers: { cookie } })).text();
    expect(html.slice(html.indexOf("old-laptop"), html.indexOf("Revoke", html.indexOf("old-laptop")))).not.toContain("uses");
  });
});
