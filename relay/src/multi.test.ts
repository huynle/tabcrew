import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function browser(user: FakeUser, name: string) {
  const tok = await extLogin(t, user, name);
  const ext = await FakeExtension.connect(t.port, tok.access_token, {}, { origin: EXT_ORIGIN, path: "/ext" });
  cleanups.push(() => ext.close());
  return { ext, ...tok };
}

async function agent(user: FakeUser) {
  const { access_token } = await mcpLogin(t, user);
  const client = await mcpClient(t.url, access_token);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.find((c) => c.type === "text");
    return { isError: !!result.isError, value: text && text.type === "text" ? JSON.parse(text.text) : undefined };
  };
  return { client, call };
}

describe("several browsers per user", () => {
  it("lists the browsers with their online state", async () => {
    const home = await browser(ALICE, "home-mac");
    await browser(ALICE, "work-laptop");
    const { call, client } = await agent(ALICE);
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toContain("browser_list");
    const open = tools.tools.find((x) => x.name === "session_open")!;
    expect(Object.keys(open.inputSchema.properties ?? {})).toContain("browser");

    let list = await call("browser_list");
    expect(list.value.browsers.map((b: any) => [b.name, b.online]).sort()).toEqual([
      ["home-mac", true],
      ["work-laptop", true],
    ]);
    home.ext.close();
    await until(() => [...t.relay.tenants.all()].some((b) => b.name === "home-mac" && !b.core.bridge.connected));
    list = await call("browser_list");
    expect(list.value.browsers.find((b: any) => b.name === "home-mac").online).toBe(false);
  });

  it("session_open goes to the named browser, or the most recently connected one", async () => {
    const home = await browser(ALICE, "home-mac");
    const work = await browser(ALICE, "work-laptop");
    const { call } = await agent(ALICE);

    const s1 = await call("session_open", { browser: "home-mac" });
    expect(s1.value.browser).toBe("home-mac");
    await call("tab_create", { session: s1.value.session });
    expect(home.ext.requests.map((r) => r.op)).toContain("tab_create");
    expect(work.ext.requests).toHaveLength(0);

    const s2 = await call("session_open", {});
    expect(s2.value.browser).toBe("work-laptop");
    await call("tab_create", { session: s2.value.session });
    expect(work.ext.requests.map((r) => r.op)).toContain("tab_create");

    // Every later call with a handle goes to the browser it was opened in.
    await call("tab_list", { session: s1.value.session });
    expect(home.ext.requests.map((r) => r.op)).toContain("tab_list");
    expect(work.ext.requests.map((r) => r.op)).not.toContain("tab_list");
  });

  it("an unknown browser name lists the known ones", async () => {
    await browser(ALICE, "home-mac");
    const { call } = await agent(ALICE);
    const res = await call("session_open", { browser: "nope" });
    expect(res.isError).toBe(true);
    expect(res.value.code).toBe("invalid_args");
    expect(res.value.message).toContain("home-mac");
  });

  it("with no browser signed in, session_open says so", async () => {
    const { call } = await agent(BOB);
    const res = await call("session_open", {});
    expect(res.value.code).toBe("extension_offline");
    expect(res.value.message).toMatch(/sign in/i);
  });

  it("another user's browser name is never reachable or listed", async () => {
    await browser(ALICE, "home-mac");
    await browser(BOB, "bob-pc");
    const { call } = await agent(BOB);
    expect((await call("browser_list")).value.browsers.map((b: any) => b.name)).toEqual(["bob-pc"]);
    const res = await call("session_open", { browser: "home-mac" });
    expect(res.value.code).toBe("invalid_args");
    // The name the agent asked for is echoed back; the list of known browsers is only Bob's.
    expect(res.value.message).toMatch(/signed-in browsers: bob-pc$/);
  });

  it("a handle from one browser is a bad_session in the other user's tenant", async () => {
    await browser(ALICE, "home-mac");
    const alice = await agent(ALICE);
    const bob = await agent(BOB);
    const handle = (await alice.call("session_open", {})).value.session;
    for (const tool of ["tab_list", "tab_create", "session_close", "group_list"]) {
      const res = await bob.call(tool, { session: handle });
      expect(res.value.code).toBe("bad_session");
    }
  });

  it("a session outlives the MCP connection that opened it (gateways connect per call)", async () => {
    const home = await browser(ALICE, "home-mac");
    const first = await agent(ALICE);
    const s = await first.call("session_open", {});
    await first.call("tab_create", { session: s.value.session });
    await (first.client.transport as unknown as { terminateSession(): Promise<void> }).terminateSession();
    await first.client.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(home.ext.requests.some((r) => r.op === "session_release" || r.op === "session_close")).toBe(false);

    const second = await agent(ALICE);
    const listed = await second.call("tab_list", { session: s.value.session });
    expect(listed.isError).toBe(false);
    expect(listed.value.tabs).toHaveLength(1);
    const closed = await second.call("session_close", { session: s.value.session });
    expect(closed.isError).toBe(false);
  });
});
