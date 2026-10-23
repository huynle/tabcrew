import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RELAY_URL,
  freshAccess,
  normaliseBrowserName,
  normaliseRelayUrl,
  relaySocketUrl,
  signIn,
  signOut,
  signedIn,
  type OnlineAccount,
  type OnlineDeps,
} from "./online.js";

const REDIRECT = "https://aejgcpbbemekfbmmkabpbgdkgmddfamo.chromiumapp.org/online";

function tokenResponse(n: number, extra: Record<string, unknown> = {}) {
  return { access_token: `tca.access-${n}`, token_type: "Bearer", expires_in: 900, refresh_token: `tcr_refresh-${n}`, browser_id: "b_1", ...extra };
}

/** In-memory deps: a fake relay /token and a launchWebAuthFlow that "signs in" by echoing state. */
function deps(overrides: Partial<OnlineDeps> = {}) {
  let stored: OnlineAccount | null = null;
  let issued = 0;
  const tokenCalls: Record<string, string>[] = [];
  const authUrls: URL[] = [];
  const d: OnlineDeps & { tokenCalls: typeof tokenCalls; authUrls: typeof authUrls; stored: () => OnlineAccount | null; clock: { t: number } } = {
    clock: { t: 1_000_000 },
    now: () => d.clock.t,
    redirectUrl: REDIRECT,
    load: async () => stored,
    save: async (a) => {
      stored = a;
    },
    launchWebAuthFlow: vi.fn(async ({ url }: { url: string; interactive: boolean }) => {
      const u = new URL(url);
      authUrls.push(u);
      return `${u.searchParams.get("redirect_uri")}?code=the-code&state=${u.searchParams.get("state")}`;
    }),
    fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      tokenCalls.push(form);
      if (form.grant_type === "refresh_token" && form.refresh_token !== `tcr_refresh-${issued}`) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      issued++;
      return new Response(JSON.stringify(tokenResponse(issued)), { status: 200 });
    }) as unknown as typeof fetch,
    tokenCalls,
    authUrls,
    stored: () => stored,
    ...overrides,
  };
  return d;
}

describe("relay URL and browser name", () => {
  it.each([
    ["https://tabcrew.huynle.com", "https://tabcrew.huynle.com"],
    ["https://tabcrew.huynle.com/", "https://tabcrew.huynle.com"],
    ["  https://Relay.Example:8443/ ", "https://relay.example:8443"],
    ["http://127.0.0.1:8790", "http://127.0.0.1:8790"],
    ["http://localhost:8790/", "http://localhost:8790"],
  ])("%s -> %s", (raw, want) => expect(normaliseRelayUrl(raw)).toBe(want));

  it.each(["http://relay.example", "ftp://x", "https://user:pw@relay.example", "https://relay.example/path", "https://relay.example/?q=1", "", "nope"])(
    "rejects %j",
    (raw) => expect(normaliseRelayUrl(raw)).toBeNull(),
  );

  it("socket URL is /ext on ws(s)", () => {
    expect(relaySocketUrl("https://tabcrew.huynle.com")).toBe("wss://tabcrew.huynle.com/ext");
    expect(relaySocketUrl("http://127.0.0.1:8790")).toBe("ws://127.0.0.1:8790/ext");
  });

  it("browser names are short and plain", () => {
    expect(normaliseBrowserName("  Home Mac ")).toBe("Home Mac");
    expect(normaliseBrowserName("<b>x</b>")).toBe("bxb");
    expect(normaliseBrowserName("")).toBe("browser");
    expect(normaliseBrowserName("a".repeat(80))).toHaveLength(40);
  });

  it("defaults to tabcrew.huynle.com", () => expect(DEFAULT_RELAY_URL).toBe("https://tabcrew.huynle.com"));
});

describe("signIn", () => {
  it("runs the PKCE authorization code flow and stores the account", async () => {
    const d = deps();
    const account = await signIn(d, { relayUrl: "https://tabcrew.huynle.com/", browserName: "Home Mac" });
    const auth = d.authUrls[0]!;
    expect(`${auth.origin}${auth.pathname}`).toBe("https://tabcrew.huynle.com/authorize");
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "tabcrew-extension",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      browser_name: "Home Mac",
    });
    expect(d.launchWebAuthFlow).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }));
    const form = d.tokenCalls[0]!;
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "tabcrew-extension", redirect_uri: REDIRECT });
    const challenge = createHash("sha256").update(form.code_verifier!).digest("base64url");
    expect(auth.searchParams.get("code_challenge")).toBe(challenge);
    expect(account).toMatchObject({
      relay_url: "https://tabcrew.huynle.com",
      browser_name: "Home Mac",
      browser_id: "b_1",
      access_token: "tca.access-1",
      refresh_token: "tcr_refresh-1",
      access_expires_at: 1_000_000 + 900_000,
    });
    expect(d.stored()).toEqual(account);
    expect(signedIn(account)).toBe(true);
  });

  it("refuses a redirect with the wrong state", async () => {
    const d = deps({ launchWebAuthFlow: async () => `${REDIRECT}?code=c&state=forged` });
    await expect(signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" })).rejects.toThrow(/state/);
    expect(d.tokenCalls).toHaveLength(0);
    expect(d.stored()).toBeNull();
  });

  it("reports a denied sign-in", async () => {
    const d = deps({ launchWebAuthFlow: async ({ url }) => `${REDIRECT}?error=access_denied&state=${new URL(url).searchParams.get("state")}` });
    await expect(signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" })).rejects.toThrow(/denied/);
  });

  it("refuses an invalid relay URL before opening anything", async () => {
    const d = deps();
    await expect(signIn(d, { relayUrl: "http://evil.example", browserName: "x" })).rejects.toThrow(/https/);
    expect(d.launchWebAuthFlow).not.toHaveBeenCalled();
  });
});

describe("freshAccess", () => {
  it("returns the stored token while it is fresh, refreshes when it is about to expire", async () => {
    const d = deps();
    await signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" });
    expect(await freshAccess(d)).toEqual({ url: "wss://tabcrew.huynle.com/ext", accessToken: "tca.access-1" });
    expect(d.tokenCalls).toHaveLength(1);
    d.clock.t += 900_000 - 60_000;
    expect((await freshAccess(d))?.accessToken).toBe("tca.access-2");
    expect(d.tokenCalls.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "tcr_refresh-1", client_id: "tabcrew-extension" });
    expect(d.stored()?.refresh_token).toBe("tcr_refresh-2");
  });

  it("force refreshes (after a 4401)", async () => {
    const d = deps();
    await signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" });
    expect((await freshAccess(d, { force: true }))?.accessToken).toBe("tca.access-2");
  });

  it("concurrent callers share one refresh (rotation must never race itself)", async () => {
    const d = deps();
    await signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" });
    const results = await Promise.all([freshAccess(d, { force: true }), freshAccess(d, { force: true }), freshAccess(d, { force: true })]);
    expect(new Set(results.map((r) => r?.accessToken))).toEqual(new Set(["tca.access-2"]));
    expect(d.tokenCalls.filter((f) => f.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("a rejected refresh signs out but keeps the relay URL and browser name", async () => {
    const d = deps();
    await signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "Home Mac" });
    await d.save({ ...d.stored()!, refresh_token: "tcr_revoked" });
    expect(await freshAccess(d, { force: true })).toBeNull();
    expect(d.stored()).toMatchObject({ relay_url: DEFAULT_RELAY_URL, browser_name: "Home Mac", refresh_token: null, access_token: null });
    expect(signedIn(d.stored())).toBe(false);
  });

  it("a network failure keeps the account (try again later)", async () => {
    const d = deps();
    await signIn(d, { relayUrl: DEFAULT_RELAY_URL, browserName: "x" });
    d.fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    d.clock.t += 2 * 900_000;
    expect(await freshAccess(d)).toBeNull();
    expect(signedIn(d.stored())).toBe(true);
  });

  it("is null when never signed in", async () => {
    expect(await freshAccess(deps())).toBeNull();
  });
});

describe("signOut", () => {
  it("forgets the tokens and keeps the preferences", async () => {
    const d = deps();
    await signIn(d, { relayUrl: "http://127.0.0.1:8790", browserName: "dev" });
    await signOut(d);
    expect(d.stored()).toMatchObject({ relay_url: "http://127.0.0.1:8790", browser_name: "dev", access_token: null, refresh_token: null });
  });
});
