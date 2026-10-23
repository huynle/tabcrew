import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeExtension } from "../../daemon/src/testing/helpers.js";
import { EXT_ORIGIN, extLogin, mcpClient, mcpLogin, startTestRelay, token, type FakeUser, type TestRelay } from "./testing/harness.js";

const ALICE: FakeUser = { id: "1001", login: "alice", email: "alice@example.com", name: "Alice" };
const BOB: FakeUser = { id: "2002", login: "bob", email: "bob@example.com", name: "Bob" };

let t: TestRelay;
beforeEach(async () => {
  t = await startTestRelay();
});
afterEach(async () => {
  await t.close();
});

/** Sign in to /account as `user`; returns the cookie header to send. */
async function accountLogin(user: FakeUser): Promise<string> {
  t.fake.current = user;
  const page = await fetch(`${t.url}/account`, { redirect: "manual" });
  const html = await page.text();
  const href = /href="(\/account\/login\?provider=github[^"]*)"/.exec(html)?.[1];
  if (!href) throw new Error(`no sign-in link: ${html.slice(0, 200)}`);
  let next = new URL(href.replace(/&amp;/g, "&"), t.url).toString();
  let cookie = "";
  for (let i = 0; i < 4; i++) {
    const res = await fetch(next, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const loc = res.headers.get("location");
    if (!loc) break;
    next = new URL(loc, next).toString();
    if (new URL(next).pathname === "/account") break;
  }
  if (!cookie) throw new Error("no account cookie");
  return cookie;
}

async function accountPage(cookie: string) {
  const res = await fetch(`${t.url}/account`, { headers: { cookie } });
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: res.status, html, csrf };
}

function post(path: string, cookie: string, form: Record<string, string>) {
  return fetch(`${t.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: t.url },
    body: new URLSearchParams(form).toString(),
  });
}

describe("/account", () => {
  it("asks to sign in when there is no session", async () => {
    const res = await fetch(`${t.url}/account`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/account/login?provider=github");
    expect(html).toContain("/account/login?provider=google");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("sets a hardened cookie and lists the user's browsers and agents", async () => {
    await extLogin(t, ALICE, "home-mac");
    await mcpLogin(t, ALICE);
    const login = await fetch(`${t.url}/account`); // warm up
    void login;
    const cookie = await accountLogin(ALICE);
    const page = await accountPage(cookie);
    expect(page.html).toContain("home-mac");
    expect(page.html).toContain("Test agent");
    expect(page.csrf).toMatch(/.{20,}/);
  });

  it("the cookie is HttpOnly and SameSite=Lax", async () => {
    t.fake.current = ALICE;
    const html = await (await fetch(`${t.url}/account`)).text();
    const href = /href="(\/account\/login\?provider=github[^"]*)"/.exec(html)![1]!;
    let next = new URL(href.replace(/&amp;/g, "&"), t.url).toString();
    let setCookie = "";
    for (let i = 0; i < 4 && !setCookie; i++) {
      const res = await fetch(next, { redirect: "manual" });
      setCookie = res.headers.get("set-cookie") ?? "";
      next = new URL(res.headers.get("location") ?? "/", next).toString();
    }
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
  });

  it("revoking a browser ends its sign-in and disconnects it, and it cannot reconnect", async () => {
    const ext = await extLogin(t, ALICE, "home-mac");
    const fake = await FakeExtension.connect(t.port, ext.access_token, {}, { origin: EXT_ORIGIN, path: "/ext" });
    const cookie = await accountLogin(ALICE);
    const { csrf } = await accountPage(cookie);
    const res = await post("/account/revoke-browser", cookie, { csrf, browser_id: ext.browser_id });
    expect(res.status).toBe(303);
    expect((await fake.closed).code).toBe(4401);
    const refresh = await token(t.url, { grant_type: "refresh_token", refresh_token: ext.refresh_token, client_id: "tabcrew-extension" });
    expect(refresh.json.error).toBe("invalid_grant");
    // The still-unexpired access token no longer gets in.
    await expect(FakeExtension.connect(t.port, ext.access_token, {}, { origin: EXT_ORIGIN, path: "/ext" })).rejects.toThrow("closed 4401");
    expect((await accountPage(cookie)).html).not.toContain("home-mac");
  });

  it("revoking an agent ends its refresh token and its access token at once", async () => {
    const agent = await mcpLogin(t, ALICE);
    const client = await mcpClient(t.url, agent.access_token);
    const cookie = await accountLogin(ALICE);
    const { csrf } = await accountPage(cookie);
    expect((await post("/account/revoke-client", cookie, { csrf, client_id: agent.clientId })).status).toBe(303);
    const refresh = await token(t.url, { grant_type: "refresh_token", refresh_token: agent.refresh_token, client_id: agent.clientId });
    expect(refresh.json.error).toBe("invalid_grant");
    await expect(client.listTools()).rejects.toThrow();
    const res = await fetch(`${t.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agent.access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("refuses revokes without the CSRF token or from another origin", async () => {
    const ext = await extLogin(t, ALICE, "home-mac");
    const cookie = await accountLogin(ALICE);
    const { csrf } = await accountPage(cookie);
    expect((await post("/account/revoke-browser", cookie, { csrf: "wrong", browser_id: ext.browser_id })).status).toBe(403);
    const cross = await fetch(`${t.url}/account/revoke-browser`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ csrf, browser_id: ext.browser_id }).toString(),
    });
    expect(cross.status).toBe(403);
    const refresh = await token(t.url, { grant_type: "refresh_token", refresh_token: ext.refresh_token, client_id: "tabcrew-extension" });
    expect(refresh.status).toBe(200);
  });

  it("one user cannot revoke another user's browser", async () => {
    const bobExt = await extLogin(t, BOB, "bob-pc");
    const cookie = await accountLogin(ALICE);
    const { csrf } = await accountPage(cookie);
    expect((await post("/account/revoke-browser", cookie, { csrf, browser_id: bobExt.browser_id })).status).toBe(404);
    const refresh = await token(t.url, { grant_type: "refresh_token", refresh_token: bobExt.refresh_token, client_id: "tabcrew-extension" });
    expect(refresh.status).toBe(200);
  });

  it("sign out clears the cookie", async () => {
    const cookie = await accountLogin(ALICE);
    const { csrf } = await accountPage(cookie);
    const res = await post("/account/logout", cookie, { csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});
