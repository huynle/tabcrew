import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event, V2Request } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { handleRequest } from "./ops.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

const alice = { short_id: "aaaa1111", label: "alice" };
const bob = { short_id: "bbbb2222", label: "bob" };

let fake: FakeChrome;
let events: V2Event[];
let tabs: TabManager;
let cdp: CdpManager;
let page: PageController;

function req(session: typeof alice, op: V2Request["op"], args: object = {}): V2Request {
  return { type: "request", id: "x", op, session, args } as V2Request;
}
const call = (session: typeof alice, op: V2Request["op"], args: object = {}) =>
  handleRequest(req(session, op, args), { tabs, cdp, page });

// These tests cover the `own_window` placement (one window per session); the default
// `shared_window` placement is covered in groups.test.ts.
beforeEach(async () => {
  fake = createFakeChrome();
  fake.install();
  await fake.chrome.storage.local.set({ "v2:placement": "own_window" });
  events = [];
  tabs = new TabManager((e) => events.push(e));
  cdp = new CdpManager();
  page = new PageController({ send: (t, m, p) => cdp.send(t, m, p), isMac: async () => true });
});

function expectNoFocus() {
  expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  for (const [args] of fake.chrome.windows.create.mock.calls) expect(args.focused).toBe(false);
  for (const [args] of fake.chrome.tabs.create.mock.calls) expect(args.active).toBe(false);
}

function expectNoFocusOrActivation() {
  expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  for (const [args] of fake.chrome.windows.create.mock.calls) expect(args.focused).toBe(false);
  for (const [args] of fake.chrome.tabs.create.mock.calls) expect(args.active).toBe(false);
}

describe("tab_create", () => {
  it("creates the session window unfocused at the requested URL, grouped under the session title", async () => {
    const userWin = fake.addWindow({ focused: true });
    fake.addTab({ windowId: userWin.id, url: "https://user.example", active: true });

    const info = (await call(alice, "tab_create", { url: "https://a.example" })) as { tab_id: number; url: string };
    expect(info.url).toBe("https://a.example");
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.windows.create.mock.calls[0]![0]).toMatchObject({ focused: false, state: "normal", url: "https://a.example" });

    const tab = fake.tabs.get(info.tab_id)!;
    const group = fake.groups.get(tab.groupId)!;
    expect(group.title).toBe("alice · aaaa1111");
    expect(tab.windowId).not.toBe(userWin.id);
    // no leftover blank tab: the window holds exactly the one session tab
    expect([...fake.tabs.values()].filter((t) => t.windowId === tab.windowId)).toHaveLength(1);
    const stored = await fake.chrome.storage.session.get(["v2:sessionWindows"]);
    expect(stored["v2:sessionWindows"]).toEqual({ aaaa1111: tab.windowId });
    expectNoFocusOrActivation();
  });

  it("adds later tabs of a session with active:false to that session's window and group", async () => {
    const first = (await call(alice, "tab_create", { url: "https://a.example/1" })) as { tab_id: number };
    const second = (await call(alice, "tab_create", { url: "https://a.example/2" })) as { tab_id: number };

    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.create.mock.calls[0]![0]).toMatchObject({ active: false, url: "https://a.example/2" });
    const t1 = fake.tabs.get(first.tab_id)!;
    const t2 = fake.tabs.get(second.tab_id)!;
    expect(t2.groupId).toBe(t1.groupId);
    expect(t2.windowId).toBe(t1.windowId);
    expect(t1.active).toBe(true);
    expect(t2.active).toBe(false);
    expectNoFocusOrActivation();
  });

  it("gives two sessions two different unfocused windows", async () => {
    const a = (await call(alice, "tab_create", { url: "https://a" })) as { tab_id: number };
    const b = (await call(bob, "tab_create", { url: "https://b" })) as { tab_id: number };
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    const ta = fake.tabs.get(a.tab_id)!;
    const tb = fake.tabs.get(b.tab_id)!;
    expect(ta.windowId).not.toBe(tb.windowId);
    expect(fake.groups.get(tb.groupId)!.title).toBe("bob · bbbb2222");
    // both are the active tab of their own window
    expect(ta.active && tb.active).toBe(true);
    expectNoFocusOrActivation();
  });

  it("concurrent creates in one session create one window", async () => {
    const results = (await Promise.all([
      call(alice, "tab_create", { url: "https://a/1" }),
      call(alice, "tab_create", { url: "https://a/2" }),
      call(alice, "tab_create", { url: "https://a/3" }),
    ])) as { tab_id: number }[];
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.windows.size).toBe(1);
    const windowIds = new Set(results.map((r) => fake.tabs.get(r.tab_id)!.windowId));
    const groupIds = new Set(results.map((r) => fake.tabs.get(r.tab_id)!.groupId));
    expect(windowIds.size).toBe(1);
    expect(groupIds.size).toBe(1);
    expectNoFocusOrActivation();
  });

  it("concurrent creates from two sessions create two windows", async () => {
    const [a, b] = (await Promise.all([call(alice, "tab_create", {}), call(bob, "tab_create", {})])) as { tab_id: number }[];
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(fake.windows.size).toBe(2);
    expect(fake.tabs.get(a!.tab_id)!.windowId).not.toBe(fake.tabs.get(b!.tab_id)!.windowId);
  });

  it("creates a new window when the session's window was closed", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const oldWindow = fake.tabs.get(a.tab_id)!.windowId;
    await call(alice, "tab_close", { tab_id: a.tab_id });
    expect(fake.windows.size).toBe(0);
    await tabs.handleWindowRemoved(oldWindow);
    const next = (await call(alice, "tab_create", {})) as { tab_id: number };
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(fake.tabs.get(next.tab_id)!.windowId).not.toBe(oldWindow);
    expectNoFocusOrActivation();
  });

  it("creates a new window when the stored window id is stale (no onRemoved seen)", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await fake.chrome.tabs.remove(a.tab_id); // user closes the last tab; the window goes away
    const next = (await call(alice, "tab_create", { url: "https://again" })) as { tab_id: number; url: string };
    expect(next.url).toBe("https://again");
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(fake.windows.size).toBe(1);
  });

  it("never reuses a window created for another session", async () => {
    await call(alice, "tab_create", {});
    const aliceWindow = [...fake.windows.keys()][0]!;
    // Corrupt persisted state so bob points at alice's window.
    await fake.chrome.storage.session.set({ "v2:sessionWindows": { aaaa1111: aliceWindow, bbbb2222: aliceWindow } });
    const fresh = new TabManager((e) => events.push(e));
    const b = (await handleRequest(req(bob, "tab_create"), { tabs: fresh, cdp, page })) as { tab_id: number };
    expect(fake.tabs.get(b.tab_id)!.windowId).not.toBe(aliceWindow);
  });
});

describe("ownership", () => {
  it("rejects a tab from another session's group with tab_not_owned", async () => {
    await call(alice, "tab_create", {});
    const bobTab = (await call(bob, "tab_create", {})) as { tab_id: number };
    await expect(call(alice, "tab_close", { tab_id: bobTab.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(call(alice, "screenshot", { tab_id: bobTab.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.tabs.has(bobTab.tab_id)).toBe(true);
  });

  it("rejects a user tab outside any session group", async () => {
    await call(alice, "tab_create", {});
    const win = fake.addWindow();
    const userTab = fake.addTab({ windowId: win.id });
    await expect(call(alice, "screenshot", { tab_id: userTab.id })).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("rejects a missing tab with tab_gone", async () => {
    await expect(call(alice, "tab_close", { tab_id: 99999 })).rejects.toMatchObject({ code: "tab_gone" });
  });

  it("rejects bad tab ids with invalid_args", async () => {
    await expect(call(alice, "tab_close", { tab_id: "1" })).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("tab_list / tab_close / session_close", () => {
  it("tab_list returns only the session's tabs", async () => {
    const a1 = (await call(alice, "tab_create", { url: "https://a/1" })) as { tab_id: number };
    const a2 = (await call(alice, "tab_create", { url: "https://a/2" })) as { tab_id: number };
    await call(bob, "tab_create", { url: "https://b/1" });
    const listed = (await call(alice, "tab_list")) as { tabs: { tab_id: number; url: string }[] };
    expect(listed.tabs.map((t) => t.tab_id).sort()).toEqual([a1.tab_id, a2.tab_id].sort());
    expect((await call({ short_id: "cccc3333", label: "c" }, "tab_list")) as object).toEqual({ tabs: [] });
  });

  it("session_close closes all session tabs and forgets the group", async () => {
    await call(alice, "tab_create", {});
    await call(alice, "tab_create", {});
    const b = (await call(bob, "tab_create", {})) as { tab_id: number };
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 2 });
    expect([...fake.tabs.keys()]).toEqual([b.tab_id]);
    expect(await call(alice, "tab_list")).toEqual({ tabs: [] });
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 0 });
  });

  it("does not echo tab_removed for tabs closed on the daemon's behalf", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await call(alice, "tab_close", { tab_id: a.tab_id });
    await tabs.handleTabRemoved(a.tab_id);
    expect(events).toEqual([]);
  });
});

describe("events", () => {
  it("adopts a tab opened by an owned tab, moving it into the opener's session window and group", async () => {
    await call(bob, "tab_create", {});
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const agentTab = fake.tabs.get(a.tab_id)!;
    const otherWin = fake.addWindow();
    const child = fake.addTab({ windowId: otherWin.id, openerTabId: a.tab_id, url: "https://popup.example" });

    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);

    expect(child.windowId).toBe(agentTab.windowId);
    expect(child.groupId).toBe(agentTab.groupId);
    expect(fake.chrome.tabs.move).toHaveBeenCalledWith(child.id, { windowId: agentTab.windowId, index: -1 });
    expect(events).toEqual([
      {
        type: "event",
        event: "tab_adopted",
        short_id: "aaaa1111",
        tab: { tab_id: child.id, url: "https://popup.example", title: "", opener_tab_id: a.tab_id },
      },
    ]);
    // the adopted tab is now owned by alice
    await expect(tabs.assertOwned(alice, child.id)).resolves.toBeTruthy();
    expectNoFocusOrActivation();
  });

  it("does not move a tab out of a popup window (warns instead)", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const popupWin = fake.addWindow({ type: "popup" });
    const child = fake.addTab({ windowId: popupWin.id, openerTabId: a.tab_id });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(fake.chrome.tabs.move).not.toHaveBeenCalled();
    expect(child.windowId).toBe(popupWin.id);
    expect(events).toEqual([]);
  });

  it("ignores tabs opened by user tabs", async () => {
    const win = fake.addWindow();
    const parent = fake.addTab({ windowId: win.id });
    const child = fake.addTab({ windowId: win.id, openerTabId: parent.id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(events).toEqual([]);
    expect(fake.chrome.tabs.group).not.toHaveBeenCalled();
  });

  it("sends tab_removed when a session tab is closed by the user", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await fake.chrome.tabs.remove(a.tab_id); // user closes it
    await tabs.handleTabRemoved(a.tab_id);
    expect(events).toEqual([{ type: "event", event: "tab_removed", short_id: "aaaa1111", tab_id: a.tab_id }]);
  });

  it("reconcile rebuilds from the owner map and drops stale mappings", async () => {
    const a = (await call(alice, "tab_create", { url: "https://a" })) as { tab_id: number };
    const b = (await call(bob, "tab_create", { url: "https://b" })) as { tab_id: number };
    // Simulate a service-worker restart: a fresh manager with stale persisted state.
    const owners = (await fake.chrome.storage.local.get("v2:tabOwners"))["v2:tabOwners"] as object;
    await fake.chrome.storage.local.set({
      "v2:tabOwners": { ...owners, "777": "zzzz9999" },
      "v2:sessionGroups": { ...((await fake.chrome.storage.local.get("v2:sessionGroups"))["v2:sessionGroups"] as object), zzzz9999: 424242 },
    });
    await fake.chrome.storage.session.set({ "v2:sessionWindows": { zzzz9999: 555, aaaa1111: 556 } });
    // A user group, even one titled like a session, is ignored.
    const userWin = fake.addWindow();
    const userTab = fake.addTab({ windowId: userWin.id });
    const userGroup = await fake.chrome.tabs.group({ tabIds: [userTab.id] });
    await fake.chrome.tabGroups.update(userGroup, { title: "carol · cccc3333" });

    const fresh = new TabManager((e) => events.push(e));
    const groups = await fresh.reconcile();
    expect(groups).toEqual([
      { short_id: "aaaa1111", tabs: [{ tab_id: a.tab_id, url: "https://a", title: "" }] },
      { short_id: "bbbb2222", tabs: [{ tab_id: b.tab_id, url: "https://b", title: "" }] },
    ]);
    const stored = await fake.chrome.storage.local.get(["v2:tabOwners", "v2:sessionGroups"]);
    expect(Object.keys(stored["v2:sessionGroups"] as object).sort()).toEqual(["aaaa1111", "bbbb2222"]);
    expect(stored["v2:tabOwners"]).toEqual({ [a.tab_id]: "aaaa1111", [b.tab_id]: "bbbb2222" });
    const windows = await fake.chrome.storage.session.get("v2:sessionWindows");
    expect(windows["v2:sessionWindows"]).toEqual({
      aaaa1111: fake.tabs.get(a.tab_id)!.windowId,
      bbbb2222: fake.tabs.get(b.tab_id)!.windowId,
    });
    // ownership still works after the rebuild
    await expect(fresh.assertOwned(alice, a.tab_id)).resolves.toBeTruthy();
    await expect(fresh.assertOwned(alice, b.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(fresh.assertOwned({ short_id: "cccc3333", label: "carol" }, userTab.id)).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("after reconcile, tab_create reuses the session's existing window", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await fake.chrome.storage.session.set({ "v2:sessionWindows": {} });
    const fresh = new TabManager((e) => events.push(e));
    await fresh.reconcile();
    const next = (await handleRequest(req(alice, "tab_create"), { tabs: fresh, cdp, page })) as { tab_id: number };
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.tabs.get(next.tab_id)!.windowId).toBe(fake.tabs.get(a.tab_id)!.windowId);
  });
});

describe("screenshot", () => {
  it("attaches once, enables focus emulation and Page, and never activates the tab", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    const shot1 = await call(alice, "screenshot", { tab_id: a.tab_id });
    const shot2 = await call(alice, "screenshot", { tab_id: a.tab_id, format: "png" });
    expect(shot1).toEqual({ media_type: "image/jpeg", data: "SU1BR0U=", width: 1280, height: 720 });
    expect(shot2).toMatchObject({ media_type: "image/png" });

    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(fake.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: a.tab_id }, "1.3");
    const methods = fake.chrome.debugger.sendCommand.mock.calls.map((c) => [c[1], c[2]]);
    expect(methods.slice(0, 2)).toEqual([
      ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      ["Page.enable", undefined],
    ]);
    expect(methods).toContainEqual(["Page.captureScreenshot", { format: "jpeg", quality: 80 }]);
    expect(methods).toContainEqual(["Page.captureScreenshot", { format: "png" }]);
    expectNoFocusOrActivation();
  });

  it("reattaches after the debugger is detached (e.g. infobar canceled)", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await call(alice, "screenshot", { tab_id: a.tab_id });
    fake.attachedDebuggee.delete(a.tab_id);
    cdp.handleDetach({ tabId: a.tab_id }, "canceled_by_user");
    await call(alice, "screenshot", { tab_id: a.tab_id });
    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it("concurrent screenshots on one tab attach only once", async () => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await Promise.all([
      call(alice, "screenshot", { tab_id: a.tab_id }),
      call(alice, "screenshot", { tab_id: a.tab_id }),
    ]);
    expect(fake.chrome.debugger.attach).toHaveBeenCalledTimes(1);
  });
});

describe("activation", () => {
  async function twoTabs() {
    const first = (await call(alice, "tab_create", { url: "https://a/1" })) as { tab_id: number };
    const second = (await call(alice, "tab_create", { url: "https://a/2" })) as { tab_id: number };
    expect(fake.tabs.get(second.tab_id)!.active).toBe(false);
    return { first: first.tab_id, second: second.tab_id };
  }

  it.each([
    ["screenshot", {}],
    ["snapshot", {}],
  ] as const)("%s on a non-active owned tab activates it once, without focusing", async (op, extra) => {
    const { first, second } = await twoTabs();
    // The fake CDP has no page behind it, so snapshot itself fails; activation precedes it.
    const run = () => call(alice, op, { tab_id: second, ...extra }).catch(() => undefined);
    await run();
    expect(fake.chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(second, { active: true });
    expect(fake.tabs.get(second)!.active).toBe(true);
    expect(fake.tabs.get(first)!.active).toBe(false);
    await run();
    expect(fake.chrome.tabs.update).toHaveBeenCalledTimes(1);
    expectNoFocus();
  });

  it("act on a non-active owned tab activates it once, without focusing", async () => {
    const { second } = await twoTabs();
    // A bogus fingerprint still goes through ownership + activation before act validates it.
    await call(alice, "act", { tab_id: second, fingerprint: "nope", action_id: "e1" }).catch(() => undefined);
    expect(fake.chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(second, { active: true });
    expectNoFocus();
  });

  it("already-active tab is not re-activated", async () => {
    const { first } = await twoTabs();
    await call(alice, "screenshot", { tab_id: first });
    await call(alice, "snapshot", { tab_id: first }).catch(() => undefined);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("activating one session's tab never touches another session's window", async () => {
    const { second } = await twoTabs();
    const b = (await call(bob, "tab_create", {})) as { tab_id: number };
    await call(alice, "screenshot", { tab_id: second });
    expect(fake.tabs.get(b.tab_id)!.active).toBe(true);
    expectNoFocus();
  });

  it("tab_list, tab_close and session_close never activate", async () => {
    const { first, second } = await twoTabs();
    await call(alice, "tab_list");
    await call(alice, "tab_close", { tab_id: second });
    await call(alice, "tab_create", {});
    await call(alice, "tab_close", { tab_id: first });
    await call(alice, "session_close");
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expectNoFocus();
  });

  it("does not activate a tab that fails the ownership check", async () => {
    const { second } = await twoTabs();
    await expect(call(bob, "screenshot", { tab_id: second })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe("phase 6 ops", () => {
  it.each(["navigate", "read_text", "debug_logs"] as const)("%s checks ownership", async (op) => {
    const a = (await call(alice, "tab_create", {})) as { tab_id: number };
    await expect(call(bob, op, { tab_id: a.tab_id, action: "reload", source: "console" })).rejects.toMatchObject({
      code: "tab_not_owned",
    });
  });
});


describe("session_release", () => {
  type Info = { tab_id: number };
  const kept = (title: string) => [...fake.groups.values()].find((g) => g.title === title);

  async function userWindow(focused = true) {
    const win = fake.addWindow({ focused });
    const tab = fake.addTab({ windowId: win.id, url: "https://user.example", active: true });
    return { win, tab };
  }

  it("moves the group into the user's last-focused window, collapsed as ✓ label, without focusing or switching tabs", async () => {
    const user = await userWindow();
    const a1 = (await call(alice, "tab_create", { url: "https://a/1" })) as Info;
    const a2 = (await call(alice, "tab_create", { url: "https://a/2" })) as Info;
    const b = (await call(bob, "tab_create", {})) as Info;
    const sessionWindow = fake.tabs.get(a1.tab_id)!.windowId;
    await call(alice, "screenshot", { tab_id: a1.tab_id });
    expect(cdp.logs.has(a1.tab_id)).toBe(true);
    const forget = vi.spyOn(page, "forget");
    fake.chrome.tabs.update.mockClear();

    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 2, moved: true, mode: "keep" });

    const group = kept("✓ alice")!;
    expect(group).toBeTruthy();
    expect(group.collapsed).toBe(true);
    expect(group.windowId).toBe(user.win.id);
    for (const id of [a1.tab_id, a2.tab_id]) {
      expect(fake.tabs.get(id)).toMatchObject({ windowId: user.win.id, groupId: group.id, active: false });
    }
    expect(fake.chrome.tabGroups.move).toHaveBeenCalledWith(expect.any(Number), { windowId: user.win.id, index: -1 });
    // The user's active tab and window focus are untouched; the emptied session window is gone.
    expect(user.tab.active).toBe(true);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expect(fake.windows.has(sessionWindow)).toBe(false);
    // Debugger detached and per-tab caches dropped.
    expect(fake.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: a1.tab_id });
    expect(fake.attachedDebuggee.has(a1.tab_id)).toBe(false);
    expect(cdp.isAttached(a1.tab_id)).toBe(false);
    expect(cdp.logs.has(a1.tab_id)).toBe(false);
    expect(forget).toHaveBeenCalledWith(a1.tab_id);
    expect(forget).toHaveBeenCalledWith(a2.tab_id);
    // The agent lost control; nothing was reported as removed, even when the user closes them later.
    await expect(call(alice, "screenshot", { tab_id: a1.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(await call(alice, "tab_list")).toEqual({ tabs: [] });
    await fake.chrome.tabs.remove(a1.tab_id);
    await tabs.handleTabRemoved(a1.tab_id);
    expect(events).toEqual([]);
    const stored = await fake.chrome.storage.session.get(["v2:releasedGroups", "v2:sessionWindows"]);
    expect(Object.keys(stored["v2:releasedGroups"] as object)).toEqual([String(group.id)]);
    expect(Object.keys(stored["v2:sessionWindows"] as object)).toEqual([bob.short_id]);
    const owned = await fake.chrome.storage.local.get(["v2:tabOwners", "v2:sessionGroups", "v2:managedGroups"]);
    expect(Object.keys(owned["v2:sessionGroups"] as object)).toEqual([bob.short_id]);
    expect(Object.values(owned["v2:tabOwners"] as object)).toEqual([bob.short_id]);
    // The finished group is the user's now, not a TabCrew-managed group.
    expect(Object.keys(owned["v2:managedGroups"] as object)).toEqual([String(fake.tabs.get(b.tab_id)!.groupId)]);
    // Bob is unaffected.
    await expect(tabs.assertOwned(bob, b.tab_id)).resolves.toBeTruthy();
  });

  it("restores the destination's previously active tab if the move changed it", async () => {
    const user = await userWindow();
    const a = (await call(alice, "tab_create", {})) as Info;
    const original = fake.chrome.tabGroups.move.getMockImplementation()!;
    fake.chrome.tabGroups.move.mockImplementationOnce(async (id, props) => {
      const result = await original(id, props);
      // Simulate Chrome activating a moved tab in the destination window.
      for (const t of fake.tabs.values()) if (t.windowId === props.windowId) t.active = t.id === a.tab_id;
      return result;
    });
    await call(alice, "session_release");
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(user.tab.id, { active: true });
    expect(user.tab.active).toBe(true);
    expect(fake.tabs.get(a.tab_id)!.active).toBe(false);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("falls back to the most recently focused user window when the last-focused window is a session window", async () => {
    const older = await userWindow(false);
    const recent = await userWindow(false);
    await tabs.handleWindowFocused(older.win.id);
    await tabs.handleWindowFocused(recent.win.id);
    await tabs.handleWindowFocused(older.win.id);
    await call(alice, "tab_create", {});
    const b = (await call(bob, "tab_create", {})) as Info;
    fake.focusWindow(fake.tabs.get(b.tab_id)!.windowId); // the user is looking at bob's window
    await tabs.handleWindowFocused(fake.tabs.get(b.tab_id)!.windowId);
    fake.chrome.windows.update.mockClear();

    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 1, moved: true, mode: "keep" });
    expect(kept("✓ alice")!.windowId).toBe(older.win.id);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("skips incognito windows", async () => {
    const normal = await userWindow(false);
    const incognito = fake.addWindow({ focused: true, incognito: true });
    fake.addTab({ windowId: incognito.id, active: true });
    await call(alice, "tab_create", {});
    await call(alice, "session_release");
    expect(kept("✓ alice")!.windowId).toBe(normal.win.id);
  });

  it("leaves the group in place (moved:false) when there is no user window", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    const sessionWindow = fake.tabs.get(a.tab_id)!.windowId;
    await call(bob, "tab_create", {});
    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 1, moved: false, mode: "keep" });
    expect(fake.chrome.tabGroups.move).not.toHaveBeenCalled();
    const group = kept("✓ alice")!;
    expect(group.windowId).toBe(sessionWindow);
    expect(fake.tabs.get(a.tab_id)!.groupId).toBe(group.id);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("leaves a session window that still holds a stray tab", async () => {
    await userWindow();
    const a = (await call(alice, "tab_create", {})) as Info;
    const sessionWindow = fake.tabs.get(a.tab_id)!.windowId;
    fake.addTab({ windowId: sessionWindow, url: "https://stray" });
    await call(alice, "session_release");
    expect(fake.windows.has(sessionWindow)).toBe(true);
  });

  it("returns kept_tabs 0 for a session without tabs", async () => {
    await userWindow();
    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 0, moved: false, mode: "keep" });
    expect(fake.chrome.tabGroups.move).not.toHaveBeenCalled();
  });

  it("released groups are not session groups: reconcile and the popup ignore them, the session starts fresh", async () => {
    await userWindow();
    const a = (await call(alice, "tab_create", {})) as Info;
    const b = (await call(bob, "tab_create", { url: "https://b" })) as Info;
    await call(alice, "session_release");
    const fresh = new TabManager((e) => events.push(e));
    expect(await fresh.reconcile()).toEqual([{ short_id: bob.short_id, tabs: [{ tab_id: b.tab_id, url: "https://b", title: "" }] }]);
    expect((await fresh.listSessionGroups()).map((s) => s.short_id)).toEqual([bob.short_id]);
    await expect(fresh.assertOwned(alice, a.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    // A later tab_create for the same short_id gets a new window and group, not the released one.
    const next = (await call(alice, "tab_create", {})) as Info;
    expect(fake.tabs.get(next.tab_id)!.groupId).not.toBe(fake.tabs.get(a.tab_id)!.groupId);
  });

  it("does not adopt tabs opened by a released tab", async () => {
    const user = await userWindow();
    const a = (await call(alice, "tab_create", {})) as Info;
    await call(alice, "session_release");
    fake.chrome.tabs.group.mockClear();
    const child = fake.addTab({ windowId: user.win.id, openerTabId: a.tab_id, url: "https://child" });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(events).toEqual([]);
    expect(fake.chrome.tabs.group).not.toHaveBeenCalled();
    expect(child.groupId).toBe(-1);
  });

  it("does not adopt via a released group even if its title still looked like a session (rename race)", async () => {
    await userWindow();
    const a = (await call(alice, "tab_create", {})) as Info;
    const groupId = fake.tabs.get(a.tab_id)!.groupId;
    await tabs.released.add(groupId, "alice");
    const child = fake.addTab({ windowId: fake.tabs.get(a.tab_id)!.windowId, openerTabId: a.tab_id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(events).toEqual([]);
  });
});

describe("closing never leaves a saved tab group behind", () => {
  // Chrome saves and pins a group to the bookmarks bar when its tabs are closed while still
  // grouped (seen live: every closed test session left a grey chip). Tabs must be ungrouped first.
  function watchGroupedRemovals(): number[] {
    const grouped: number[] = [];
    const orig = fake.chrome.tabs.remove.getMockImplementation()!;
    fake.chrome.tabs.remove.mockImplementation(async (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) if ((fake.tabs.get(id)?.groupId ?? -1) > 0) grouped.push(id);
      return orig(ids);
    });
    return grouped;
  }

  it("tab_close ungroups before removing", async () => {
    const grouped = watchGroupedRemovals();
    const a = (await call(alice, "tab_create", { url: "https://a/1" })) as { tab_id: number };
    await call(alice, "tab_create", { url: "https://a/2" });
    await call(alice, "tab_close", { tab_id: a.tab_id });
    expect(fake.tabs.has(a.tab_id)).toBe(false);
    expect(grouped).toEqual([]);
  });

  it("session_close ungroups before removing", async () => {
    const grouped = watchGroupedRemovals();
    await call(alice, "tab_create", {});
    await call(alice, "tab_create", {});
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 2 });
    expect(grouped).toEqual([]);
  });

  it("closing a finished (released) group from the popup ungroups first", async () => {
    const userWin = fake.addWindow({ focused: true });
    fake.addTab({ windowId: userWin.id, url: "https://user.example", active: true });
    await call(alice, "tab_create", { url: "https://a/1" });
    await call(alice, "session_release");
    const grouped = watchGroupedRemovals();
    const finishedGroup = [...fake.groups.values()].find((g) => g.title.startsWith("✓"))!;
    await tabs.closeFinished(finishedGroup.id);
    expect(grouped).toEqual([]);
    expect([...fake.tabs.values()].some((t) => t.url === "https://a/1")).toBe(false);
  });
});
