import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event, V2Request } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { loadPlacement } from "./config.js";
import { BACKGROUND_SCREENSHOT_TIMEOUT, handleRequest } from "./ops.js";
import { bindPlacementRadios, type RadioLike } from "./popup/placement.js";
import { PageController } from "./snapshot/controller.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

const alice = { short_id: "aaaa1111", label: "alice" };
const bob = { short_id: "bbbb2222", label: "bob" };
type Info = { tab_id: number };

let fake: FakeChrome;
let events: V2Event[];
let tabs: TabManager;
let cdp: CdpManager;
let page: PageController;
let user: { win: { id: number }; tab: { id: number; active: boolean } };

function req(session: typeof alice, op: V2Request["op"], args: object = {}): V2Request {
  return { type: "request", id: "x", op, session, args } as V2Request;
}
const call = (session: typeof alice, op: V2Request["op"], args: object = {}, manager = tabs) =>
  handleRequest(req(session, op, args), { tabs: manager, cdp, page });
const setPlacement = (value: string) => fake.chrome.storage.local.set({ "v2:placement": value });
const tabOf = (info: Info) => fake.tabs.get(info.tab_id)!;
const groupOf = (info: Info) => fake.groups.get(tabOf(info).groupId)!;

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
  events = [];
  tabs = new TabManager((e) => events.push(e));
  fake.chrome.tabs.onActivated.addListener((info) => tabs.handleTabActivated(info));
  cdp = new CdpManager({ screenshotTimeoutMs: 30 });
  page = new PageController({ send: (t, m, p) => cdp.send(t, m, p), isMac: async () => true });
  const win = fake.addWindow({ focused: true });
  const tab = fake.addTab({ windowId: win.id, url: "https://user.example", active: true });
  user = { win, tab };
});

function expectUserViewUntouched() {
  expect(user.tab.active).toBe(true);
  expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  expect(fake.chrome.windows.create).not.toHaveBeenCalled();
  for (const [args] of fake.chrome.tabs.create.mock.calls) expect(args.active).toBe(false);
}

describe("placement setting", () => {
  it("defaults to shared_window when nothing is stored: the shared TabCrew group in the TabCrew window", async () => {
    expect(await loadPlacement()).toBe("shared_window");
    const a = (await call(alice, "tab_create", {})) as Info;
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(tabOf(a).windowId).not.toBe(user.win.id);
    expect(groupOf(a).title).toBe("TabCrew");
    expect((await fake.chrome.storage.session.get("v2:placements"))["v2:placements"]).toEqual({ [alice.short_id]: "shared_window" });
    expect((await fake.chrome.storage.local.get("v2:tabcrewWindow"))["v2:tabcrewWindow"]).toBe(tabOf(a).windowId);
  });

  it("treats an unknown stored value as shared_window", async () => {
    await setPlacement("somewhere");
    expect(await loadPlacement()).toBe("shared_window");
  });
});

describe("user_window placement", () => {
  beforeEach(() => setPlacement("user_window"));

  it("opens the first tab in the user's last-focused window, inactive, in a new collapsed group", async () => {
    const a = (await call(alice, "tab_create", { url: "https://a/1" })) as Info & { url: string };
    expect(a.url).toBe("https://a/1");
    const tab = tabOf(a);
    expect(tab.windowId).toBe(user.win.id);
    expect(tab.active).toBe(false);
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ windowId: user.win.id, url: "https://a/1", active: false });
    expect(groupOf(a)).toMatchObject({ title: "alice · aaaa1111", collapsed: true, windowId: user.win.id });
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expectUserViewUntouched();
    const stored = await fake.chrome.storage.session.get(["v2:placements", "v2:sessionWindows"]);
    expect(stored["v2:placements"]).toEqual({ [alice.short_id]: "user_window" });
    expect(stored["v2:sessionWindows"]).toEqual({});
  });

  it("restores the user's active tab if Chrome activated the new tab anyway", async () => {
    const original = fake.chrome.tabs.create.getMockImplementation()!;
    fake.chrome.tabs.create.mockImplementationOnce(async (props) => original({ ...props, active: true }));
    const a = (await call(alice, "tab_create", {})) as Info;
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(user.tab.id, { active: true });
    expect(user.tab.active).toBe(true);
    expect(tabOf(a).active).toBe(false);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("puts later tabs in the same window and group and keeps the group collapsed", async () => {
    const a1 = (await call(alice, "tab_create", { url: "https://a/1" })) as Info;
    // Simulate Chrome expanding a collapsed group when a tab joins it.
    const original = fake.chrome.tabs.group.getMockImplementation()!;
    fake.chrome.tabs.group.mockImplementationOnce(async (opts) => {
      const id = await original(opts);
      fake.groups.get(id)!.collapsed = false;
      return id;
    });
    const a2 = (await call(alice, "tab_create", { url: "https://a/2" })) as Info;
    expect(tabOf(a2).windowId).toBe(user.win.id);
    expect(tabOf(a2).groupId).toBe(tabOf(a1).groupId);
    expect(tabOf(a2).active).toBe(false);
    expect(groupOf(a2).collapsed).toBe(true);
    expect(fake.groups.size).toBe(1);
    expectUserViewUntouched();
  });

  it("does not re-collapse a group the user expanded", async () => {
    const a1 = (await call(alice, "tab_create", {})) as Info;
    groupOf(a1).collapsed = false;
    await call(alice, "tab_create", {});
    expect(groupOf(a1).collapsed).toBe(false);
  });

  it("picks the most recently focused user window when the last-focused one is a session window", async () => {
    await setPlacement("own_window");
    const b = (await call(bob, "tab_create", {})) as Info;
    const other = fake.addWindow();
    fake.addTab({ windowId: other.id, active: true });
    await tabs.handleWindowFocused(other.id);
    await tabs.handleWindowFocused(user.win.id);
    fake.focusWindow(tabOf(b).windowId);
    await tabs.handleWindowFocused(tabOf(b).windowId);
    await setPlacement("user_window");
    const a = (await call(alice, "tab_create", {})) as Info;
    expect(tabOf(a).windowId).toBe(user.win.id);
  });

  it("does not treat the user's window holding a session group as a session window", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    // A second user_window session lands in the same user window.
    const c = (await call({ short_id: "cccc3333", label: "carol" }, "tab_create", {})) as Info;
    expect(tabOf(c).windowId).toBe(user.win.id);
    expect(tabOf(c).groupId).not.toBe(tabOf(a).groupId);
    // An own_window session's finished group still goes to the user's window.
    await setPlacement("own_window");
    await call(bob, "tab_create", {});
    expect(await call(bob, "session_release")).toEqual({ kept_tabs: 1, moved: true, mode: "keep" });
    expect([...fake.groups.values()].find((g) => g.title === "✓ bob")!.windowId).toBe(user.win.id);
    expect(user.tab.active).toBe(true);
  });

  it.each([
    ["screenshot", {}],
    ["snapshot", {}],
    ["act", { fingerprint: "nope", action_id: "e1" }],
    ["read_text", {}],
  ] as const)("%s never activates a user_window tab", async (op, extra) => {
    const a = (await call(alice, "tab_create", {})) as Info;
    await call(alice, op, { tab_id: a.tab_id, ...extra }).catch(() => undefined);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expect(tabOf(a).active).toBe(false);
    expectUserViewUntouched();
  });

  it("still keeps the ownership check", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    await expect(call(bob, "screenshot", { tab_id: a.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(call(alice, "screenshot", { tab_id: user.tab.id })).rejects.toMatchObject({ code: "tab_not_owned" });
  });

  it("own_window sessions are still activated alongside user_window ones", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    await setPlacement("own_window");
    await call(bob, "tab_create", {});
    const b2 = (await call(bob, "tab_create", {})) as Info;
    await call(bob, "snapshot", { tab_id: b2.tab_id }).catch(() => undefined);
    await call(alice, "snapshot", { tab_id: a.tab_id }).catch(() => undefined);
    expect(fake.chrome.tabs.update.mock.calls).toEqual([[b2.tab_id, { active: true }]]);
  });

  it("reports a clear error when a background screenshot times out, without activating", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    const original = fake.chrome.debugger.sendCommand.getMockImplementation()!;
    fake.chrome.debugger.sendCommand.mockImplementation(async (target, method, params) =>
      method === "Page.captureScreenshot" ? new Promise(() => undefined) : original(target, method, params),
    );
    await expect(call(alice, "screenshot", { tab_id: a.tab_id })).rejects.toMatchObject({
      code: "internal",
      message: BACKGROUND_SCREENSHOT_TIMEOUT,
    });
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("session_release retitles and collapses in place, never moving or closing the window", async () => {
    const a1 = (await call(alice, "tab_create", {})) as Info;
    const a2 = (await call(alice, "tab_create", {})) as Info;
    await call(alice, "screenshot", { tab_id: a1.tab_id });
    groupOf(a1).collapsed = false;
    const groupId = tabOf(a1).groupId;

    expect(await call(alice, "session_release")).toEqual({ kept_tabs: 2, moved: true, mode: "keep" });
    expect(fake.groups.get(groupId)).toMatchObject({ title: "✓ alice", collapsed: true, windowId: user.win.id });
    expect(fake.chrome.tabGroups.move).not.toHaveBeenCalled();
    expect(fake.chrome.tabs.move).not.toHaveBeenCalled();
    expect(fake.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(fake.windows.has(user.win.id)).toBe(true);
    for (const id of [a1.tab_id, a2.tab_id]) expect(fake.tabs.get(id)).toMatchObject({ windowId: user.win.id, groupId });
    expect(fake.attachedDebuggee.has(a1.tab_id)).toBe(false);
    expect(await tabs.released.has(groupId)).toBe(true);
    await expect(call(alice, "screenshot", { tab_id: a1.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    expectUserViewUntouched();
  });

  it("session_close removes only the session's tabs, never the user's window", async () => {
    const a1 = (await call(alice, "tab_create", {})) as Info;
    const a2 = (await call(alice, "tab_create", {})) as Info;
    expect(await call(alice, "session_close")).toEqual({ closed_tabs: 2 });
    expect(fake.tabs.has(a1.tab_id) || fake.tabs.has(a2.tab_id)).toBe(false);
    expect(fake.tabs.has(user.tab.id)).toBe(true);
    expect(fake.windows.has(user.win.id)).toBe(true);
    expect(user.tab.active).toBe(true);
  });

  it("closing the session's tabs keeps the user's window open even when they were its only tabs", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    await fake.chrome.tabs.remove(user.tab.id); // the user closed their own tab meanwhile
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 1 });
    expect(fake.tabs.has(a.tab_id)).toBe(false);
    expect(fake.windows.has(user.win.id)).toBe(true);
    expect([...fake.tabs.values()].filter((t) => t.windowId === user.win.id)).toHaveLength(1);
  });

  it("tab_close of the last tab never closes the user's window", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    await fake.chrome.tabs.remove(user.tab.id);
    await call(alice, "tab_close", { tab_id: a.tab_id });
    expect(fake.windows.has(user.win.id)).toBe(true);
  });

  it("falls back to own_window when there is no user window", async () => {
    await fake.chrome.tabs.remove(user.tab.id); // the only user window goes away
    expect(fake.windows.size).toBe(0);
    const a = (await call(alice, "tab_create", {})) as Info;
    expect(fake.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.windows.create.mock.calls[0]![0]).toMatchObject({ focused: false });
    expect((await fake.chrome.storage.session.get("v2:placements"))["v2:placements"]).toEqual({ [alice.short_id]: "own_window" });
    // The session stays in its own window even once a user window exists.
    const win = fake.addWindow({ focused: true });
    fake.addTab({ windowId: win.id, active: true });
    const a2 = (await call(alice, "tab_create", {})) as Info;
    expect(tabOf(a2).windowId).toBe(tabOf(a).windowId);
  });

  it("Show expands the group, activates its first tab and focuses the window (user click)", async () => {
    const a1 = (await call(alice, "tab_create", {})) as Info;
    await call(alice, "tab_create", {});
    await tabs.showSession(alice.short_id);
    expect(groupOf(a1).collapsed).toBe(false);
    expect(tabOf(a1).active).toBe(true);
    expect(fake.chrome.windows.update).toHaveBeenCalledWith(user.win.id, { focused: true });
  });
});

describe("switching the setting mid-session", () => {
  it("does not move an existing own_window session", async () => {
    await setPlacement("own_window");
    const a1 = (await call(alice, "tab_create", {})) as Info;
    await setPlacement("user_window");
    const a2 = (await call(alice, "tab_create", {})) as Info;
    expect(tabOf(a2).windowId).toBe(tabOf(a1).windowId);
    expect(tabOf(a2).windowId).not.toBe(user.win.id);
    // A new session uses the new setting.
    const b = (await call(bob, "tab_create", {})) as Info;
    expect(tabOf(b).windowId).toBe(user.win.id);
  });

  it("does not move an existing user_window session", async () => {
    await setPlacement("user_window");
    const a1 = (await call(alice, "tab_create", {})) as Info;
    await setPlacement("own_window");
    const a2 = (await call(alice, "tab_create", {})) as Info;
    expect(tabOf(a2).windowId).toBe(user.win.id);
    expect(tabOf(a2).groupId).toBe(tabOf(a1).groupId);
    await call(alice, "snapshot", { tab_id: a2.tab_id }).catch(() => undefined);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe("reconcile", () => {
  it("rebuilds placement from group windows", async () => {
    await setPlacement("user_window");
    const a = (await call(alice, "tab_create", {})) as Info;
    await setPlacement("own_window");
    const b = (await call(bob, "tab_create", {})) as Info;
    // Service-worker restart with lost runtime state.
    await fake.chrome.storage.session.set({ "v2:placements": {}, "v2:sessionWindows": {}, "v2:groups": {} });
    await setPlacement("user_window");
    const fresh = new TabManager((e) => events.push(e));
    await fresh.reconcile();
    const stored = await fake.chrome.storage.session.get(["v2:placements", "v2:sessionWindows"]);
    expect(stored["v2:placements"]).toEqual({ [alice.short_id]: "user_window", [bob.short_id]: "own_window" });
    expect(stored["v2:sessionWindows"]).toEqual({ [bob.short_id]: tabOf(b).windowId });
    fake.chrome.tabs.update.mockClear();
    await call(alice, "snapshot", { tab_id: a.tab_id }, fresh).catch(() => undefined);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expect(await call(alice, "session_release", {}, fresh)).toEqual({ kept_tabs: 1, moved: true, mode: "keep" });
    expect(fake.chrome.tabGroups.move).not.toHaveBeenCalled();
  });

  it("rebuilds placement lazily without a reconcile", async () => {
    await setPlacement("user_window");
    const a = (await call(alice, "tab_create", {})) as Info;
    await fake.chrome.storage.session.set({ "v2:placements": {}, "v2:groups": {} });
    const fresh = new TabManager((e) => events.push(e));
    expect(await fresh.placementFor(alice.short_id)).toBe("user_window");
    await call(alice, "snapshot", { tab_id: a.tab_id }, fresh).catch(() => undefined);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe("adoption into a user_window group", () => {
  beforeEach(() => setPlacement("user_window"));

  it("groups a tab Chrome opened active in the user's window and restores the user's active tab", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    const child = fake.addTab({ windowId: user.win.id, openerTabId: a.tab_id, url: "https://child", active: true });
    expect(user.tab.active).toBe(false);
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(child.groupId).toBe(tabOf(a).groupId);
    expect(child.active).toBe(false);
    expect(user.tab.active).toBe(true);
    expect(fake.chrome.tabs.update).toHaveBeenCalledWith(user.tab.id, { active: true });
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ event: "tab_adopted", short_id: alice.short_id, tab: expect.objectContaining({ tab_id: child.id }) }),
    ]);
    await expect(tabs.assertOwned(alice, child.id)).resolves.toBeTruthy();
  });

  it("moves a tab opened in another window into the group without changing the user's active tab", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    const other = fake.addWindow();
    const child = fake.addTab({ windowId: other.id, openerTabId: a.tab_id, active: true });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(child).toMatchObject({ windowId: user.win.id, groupId: tabOf(a).groupId, active: false });
    expect(user.tab.active).toBe(true);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    const stored = await fake.chrome.storage.session.get("v2:sessionWindows");
    expect(stored["v2:sessionWindows"]).toEqual({});
  });

  it("leaves an inactive adopted tab alone", async () => {
    const a = (await call(alice, "tab_create", {})) as Info;
    const child = fake.addTab({ windowId: user.win.id, openerTabId: a.tab_id });
    await tabs.handleTabCreated((await fake.chrome.tabs.get(child.id)) as chrome.tabs.Tab);
    expect(child.groupId).toBe(tabOf(a).groupId);
    expect(fake.chrome.tabs.update).not.toHaveBeenCalled();
    expect(user.tab.active).toBe(true);
  });
});

describe("popup placement radios", () => {
  function radio(value: string): RadioLike & { fire(): void } {
    const listeners: (() => void)[] = [];
    return {
      value,
      checked: false,
      addEventListener: (_type, fn) => void listeners.push(fn),
      fire: () => listeners.forEach((fn) => fn()),
    };
  }

  it("checks the stored choice (shared_window by default, no radio for it yet) and persists a change", async () => {
    const own = radio("own_window");
    const mine = radio("user_window");
    await bindPlacementRadios([own, mine]);
    expect([own.checked, mine.checked]).toEqual([false, false]);
    mine.checked = true;
    own.checked = false;
    own.fire();
    mine.fire();
    await vi.waitFor(async () => expect(await loadPlacement()).toBe("user_window"));
    expect(fake.chrome.storage.local.set).toHaveBeenLastCalledWith({ "v2:placement": "user_window" });

    const again = [radio("own_window"), radio("user_window")];
    await bindPlacementRadios(again);
    expect(again.map((r) => r.checked)).toEqual([false, true]);
  });

  it("shows both options with the note under 'My current window'", () => {
    const html = readFileSync(new URL("./popup/popup.html", import.meta.url), "utf8");
    expect(html).toContain("New agent tabs open in:");
    expect(html).toMatch(/<input type="radio" name="placement" value="own_window" checked \/> Their own window \(fastest\)/);
    expect(html).toMatch(/<input type="radio" name="placement" value="user_window" \/> My current window/);
    const note = "Slower: Chrome throttles tabs you aren't looking at. Agents never switch your current tab.";
    expect(html).toContain(note);
    expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("My current window"));
  });
});
