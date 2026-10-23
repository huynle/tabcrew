import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { V2_CLOSE_BAD_HELLO, V2_EXT_FEATURE_MODEL_CALL } from "@tabcrew/shared/v2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FakeExtension, until } from "../../daemon/src/testing/helpers.js";
import { EXT_ORIGIN, extLogin, mcpClient, mcpLogin, startTestRelay, type FakeUser, type TestRelay } from "./testing/harness.js";

const ALICE: FakeUser = { id: "1001", login: "alice", email: "alice@example.com", name: "Alice" };
const BOB: FakeUser = { id: "2002", login: "bob", email: "bob@example.com", name: "Bob" };

let t: TestRelay;
const cleanups: (() => unknown)[] = [];
beforeEach(async () => {
  t = await startTestRelay();
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await t.close();
});

async function connectExt(accessToken: string, features: string[] = []) {
  const ext = await FakeExtension.connect(t.port, accessToken, { features }, { origin: EXT_ORIGIN, path: "/ext" });
  cleanups.push(() => ext.close());
  return ext;
}

async function agent(user: FakeUser) {
  const { access_token } = await mcpLogin(t, user);
  const client = await mcpClient(t.url, access_token);
  cleanups.push(() => client.close());
  return { client, access_token };
}

async function call(client: Awaited<ReturnType<typeof mcpClient>>, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.find((c) => c.type === "text");
  const value = text && text.type === "text" ? JSON.parse(text.text) : undefined;
  return { isError: !!result.isError, value };
}

describe("Online relay end to end", () => {
  it("an agent drives the signed-in user's browser", async () => {
    const ext = await connectExt((await extLogin(t, ALICE)).access_token);
    const { client } = await agent(ALICE);
    const opened = await call(client, "session_open", { label: "agent" });
    expect(opened.isError).toBe(false);
    const created = await call(client, "tab_create", { session: opened.value.session, url: "https://example.com/" });
    expect(created.isError).toBe(false);
    expect(ext.requests.map((r) => r.op)).toContain("tab_create");
    const listed = await call(client, "tab_list", { session: opened.value.session });
    expect(listed.value.tabs).toHaveLength(1);
  });

  it("users are isolated: Bob reaches neither Alice's browser nor her sessions", async () => {
    const aliceExt = await connectExt((await extLogin(t, ALICE)).access_token);
    const alice = await agent(ALICE);
    const bob = await agent(BOB);
    const aliceSession = (await call(alice.client, "session_open", {})).value.session;

    // Bob's own session has no browser: offline, and nothing reaches Alice's extension.
    const bobSession = (await call(bob.client, "session_open", {})).value.session;
    const bobTab = await call(bob.client, "tab_create", { session: bobSession });
    expect(bobTab.isError).toBe(true);
    expect(bobTab.value.code).toBe("extension_offline");

    // Alice's handle is unknown to Bob, the same error as a made-up handle.
    const stolen = await call(bob.client, "tab_list", { session: aliceSession });
    const madeUp = await call(bob.client, "tab_list", { session: "s_AAAAAAAAAAAAAAAAAAAAAA" });
    expect(stolen.value.code).toBe("bad_session");
    expect(stolen.value).toEqual(madeUp.value);
    expect(aliceExt.requests).toHaveLength(0);
  });

  it("an MCP session id cannot be used with another user's token", async () => {
    const alice = await agent(ALICE);
    const bob = await agent(BOB);
    const sessionId = (alice.client.transport as { sessionId?: string }).sessionId!;
    const res = await fetch(`${t.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bob.access_token}`,
        "mcp-session-id": sessionId,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("browse model calls go to the user's own extension", async () => {
    await connectExt((await extLogin(t, ALICE)).access_token, [V2_EXT_FEATURE_MODEL_CALL]);
    const tenants = () => [...t.relay.tenants.all()];
    await until(() => tenants().length === 1 && tenants()[0]!.core.bridge.connected);
    const core = tenants()[0]!.core;
    expect(core.jev.transport?.kind).toBe("model_call");
    expect(core.bridge.features).toContain(V2_EXT_FEATURE_MODEL_CALL);
  });
});

describe("/ext socket", () => {
  it("refuses web origins and missing origins before any hello", async () => {
    const { access_token } = await extLogin(t, ALICE);
    for (const origin of ["https://evil.example", undefined, "chrome-extension://abcdefghijklmnopabcdefghijklmnop"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ext`, origin ? { headers: { origin } } : {});
      const outcome = await new Promise<string>((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("unexpected-response", (_q, res) => resolve(`http ${res.statusCode}`));
        ws.once("error", () => resolve("error"));
      });
      expect(outcome).toBe("http 403");
      void access_token;
    }
  });

  it("closes 4401 for a missing, forged or MCP token", async () => {
    const mcp = await mcpLogin(t, ALICE);
    for (const tok of ["", "tca.e30.AAAA", mcp.access_token]) {
      await expect(FakeExtension.connect(t.port, tok, {}, { origin: EXT_ORIGIN, path: "/ext" })).rejects.toThrow(
        `closed ${V2_CLOSE_BAD_HELLO}`,
      );
    }
  });

  it("closes 4401 when no hello arrives in time", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ext`, { headers: { origin: EXT_ORIGIN } });
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(V2_CLOSE_BAD_HELLO);
  });

  it("a newer connection of the same user replaces the older one", async () => {
    const tok = (await extLogin(t, ALICE)).access_token;
    const first = await connectExt(tok);
    const second = await connectExt(tok);
    expect((await first.closed).code).toBe(4409);
    const { client } = await agent(ALICE);
    const s = (await call(client, "session_open", {})).value.session;
    await call(client, "tab_create", { session: s });
    expect(second.requests.map((r) => r.op)).toContain("tab_create");
  });
});

describe("health", () => {
  it("reports ok without any user data", async () => {
    const res = await fetch(`${t.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) });
  });
});
