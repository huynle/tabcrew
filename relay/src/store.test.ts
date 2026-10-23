import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

const id = () => randomBytes(8).toString("hex");

function contract(name: string, make: () => Store, enabled = true) {
  describe.skipIf(!enabled)(`${name} store`, () => {
    let store: Store;
    beforeAll(async () => {
      store = make();
      await store.init();
    });
    afterAll(async () => {
      await store.close();
    });

    it("upsertIdentity keeps one user per (provider, subject) and updates the profile", async () => {
      const subject = id();
      const a = await store.upsertIdentity({ provider: "github", subject, email: "a@x", name: "A" });
      const b = await store.upsertIdentity({ provider: "github", subject, email: "a2@x", name: "A2" });
      expect(b.id).toBe(a.id);
      expect(b.email).toBe("a2@x");
      const g = await store.upsertIdentity({ provider: "google", subject, email: "a@x" });
      expect(g.id).not.toBe(a.id);
      expect((await store.getUser(a.id))?.disabled).toBe(false);
    });

    it("clients round-trip", async () => {
      const c = { id: id(), name: "Agent", redirectUris: ["http://127.0.0.1/cb"], kind: "mcp" as const };
      await store.createClient(c);
      expect(await store.getClient(c.id)).toEqual(c);
      expect(await store.getClient(id())).toBeNull();
    });

    it("transactions and codes are taken exactly once", async () => {
      const k = id();
      await store.putTxn(k, { any: 1 }, Date.now() + 60_000);
      const [x, y] = await Promise.all([store.takeTxn(k), store.takeTxn(k)]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      expect([x, y].find(Boolean)).toMatchObject({ data: { any: 1 } });
      const c = id();
      await store.putCode(c, { code: true }, Date.now() + 60_000);
      expect(await store.takeCode(c)).toMatchObject({ data: { code: true } });
      expect(await store.takeCode(c)).toBeNull();
    });

    it("refresh tokens: use once, revoke a family", async () => {
      const user = await store.upsertIdentity({ provider: "github", subject: id() });
      const family = id();
      const rec = { hash: id(), family, userId: user.id, clientId: "c", audience: "mcp" as const, browserId: null, expiresAt: Date.now() + 1e6 };
      await store.putRefresh(rec);
      expect(await store.getRefresh(rec.hash)).toMatchObject({ ...rec, used: false, revoked: false });
      const [u1, u2] = await Promise.all([store.markRefreshUsed(rec.hash), store.markRefreshUsed(rec.hash)]);
      expect([u1, u2].filter(Boolean)).toHaveLength(1);
      const sibling = { ...rec, hash: id() };
      await store.putRefresh(sibling);
      await store.revokeFamily(family);
      expect((await store.getRefresh(sibling.hash))?.revoked).toBe(true);
      expect(await store.markRefreshUsed(sibling.hash)).toBe(false);
    });

    it("browsers: list, revoke (owner only), re-sign-in clears the revocation", async () => {
      const user = await store.upsertIdentity({ provider: "github", subject: id() });
      const other = await store.upsertIdentity({ provider: "github", subject: id() });
      const a = await store.upsertBrowser(user.id, "home");
      const b = await store.upsertBrowser(user.id, "work");
      expect((await store.listBrowsers(user.id)).map((x) => x.name).sort()).toEqual(["home", "work"]);
      expect(await store.revokeBrowser(other.id, a.id)).toBe(false);
      expect(await store.revokeBrowser(user.id, a.id)).toBe(true);
      expect((await store.listBrowsers(user.id)).map((x) => x.id)).toEqual([b.id]);
      expect((await store.getBrowser(a.id))?.revoked).toBe(true);
      expect((await store.upsertBrowser(user.id, "home")).id).toBe(a.id);
      expect((await store.getBrowser(a.id))?.revoked).toBe(false);
      expect(await store.getBrowser(id())).toBeNull();
    });

    it("grants: one per live family, revocable by client or browser", async () => {
      const user = await store.upsertIdentity({ provider: "github", subject: id() });
      const base = { userId: user.id, expiresAt: Date.now() + 1e6 };
      const f1 = id();
      await store.putRefresh({ ...base, hash: id(), family: f1, clientId: "agent-1", audience: "mcp", browserId: null, used: true });
      await store.putRefresh({ ...base, hash: id(), family: f1, clientId: "agent-1", audience: "mcp", browserId: null });
      const f2 = id();
      const ext = { ...base, hash: id(), family: f2, clientId: "tabcrew-extension", audience: "ext" as const, browserId: "b_x" };
      await store.putRefresh(ext);
      await store.putRefresh({ ...base, hash: id(), family: id(), clientId: "old", audience: "mcp", browserId: null, expiresAt: Date.now() - 1 });
      const grants = await store.listGrants(user.id);
      expect(grants.map((g) => [g.family, g.clientId, g.audience, g.browserId]).sort()).toEqual(
        [
          [f1, "agent-1", "mcp", null],
          [f2, "tabcrew-extension", "ext", "b_x"],
        ].sort(),
      );
      expect(await store.revokeGrants(user.id, { browserId: "b_x" })).toBe(1);
      expect((await store.getRefresh(ext.hash))?.revoked).toBe(true);
      expect(await store.revokeGrants(user.id, { clientId: "agent-1" })).toBe(2);
      expect(await store.listGrants(user.id)).toEqual([]);
    });

    it("browsers are unique per user and name", async () => {
      const user = await store.upsertIdentity({ provider: "github", subject: id() });
      const other = await store.upsertIdentity({ provider: "github", subject: id() });
      const a = await store.upsertBrowser(user.id, "home-mac");
      expect((await store.upsertBrowser(user.id, "home-mac")).id).toBe(a.id);
      expect((await store.upsertBrowser(other.id, "home-mac")).id).not.toBe(a.id);
      expect(a).toMatchObject({ userId: user.id, name: "home-mac" });
    });
  });
}

contract("memory", () => new MemoryStore());
contract("postgres", () => new PostgresStore(process.env.TEST_DATABASE_URL ?? ""), !!process.env.TEST_DATABASE_URL);
