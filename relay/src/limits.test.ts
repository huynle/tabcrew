import { afterEach, describe, expect, it } from "vitest";
import { FakeExtension } from "../../daemon/src/testing/helpers.js";
import { TokenBucket } from "./limits.js";
import { EXT_ORIGIN, extLogin, mcpClient, mcpLogin, register, startTestRelay, type TestRelay } from "./testing/harness.js";

let t: TestRelay | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("TokenBucket", () => {
  it("allows a burst, then refills over time, per key", () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
    expect([b.take("a"), b.take("a"), b.take("a"), b.take("a")]).toEqual([true, true, true, false]);
    expect(b.take("b")).toBe(true);
    now += 1_000;
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
  });
});

describe("relay limits", () => {
  it("rate-limits sign-in endpoints per client IP (429)", async () => {
    t = await startTestRelay({ limits: { authPerMinute: 3 } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await register(t.url)).status);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });

  it("rate-limits /mcp per user (429) without touching other users", async () => {
    t = await startTestRelay({ limits: { mcpBurst: 4, mcpPerSecond: 0.001 } });
    const alice = await mcpLogin(t, { id: "1", login: "a", email: "a@x", name: "A" });
    const bob = await mcpLogin(t, { id: "2", login: "b", email: "b@x", name: "B" });
    const post = (tok: string) =>
      fetch(`${t!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{}" });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post(alice.access_token)).status);
    expect(codes.slice(0, 4).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(4)).toEqual([429, 429]);
    expect((await post(bob.access_token)).status).not.toBe(429);
  });

  it("caps browsers per user at sign-in", async () => {
    t = await startTestRelay({ limits: { maxBrowsers: 2 } });
    await extLogin(t, undefined, "one");
    await extLogin(t, undefined, "two");
    await extLogin(t, undefined, "one"); // an existing browser signs in again: fine
    await expect(extLogin(t, undefined, "three")).rejects.toThrow();
  });

  it("caps open sessions per user", async () => {
    t = await startTestRelay({ limits: { maxSessions: 2 } });
    const ext = await extLogin(t);
    const fake = await FakeExtension.connect(t.port, ext.access_token, {}, { origin: EXT_ORIGIN, path: "/ext" });
    const { access_token } = await mcpLogin(t);
    const client = await mcpClient(t.url, access_token);
    const open = async () => {
      const r: any = await client.callTool({ name: "session_open", arguments: {} });
      return { isError: !!r.isError, value: JSON.parse(r.content[0].text) };
    };
    expect((await open()).isError).toBe(false);
    expect((await open()).isError).toBe(false);
    const third = await open();
    expect(third.isError).toBe(true);
    expect(third.value.message).toMatch(/at most 2/);
    await client.close();
    fake.close();
  });
});
