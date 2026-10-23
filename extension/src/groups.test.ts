/**
 * Shared tab groups: the default `shared_window` placement (one TabCrew window, named TabCrew
 * groups, per-tab ownership), isolation inside a shared group, persistence of ownership, the
 * per-window activation lock, finish modes and group ops.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event, V2Request, V2SessionRef } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { handleRequest } from "./ops.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, flush, type FakeChrome } from "./test/fakes.js";

const alice: V2SessionRef = { short_id: "aaaa1111", label: "alice" };
const bob: V2SessionRef = { short_id: "bbbb2222", label: "bob" };
const carol: V2SessionRef = { short_id: "cccc3333", label: "carol", group: "Research" };
const dave: V2SessionRef = { short_id: "dddd4444", label: "dave", group: "Research" };
type Info = { tab_id: number; url: string };

let fake: FakeChrome;
let events: V2Event[];
let tabs: TabManager;
let cdp: CdpManager;
let page: PageController;
let user: { win: { id: number }; tab: { id: number; active: boolean } };

function req(session: V2SessionRef, op: V2Request["op"], args: object = {}): V2Request {
  return { type: "request", id: "x", op, session, args } as V2Request;
}
const call = (session: V2SessionRef, op: V2Request["op"], args: object = {}, manager = tabs, navigateWaitMs?: number) =>
  handleRequest(req(session, op, args), { tabs: manager, cdp, page, ...(navigateWaitMs !== undefined && { navigateWaitMs }) });
const create = (session: V2SessionRef, url?: string) => call(session, "tab_create", url ? { url } : {}) as Promise<Info>;
const tabOf = (info: Info) => fake.tabs.get(info.tab_id)!;
const groupOf = (info: Info) => fake.groups.get(tabOf(info).groupId)!;
const local = async (key: string) => (await fake.chrome.storage.local.get(key))[key];
const groupTitled = (title: string) => [...fake.groups.values()].find((g) => g.title === title);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function clearSessionStorage() {
  await fake.chrome.storage.session.remove(Object.keys(fake.chrome.storage.session._data()));
}

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
  events = [];
  tabs = new TabManager((e) => events.push(e));
  cdp = new CdpManager();
  page = new PageController({ send: (t, m, p) => cdp.send(t, m, p), isMac: async () => true });
  const win = fake.addWindow({ focused: true });
  const tab = fake.addTab({ windowId: win.id, url: "https://user.example", active: true });
  user = { win, tab };
});

function expectNoFocus() {
  expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  for (const [args] of fake.chrome.windows.create.mock.calls) expect(args.focused).toBe(false);
  for (const [args] of fake.chrome.tabs.create.mock.calls) expect(args.active).toBe(false);
  expect(user.tab.active).toBe(true);
}

describe("shared_window placement (default)", () => {
  it("opens the first tab in one new unfocused TabCrew window, in a group titled TabCrew", async () => {
    const a = await create(alice, "https://a.example");
    expect(a.url).toBe("https://a.example");
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.windows.create.mock.calls[0]![0]).toMatchObject({ focused: false, url: "https://a.example" });
    const tab = tabOf(a);
    expect(tab.windowId).not.toBe(user.win.id);
    expect(groupOf(a)).toMatchObject({ title: "TabCrew", windowId: tab.windowId });
    // No leftover blank tab.
    expect([...fake.tabs.values()].filter((t) => t.windowId === tab.windowId)).toHaveLength(1);
    expect(await local("v2:tabcrewWindow")).toBe(tab.windowId);
    expect(await local("v2:tabOwners")).toEqual({ [a.tab_id]: alice.short_id });
    expect(await local("v2:sessionGroups")).toEqual({ [alice.short_id]: tab.groupId });
    expect(await local("v2:managedGroups")).toEqual({ [tab.groupId]: { name: "TabCrew", windowId: tab.windowId, kind: "shared" } });
    expectNoFocus();
  });

  it("puts every session's tabs in the same window and group (later tabs inactive)", async () => {
    const a = await create(alice);
    const b = await create(bob);
    const a2 = await create(alice);
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(new Set([a, b, a2].map((i) => tabOf(i).windowId)).size).toBe(1);
    expect(new Set([a, b, a2].map((i) => tabOf(i).groupId)).size).toBe(1);
    expect(fake.groups.size).toBe(1);
    expect(tabOf(b).active).toBe(false);
    expectNoFocus();
  });

  it("concurrent first tab_creates from several sessions create one window and one group", async () => {
    const results = await Promise.all([create(alice), create(bob), create({ short_id: "eeee5555", label: "e" }), create(alice)]);
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => tabOf(r).windowId)).size).toBe(1);
    expect(new Set(results.map((r) => tabOf(r).groupId)).size).toBe(1);
    expect(fake.windows.size).toBe(2); // the user's + the TabCrew window
    expectNoFocus();
  });

  it("a session's group parameter joins or creates that named group in the TabCrew window", async () => {
    const a = await create(alice);
    const c = await create(carol);
    const d = await create(dave);
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(groupOf(c).title).toBe("Research");
    expect(tabOf(c).groupId).not.toBe(tabOf(a).groupId);
    expect(tabOf(d).groupId).toBe(tabOf(c).groupId);
    expect(tabOf(c).windowId).toBe(tabOf(a).windowId);
  });

  it("names the default group after v2:group_name", async () => {
    await fake.chrome.storage.local.set({ "v2:group_name": "Work" });
    const a = await create(alice);
    expect(groupOf(a).title).toBe("Work");
  });

  it("a session keeps using its group (tracked by id) after the user renames it in Chrome", async () => {
    const a = await create(alice);
    groupOf(a).title = "Renamed by me";
    const a2 = await create(alice);
    expect(tabOf(a2).groupId).toBe(tabOf(a).groupId);
    await expect(tabs.assertOwned(alice, a2.tab_id)).resolves.toBeTruthy();
  });

  it("recreates the TabCrew window after it was closed", async () => {
    const a = await create(alice);
    const first = tabOf(a).windowId;
    await fake.chrome.tabs.remove(a.tab_id);
    await tabs.handleWindowRemoved(first);
    const next = await create(bob);
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(tabOf(next).windowId).not.toBe(first);
    expect(tabOf(next).windowId).not.toBe(user.win.id);
    expect(groupOf(next).title).toBe("TabCrew");
  });

  it("page ops activate the target tab inside the TabCrew window only", async () => {
    const a = await create(alice);
    const b = await create(bob);
    await call(bob, "screenshot", { tab_id: b.tab_id });
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(b.tab_id, { active: true });
    expect(tabOf(b).active).toBe(true);
    expect(tabOf(a).active).toBe(false);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    expect(user.tab.active).toBe(true);
  });
});

describe("isolation inside a shared group", () => {
  it("tab_list returns only the caller's own tabs", async () => {
    const a1 = await create(alice, "https://a/1");
    const a2 = await create(alice, "https://a/2");
    const b = await create(bob, "https://b/1");
    const listA = (await call(alice, "tab_list")) as { tabs: { tab_id: number }[] };
    const listB = (await call(bob, "tab_list")) as { tabs: { tab_id: number }[] };
    expect(listA.tabs.map((t) => t.tab_id).sort()).toEqual([a1.tab_id, a2.tab_id].sort());
    expect(listB.tabs.map((t) => t.tab_id)).toEqual([b.tab_id]);
    expect(await call({ short_id: "zzzz9999", label: "z" }, "tab_list")).toEqual({ tabs: [] });
  });

  it.each([
    ["tab_close", {}],
    ["screenshot", {}],
    ["snapshot", {}],
    ["act", { fingerprint: "f", action_id: "e1" }],
    ["navigate", { action: "reload" }],
    ["read_text", {}],
    ["debug_logs", { source: "console" }],
  ] as const)("%s on another session's tab in the same group is tab_not_owned, without activating", async (op, extra) => {
    await create(alice);
    const a2 = await create(alice);
    await create(bob);
    fake.chrome.tabs.update.mockClear();
    await expect(call(bob, op, { tab_id: a2.tab_id, ...extra })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.tabs.has(a2.tab_id)).toBe(true);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("a tab the user drags into a TabCrew group belongs to nobody", async () => {
    const a = await create(alice);
    const b = await create(bob);
    // The user drags their own tab into the TabCrew group.
    const mine = fake.addTab({ windowId: user.win.id, url: "https://mine.example" });
    await fake.chrome.tabs.group({ groupId: tabOf(a).groupId, tabIds: [mine.id] });
    expect(mine.groupId).toBe(tabOf(a).groupId);

    for (const s of [alice, bob]) {
      await expect(call(s, "screenshot", { tab_id: mine.id })).rejects.toMatchObject({ code: "tab_not_owned" });
      await expect(call(s, "tab_close", { tab_id: mine.id })).rejects.toMatchObject({ code: "tab_not_owned" });
      const listed = (await call(s, "tab_list")) as { tabs: { tab_id: number }[] };
      expect(listed.tabs.map((t) => t.tab_id)).not.toContain(mine.id);
    }
    // A popup it opens is not adopted by anyone.
    const child = fake.addTab({ windowId: mine.windowId, openerTabId: mine.id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(events).toEqual([]);
    // Closing / releasing the sessions never touches it.
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 1 });
    expect(await call(bob, "session_release", { tabs: "close" })).toMatchObject({ closed_tabs: 1 });
    expect(fake.tabs.has(mine.id)).toBe(true);
    expect(fake.tabs.has(b.tab_id)).toBe(false);
    expect((await tabs.listSessionGroups()).map((s) => s.short_id)).toEqual([]);
  });

  it("session_close closes only the caller's tabs and leaves the shared group to the others", async () => {
    await create(alice);
    await create(alice);
    const b = await create(bob);
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 2 });
    expect(fake.tabs.has(b.tab_id)).toBe(true);
    expect(groupOf(b).title).toBe("TabCrew");
    await expect(tabs.assertOwned(bob, b.tab_id)).resolves.toBeTruthy();
  });

  it("a tab opened by an agent's tab is adopted by that tab's owner, not by the group", async () => {
    const a = await create(alice);
    const b = await create(bob);
    const child = fake.addTab({ windowId: user.win.id, openerTabId: a.tab_id, url: "https://popup.example" });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(child.groupId).toBe(tabOf(a).groupId);
    expect(child.windowId).toBe(tabOf(a).windowId);
    expect(events).toEqual([
      {
        type: "event",
        event: "tab_adopted",
        short_id: alice.short_id,
        tab: { tab_id: child.id, url: "https://popup.example", title: "", opener_tab_id: a.tab_id },
      },
    ]);
    await expect(tabs.assertOwned(alice, child.id)).resolves.toBeTruthy();
    await expect(tabs.assertOwned(bob, child.id)).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(((await call(bob, "tab_list")) as { tabs: { tab_id: number }[] }).tabs.map((t) => t.tab_id)).toEqual([b.tab_id]);
  });

  it("the popup lists each session with its own tab count", async () => {
    await create(alice);
    await create(alice);
    await create(bob);
    expect(await tabs.listSessionGroups()).toEqual([
      { short_id: alice.short_id, label: "alice", tab_count: 2 },
      { short_id: bob.short_id, label: "bob", tab_count: 1 },
    ]);
  });

  it("closing a stopped session's tabs from the popup closes only that session's tabs", async () => {
    await create(alice);
    const b = await create(bob);
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 1 });
    expect(fake.tabs.has(b.tab_id)).toBe(true);
  });

  it("Show focuses the TabCrew window and activates the session's own tab", async () => {
    const a = await create(alice);
    const b = await create(bob);
    await tabs.showSession(bob.short_id);
    expect(tabOf(b).active).toBe(true);
    expect(tabOf(a).active).toBe(false);
    expect(fake.chrome.windows.update).toHaveBeenCalledWith(tabOf(b).windowId, { focused: true });
    await expect(tabs.showSession("zzzz9999")).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("reconcile reports each session's own tabs and its group name", async () => {
    const a = await create(alice, "https://a");
    const b = await create(bob, "https://b");
    const c = await create(carol, "https://c");
    const mine = fake.addTab({ windowId: user.win.id });
    await fake.chrome.tabs.group({ groupId: tabOf(a).groupId, tabIds: [mine.id] });
    const fresh = new TabManager((e) => events.push(e));
    expect(await fresh.reconcile()).toEqual([
      { short_id: alice.short_id, group: "TabCrew", tabs: [{ tab_id: a.tab_id, url: "https://a", title: "" }] },
      { short_id: bob.short_id, group: "TabCrew", tabs: [{ tab_id: b.tab_id, url: "https://b", title: "" }] },
      { short_id: carol.short_id, group: "Research", tabs: [{ tab_id: c.tab_id, url: "https://c", title: "" }] },
    ]);
  });
});

describe("ownership persistence", () => {
  it("survives a fresh TabManager with chrome.storage.session cleared (extension reload)", async () => {
    const a = await create(alice);
    const b = await create(bob);
    await clearSessionStorage();
    const fresh = new TabManager((e) => events.push(e));
    await expect(fresh.assertOwned(alice, a.tab_id)).resolves.toBeTruthy();
    await expect(fresh.assertOwned(alice, b.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    const a2 = (await call(alice, "tab_create", {}, fresh)) as Info;
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(tabOf(a2).groupId).toBe(tabOf(a).groupId);
    expect(await fresh.placementFor(alice.short_id)).toBe("shared_window");
  });

  it("drops stored entries that no longer match the browser", async () => {
    const a = await create(alice);
    const b = await create(bob);
    // The user drags bob's tab out of the TabCrew group; plus stale ids from somewhere.
    await fake.chrome.tabs.ungroup([b.tab_id]);
    const owners = (await local("v2:tabOwners")) as Record<string, string>;
    await fake.chrome.storage.local.set({
      "v2:tabOwners": { ...owners, "99999": alice.short_id, [user.tab.id]: alice.short_id },
      "v2:managedGroups": { ...((await local("v2:managedGroups")) as object), "424242": { name: "Gone", windowId: 1, kind: "shared" } },
    });
    const fresh = new TabManager((e) => events.push(e));
    await expect(fresh.assertOwned(alice, user.tab.id)).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(fresh.assertOwned(bob, b.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(fresh.assertOwned(alice, a.tab_id)).resolves.toBeTruthy();
    await fresh.reconcile();
    expect(await local("v2:tabOwners")).toEqual({ [a.tab_id]: alice.short_id });
    expect(Object.keys((await local("v2:managedGroups")) as object)).toEqual([String(tabOf(a).groupId)]);
  });

  it("a managed group the user moved to another window is no longer TabCrew's (fail closed)", async () => {
    const a = await create(alice);
    await fake.chrome.tabGroups.move(tabOf(a).groupId, { windowId: user.win.id, index: -1 });
    await expect(tabs.assertOwned(alice, a.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    fake.chrome.tabs.update.mockClear();
    await expect(call(alice, "snapshot", { tab_id: a.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("browser startup wipes ownership: old TabCrew tabs become the user's", async () => {
    const a = await create(alice);
    await tabs.handleStartup();
    await expect(tabs.assertOwned(alice, a.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(await call(alice, "tab_list")).toEqual({ tabs: [] });
    for (const key of ["v2:tabOwners", "v2:sessionGroups", "v2:managedGroups"]) {
      expect((await local(key)) ?? {}).toEqual({});
    }
    expect(await local("v2:tabcrewWindow")).toBeUndefined();
    // A new tab does not reuse the old (now the user's) window or group.
    const next = await create(alice);
    expect(tabOf(next).groupId).not.toBe(tabOf(a).groupId);
    expect(tabOf(next).windowId).not.toBe(tabOf(a).windowId);
  });

  it("loading state waits for the startup wipe", async () => {
    const a = await create(alice);
    const fresh = new TabManager((e) => events.push(e));
    const wipe = fresh.handleStartup();
    const listed = fresh.tabList(alice);
    await wipe;
    expect(await listed).toEqual({ tabs: [] });
    await expect(fresh.assertOwned(alice, a.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("migrates legacy '<label> · <short_id>' groups once when nothing is stored", async () => {
    const win = fake.addWindow();
    const legacy = fake.addTab({ windowId: win.id, url: "https://legacy", active: true });
    const gid = await fake.chrome.tabs.group({ tabIds: [legacy.id] });
    await fake.chrome.tabGroups.update(gid, { title: "alice · aaaa1111" });

    const fresh = new TabManager((e) => events.push(e));
    await expect(fresh.assertOwned(alice, legacy.id)).resolves.toBeTruthy();
    expect(await local("v2:managedGroups")).toEqual({ [gid]: { name: "alice · aaaa1111", windowId: win.id, kind: "session" } });
    expect(await fresh.placementFor(alice.short_id)).toBe("own_window");
    // Later legacy-looking groups are never adopted by title again.
    const other = fake.addTab({ windowId: win.id });
    const gid2 = await fake.chrome.tabs.group({ tabIds: [other.id], createProperties: { windowId: win.id } });
    await fake.chrome.tabGroups.update(gid2, { title: "bob · bbbb2222" });
    await fake.chrome.storage.local.remove(["v2:tabOwners", "v2:sessionGroups", "v2:managedGroups"]);
    const again = new TabManager((e) => events.push(e));
    await expect(again.assertOwned(bob, other.id)).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("after a browser startup, restored legacy groups are not adopted", async () => {
    const win = fake.addWindow();
    const legacy = fake.addTab({ windowId: win.id, active: true });
    const gid = await fake.chrome.tabs.group({ tabIds: [legacy.id] });
    await fake.chrome.tabGroups.update(gid, { title: "alice · aaaa1111" });
    await tabs.handleStartup();
    await expect(tabs.assertOwned(alice, legacy.id)).rejects.toMatchObject({ code: "tab_not_owned" });
  });
});

describe("activation lock (per window, FIFO)", () => {
  async function twoAgents() {
    await create(alice);
    const a2 = await create(alice);
    const b = await create(bob);
    expect(tabOf(a2).active || tabOf(b).active).toBe(false);
    return { a2, b };
  }

  it("serializes activate + snapshot across sessions in one window", async () => {
    const { a2, b } = await twoAgents();
    const first = deferred<never>();
    const order: string[] = [];
    const snap = vi.spyOn(page, "snapshot").mockImplementation(async (tabId: number) => {
      order.push(`snapshot ${tabId} (active ${fake.tabs.get(tabId)!.active})`);
      if (tabId === a2.tab_id) return first.promise;
      return {} as never;
    });
    const pa = call(alice, "snapshot", { tab_id: a2.tab_id });
    const pb = call(bob, "snapshot", { tab_id: b.tab_id });
    await flush(50);
    expect(snap).toHaveBeenCalledTimes(1);
    expect(tabOf(a2).active).toBe(true);
    expect(tabOf(b).active).toBe(false);
    first.resolve({} as never);
    await pa;
    await pb;
    expect(order).toEqual([`snapshot ${a2.tab_id} (active true)`, `snapshot ${b.tab_id} (active true)`]);
  });

  it("act, read_text and screenshot take the same lock", async () => {
    const { a2, b } = await twoAgents();
    const first = deferred<never>();
    vi.spyOn(page, "act").mockImplementation(() => first.promise);
    const shot = vi.spyOn(cdp, "screenshot");
    const pa = call(alice, "act", { tab_id: a2.tab_id, fingerprint: "f", action_id: "e1" });
    const pb = call(bob, "screenshot", { tab_id: b.tab_id });
    await flush(50);
    expect(shot).not.toHaveBeenCalled();
    first.resolve({ executed: "x", page_changed: null } as never);
    await pa;
    await pb;
    expect(shot).toHaveBeenCalledTimes(1);
  });

  it("debug_logs never waits for the lock", async () => {
    const { a2, b } = await twoAgents();
    const first = deferred<never>();
    vi.spyOn(page, "snapshot").mockImplementation(() => first.promise);
    const pa = call(alice, "snapshot", { tab_id: a2.tab_id });
    await flush(20);
    await expect(call(bob, "debug_logs", { tab_id: b.tab_id, source: "console" })).resolves.toMatchObject({ entries: [] });
    first.resolve({} as never);
    await pa;
  });

  it("navigate holds the lock only while issuing the navigation, not during the load wait", async () => {
    const { a2, b } = await twoAgents();
    const original = fake.chrome.debugger.sendCommand.getMockImplementation()!;
    fake.chrome.debugger.sendCommand.mockImplementation(async (target, method, params) =>
      method === "Page.navigate" ? ({ loaderId: "L1" } as never) : original(target, method, params),
    );
    const snap = vi.spyOn(page, "snapshot").mockResolvedValue({} as never);
    let navDone = false;
    const nav = call(alice, "navigate", { tab_id: a2.tab_id, url: "https://a.example/next" }, tabs, 60_000).then((r) => {
      navDone = true;
      return r;
    });
    await vi.waitFor(() => expect(fake.chrome.debugger.sendCommand.mock.calls.some((c) => c[1] === "Page.navigate")).toBe(true));
    await call(bob, "snapshot", { tab_id: b.tab_id });
    expect(snap).toHaveBeenCalledTimes(1);
    expect(navDone).toBe(false);
    cdp.handleEvent(a2.tab_id, "Page.loadEventFired", {});
    await expect(nav).resolves.toMatchObject({ tab_id: a2.tab_id });
  });

  it("re-checks ownership after waiting for the lock", async () => {
    const { a2, b } = await twoAgents();
    const first = deferred<never>();
    vi.spyOn(page, "snapshot").mockImplementation((tabId: number) => (tabId === a2.tab_id ? first.promise : Promise.resolve({} as never)));
    const pa = call(alice, "snapshot", { tab_id: a2.tab_id });
    await flush(20);
    const pb = call(bob, "snapshot", { tab_id: b.tab_id });
    await flush(20);
    await call(bob, "session_release", { tabs: "keep" });
    first.resolve({} as never);
    await pa;
    await expect(pb).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("does not lock or activate for user_window sessions", async () => {
    await fake.chrome.storage.local.set({ "v2:placement": "user_window" });
    const a = await create(alice);
    const b = await create(bob);
    const first = deferred<never>();
    const snap = vi.spyOn(page, "snapshot").mockImplementation((tabId: number) => (tabId === a.tab_id ? first.promise : Promise.resolve({} as never)));
    const pa = call(alice, "snapshot", { tab_id: a.tab_id });
    await flush(20);
    await call(bob, "snapshot", { tab_id: b.tab_id });
    expect(snap).toHaveBeenCalledTimes(2);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    first.resolve({} as never);
    await pa;
  });
});

describe("finish modes (session_release)", () => {
  it("keep (the default): tabs stay in their group, unowned and counted as finished", async () => {
    const a1 = await create(alice);
    const a2 = await create(alice);
    const b = await create(bob);
    await call(alice, "screenshot", { tab_id: a1.tab_id });
    const groupId = tabOf(a1).groupId;

    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 2, moved: false, mode: "keep" });
    for (const id of [a1.tab_id, a2.tab_id]) expect(fake.tabs.get(id)!.groupId).toBe(groupId);
    expect(fake.attachedDebuggee.has(a1.tab_id)).toBe(false);
    await expect(call(alice, "screenshot", { tab_id: a1.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(call(bob, "screenshot", { tab_id: a1.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(tabs.assertOwned(bob, b.tab_id)).resolves.toBeTruthy();
    expect(await tabs.popupGroups()).toEqual([
      { group_id: groupId, name: "TabCrew", active_sessions: 1, finished_tabs: 2, is_default: true },
    ]);
    // A popup opened by a finished tab is not adopted; closing finished tabs is never reported.
    const child = fake.addTab({ windowId: tabOf(a1).windowId, openerTabId: a1.tab_id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    await fake.chrome.tabs.remove(a1.tab_id);
    await tabs.handleTabRemoved(a1.tab_id);
    expect(events).toEqual([]);
    expect((await tabs.popupGroups())[0]).toMatchObject({ finished_tabs: 1 });
  });

  it("close (from v2:finish_mode): closes only the session's tabs, ungrouped first, without tab_removed", async () => {
    await fake.chrome.storage.local.set({ "v2:finish_mode": "close" });
    const a1 = await create(alice);
    await create(alice);
    const b = await create(bob);
    const ungroup = fake.chrome.tabs.ungroup;
    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 0, moved: false, closed_tabs: 2, mode: "close" });
    expect(ungroup).toHaveBeenCalled();
    expect([...fake.tabs.keys()].sort()).toEqual([user.tab.id, b.tab_id].sort());
    await tabs.handleTabRemoved(a1.tab_id);
    expect(events).toEqual([]);
  });

  it("the agent's tabs argument overrides the default", async () => {
    await create(alice);
    expect(await call(alice, "session_release", { tabs: "close" })).toMatchObject({ closed_tabs: 1, mode: "close" });
  });

  it("collect: moves the tabs into one collapsed '✓ TabCrew' group in the TabCrew window", async () => {
    const eve: V2SessionRef = { short_id: "eeee5555", label: "e" };
    const a1 = await create(alice);
    const a2 = await create(alice);
    const b = await create(bob);
    const e = await create(eve);
    const tabcrewWindow = tabOf(a1).windowId;

    expect(await call(alice, "session_release", { tabs: "collect" })).toEqual({ kept_tabs: 2, moved: true, mode: "collect" });
    const collect = groupTitled("✓ TabCrew")!;
    expect(collect).toMatchObject({ collapsed: true, windowId: tabcrewWindow });
    for (const id of [a1.tab_id, a2.tab_id]) expect(fake.tabs.get(id)!.groupId).toBe(collect.id);
    expect(groupOf(b).title).toBe("TabCrew");
    await expect(tabs.assertOwned(alice, a1.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });

    // A second collecting session joins the same collect group.
    await call(eve, "session_release", { tabs: "collect" });
    expect([...fake.groups.values()].filter((g) => g.title === "✓ TabCrew")).toHaveLength(1);
    expect(tabOf(e).groupId).toBe(collect.id);
    // The popup lists the collect group under Finished; the default group still holds bob.
    expect((await tabs.listFinished()).map((f) => [f.group_id, f.label, f.tab_count])).toEqual([[collect.id, "TabCrew", 3]]);
    expect((await tabs.popupGroups()).map((g) => g.name)).toEqual(["TabCrew"]);
    expectNoFocus();
  });

  it("collect from a named group uses '✓ <name>'", async () => {
    const c = await create(carol);
    await call(carol, "session_release", { tabs: "collect" });
    expect(groupTitled("✓ Research")!.id).toBe(tabOf(c).groupId);
  });

  it("collect from an own_window session moves its tabs into the TabCrew window", async () => {
    await fake.chrome.storage.local.set({ "v2:placement": "own_window" });
    const a = await create(alice);
    const sessionWindow = tabOf(a).windowId;
    expect(await call(alice, "session_release", { tabs: "collect" })).toEqual({ kept_tabs: 1, moved: true, mode: "collect" });
    const collect = groupTitled("✓ TabCrew")!;
    expect(tabOf(a).groupId).toBe(collect.id);
    expect(collect.windowId).not.toBe(user.win.id);
    expect(fake.windows.has(sessionWindow) && collect.windowId !== sessionWindow).toBe(false);
    expect(await local("v2:tabcrewWindow")).toBe(collect.windowId);
    expectNoFocus();
  });

  it("rejects an unknown finish mode", async () => {
    await create(alice);
    await expect(call(alice, "session_release", { tabs: "burn" })).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("close never closes the user's window (user_window placement)", async () => {
    await fake.chrome.storage.local.set({ "v2:placement": "user_window" });
    const a = await create(alice);
    await fake.chrome.tabs.remove(user.tab.id);
    expect(await call(alice, "session_release", { tabs: "close" })).toMatchObject({ closed_tabs: 1, mode: "close" });
    expect(fake.tabs.has(a.tab_id)).toBe(false);
    expect(fake.windows.has(user.win.id)).toBe(true);
  });

  it("sessions missing from the daemon's welcome are finished with the default mode", async () => {
    const a = await create(alice);
    const b = await create(bob, "https://b");
    await call(alice, "screenshot", { tab_id: a.tab_id });
    const released: number[] = [];
    const groups = await tabs.reconcile([bob], async (id) => void released.push(id));
    expect(groups).toEqual([{ short_id: bob.short_id, group: "TabCrew", tabs: [{ tab_id: b.tab_id, url: "https://b", title: "" }] }]);
    expect(released).toEqual([a.tab_id]);
    expect(fake.tabs.has(a.tab_id)).toBe(true);
    await expect(tabs.assertOwned(alice, a.tab_id)).rejects.toMatchObject({ code: "tab_not_owned" });
    expect((await tabs.popupGroups())[0]).toMatchObject({ active_sessions: 1, finished_tabs: 1 });
  });
});

describe("group ops", () => {
  it("group_list returns TabCrew group names and which one is the caller's, never user groups", async () => {
    await create(alice);
    await create(carol);
    const mine = fake.addTab({ windowId: user.win.id });
    const userGroup = await fake.chrome.tabs.group({ tabIds: [mine.id] });
    await fake.chrome.tabGroups.update(userGroup, { title: "My stuff" });
    expect(await call(alice, "group_list")).toEqual({
      groups: [
        { name: "TabCrew", mine: true },
        { name: "Research", mine: false },
      ],
    });
    expect(await call(carol, "group_list")).toEqual({
      groups: [
        { name: "TabCrew", mine: false },
        { name: "Research", mine: true },
      ],
    });
  });

  it("group_list includes the default group and names registered in the popup before they hold tabs", async () => {
    await tabs.createGroup("Later");
    expect(await call(alice, "group_list")).toEqual({
      groups: [
        { name: "TabCrew", mine: true },
        { name: "Later", mine: false },
      ],
    });
    // Joining a registered name creates the group in Chrome.
    const l = await create({ short_id: "ffff6666", label: "f", group: "Later" });
    expect(groupOf(l).title).toBe("Later");
  });

  it("group_rename renames the caller's group (the default name follows) and returns the previous name", async () => {
    const a = await create(alice);
    expect(await call(alice, "group_rename", { name: "  Deep   work " })).toEqual({ name: "Deep work", previous: "TabCrew" });
    expect(groupOf(a).title).toBe("Deep work");
    expect(await local("v2:group_name")).toBe("Deep work");
    expect(((await local("v2:managedGroups")) as Record<string, { name: string }>)[tabOf(a).groupId]!.name).toBe("Deep work");
    // New default-group sessions still join the same group.
    const b = await create(bob);
    expect(tabOf(b).groupId).toBe(tabOf(a).groupId);
  });

  it("group_rename by name renames another TabCrew group", async () => {
    await create(alice);
    const c = await create(carol);
    expect(await call(alice, "group_rename", { group: "Research", name: "Papers" })).toEqual({ name: "Papers", previous: "Research" });
    expect(groupOf(c).title).toBe("Papers");
    expect(await local("v2:group_name")).toBeUndefined();
  });

  it("group_rename refuses user groups, unknown groups, bad names and duplicates", async () => {
    await create(alice);
    await create(carol);
    const mine = fake.addTab({ windowId: user.win.id });
    const userGroup = await fake.chrome.tabs.group({ tabIds: [mine.id] });
    await fake.chrome.tabGroups.update(userGroup, { title: "My stuff" });
    await expect(call(alice, "group_rename", { group: "My stuff", name: "Hacked" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(fake.groups.get(userGroup)!.title).toBe("My stuff");
    await expect(call(alice, "group_rename", { group: "Nope", name: "X" })).rejects.toMatchObject({ code: "invalid_args" });
    for (const name of ["", "✓ done", "alice · aaaa1111", 5]) {
      await expect(call(alice, "group_rename", { name })).rejects.toMatchObject({ code: "invalid_args" });
    }
    await expect(call(alice, "group_rename", { name: "Research" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(tabs.renameGroupById(userGroup, "Hacked")).rejects.toThrow();
    expect(fake.groups.get(userGroup)!.title).toBe("My stuff");
  });

  it("the popup renames a TabCrew group by id and lists groups with counts", async () => {
    const a = await create(alice);
    await create(bob);
    await create(carol);
    await tabs.renameGroupById(tabOf(a).groupId, "Main");
    expect(groupOf(a).title).toBe("Main");
    await tabs.createGroup("Later");
    const groups = await tabs.popupGroups();
    expect(groups).toEqual([
      { group_id: tabOf(a).groupId, name: "Main", active_sessions: 2, finished_tabs: 0, is_default: true },
      { group_id: expect.any(Number), name: "Research", active_sessions: 1, finished_tabs: 0, is_default: false },
      { group_id: -1, name: "Later", active_sessions: 0, finished_tabs: 0, is_default: false },
    ]);
    // A registered name (no Chrome group yet) can be renamed by its negative id.
    await tabs.renameGroupById(-1, "Someday");
    expect((await tabs.popupGroups()).at(-1)).toMatchObject({ group_id: -1, name: "Someday" });
  });
});
