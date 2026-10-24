import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorize,
  EXT_ORIGIN,
  EXT_REDIRECT,
  extLogin,
  mcpLogin,
  pkce,
  providerForm,
  register,
  startTestRelay,
  submitProvider,
  token,
  type TestRelay,
} from "./testing/harness.js";

let t: TestRelay;
beforeEach(async () => {
  t = await startTestRelay();
});
afterEach(async () => {
  await t.close();
});

const REDIRECT = "http://127.0.0.1:9999/callback";

describe("discovery", () => {
  it("serves authorization server metadata (RFC 8414)", async () => {
    const meta = await (await fetch(`${t.url}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({
      issuer: t.url,
      authorization_endpoint: `${t.url}/authorize`,
      token_endpoint: `${t.url}/token`,
      registration_endpoint: `${t.url}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("serves protected resource metadata for /mcp (RFC 9728)", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const meta = await (await fetch(`${t.url}${path}`)).json();
      expect(meta).toMatchObject({ resource: `${t.url}/mcp`, authorization_servers: [t.url] });
    }
  });

  it("/mcp without a token is 401 and points at the resource metadata", async () => {
    const res = await fetch(`${t.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${t.url}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("dynamic client registration", () => {
  it("registers a public client with loopback or https redirect URIs", async () => {
    const reg = await register(t.url, { redirect_uris: [REDIRECT, "https://agent.example/cb"] });
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({
      client_name: "Test agent",
      redirect_uris: [REDIRECT, "https://agent.example/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(reg.json.client_id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(reg.json.client_secret).toBeUndefined();
  });

  it.each([
    [{ redirect_uris: [] }],
    [{ redirect_uris: ["http://evil.example/cb"] }],
    [{ redirect_uris: ["https://a.example/cb#frag"] }],
    [{ redirect_uris: ["javascript:alert(1)"] }],
    [{ redirect_uris: [EXT_REDIRECT] }],
    [{ token_endpoint_auth_method: "client_secret_basic" }],
  ])("rejects %j", async (body) => {
    const reg = await register(t.url, body);
    expect(reg.status).toBe(400);
    expect(reg.json.error).toBe("invalid_client_metadata");
  });
});

describe("authorization code flow", () => {
  it("signs in through GitHub and issues mcp tokens", async () => {
    const tokens = await mcpLogin(t);
    expect(tokens.access_token).toMatch(/^tca\./);
    expect(tokens.refresh_token).toMatch(/^tcr_/);
  });

  it("the same person through GitHub and Google are two different users (no auto-linking by email)", async () => {
    const a = await mcpLogin(t, undefined, "github");
    const b = await mcpLogin(t, undefined, "google");
    const sub = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1]!, "base64url").toString()).sub;
    expect(sub(a.access_token)).not.toBe(sub(b.access_token));
  });

  it("returns the client's state and only to the registered redirect URI", async () => {
    const reg = await register(t.url);
    const { challenge } = pkce();
    const ok = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: REDIRECT, challenge, state: "xyz" });
    expect(ok.location?.origin + ok.location!.pathname).toBe(REDIRECT);
    expect(ok.location?.searchParams.get("state")).toBe("xyz");
    const bad = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: "http://127.0.0.1:9999/other", challenge });
    expect(bad.status).toBe(400);
    expect(bad.location).toBeNull();
  });

  it("accepts any port for a registered loopback redirect (RFC 8252)", async () => {
    const reg = await register(t.url);
    const { challenge } = pkce();
    const ok = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: "http://127.0.0.1:41234/callback", challenge });
    expect(ok.location?.port).toBe("41234");
  });

  it("requires PKCE S256", async () => {
    const reg = await register(t.url);
    const plain = await authorize(t.url, {
      clientId: reg.json.client_id,
      redirectUri: REDIRECT,
      challenge: "x".repeat(43),
      extra: { code_challenge_method: "plain" },
    });
    expect(plain.status).toBe(400);
  });

  it("rejects unknown clients", async () => {
    const res = await authorize(t.url, { clientId: "nope", redirectUri: REDIRECT, challenge: pkce().challenge });
    expect(res.status).toBe(400);
  });

  it("codes are single use and bound to the verifier, client and redirect", async () => {
    const reg = await register(t.url);
    const { verifier, challenge } = pkce();
    const auth = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: REDIRECT, challenge });
    const code = auth.location!.searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, client_id: reg.json.client_id, redirect_uri: REDIRECT, code_verifier: verifier };
    expect((await token(t.url, { ...form, code_verifier: pkce().verifier })).json.error).toBe("invalid_grant");
    // a failed attempt burns the code too
    expect((await token(t.url, form)).json.error).toBe("invalid_grant");

    const auth2 = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: REDIRECT, challenge });
    const form2 = { ...form, code: auth2.location!.searchParams.get("code")! };
    const other = await register(t.url);
    expect((await token(t.url, { ...form2, client_id: other.json.client_id })).json.error).toBe("invalid_grant");

    const auth3 = await authorize(t.url, { clientId: reg.json.client_id, redirectUri: REDIRECT, challenge });
    const form3 = { ...form, code: auth3.location!.searchParams.get("code")! };
    expect((await token(t.url, form3)).status).toBe(200);
    expect((await token(t.url, form3)).json.error).toBe("invalid_grant");
  });

  it("a replayed provider callback is refused", async () => {
    const reg = await register(t.url);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.json.client_id,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    const html = await (await fetch(`${t.url}/authorize?${q}`)).text();
    const toProvider = await submitProvider(t.url, html, "github");
    const toRelay = await fetch(toProvider.headers.get("location")!, { redirect: "manual" });
    const callback = toRelay.headers.get("location")!;
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  });

  describe("the one-time sign-in step survives browser link preloading", () => {
    async function page() {
      const reg = await register(t.url);
      const q = new URLSearchParams({
        response_type: "code",
        client_id: reg.json.client_id,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      });
      const res = await fetch(`${t.url}/authorize?${q}`);
      return { html: await res.text(), csp: res.headers.get("content-security-policy") ?? "" };
    }

    it("buttons are POST forms: no link carries the one-time txn", async () => {
      const { html, csp } = await page();
      expect(html).not.toMatch(/href="[^"]*txn=/);
      expect(providerForm(html, "github").txn).toMatch(/.{20,}/);
      expect(providerForm(html, "google").txn).toMatch(/.{20,}/);
      expect(csp).toContain("form-action 'self'");
    });

    it("a prefetch or a plain GET does not use up the txn", async () => {
      const { html } = await page();
      const { txn } = providerForm(html, "github");
      const prefetch = await fetch(`${t.url}/auth/github?txn=${txn}`, { redirect: "manual", headers: { "sec-purpose": "prefetch" } });
      expect(prefetch.status).toBe(204);
      const get = await fetch(`${t.url}/auth/github?txn=${txn}`, { redirect: "manual" });
      expect(get.status).toBe(405);
      expect((await submitProvider(t.url, html, "github")).status).toBe(302);
      // ...and it is still single use.
      expect((await submitProvider(t.url, html, "github")).status).toBe(400);
    });
  });

  it("sends the provider the relay's own callback URL", async () => {
    await mcpLogin(t);
    expect(t.fake.tokenRequests.at(-1)?.redirect_uri).toBe(`${t.url}/auth/github/callback`);
  });
});

describe("refresh tokens", () => {
  it("rotate: a refresh gives a new pair and the old refresh token stops working", async () => {
    const first = await mcpLogin(t);
    const r1 = await token(t.url, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(first.refresh_token);
    const r2 = await token(t.url, { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: first.clientId });
    expect(r2.status).toBe(200);
  });

  it("reuse of a rotated refresh token revokes the whole family", async () => {
    const first = await mcpLogin(t);
    const r1 = await token(t.url, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
    const replay = await token(t.url, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
    expect(replay.json.error).toBe("invalid_grant");
    const next = await token(t.url, { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: first.clientId });
    expect(next.json.error).toBe("invalid_grant");
  });

  it("are bound to their client", async () => {
    const first = await mcpLogin(t);
    const other = await register(t.url);
    const r = await token(t.url, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: other.json.client_id });
    expect(r.json.error).toBe("invalid_grant");
  });
});

describe("/token CORS", () => {
  it("lets the TabCrew extension read token replies and nobody else", async () => {
    const pre = await fetch(`${t.url}/token`, { method: "OPTIONS", headers: { origin: EXT_ORIGIN } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    const ok = await fetch(`${t.url}/token`, {
      method: "POST",
      headers: { origin: EXT_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=nope&client_id=tabcrew-extension",
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect((await ok.json()).error).toBe("invalid_grant");
    const web = await fetch(`${t.url}/token`, { method: "POST", headers: { origin: "https://evil.example" }, body: "" });
    expect(web.status).toBe(403);
    expect(web.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("extension client", () => {
  it("signs in with a chromiumapp.org redirect and gets an ext token and browser id", async () => {
    const ext = await extLogin(t);
    expect(ext.access_token).toMatch(/^tca\./);
    expect(ext.browser_id).toMatch(/^b_/);
    // same browser name again: same browser
    expect((await extLogin(t)).browser_id).toBe(ext.browser_id);
    expect((await extLogin(t, undefined, "work-laptop")).browser_id).not.toBe(ext.browser_id);
  });

  it("only allows chromiumapp.org redirects of known TabCrew extension IDs", async () => {
    const { challenge } = pkce();
    const res = await authorize(t.url, {
      clientId: "tabcrew-extension",
      redirectUri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb",
      challenge,
    });
    expect(res.status).toBe(400);
  });

  it("extension tokens cannot call /mcp", async () => {
    const ext = await extLogin(t);
    const res = await fetch(`${t.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${ext.access_token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("forged or expired access tokens are refused", async () => {
    const { access_token } = await mcpLogin(t);
    const [p, payload, sig] = access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = `${p}.${Buffer.from(JSON.stringify({ ...claims, sub: "u_someone_else" })).toString("base64url")}.${sig}`;
    for (const bad of [forged, `${access_token}x`, "tca.e30.AAAA"]) {
      const res = await fetch(`${t.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bad}` }, body: "{}" });
      expect(res.status).toBe(401);
    }
  });
});
