import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CLOSE_BAD_HELLO, CLOSE_REPLACED, ExtensionBridge, MUTATING_OPS } from "./bridge.js";
import { daemonVersion, type RunningDaemon } from "./daemon.js";
import {
  call,
  FakeExtension,
  HOLD,
  mcpClient,
  rawHttp,
  startTestDaemon,
  tempHome,
  until,
} from "./testing/helpers.js";

let home: string;
let cleanupHome: () => void;
let daemon: RunningDaemon | null;
const clients: Client[] = [];
const extensions: FakeExtension[] = [];

beforeEach(() => {
  ({ home, cleanup: cleanupHome } = tempHome());
  daemon = null;
});

afterEach(async () => {
  for (const ext of extensions.splice(0)) ext.ws.terminate();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await daemon?.close();
  cleanupHome();
});

async function setup(overrides = {}, env: Record<string, string> = {}) {
  daemon = await startTestDaemon(home, overrides, env);
  const client = await mcpClient(daemon.mcpPort, daemon.token);
  clients.push(client);
  return { d: daemon, client };
}

async function connectExtension(d: RunningDaemon): Promise<FakeExtension> {
  const ext = await FakeExtension.connect(d.extensionPort, d.token);
  extensions.push(ext);
  return ext;
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});
const jsonHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("HTTP endpoint", () => {
  it("serves /health without auth and without secrets", async () => {
    daemon = await startTestDaemon(home);
    const res = await rawHttp(daemon.mcpPort, "GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, version: expect.any(String), extension_connected: false });
    expect(res.body).not.toContain(daemon.token);
  });

  it("returns 401 without or with a bad bearer token", async () => {
    daemon = await startTestDaemon(home);
    const none = await rawHttp(daemon.mcpPort, "POST", "/mcp", jsonHeaders, initBody);
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body).error).toBe("unauthorized");
    const bad = await rawHttp(daemon.mcpPort, "POST", "/mcp", { ...jsonHeaders, authorization: "Bearer nope" }, initBody);
    expect(bad.status).toBe(401);
    const good = await rawHttp(
      daemon.mcpPort,
      "POST",
      "/mcp",
      { ...jsonHeaders, authorization: `Bearer ${daemon.token}` },
      initBody,
    );
    expect(good.status).toBe(200);
  });

  it("returns 403 for a disallowed Origin and accepts an allowed one", async () => {
    daemon = await startTestDaemon(home, {}, { TABCREW_ALLOWED_ORIGINS: "http://allowed.test" });
    const auth = { ...jsonHeaders, authorization: `Bearer ${daemon.token}` };
    const evil = await rawHttp(daemon.mcpPort, "POST", "/mcp", { ...auth, origin: "https://evil.example" }, initBody);
    expect(evil.status).toBe(403);
    const health = await rawHttp(daemon.mcpPort, "GET", "/health", { origin: "https://evil.example" });
    expect(health.status).toBe(403);
    const allowed = await rawHttp(daemon.mcpPort, "POST", "/mcp", { ...auth, origin: "http://allowed.test" }, initBody);
    expect(allowed.status).toBe(200);
  });

  it("lists exactly the v2 tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "act",
        "browse",
        "debug_logs",
        "group_list",
        "group_rename",
        "navigate",
        "observe",
        "read_text",
        "screenshot",
        "session_close",
        "session_open",
        "tab_close",
        "tab_create",
        "tab_list",
      ].sort(),
    );
  });
});

describe("extension bridge", () => {
  it("closes with 4401 on a bad token, wrong protocol, or non-hello first frame", async () => {
    daemon = await startTestDaemon(home);
    const port = daemon.extensionPort;
    for (const first of [
      { type: "hello", protocol: 2, token: "wrong", extension_version: "x" },
      { type: "hello", protocol: 1, token: daemon.token, extension_version: "x" },
      { type: "pong", t: 1 },
    ]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((r) => ws.once("open", r));
      const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      ws.send(JSON.stringify(first));
      expect(await closed).toBe(CLOSE_BAD_HELLO);
    }
    expect(daemon.bridge.connected).toBe(false);
  });

  it("refuses handshakes from web origins and non-local Host headers", async () => {
    daemon = await startTestDaemon(home);
    const port = daemon.extensionPort;
    const attempt = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
        ws.once("open", () => {
          ws.terminate();
          resolve("open");
        });
        ws.once("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
        ws.once("error", () => resolve("error"));
      });
    expect(await attempt({ origin: "https://evil.example" })).toBe("http 401");
    expect(await attempt({ origin: "http://127.0.0.1:8000" })).toBe("http 401");
    expect(await attempt({ origin: "null" })).toBe("http 401");
    expect(await attempt({ origin: "file://" })).toBe("http 401");
    expect(await attempt({ host: "evil.example:8771" })).toBe("http 401");
    expect(await attempt({ origin: "chrome-extension://aejgcpbbemekfbmmkabpbgdkgmddfamo" })).toBe("open");
    expect(await attempt({})).toBe("open");
  });

  it("closes with 4401 when no hello arrives in time", async () => {
    daemon = await startTestDaemon(home, { helloTimeoutMs: 100 });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.extensionPort}`);
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(CLOSE_BAD_HELLO);
  });

  it("welcomes with session refs only (never handles) and replaces older connections with 4409", async () => {
    const { d, client } = await setup();
    const opened = await call(client, "session_open", { label: "alpha" });
    const ext1 = await connectExtension(d);
    expect(ext1.welcome?.sessions).toEqual([{ short_id: opened.ok && opened.value.short_id, label: "alpha" }]);
    expect(JSON.stringify(ext1.welcome)).not.toContain(opened.ok && opened.value.session);
    const health = JSON.parse((await rawHttp(d.mcpPort, "GET", "/health")).body);
    expect(health.extension_connected).toBe(true);

    await connectExtension(d);
    expect((await ext1.closed).code).toBe(CLOSE_REPLACED);
    expect(d.bridge.connected).toBe(true);
  });

  it("announces its version and the settings feature in welcome", async () => {
    const { d } = await setup();
    const ext = await connectExtension(d);
    expect(ext.welcome?.daemon_version).toBe(daemonVersion());
    expect(ext.welcome?.daemon_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(ext.welcome?.features).toEqual(["settings"]);
  });

  it("a bridge without an ext_request handler announces no settings feature", async () => {
    const bridge = new ExtensionBridge({ token: "t".repeat(32), port: 0, sessions: () => [], daemonVersion: "9.9.9" });
    const port = await bridge.start();
    try {
      const ext = await FakeExtension.connect(port, "t".repeat(32));
      extensions.push(ext);
      expect(ext.welcome?.daemon_version).toBe("9.9.9");
      expect(ext.welcome?.features).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it("drops the connection after two missed pongs", async () => {
    daemon = await startTestDaemon(home, { pingIntervalMs: 30 });
    const ext = await connectExtension(daemon);
    ext.respondToPings = false;
    await ext.closed;
    expect(daemon.bridge.connected).toBe(false);
  });
});

describe("extension bridge: shared groups", () => {
  const TOKEN = "t".repeat(32);
  const refs = [
    { short_id: "AAAAAAAA", label: "plain" },
    { short_id: "BBBBBBBB", label: "named", group: "Research" },
  ];

  async function bridgeWith(features: string[]) {
    const bridge = new ExtensionBridge({ token: TOKEN, port: 0, sessions: () => refs, offlineWaitMs: 200 });
    const port = await bridge.start();
    const ext = await FakeExtension.connect(port, TOKEN, { features });
    extensions.push(ext);
    return { bridge, ext };
  }

  it("announces session groups in welcome and requests only to an extension with the groups feature", async () => {
    const { bridge, ext } = await bridgeWith(["groups"]);
    try {
      expect(ext.welcome?.sessions).toEqual(refs);
      await bridge.request(refs[1], "tab_list", {});
      expect(ext.requests.at(-1)?.session).toEqual(refs[1]);
      expect(await bridge.request(refs[1], "group_list", {})).toEqual({ groups: [{ name: "Research", mine: true }] });
    } finally {
      await bridge.close();
    }
  });

  it("strips groups for an older extension and refuses group ops with an update hint", async () => {
    const { bridge, ext } = await bridgeWith([]);
    try {
      expect(ext.welcome?.sessions).toEqual([refs[0], { short_id: "BBBBBBBB", label: "named" }]);
      await bridge.request(refs[1], "tab_list", {});
      expect(ext.requests.at(-1)?.session).toEqual({ short_id: "BBBBBBBB", label: "named" });
      for (const op of ["group_list", "group_rename"] as const) {
        const err = await bridge.request(refs[1], op, op === "group_rename" ? { name: "X" } : {}).catch((e) => e);
        expect(err).toMatchObject({ code: "invalid_args" });
        expect(err.message).toMatch(/update the TabCrew extension/);
      }
      expect(ext.requests.some((r) => r.op === "group_list" || r.op === "group_rename")).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("treats group_rename as mutating, group_list as read-only", async () => {
    expect(MUTATING_OPS.has("group_rename")).toBe(true);
    expect(MUTATING_OPS.has("group_list")).toBe(false);
  });
});

describe("tools", () => {
  it("scopes tabs to their session", async () => {
    const { d, client } = await setup();
    await connectExtension(d);
    const a = await call(client, "session_open", { label: "A" });
    const b = await call(client, "session_open", { label: "B" });
    if (!a.ok || !b.ok) throw new Error("open failed");
    const A = a.value.session;
    const B = b.value.session;

    const tab = await call(client, "tab_create", { session: A, url: "https://example.com/" });
    expect(tab).toMatchObject({ ok: true, value: { tab_id: expect.any(Number), url: "https://example.com/" } });
    const tabId = tab.ok && tab.value.tab_id;
    await call(client, "tab_create", { session: B });

    const listA = await call(client, "tab_list", { session: A });
    expect(listA.ok && listA.value.tabs.map((t: { tab_id: number }) => t.tab_id)).toEqual([tabId]);
    const listB = await call(client, "tab_list", { session: B });
    expect(listB.ok && listB.value.tabs.map((t: { tab_id: number }) => t.tab_id)).not.toContain(tabId);

    for (const [name, args] of [
      ["tab_close", { session: B, tab_id: tabId }],
      ["screenshot", { session: B, tab_id: tabId }],
    ] as const) {
      const r = await call(client, name, args);
      expect(r).toEqual({ ok: false, error: { code: "tab_not_owned", message: expect.any(String) } });
    }

    const shot = await call(client, "screenshot", { session: A, tab_id: tabId, format: "png" });
    expect(shot.ok).toBe(true);
    const content = shot.ok ? shot.value.content : [];
    expect(content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(JSON.parse(content[1].text)).toEqual({ width: 800, height: 600, media_type: "image/png" });

    expect(await call(client, "tab_close", { session: A, tab_id: tabId })).toEqual({ ok: true, value: { closed: true } });
    const again = await call(client, "tab_close", { session: A, tab_id: tabId });
    expect(again.ok === false && again.error.code).toBe("tab_not_owned");

    const closed = await call(client, "session_close", { session: B });
    expect(closed).toEqual({
      ok: true,
      value: {
        closed: true,
        kept_tabs: 1,
        moved: true,
        note: "Your tabs were handed to the user for review; you no longer control them.",
      },
    });
    const after = await call(client, "tab_list", { session: B });
    expect(after.ok === false && after.error.code).toBe("bad_session");
  });

  it("returns bad_session for unknown handles and invalid_args for bad input", async () => {
    const { client } = await setup();
    const r = await call(client, "tab_list", { session: "s_AAAAAAAAAAAAAAAAAAAAAA" });
    expect(r).toEqual({ ok: false, error: { code: "bad_session", message: expect.any(String) } });
    const missing = await call(client, "tab_list", {});
    expect(missing.ok === false && missing.error.code).toBe("invalid_args");
    const badTab = await call(client, "tab_close", { session: "s_x", tab_id: "1" });
    expect(badTab.ok === false && badTab.error.code).toBe("invalid_args");
    const badUrl = await call(client, "tab_create", { session: "s_x", url: "not a url" });
    expect(badUrl.ok === false && badUrl.error.code).toBe("invalid_args");
  });

  it("returns extension_offline when no extension connects in time", async () => {
    const { client } = await setup({ offlineWaitMs: 100 });
    const s = await call(client, "session_open", {});
    const r = await call(client, "tab_create", { session: s.ok && s.value.session });
    expect(r).toEqual({ ok: false, error: { code: "extension_offline", message: expect.any(String) } });
  });

  it("waits for a late extension within the offline window", async () => {
    const { d, client } = await setup({ offlineWaitMs: 2000 });
    const s = await call(client, "session_open", {});
    const pending = call(client, "tab_create", { session: s.ok && s.value.session });
    await new Promise((r) => setTimeout(r, 100));
    await connectExtension(d);
    expect((await pending).ok).toBe(true);
  });

  it("fails an in-flight mutating request with outcome_unknown and a read with extension_offline on disconnect", async () => {
    const { d, client } = await setup();
    const ext = await connectExtension(d);
    const s = await call(client, "session_open", {});
    const S = s.ok && s.value.session;
    // A second session: tab_list in the same session would queue behind tab_create.
    const s2 = await call(client, "session_open", {});
    const S2 = s2.ok && s2.value.session;
    ext.handler = () => HOLD;
    const create = call(client, "tab_create", { session: S });
    const list = call(client, "tab_list", { session: S2 });
    await ext.waitForRequests(2);
    ext.ws.terminate();
    expect((await create).ok === false && ((await create) as { error: { code: string } }).error.code).toBe(
      "outcome_unknown",
    );
    const l = await list;
    expect(l.ok === false && l.error.code).toBe("extension_offline");
  });

  it("keeps several extension requests in flight at once", async () => {
    const { d, client } = await setup();
    const ext = await connectExtension(d);
    const s1 = await call(client, "session_open", {});
    const s2 = await call(client, "session_open", {});
    const release: (() => void)[] = [];
    ext.handler = (req) =>
      new Promise((resolve) => {
        release.push(() => resolve(ext.simulate(req)));
      });
    const r1 = call(client, "tab_create", { session: s1.ok && s1.value.session });
    const r2 = call(client, "tab_create", { session: s2.ok && s2.value.session });
    await ext.waitForRequests(2);
    expect(d.bridge.inFlight).toBe(2);
    release[1]();
    expect((await r2).ok).toBe(true);
    release[0]();
    expect((await r1).ok).toBe(true);
  });

  it("passes typed extension errors through and forgets gone tabs", async () => {
    const { d, client } = await setup();
    const ext = await connectExtension(d);
    const s = await call(client, "session_open", {});
    const S = s.ok && s.value.session;
    const tab = await call(client, "tab_create", { session: S });
    const tabId = tab.ok && tab.value.tab_id;
    ext.groups.clear(); // the user closed the tab behind our back
    const r = await call(client, "tab_close", { session: S, tab_id: tabId });
    expect(r.ok === false && r.error.code).toBe("tab_gone");
    const again = await call(client, "screenshot", { session: S, tab_id: tabId });
    expect(again.ok === false && again.error.code).toBe("tab_not_owned");
  });

  it("updates ownership from tab_adopted, tab_removed and groups events", async () => {
    const { d, client } = await setup();
    const ext = await connectExtension(d);
    const s = await call(client, "session_open", {});
    if (!s.ok) throw new Error("open failed");
    const { session: S, short_id } = s.value;
    const session = d.registry.use(S);

    ext.send({ type: "event", event: "tab_adopted", short_id, tab: { tab_id: 777, url: "https://x/", title: "" } });
    await until(() => session.tabs.has(777));
    ext.send({ type: "event", event: "tab_removed", short_id, tab_id: 777 });
    await until(() => !session.tabs.has(777));
    ext.send({ type: "event", event: "groups", groups: [{ short_id, tabs: [{ tab_id: 5, url: "", title: "" }] }] });
    await until(() => session.tabs.has(5));
    expect([...session.tabs]).toEqual([5]);
  });

  it("restores sessions after a daemon restart", async () => {
    const first = await setup();
    await connectExtension(first.d);
    const s = await call(first.client, "session_open", { label: "keep" });
    if (!s.ok) throw new Error("open failed");
    const tab = await call(first.client, "tab_create", { session: s.value.session });
    const tabId = tab.ok && tab.value.tab_id;
    for (const ext of extensions.splice(0)) ext.ws.terminate();
    for (const c of clients.splice(0)) await c.close();
    await first.d.close();

    const { d, client } = await setup();
    const ext = await connectExtension(d);
    expect(ext.welcome?.sessions).toEqual([{ short_id: s.value.short_id, label: "keep" }]);
    const restored = d.registry.use(s.value.session);
    expect([...restored.tabs]).toEqual([tabId]);
    ext.groups.set(s.value.short_id, [{ tab_id: tabId, url: "about:blank", title: "" }]);
    const shot = await call(client, "screenshot", { session: s.value.session, tab_id: tabId });
    expect(shot.ok).toBe(true);
  });

  it("ends idle sessions by handing their tabs to the user", async () => {
    const { d, client } = await setup({ idleTimeoutMs: 50, sweepIntervalMs: 20 });
    const ext = await connectExtension(d);
    const s = await call(client, "session_open", {});
    if (!s.ok) throw new Error("open failed");
    await until(() => d.registry.size === 0);
    await until(() => ext.requests.some((r) => r.op === "session_release"));
    expect(ext.requests.some((r) => r.op === "session_close")).toBe(false);
    const req = ext.requests.find((r) => r.op === "session_release");
    expect(req?.session.short_id).toBe(s.value.short_id);
    const r = await call(client, "tab_list", { session: s.value.session });
    expect(r.ok === false && r.error.code).toBe("bad_session");
  });
});

describe("extension requests (popup settings)", () => {
  const KEY = "sk-or-good-1234567890abcd";
  const fakeFetch = (async (_url: unknown, init?: RequestInit) =>
    new Response("{}", { status: new Headers(init?.headers).get("authorization") === `Bearer ${KEY}` ? 200 : 401 })) as typeof fetch;

  it("answers settings_get with a redacted view, matched by id", async () => {
    daemon = await startTestDaemon(home);
    const ext = await connectExtension(daemon);
    const response = await ext.extRequest("settings_get");
    expect(response).toMatchObject({
      type: "ext_response",
      id: "x1",
      ok: true,
      result: { openrouter_api_key: { source: "unset", hint: null }, jev_model: { source: "default" } },
    });
  });

  it("settings_set saves the key, never echoes it, and the next browse sees it", async () => {
    daemon = await startTestDaemon(home, { fetch: fakeFetch });
    const ext = await connectExtension(daemon);
    expect(daemon.jev.settings.openrouterApiKey).toBeUndefined();
    const response = await ext.extRequest("settings_set", { openrouter_api_key: KEY, jev_model: "a/jev" });
    expect(response).toMatchObject({ ok: true, result: { updated: ["openrouter_api_key", "jev_model"], warnings: [] } });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(daemon.jev.settings.openrouterApiKey).toBe(KEY);
    expect(daemon.jev.settings.jevModel).toBe("a/jev");
  });

  it("answers errors as ok:false with a typed code (invalid key, unknown op, bad id ignored)", async () => {
    daemon = await startTestDaemon(home, { fetch: fakeFetch });
    const ext = await connectExtension(daemon);
    expect(await ext.extRequest("settings_set", { openrouter_api_key: "sk-or-nope-00000000" })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: expect.stringMatching(/rejected/) },
    });
    expect(await ext.extRequest("tab_list")).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    // A frame without a string id gets no answer and does not break the connection.
    ext.send({ type: "ext_request", op: "settings_get", args: {} });
    expect(await ext.extRequest("settings_get")).toMatchObject({ ok: true });
  });

  it("rejects ext_request before hello with 4401", async () => {
    daemon = await startTestDaemon(home);
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.extensionPort}`);
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    const replies: string[] = [];
    ws.on("message", (d) => replies.push(d.toString()));
    ws.send(JSON.stringify({ type: "ext_request", id: "x", op: "settings_get", args: {} }));
    expect(await closed).toBe(CLOSE_BAD_HELLO);
    expect(replies).toEqual([]);
  });
});
