import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "@tabcrew/shared/v2";
import type { PopupActionResult, PopupCloseResult, PopupRequest, PopupState, PopupStopResult } from "../config.js";
import { TabManager } from "../tabs.js";
import { createFakeChrome, flush, type FakeChrome, type FakePort } from "../test/fakes.js";
import { finishedRows, sessionRows } from "./view.js";

describe("sessionRows", () => {
  it("shows label · short_id and tab count, Stop for live sessions and Close tabs for stopped ones", () => {
    expect(
      sessionRows([
        { short_id: "aaaa1111", label: "alice", tab_count: 1 },
        { short_id: "bbbb2222", label: "bob", tab_count: 3, stopped: true },
        { short_id: "cccc3333", label: "carol", tab_count: 0, stopped: true },
      ]),
    ).toEqual([
      { short_id: "aaaa1111", name: "alice · aaaa1111", meta: "1 tab", stopped: false, action: "stop" },
      { short_id: "bbbb2222", name: "bob · bbbb2222", meta: "3 tabs · stopped", stopped: true, action: "close_tabs" },
      { short_id: "cccc3333", name: "carol · cccc3333", meta: "0 tabs · stopped", stopped: true, action: null },
    ]);
  });
});

describe("finishedRows", () => {
  it("shows ✓ label and tab count", () => {
    expect(finishedRows([{ group_id: 7, label: "alice", tab_count: 2 }])).toEqual([{ group_id: 7, name: "✓ alice", meta: "2 tabs" }]);
  });
});

describe("TabManager.closeSessionTabsLocally", () => {
  it("closes every tab of the session and reports each as tab_removed (a user action)", async () => {
    const fake = createFakeChrome();
    fake.install();
    const events: V2Event[] = [];
    const tabs = new TabManager((e) => events.push(e));
    const alice = { short_id: "aaaa1111", label: "alice" };
    const bob = { short_id: "bbbb2222", label: "bob" };
    const a1 = await tabs.tabCreate(alice, {});
    const a2 = await tabs.tabCreate(alice, {});
    const b1 = await tabs.tabCreate(bob, {});
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 2 });
    expect(fake.tabs.has(a1.tab_id) || fake.tabs.has(a2.tab_id)).toBe(false);
    expect(fake.tabs.has(b1.tab_id)).toBe(true);
    for (const id of [a1.tab_id, a2.tab_id]) await tabs.handleTabRemoved(id);
    expect(events).toEqual([
      { type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a1.tab_id },
      { type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a2.tab_id },
    ]);
    expect(await tabs.closeSessionTabsLocally(alice.short_id)).toEqual({ closed_tabs: 0 });
  });
});

describe("service worker stop state", () => {
  let fake: FakeChrome;
  let port: FakePort;
  const alice = { short_id: "aaaa1111", label: "alice" };
  const bob = { short_id: "bbbb2222", label: "bob" };

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  function message<T>(msg: PopupRequest): Promise<T> {
    return new Promise((resolve) => fake.chrome.runtime.onMessage.fire(msg, {}, (r) => resolve(r as T)));
  }

  async function request(id: string, op: string, session: typeof alice, args: object = {}): Promise<{ ok: boolean; result?: any }> {
    port.postMessage({ type: "request", request: { type: "request", id, op, session, args } });
    await settle();
    const frame = port
      .messages<{ type: string; frame: { id: string; ok: boolean; result?: unknown } }>()
      .find((m) => m.type === "frame" && m.frame.id === id)!.frame;
    return frame;
  }

  const sentEvents = () =>
    port
      .messages<{ type: string; frame: V2Event }>()
      .filter((m) => m.type === "frame" && m.frame.type === "event")
      .map((m) => m.frame);

  beforeEach(async () => {
    fake = createFakeChrome();
    fake.install();
    await fake.chrome.storage.local.set({ "v2:token": "secret-token" });
    vi.resetModules();
    await import("../service-worker.js");
    await settle();
    port = fake.chrome.runtime.connect({ name: "v2-bridge" });
    port.postMessage({ type: "status", status: "connected" });
    await settle();
  });

  it("marks a stopped session in the popup state until its group disappears", async () => {
    const a = await request("r1", "tab_create", alice);
    await request("r2", "tab_create", bob);
    expect((await message<PopupStopResult>({ type: "v2:stop", short_id: alice.short_id })).ok).toBe(true);
    await settle();
    expect(sentEvents()).toContainEqual({ type: "event", event: "stop", short_id: alice.short_id });

    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions.map((s) => [s.short_id, s.stopped])).toEqual([
      [alice.short_id, true],
      [bob.short_id, false],
    ]);

    // Closing the stopped session's tabs from the popup is allowed; the group then disappears.
    const closed = await message<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: alice.short_id });
    expect(closed).toEqual({ ok: true, closed_tabs: 1 });
    expect(fake.tabs.has(a.result.tab_id)).toBe(false);
    fake.chrome.tabs.onRemoved.fire(a.result.tab_id);
    await settle();
    expect(sentEvents()).toContainEqual({ type: "event", event: "tab_removed", short_id: alice.short_id, tab_id: a.result.tab_id });

    const after = await message<PopupState>({ type: "v2:get_state" });
    expect(after.sessions.map((s) => s.short_id)).toEqual([bob.short_id]);
    expect((await fake.chrome.storage.session.get("v2:stoppedSessions"))["v2:stoppedSessions"]).toEqual([]);
  });

  it("Stop all marks every listed session stopped", async () => {
    await request("r1", "tab_create", alice);
    await request("r2", "tab_create", bob);
    expect((await message<PopupStopResult>({ type: "v2:stop", short_id: null })).ok).toBe(true);
    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions.every((s) => s.stopped)).toBe(true);
    expect(sentEvents()).toContainEqual({ type: "event", event: "stop", short_id: null });
  });

  it("refuses to close tabs of a session that was not stopped", async () => {
    const a = await request("r1", "tab_create", alice);
    const r = await message<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: alice.short_id });
    expect(r.ok).toBe(false);
    expect(fake.tabs.has(a.result.tab_id)).toBe(true);
  });

  it("does not mark a session stopped when the daemon is not connected", async () => {
    await request("r1", "tab_create", alice);
    port.postMessage({ type: "status", status: "offline" });
    await settle();
    const r = await message<PopupStopResult>({ type: "v2:stop", short_id: alice.short_id });
    expect(r.ok).toBe(false);
    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions[0]!.stopped).toBe(false);
  });
});

describe("popup: Show and finished sessions", () => {
  let fake: FakeChrome;
  let port: FakePort;
  const alice = { short_id: "aaaa1111", label: "alice" };
  const bob = { short_id: "bbbb2222", label: "bob" };

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  function message<T>(msg: PopupRequest): Promise<T> {
    return new Promise((resolve) => fake.chrome.runtime.onMessage.fire(msg, {}, (r) => resolve(r as T)));
  }
  async function request(id: string, op: string, session: typeof alice, args: object = {}): Promise<{ ok: boolean; result?: any }> {
    port.postMessage({ type: "request", request: { type: "request", id, op, session, args } });
    await settle();
    return port
      .messages<{ type: string; frame: { id: string; ok: boolean; result?: unknown } }>()
      .find((m) => m.type === "frame" && m.frame.id === id)!.frame;
  }

  let userWin: { id: number };
  let userTab: { id: number; active: boolean };

  beforeEach(async () => {
    fake = createFakeChrome();
    fake.install();
    userWin = fake.addWindow({ focused: true });
    userTab = fake.addTab({ windowId: userWin.id, url: "https://user", active: true });
    await fake.chrome.storage.local.set({ "v2:token": "secret-token" });
    // Released ("✓ label") groups are the own_window placement's finish behaviour.
    await fake.chrome.storage.local.set({ "v2:placement": "own_window" });
    vi.resetModules();
    await import("../service-worker.js");
    await settle();
    port = fake.chrome.runtime.connect({ name: "v2-bridge" });
    port.postMessage({ type: "status", status: "connected" });
    await settle();
  });

  it("Show focuses the session's window only when clicked", async () => {
    const a = await request("r1", "tab_create", alice);
    const win = fake.tabs.get(a.result.tab_id)!.windowId;
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    expect(await message<PopupActionResult>({ type: "v2:show_session", short_id: alice.short_id })).toEqual({ ok: true });
    expect(fake.chrome.windows.update).toHaveBeenCalledWith(win, { focused: true });
    expect((await message<PopupActionResult>({ type: "v2:show_session", short_id: "zzzz9999" })).ok).toBe(false);
  });

  it("lists released groups as finished; Open expands, activates and focuses on click; Close removes the tabs", async () => {
    const a1 = await request("r1", "tab_create", alice, { url: "https://a/1" });
    const a2 = await request("r2", "tab_create", alice, { url: "https://a/2" });
    await request("r3", "tab_create", bob);
    const released = await request("r4", "session_release", alice);
    expect(released).toMatchObject({ ok: true, result: { kept_tabs: 2, moved: true } });
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
    expect(userTab.active).toBe(true);

    const state = await message<PopupState>({ type: "v2:get_state" });
    expect(state.sessions.map((s) => s.short_id)).toEqual([bob.short_id]);
    expect(state.finished).toHaveLength(1);
    const finished = state.finished[0]!;
    expect(finished).toEqual({ group_id: expect.any(Number), label: "alice", tab_count: 2 });
    expect(fake.groups.get(finished.group_id)).toMatchObject({ title: "✓ alice", collapsed: true, windowId: userWin.id });

    // Open: a user click, so focusing is allowed.
    fake.focusWindow(fake.tabs.get((await request("r5", "tab_list", bob)).result.tabs[0].tab_id)!.windowId);
    expect(await message<PopupActionResult>({ type: "v2:open_finished", group_id: finished.group_id })).toEqual({ ok: true });
    expect(fake.groups.get(finished.group_id)!.collapsed).toBe(false);
    expect(fake.tabs.get(a1.result.tab_id)!.active).toBe(true);
    expect(userTab.active).toBe(false);
    expect(fake.chrome.windows.update).toHaveBeenCalledWith(userWin.id, { focused: true });

    // Close: removes the tabs; no tab_removed goes to the daemon for released tabs.
    expect(await message<PopupCloseResult>({ type: "v2:close_finished", group_id: finished.group_id })).toEqual({ ok: true, closed_tabs: 2 });
    expect(fake.tabs.has(a1.result.tab_id) || fake.tabs.has(a2.result.tab_id)).toBe(false);
    for (const id of [a1.result.tab_id, a2.result.tab_id]) fake.chrome.tabs.onRemoved.fire(id);
    await settle();
    const events = port
      .messages<{ type: string; frame: V2Event }>()
      .filter((m) => m.type === "frame" && m.frame.type === "event" && m.frame.event === "tab_removed");
    expect(events).toEqual([]);
    expect((await message<PopupState>({ type: "v2:get_state" })).finished).toEqual([]);
  });

  it("Close all finished closes every released group and nothing else", async () => {
    const a = await request("r1", "tab_create", alice);
    const b = await request("r2", "tab_create", bob);
    await request("r3", "session_release", alice);
    await request("r4", "session_release", bob);
    const c = await request("r5", "tab_create", { short_id: "cccc3333", label: "carol" });
    expect((await message<PopupState>({ type: "v2:get_state" })).finished).toHaveLength(2);
    expect(await message<PopupCloseResult>({ type: "v2:close_all_finished" })).toEqual({ ok: true, closed_tabs: 2 });
    expect(fake.tabs.has(a.result.tab_id) || fake.tabs.has(b.result.tab_id)).toBe(false);
    expect(fake.tabs.has(c.result.tab_id)).toBe(true);
    expect(userTab.active).toBe(true);
  });

  it("refuses to Open or Close a group that is not a finished session", async () => {
    const a = await request("r1", "tab_create", alice);
    const groupId = fake.tabs.get(a.result.tab_id)!.groupId;
    expect((await message<PopupCloseResult>({ type: "v2:close_finished", group_id: groupId })).ok).toBe(false);
    expect((await message<PopupActionResult>({ type: "v2:open_finished", group_id: groupId })).ok).toBe(false);
    expect(fake.tabs.has(a.result.tab_id)).toBe(true);
    expect(fake.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("forgets a finished group the user closed in Chrome", async () => {
    const a = await request("r1", "tab_create", alice);
    await request("r2", "session_release", alice);
    await fake.chrome.tabs.remove(a.result.tab_id);
    expect((await message<PopupState>({ type: "v2:get_state" })).finished).toEqual([]);
    expect((await fake.chrome.storage.session.get("v2:releasedGroups"))["v2:releasedGroups"]).toEqual({});
  });
});
