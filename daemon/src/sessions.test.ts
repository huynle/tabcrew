import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError } from "./errors.js";
import { normaliseLabel, SessionRegistry, sessionRef } from "./sessions.js";
import { tempHome } from "./testing/helpers.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as DaemonError).code;
  }
  return undefined;
}

describe("SessionRegistry", () => {
  it("issues unguessable handles and independent short ids", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const { handle, session } = reg.open("Flights · search");
    expect(handle).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
    expect(session.short_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(handle).not.toContain(session.short_id);
    expect(session.label).toBe("Flights - search");
    expect(reg.use(handle)).toBe(session);
    expect(codeOf(() => reg.use("s_AAAAAAAAAAAAAAAAAAAAAA"))).toBe("bad_session");
    expect(codeOf(() => reg.use(session.short_id))).toBe("bad_session");
    expect(normaliseLabel("  ")).toBe("agent");
  });

  it("keeps a tab in at most one session and enforces ownership", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const a = reg.open("a").session;
    const b = reg.open("b").session;
    reg.addTab(a.short_id, 1);
    expect(codeOf(() => reg.requireTab(b, 1))).toBe("tab_not_owned");
    reg.addTab(b.short_id, 1);
    expect(a.tabs.has(1)).toBe(false);
    expect(b.tabs.has(1)).toBe(true);
    expect(reg.addTab("unknown1", 2)).toBe(false);
  });

  it("persists to sessions.json (0600, no raw handles) and reloads", () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const file = join(t.home, "sessions.json");
    const reg = new SessionRegistry({ file, idleTimeoutMs: 0 });
    const { handle, session } = reg.open("persist");
    reg.addTab(session.short_id, 42);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(handle);

    const reg2 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg2.load();
    const restored = reg2.use(handle);
    expect(restored.short_id).toBe(session.short_id);
    expect(restored.label).toBe("persist");
    expect([...restored.tabs]).toEqual([42]);

    reg2.close(restored);
    const reg3 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg3.load();
    expect(reg3.size).toBe(0);
  });

  it("reconciles with the extension's groups", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const a = reg.open("a").session;
    const b = reg.open("b").session;
    reg.addTab(a.short_id, 1);
    reg.addTab(a.short_id, 2);
    reg.addTab(b.short_id, 3);
    reg.reconcile([
      { short_id: a.short_id, tabs: [{ tab_id: 2, url: "", title: "" }, { tab_id: 5, url: "", title: "" }] },
      { short_id: "zzzzzzzz", tabs: [{ tab_id: 9, url: "", title: "" }] },
    ]);
    expect([...a.tabs].sort()).toEqual([2, 5]);
    expect([...b.tabs]).toEqual([]);
    expect(reg.size).toBe(2);
  });

  it("keeps an optional, normalised group name in the session ref", () => {
    const reg = new SessionRegistry({ idleTimeoutMs: 0 });
    const plain = reg.open("plain").session;
    const named = reg.open("named", "  Research \n team ").session;
    const junk = reg.open("junk", "✓ TabCrew").session;
    expect(plain.group).toBeUndefined();
    expect(sessionRef(plain)).toEqual({ short_id: plain.short_id, label: "plain" });
    expect(named.group).toBe("Research team");
    expect(sessionRef(named)).toEqual({ short_id: named.short_id, label: "named", group: "Research team" });
    expect(junk.group).toBeUndefined();
    expect(reg.refs().map((r) => r.group)).toEqual([undefined, "Research team", undefined]);
  });

  it("persists the group and reloads it (dropping invalid names)", () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const file = join(t.home, "sessions.json");
    const reg = new SessionRegistry({ file, idleTimeoutMs: 0 });
    const { handle: h1 } = reg.open("a", "Docs");
    const { handle: h2 } = reg.open("b");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.sessions.map((s: { group?: string }) => s.group)).toEqual(["Docs", undefined]);
    saved.sessions[1].group = "x".repeat(41);
    writeFileSync(file, JSON.stringify(saved));

    const reg2 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg2.load();
    expect(reg2.use(h1).group).toBe("Docs");
    expect(reg2.use(h2).group).toBeUndefined();
  });

  it("renames a group for every session in it (and an extra session that used the default)", () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const file = join(t.home, "sessions.json");
    const reg = new SessionRegistry({ file, idleTimeoutMs: 0 });
    const a = reg.open("a", "Docs").session;
    const b = reg.open("b", "Docs").session;
    const c = reg.open("c", "Other").session;
    const d = reg.open("d").session;
    const e = reg.open("e").session;
    expect(reg.renameGroup("Docs", "Manuals").sort((x, y) => x.label.localeCompare(y.label))).toEqual([a, b]);
    expect([a.group, b.group, c.group, d.group]).toEqual(["Manuals", "Manuals", "Other", undefined]);
    expect(reg.renameGroup("TabCrew", "Mine", d)).toEqual([d]);
    expect([d.group, e.group]).toEqual(["Mine", undefined]);
    expect(reg.renameGroup("Nope", "Whatever")).toEqual([]);
    expect(reg.renameGroup("Other", "✓ bad")).toEqual([]);
    expect(c.group).toBe("Other");

    const reg2 = new SessionRegistry({ file, idleTimeoutMs: 0 });
    reg2.load();
    expect(reg2.list().map((s) => s.group)).toEqual(["Manuals", "Manuals", "Other", "Mine", undefined]);
  });

  it("reports idle sessions after the timeout", () => {
    let now = 1_000;
    const reg = new SessionRegistry({ idleTimeoutMs: 100, now: () => now });
    const { handle: h1 } = reg.open("one");
    const { session: s2 } = reg.open("two");
    now += 60;
    reg.use(h1);
    now += 50;
    expect(reg.idleSessions()).toEqual([s2]);
  });
});
