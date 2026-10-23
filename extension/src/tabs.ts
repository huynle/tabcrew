/**
 * Sessions → tabs, with per-tab ownership.
 *
 * Ownership (chrome.storage.local, see config.ts `OWNERSHIP_KEYS`):
 * - `tabOwners` (tab id → short_id) is the only source of truth for "this agent may touch this
 *   tab". A tab is owned by a session iff the map says so AND the tab is in that session's
 *   group (`sessionGroups`) AND that group is TabCrew-managed (`managedGroups`) and still in the
 *   window it was recorded in. Group titles never grant ownership: a tab the user drags into a
 *   TabCrew group belongs to nobody, and every group-wide query goes through the map.
 * - The maps live in chrome.storage.local so they survive an extension reload (which clears
 *   chrome.storage.session), and are wiped on `chrome.runtime.onStartup` (`handleStartup`): tab,
 *   group and window ids do not survive a Chrome restart, so old TabCrew tabs become the user's
 *   (fail closed). State loading awaits a pending wipe. Every load validates entries against the
 *   live browser (tab exists, tab.groupId is its session's managed group, the group is still in
 *   its recorded window); a managed group the user moved to another window stops being TabCrew's.
 * - One-time legacy migration: when nothing is stored and `MIGRATED_KEY` is unset, groups titled
 *   `<label> · <short_id>` (pre-shared-groups sessions) are adopted once. Never again afterwards,
 *   and never after a startup wipe.
 *
 * Placement (user setting `v2:placement`, decided per session at its first `tab_create`):
 * - `shared_window` (default): ONE TabCrew window (created unfocused under a global lock, reused
 *   while alive) holding named, TabCrew-managed groups (kind `shared`). A session's tabs join
 *   the group named `session.group ?? loadGroupName()` (created if missing). Several sessions
 *   share a group; each owns only its own tabs. Page-driving ops activate the target tab inside
 *   the TabCrew window under a per-window FIFO lock (`pageLocks`, used by ops.ts).
 * - `own_window`: one never-focused window per session holding the session's own group (kind
 *   `session`, titled `v2GroupTitle(session)`). Chrome throttles every tab that is not the active
 *   tab of its window, so the target tab is activated within that window.
 * - `user_window`: the session's own collapsed group in the user's window; its tabs are created
 *   with `active: false`, never activated, and the user's active tab is restored if Chrome changed
 *   it. That window is never focused and never closed.
 * No window is ever focused except by popup clicks (Show / Open).
 *
 * Finishing (`session_release`, mode = `args.tabs ?? v2:finish_mode`):
 * - `keep`: shared groups keep the tabs in place, unowned and recorded as finished
 *   (`FinishedTabs`); a per-session group (own/user window) is handed to the user as before:
 *   retitled `✓ <label>`, collapsed, moved into the user's window (own_window).
 * - `close`: the session's tabs are closed (ungrouped first; the user's window is never closed).
 * - `collect`: the tabs move into one collapsed `v2CollectGroupTitle(name)` group (kind `collect`)
 *   in the TabCrew window, listed by the popup under Finished.
 * In every mode the debugger is detached and the tabs stop being owned.
 */

import {
  v2CollectGroupTitle,
  v2GroupTitle,
  v2IsFinishMode,
  v2NormaliseGroupName,
  v2ParseGroupTitle,
  v2ReleasedGroupTitle,
  type V2Event,
  type V2FinishMode,
  type V2SessionRef,
  type V2TabInfo,
} from "@tabcrew/shared/v2";
import {
  FOCUS_ORDER_KEY,
  MANAGED_GROUPS_KEY,
  OWNERSHIP_KEYS,
  PLACEMENTS_KEY,
  SESSION_GROUPS_KEY,
  SESSION_WINDOWS_KEY,
  TABCREW_WINDOW_KEY,
  TAB_OWNERS_KEY,
  loadFinishMode,
  loadGroupName,
  loadPlacement,
  parseOwnership,
  saveGroupName,
  type ManagedGroup,
  type ManagedGroupKind,
  type Placement,
  type PopupFinishedInfo,
  type PopupGroupInfo,
  type PopupSessionInfo,
} from "./config.js";
import { OpError } from "./errors.js";
import { FinishedTabs, ReleasedGroups } from "./released.js";

/** chrome.storage.local: legacy title groups were migrated (or a startup wipe happened); never adopt by title again. */
export const MIGRATED_KEY = "v2:ownershipMigrated";
/** chrome.storage.local: TabCrew group names registered in the popup that have no Chrome group yet (Chrome cannot hold an empty group). */
export const CREATED_GROUPS_KEY = "v2:createdGroups";
/** chrome.storage.session: short_id → label (for the popup and finished-group titles). */
export const SESSION_LABELS_KEY = "v2:sessionLabels";

const NO_GROUP = -1;
const BLANK_URL = "about:blank";
const FOCUS_ORDER_MAX = 20;
const ACTIVE_HISTORY_MAX = 5;
const MAX_CREATED_GROUPS = 20;
const WINDOW_LOCK = "tabcrew-window";
const GROUPS_LOCK = "tabcrew-groups";

interface State {
  // chrome.storage.local (ownership; wiped on browser startup)
  tabOwners: Record<string, string>;
  sessionGroups: Record<string, number>;
  managedGroups: Record<string, ManagedGroup>;
  tabcrewWindow: number | null;
  // chrome.storage.session (rebuildable)
  /** short_id → id of the window created for that session (own_window sessions only). */
  sessionWindows: Record<string, number>;
  /** short_id → where the session's tabs live, decided at its first tab_create. */
  placements: Record<string, Placement>;
  labels: Record<string, string>;
  /** Window ids in most-recently-focused order (first = latest). */
  focusOrder: number[];
}

/** A session's validated, live group. */
interface LiveGroup {
  groupId: number;
  windowId: number;
  rec: ManagedGroup;
  /** Live title (the group is tracked by id, so the user may have renamed it). */
  name: string;
}

export type GroupsPayload = Extract<V2Event, { event: "groups" }>["groups"];
type GroupsEntry = GroupsPayload[number];
export type ReleaseResult = { kept_tabs: number; moved: boolean; closed_tabs?: number; mode: V2FinishMode };

export function toTabInfo(tab: chrome.tabs.Tab): V2TabInfo {
  const info: { tab_id: number; url: string; title: string; opener_tab_id?: number } = {
    tab_id: tab.id ?? -1,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title ?? "",
  };
  if (typeof tab.openerTabId === "number") info.opener_tab_id = tab.openerTabId;
  return info;
}

/** Runs async tasks one at a time per key, in call order (FIFO). Not reentrant. */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export class TabManager {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  /** Bumped by a startup wipe so an in-flight load never resurrects wiped state. */
  private generation = 0;
  private startup: Promise<void> = Promise.resolve();
  private readonly locks = new KeyedLock();
  /** Per-window FIFO lock around activate + page op (ops.ts); key `window:<id>`. */
  readonly pageLocks = new KeyedLock();
  /** Tabs we are closing on the daemon's behalf: no `tab_removed` echo for these. */
  private readonly expectedRemovals = new Set<number>();
  /** windowId → recently activated tab ids (latest first), to undo activations we caused. */
  private readonly activeHistory = new Map<number, number[]>();

  constructor(
    private readonly emit: (event: V2Event) => void,
    readonly released: ReleasedGroups = new ReleasedGroups(),
    readonly finished: FinishedTabs = new FinishedTabs(),
  ) {}

  // ---------------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------------

  tabCreate(session: V2SessionRef, args: { url?: unknown }): Promise<V2TabInfo> {
    if (args.url !== undefined && typeof args.url !== "string") {
      throw new OpError("invalid_args", "url must be a string");
    }
    const url = (args.url as string | undefined) || BLANK_URL;
    return this.locks.run(`session:${session.short_id}`, async () => {
      const state = await this.load();
      if (session.label) state.labels[session.short_id] = session.label;
      const placement = (await this.placementFor(session.short_id)) ?? (await loadPlacement());
      if (placement === "user_window") {
        const created = await this.createInUserWindow(session, url);
        if (created) return created;
        // No user window to use: this session falls back to its own window.
      }
      if (placement === "shared_window") return this.createShared(session, url);
      return this.createInOwnWindow(session, url);
    });
  }

  async tabList(session: V2SessionRef): Promise<{ tabs: V2TabInfo[] }> {
    return { tabs: (await this.ownedTabs(session.short_id)).map(toTabInfo) };
  }

  tabClose(session: V2SessionRef, args: { tab_id?: unknown }): Promise<{ closed: true }> {
    const tabId = requireTabId(args);
    return this.locks.run(`session:${session.short_id}`, async () => {
      await this.assertOwned(session, tabId);
      this.expectedRemovals.add(tabId);
      try {
        await this.removeTabs(session.short_id, [tabId]);
      } catch (err) {
        this.expectedRemovals.delete(tabId);
        throw err;
      }
      const state = await this.load();
      delete state.tabOwners[tabId];
      await this.save();
      return { closed: true as const };
    });
  }

  sessionClose(session: V2SessionRef): Promise<{ closed_tabs: number }> {
    const shortId = session.short_id;
    return this.locks.run(`session:${shortId}`, async () => {
      const tabIds = idsOf(await this.ownedTabs(shortId));
      for (const id of tabIds) this.expectedRemovals.add(id);
      await this.removeTabs(shortId, tabIds);
      const state = await this.load();
      const live = state.sessionGroups[shortId];
      if (live !== undefined && state.managedGroups[live]?.kind === "session") delete state.managedGroups[live];
      this.forgetSession(state, shortId);
      await this.save();
      return { closed_tabs: tabIds.length };
    });
  }

  /**
   * Finish a session (op `session_release`): detach the debugger from its tabs (`releaseTab`),
   * stop owning them and apply the finish mode (`args.tabs`, else the user's default; see the
   * file comment). Only the session's own tabs are touched, never other tabs in a shared group.
   * Idempotent: a session without tabs yields `kept_tabs: 0`.
   */
  releaseSession(
    session: V2SessionRef,
    releaseTab: (tabId: number) => Promise<void>,
    args: { tabs?: unknown } = {},
  ): Promise<ReleaseResult> {
    const requested = args?.tabs;
    if (requested !== undefined && !v2IsFinishMode(requested)) {
      throw new OpError("invalid_args", "tabs must be keep, close or collect");
    }
    const shortId = session.short_id;
    return this.locks.run(`session:${shortId}`, async () => {
      const mode = requested ?? (await loadFinishMode());
      const placement = await this.placementFor(shortId);
      const live = await this.liveSessionGroup(shortId);
      const owned = await this.ownedTabs(shortId);
      const tabIds = idsOf(owned);
      // Windows that never receive a finished group (this session's own window included).
      const nonUser = await this.nonUserWindowIds();
      const state = await this.load();
      const label = session.label || state.labels[shortId] || shortId;
      // From here on the tabs are no longer owned, and closing them is never reported.
      if (live?.rec.kind === "session") delete state.managedGroups[live.groupId];
      this.forgetSession(state, shortId);
      await this.save();

      const closedPart = mode === "close" ? { closed_tabs: 0 } : {};
      if (tabIds.length === 0 || !live) return { kept_tabs: 0, moved: false, ...closedPart, mode };
      for (const id of tabIds) await releaseTab(id).catch(() => undefined);

      const inUserWindow = placement === "user_window";
      if (mode === "close") {
        await this.closeTabsGuarded(tabIds, inUserWindow);
        return { kept_tabs: 0, moved: false, closed_tabs: tabIds.length, mode };
      }
      if (mode === "collect") {
        const name = live.rec.kind === "shared" ? live.name : await loadGroupName();
        const moved = await this.collect(tabIds, name, inUserWindow);
        return { kept_tabs: tabIds.length, moved, mode };
      }
      if (live.rec.kind === "shared") {
        await this.finished.add(tabIds, live.groupId);
        return { kept_tabs: tabIds.length, moved: false, mode };
      }
      const moved = await this.handOver(live.groupId, label, inUserWindow, nonUser);
      return { kept_tabs: tabIds.length, moved, mode };
    });
  }

  /**
   * keep for a per-session group: retitle it `✓ <label>`, move it into the user's window (see
   * `pickUserWindow`) and collapse it; the user's active tab is restored if the move changed it.
   * No user window: the group stays where it is (false). A `user_window` group is retitled and
   * collapsed in place (true: the tabs are in the user's window).
   */
  private async handOver(groupId: number, label: string, inUserWindow: boolean, nonUser: ReadonlySet<number>): Promise<boolean> {
    const title = v2ReleasedGroupTitle(label);
    const collapse = (id: number) =>
      chrome.tabGroups
        .update(id, { title, collapsed: true })
        .catch(() => chrome.tabGroups.update(id, { title }).catch(() => undefined));
    if (inUserWindow) {
      await collapse(groupId);
      await this.released.add(groupId, label);
      return true;
    }
    const dest = await this.pickUserWindow(nonUser);
    const previousActive = dest !== null ? await activeTabId(dest) : undefined;
    let moved = dest !== null;
    // Retitle first so the group never looks like a live session group again.
    await chrome.tabGroups.update(groupId, { title }).catch(() => undefined);
    let finalId = groupId;
    if (dest !== null) {
      try {
        const g = await chrome.tabGroups.move(groupId, { windowId: dest, index: -1 });
        if (g && typeof g.id === "number") finalId = g.id;
      } catch (err) {
        moved = false;
        console.warn(`[v2 tabs] could not move finished group ${groupId} to window ${dest}:`, err);
      }
    }
    await collapse(finalId);
    await this.released.add(finalId, label);
    if (dest !== null && previousActive !== undefined && (await activeTabId(dest)) !== previousActive) {
      // Switches tabs inside that window only; it does not focus the window.
      await chrome.tabs.update(previousActive, { active: true }).catch(() => undefined);
    }
    return moved;
  }

  /**
   * collect: move the tabs into the collapsed `✓ <name>` group in the TabCrew window (created
   * unfocused from the first tab if there is none). Tabs leaving the user's window never leave
   * it empty.
   */
  private async collect(tabIds: number[], name: string, fromUserWindow: boolean): Promise<boolean> {
    const title = v2CollectGroupTitle(name);
    if (fromUserWindow) await keepWindowsOpen(tabIds);
    const { windowId } = await this.locks.run(WINDOW_LOCK, () => this.ensureTabcrewWindow({ tabId: tabIds[0]! }));
    return this.locks.run(GROUPS_LOCK, async () => {
      const state = await this.load();
      const away: number[] = [];
      for (const id of tabIds) {
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (tab && tab.windowId !== windowId) away.push(id);
      }
      if (away.length > 0) await chrome.tabs.move(away, { windowId, index: -1 });
      let groupId = await this.findManagedGroup("collect", title, windowId);
      if (groupId !== null) {
        await chrome.tabs.group({ groupId, tabIds });
      } else {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        state.managedGroups[groupId] = { name: title, windowId, kind: "collect" };
        await this.save();
      }
      const id = groupId;
      await chrome.tabGroups
        .update(id, { title, collapsed: true })
        .catch(() => chrome.tabGroups.update(id, { title }).catch(() => undefined));
      await this.released.add(id, v2NormaliseGroupName(name) ?? title);
      await this.finished.add(tabIds, id);
      return true;
    });
  }

  /**
   * Where a finished group goes: the last-focused normal window if it is the user's (not
   * incognito, not a TabCrew/session window), else the most recently focused such window, else null.
   */
  private async pickUserWindow(nonUser: ReadonlySet<number>): Promise<number | null> {
    const usable = (w: chrome.windows.Window | null | undefined): w is chrome.windows.Window & { id: number } =>
      !!w && typeof w.id === "number" && w.type === "normal" && !w.incognito && !nonUser.has(w.id);
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    if (usable(last)) return last.id;
    const candidates: number[] = [];
    for (const w of await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => [])) {
      if (usable(w)) candidates.push(w.id);
    }
    if (candidates.length === 0) return null;
    const order = (await this.load()).focusOrder;
    const rank = (id: number) => {
      const i = order.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0];
  }

  /**
   * User action from the popup: close every tab the session owns. Unlike sessionClose this is
   * not on the daemon's behalf, so each closed tab is reported as `tab_removed`.
   */
  closeSessionTabsLocally(shortId: string): Promise<{ closed_tabs: number }> {
    return this.locks.run(`session:${shortId}`, async () => {
      const tabIds = idsOf(await this.ownedTabs(shortId));
      await this.removeTabs(shortId, tabIds);
      return { closed_tabs: tabIds.length };
    });
  }

  /**
   * Ownership check for every tab-scoped op: the owner map says this session, and the tab is in
   * the session's TabCrew-managed group (in its recorded window). Returns the live tab.
   */
  async assertOwned(session: V2SessionRef, tabId: number): Promise<chrome.tabs.Tab> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new OpError("tab_gone", `tab ${tabId} no longer exists`);
    }
    const state = await this.load();
    if (state.tabOwners[tabId] !== session.short_id) {
      throw new OpError("tab_not_owned", `tab ${tabId} is not one of this session's tabs`);
    }
    const live = await this.liveSessionGroup(session.short_id);
    if (!live || tab.groupId !== live.groupId || tab.windowId !== live.windowId) {
      // The user took the tab out of the session's group: it is theirs now.
      delete state.tabOwners[tabId];
      await this.save();
      throw new OpError("tab_not_owned", `tab ${tabId} is not one of this session's tabs`);
    }
    return tab;
  }

  /**
   * Make an owned tab the active tab of its (unfocused) window so Chrome does not throttle it.
   * Switches tabs within that window only; never focuses the window. Callers hold the window's
   * page lock (ops.ts) and never call this for `user_window` sessions.
   */
  async activate(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.active || typeof tab.id !== "number") return;
    await chrome.tabs.update(tab.id, { active: true });
  }

  /**
   * The session's remembered placement; rebuilt from its group when unknown (after an extension
   * reload). Undefined for a session that has no placement and no group.
   */
  async placementFor(shortId: string): Promise<Placement | undefined> {
    const state = await this.load();
    const known = state.placements[shortId];
    if (known) return known;
    const live = await this.liveSessionGroup(shortId);
    if (!live) return undefined;
    if (state.placements[shortId]) return state.placements[shortId];
    const placement: Placement =
      live.rec.kind === "session" ? await this.inferPlacement(shortId, live.groupId, live.windowId) : "shared_window";
    state.placements[shortId] = placement;
    if (placement === "own_window") state.sessionWindows[shortId] = live.windowId;
    await this.save();
    return placement;
  }

  // ---------------------------------------------------------------------------
  // Group ops (agents) + popup
  // ---------------------------------------------------------------------------

  /** Op `group_list`: TabCrew group names (shared groups + registered names), never user groups. */
  async groupList(session: V2SessionRef): Promise<{ groups: { name: string; mine: boolean }[] }> {
    const groups = await this.popupGroups();
    const own = await this.liveSessionGroup(session.short_id);
    if (own && own.rec.kind === "shared") {
      return { groups: groups.map((g) => ({ name: g.name, mine: g.group_id === own.groupId })) };
    }
    const target = own ? null : (v2NormaliseGroupName(session.group) ?? (await loadGroupName()));
    return { groups: groups.map((g) => ({ name: g.name, mine: g.name === target })) };
  }

  /**
   * Op `group_rename`: rename a TabCrew group (default: the caller's group; `group` names another
   * TabCrew group). Never a user group. When the renamed group is the default group, the default
   * group name follows, so new sessions keep joining it.
   */
  groupRename(session: V2SessionRef, args: { group?: unknown; name?: unknown }): Promise<{ name: string; previous: string }> {
    const name = requireGroupName(args?.name);
    const byName = args?.group === undefined ? undefined : v2NormaliseGroupName(args.group);
    if (byName === null) throw new OpError("invalid_args", "group must be a TabCrew group name");
    return this.locks.run(GROUPS_LOCK, async () => {
      const groups = await this.popupGroups();
      if (byName !== undefined) {
        const target = groups.find((g) => g.name === byName);
        if (!target) throw new OpError("invalid_args", `no TabCrew group named "${byName}"`);
        return this.applyRename(target, name, groups);
      }
      const own = await this.liveSessionGroup(session.short_id);
      if (own?.rec.kind === "session") {
        // A per-session group (own/user window placement) is the caller's own group.
        if (name !== own.name) {
          await chrome.tabGroups.update(own.groupId, { title: name });
          await this.recordName(own.groupId, name);
        }
        return { name, previous: own.name };
      }
      const wanted = own ? null : (v2NormaliseGroupName(session.group) ?? (await loadGroupName()));
      const target = groups.find((g) => (own ? g.group_id === own.groupId : g.name === wanted));
      if (!target) throw new OpError("invalid_args", "this session is not in a TabCrew group; pass group");
      return this.applyRename(target, name, groups);
    });
  }

  /** Popup: rename a TabCrew group by id (negative ids: registered names without a Chrome group). */
  renameGroupById(groupId: unknown, rawName: unknown): Promise<void> {
    const name = requireGroupName(rawName);
    return this.locks.run(GROUPS_LOCK, async () => {
      const groups = await this.popupGroups();
      const target = groups.find((g) => g.group_id === groupId);
      if (!target) throw new OpError("invalid_args", "not a TabCrew group");
      await this.applyRename(target, name, groups);
    });
  }

  /**
   * Popup: register a TabCrew group name for later. Chrome cannot hold an empty group, so the name
   * is stored (`CREATED_GROUPS_KEY`) and listed (negative group id) until a session joins it.
   * Idempotent for an existing name.
   */
  createGroup(rawName: unknown): Promise<void> {
    const name = requireGroupName(rawName);
    return this.locks.run(GROUPS_LOCK, async () => {
      if ((await this.popupGroups()).some((g) => g.name === name)) return;
      const created = await loadCreatedGroups();
      if (created.length >= MAX_CREATED_GROUPS) throw new OpError("invalid_args", "too many TabCrew groups");
      await chrome.storage.local.set({ [CREATED_GROUPS_KEY]: [...created, name] });
    });
  }

  private async applyRename(
    target: PopupGroupInfo,
    name: string,
    groups: readonly PopupGroupInfo[],
  ): Promise<{ name: string; previous: string }> {
    const previous = target.name;
    if (name === previous) return { name, previous };
    if (groups.some((g) => g !== target && g.name === name)) {
      throw new OpError("invalid_args", `a TabCrew group named "${name}" already exists`);
    }
    if (target.group_id >= 0) {
      await chrome.tabGroups.update(target.group_id, { title: name });
      await this.recordName(target.group_id, name);
    } else {
      const created = await loadCreatedGroups();
      if (created.includes(previous)) {
        await chrome.storage.local.set({ [CREATED_GROUPS_KEY]: created.map((n) => (n === previous ? name : n)) });
      }
    }
    if (target.is_default) await saveGroupName(name);
    return { name, previous };
  }

  private async recordName(groupId: number, name: string): Promise<void> {
    const state = await this.load();
    const rec = state.managedGroups[groupId];
    if (rec) state.managedGroups[groupId] = { ...rec, name };
    await this.save();
  }

  /**
   * The TabCrew groups for the popup: live shared groups (by group id) and names without a Chrome
   * group yet (the default name, then names registered with `createGroup`) with ids -1, -2, ...
   */
  async popupGroups(): Promise<PopupGroupInfo[]> {
    const state = await this.load();
    const defaultName = await loadGroupName();
    const live = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const out: PopupGroupInfo[] = [];
    for (const [id, rec] of Object.entries(state.managedGroups)) {
      const groupId = Number(id);
      const g = live.get(groupId);
      if (rec.kind !== "shared" || !g || g.windowId !== rec.windowId) continue;
      const name = g.title || rec.name;
      const sessions = new Set(Object.values(state.tabOwners).filter((owner) => state.sessionGroups[owner] === groupId));
      out.push({
        group_id: groupId,
        name,
        active_sessions: sessions.size,
        finished_tabs: await this.finished.count(groupId),
        is_default: name === defaultName,
      });
    }
    const names = new Set(out.map((g) => g.name));
    const virtual = [defaultName, ...(await loadCreatedGroups())].filter((n, i, all) => !names.has(n) && all.indexOf(n) === i);
    virtual.forEach((name, i) =>
      out.push({ group_id: -(i + 1), name, active_sessions: 0, finished_tabs: 0, is_default: name === defaultName }),
    );
    return out;
  }

  // ---------------------------------------------------------------------------
  // Reconcile + popup
  // ---------------------------------------------------------------------------

  /**
   * After a welcome: prune the owner map against the live browser and return the `groups`
   * payload (each session's own tabs, plus its shared group's name). With the welcome's
   * `sessions`, owners the daemon no longer knows are finished with the default mode.
   */
  async reconcile(
    sessions?: readonly V2SessionRef[],
    releaseTab: (tabId: number) => Promise<void> = async () => undefined,
  ): Promise<GroupsPayload> {
    const state = await this.load();
    await this.pruneAgainstBrowser(state);
    if (sessions) {
      const known = new Set<string>();
      for (const s of sessions) {
        known.add(s.short_id);
        if (s.label) state.labels[s.short_id] = s.label;
      }
      for (const shortId of owners(state)) {
        if (known.has(shortId)) continue;
        await this.releaseSession({ short_id: shortId, label: state.labels[shortId] ?? shortId }, releaseTab).catch((err) =>
          console.warn(`[v2 tabs] could not finish unknown session ${shortId}:`, err),
        );
      }
    }
    const payload: GroupsEntry[] = [];
    const sessionWindows: Record<string, number> = {};
    for (const shortId of owners(state)) {
      const tabs = await this.ownedTabs(shortId);
      const live = await this.liveSessionGroup(shortId);
      if (tabs.length === 0 || !live) continue;
      if (live.rec.kind === "session" && (await this.placementFor(shortId)) === "own_window") {
        sessionWindows[shortId] = live.windowId;
      }
      payload.push(live.rec.kind === "shared" ? { short_id: shortId, group: live.name, tabs: tabs.map(toTabInfo) } : { short_id: shortId, tabs: tabs.map(toTabInfo) });
    }
    state.sessionWindows = sessionWindows;
    await this.save();
    return payload;
  }

  /**
   * Popup Show (a user click): bring a session's window to the front. In a shared group or the
   * user's window the group is expanded and the session's first tab activated.
   */
  async showSession(shortId: string): Promise<void> {
    const tabs = await this.ownedTabs(shortId);
    const live = await this.liveSessionGroup(shortId);
    if (tabs.length === 0 || !live) throw new OpError("invalid_args", `no tabs for session ${shortId}`);
    if ((await this.placementFor(shortId)) !== "own_window") {
      await chrome.tabGroups.update(live.groupId, { collapsed: false }).catch(() => undefined);
      const first = [...tabs].sort((a, b) => a.index - b.index)[0];
      if (first && typeof first.id === "number") await chrome.tabs.update(first.id, { active: true });
    }
    await chrome.windows.update(live.windowId, { focused: true });
  }

  /** Finished groups (handed over or collected) that still exist, newest first; forgets the ones that are gone. */
  async listFinished(): Promise<PopupFinishedInfo[]> {
    const live = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const kept = await this.released.prune(new Set(live.keys()));
    const out: (PopupFinishedInfo & { at: number })[] = [];
    for (const [id, entry] of Object.entries(kept)) {
      const groupId = Number(id);
      const tab_count = (await chrome.tabs.query({ groupId })).length;
      out.push({ group_id: groupId, label: entry.label, tab_count, at: entry.released_at });
    }
    out.sort((a, b) => b.at - a.at);
    return out.map(({ at: _at, ...info }) => info);
  }

  /** Popup Open (a user click): expand a finished group, activate its first tab, focus its window. */
  async openFinished(groupId: number): Promise<void> {
    await this.requireReleased(groupId);
    const group = await chrome.tabGroups.get(groupId);
    await chrome.tabGroups.update(groupId, { collapsed: false });
    const first = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index)[0];
    if (first && typeof first.id === "number") await chrome.tabs.update(first.id, { active: true });
    await chrome.windows.update(group.windowId, { focused: true });
  }

  /** Popup Close: close a finished group's tabs (all of them are the user's). */
  async closeFinished(groupId: number): Promise<{ closed_tabs: number }> {
    await this.requireReleased(groupId);
    const ids = idsOf(await chrome.tabs.query({ groupId }));
    if (ids.length > 0) await closeTabsUngrouped(ids);
    await this.released.remove(groupId);
    return { closed_tabs: ids.length };
  }

  async closeAllFinished(): Promise<{ closed_tabs: number }> {
    let closed = 0;
    for (const f of await this.listFinished()) closed += (await this.closeFinished(f.group_id)).closed_tabs;
    return { closed_tabs: closed };
  }

  private async requireReleased(groupId: unknown): Promise<void> {
    if (typeof groupId !== "number" || !Number.isInteger(groupId) || !(await this.released.has(groupId))) {
      throw new OpError("invalid_args", "not a finished session's group");
    }
    if (!(await chrome.tabGroups.get(groupId).catch(() => null))) {
      await this.released.remove(groupId);
      throw new OpError("invalid_args", "that group no longer exists");
    }
  }

  /** Sessions with tabs, with the number of tabs each one owns. */
  async listSessionGroups(): Promise<PopupSessionInfo[]> {
    const state = await this.load();
    const out: PopupSessionInfo[] = [];
    for (const shortId of owners(state)) {
      const count = (await this.ownedTabs(shortId)).length;
      if (count === 0) continue;
      out.push({ short_id: shortId, label: state.labels[shortId] ?? shortId, tab_count: count });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Chrome events
  // ---------------------------------------------------------------------------

  /**
   * chrome.runtime.onStartup: tab/group/window ids did not survive the browser restart, so the
   * ownership maps are wiped (old TabCrew tabs become the user's) and legacy title migration is
   * switched off. Pending and later state loads wait for this.
   */
  handleStartup(): Promise<void> {
    this.generation++;
    this.state = null;
    const run = this.startup.then(async () => {
      await chrome.storage.local.remove([...OWNERSHIP_KEYS]);
      await chrome.storage.local.set({ [MIGRATED_KEY]: true });
    });
    this.startup = run.catch(() => undefined);
    return run;
  }

  /**
   * A tab opened by an owned tab (pop-up, target=_blank) is adopted by that tab's OWNER (never by
   * whoever else has tabs in the group): it joins the owner's group, moving into its window.
   */
  async handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    const tabId = tab.id;
    const openerId = tab.openerTabId;
    if (typeof tabId !== "number" || typeof openerId !== "number") return;
    const shortId = (await this.load()).tabOwners[openerId];
    if (shortId === undefined) return;

    await this.locks.run(`session:${shortId}`, async () => {
      const state = await this.load();
      // The session may have been released while we waited for its lock.
      if (state.tabOwners[openerId] !== shortId || state.tabOwners[tabId] !== undefined) return;
      const opener = await chrome.tabs.get(openerId).catch(() => null);
      const live = await this.liveSessionGroup(shortId);
      if (!opener || !live || opener.groupId !== live.groupId) return;
      if (await this.released.has(live.groupId)) return;
      let current: chrome.tabs.Tab;
      try {
        current = await chrome.tabs.get(tabId);
      } catch {
        return;
      }
      const placement = (await this.placementFor(shortId)) ?? "own_window";
      // In the user's window the new tab must not take over the user's view.
      let restore: number | undefined;
      if (placement === "user_window") {
        const active = await activeTabId(live.windowId);
        restore = active !== undefined && active !== tabId ? active : this.previousActive(live.windowId, tabId);
      }
      if (current.groupId !== live.groupId) {
        if (current.windowId !== live.windowId) {
          const win = await chrome.windows.get(current.windowId).catch(() => null);
          if (!win || win.type !== "normal") {
            // Chrome cannot move tabs out of popup/app windows, so they cannot join the group.
            console.warn(`[v2 tabs] cannot adopt tab ${tabId} from a ${win?.type ?? "missing"} window`);
            return;
          }
          await chrome.tabs.move(tabId, { windowId: live.windowId, index: -1 });
        }
        await chrome.tabs.group({ groupId: live.groupId, tabIds: [tabId] });
        current = await chrome.tabs.get(tabId);
      }
      if (placement === "user_window" && restore !== undefined && (await activeTabId(live.windowId)) !== restore) {
        await chrome.tabs.update(restore, { active: true }).catch(() => undefined);
        current = await chrome.tabs.get(tabId).catch(() => current);
      }
      state.tabOwners[tabId] = shortId;
      await this.save();
      const info = toTabInfo(current);
      this.emit({
        type: "event",
        event: "tab_adopted",
        short_id: shortId,
        tab: info.opener_tab_id === undefined ? { ...info, opener_tab_id: openerId } : info,
      });
    });
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    const state = await this.load();
    const shortId = state.tabOwners[tabId];
    const expected = this.expectedRemovals.delete(tabId);
    await this.finished.remove(tabId);
    if (shortId === undefined) return;
    delete state.tabOwners[tabId];
    await this.save();
    if (!expected) this.emit({ type: "event", event: "tab_removed", short_id: shortId, tab_id: tabId });
  }

  /** chrome.tabs.onActivated: remember recent active tabs per window (in memory only). */
  handleTabActivated(info: { tabId: number; windowId: number }): void {
    const list = this.activeHistory.get(info.windowId) ?? [];
    this.activeHistory.set(
      info.windowId,
      [info.tabId, ...list.filter((id) => id !== info.tabId)].slice(0, ACTIVE_HISTORY_MAX),
    );
  }

  private previousActive(windowId: number, exclude: number): number | undefined {
    return this.activeHistory.get(windowId)?.find((id) => id !== exclude);
  }

  /** chrome.windows.onFocusChanged: remember focus order (finished groups go to the user's latest window). */
  async handleWindowFocused(windowId: number): Promise<void> {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    const state = await this.load();
    if (state.focusOrder[0] === windowId) return;
    state.focusOrder = [windowId, ...state.focusOrder.filter((id) => id !== windowId)].slice(0, FOCUS_ORDER_MAX);
    await this.save();
  }

  async handleWindowRemoved(windowId: number): Promise<void> {
    const state = await this.load();
    let changed = false;
    this.activeHistory.delete(windowId);
    if (state.focusOrder.includes(windowId)) {
      state.focusOrder = state.focusOrder.filter((id) => id !== windowId);
      changed = true;
    }
    for (const [shortId, id] of Object.entries(state.sessionWindows)) {
      if (id === windowId) {
        delete state.sessionWindows[shortId];
        changed = true;
      }
    }
    if (state.tabcrewWindow === windowId) {
      state.tabcrewWindow = null;
      changed = true;
    }
    for (const [id, rec] of Object.entries(state.managedGroups)) {
      if (rec.windowId === windowId) {
        delete state.managedGroups[id];
        changed = true;
      }
    }
    if (changed) {
      dropDangling(state);
      await this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals: placement paths
  // ---------------------------------------------------------------------------

  /** shared_window: a tab in the TabCrew window, in the session's (or the named) shared group. */
  private async createShared(session: V2SessionRef, url: string): Promise<V2TabInfo> {
    const state = await this.load();
    state.placements[session.short_id] = "shared_window";
    const own = await this.liveSessionGroup(session.short_id);
    let windowId: number;
    let firstTab: chrome.tabs.Tab | undefined;
    if (own?.rec.kind === "shared") windowId = own.windowId;
    else ({ windowId, firstTab } = await this.locks.run(WINDOW_LOCK, () => this.ensureTabcrewWindow({ url })));
    const created = firstTab ?? (await chrome.tabs.create({ windowId, url, active: false }));
    const tabId = created.id;
    if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
    try {
      await this.locks.run(GROUPS_LOCK, () => this.joinShared(session, tabId, windowId));
    } catch (err) {
      await closeTabsUngrouped([tabId]).catch(() => undefined);
      throw err;
    }
    return toTabInfo(await chrome.tabs.get(tabId));
  }

  /** Add the tab to the session's shared group, else to the group named after the session's group / the default (creating it). */
  private async joinShared(session: V2SessionRef, tabId: number, windowId: number): Promise<void> {
    const state = await this.load();
    const own = await this.liveSessionGroup(session.short_id);
    let groupId = own?.rec.kind === "shared" && own.windowId === windowId ? own.groupId : null;
    const name = v2NormaliseGroupName(session.group) ?? (await loadGroupName());
    groupId ??= await this.findManagedGroup("shared", name, windowId);
    if (groupId !== null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: name, collapsed: false });
      state.managedGroups[groupId] = { name, windowId, kind: "shared" };
    }
    state.sessionGroups[session.short_id] = groupId;
    state.tabOwners[tabId] = session.short_id;
    await this.save();
  }

  /**
   * The one TabCrew window: the stored one while it is open, else the window of a live shared /
   * collect group, else a new unfocused window (opened at `url`, or created around an existing
   * tab). Callers hold WINDOW_LOCK so concurrent first tab_creates create one window. A new
   * window's tab is returned as `firstTab` so no blank tab is left behind.
   */
  private async ensureTabcrewWindow(seed: { url: string } | { tabId: number }): Promise<{ windowId: number; firstTab?: chrome.tabs.Tab }> {
    const state = await this.load();
    if (state.tabcrewWindow !== null && (await isNormalWindow(state.tabcrewWindow))) return { windowId: state.tabcrewWindow };
    for (const [id, rec] of Object.entries(state.managedGroups)) {
      if (rec.kind === "session") continue;
      const g = await chrome.tabGroups.get(Number(id)).catch(() => null);
      if (g && g.windowId === rec.windowId && (await isNormalWindow(g.windowId))) {
        state.tabcrewWindow = g.windowId;
        await this.save();
        return { windowId: g.windowId };
      }
    }
    const win = await chrome.windows.create({ ...seed, focused: false, state: "normal", type: "normal" });
    if (!win || typeof win.id !== "number") throw new OpError("internal", "could not create the TabCrew window");
    state.tabcrewWindow = win.id;
    await this.save();
    const firstTab = "url" in seed ? win.tabs?.[0] : undefined;
    return firstTab ? { windowId: win.id, firstTab } : { windowId: win.id };
  }

  /** own_window: a tab in the session's own window and group. */
  private async createInOwnWindow(session: V2SessionRef, url: string): Promise<V2TabInfo> {
    const state = await this.load();
    state.placements[session.short_id] = "own_window";
    const { windowId, firstTab } = await this.ensureSessionWindow(session.short_id, url);
    const created = firstTab ?? (await chrome.tabs.create({ windowId, url, active: false }));
    const tabId = created.id;
    if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
    try {
      await this.addToSessionGroup(session, tabId, windowId);
    } catch (err) {
      await closeTabsUngrouped([tabId]).catch(() => undefined);
      throw err;
    }
    return toTabInfo(await chrome.tabs.get(tabId));
  }

  /**
   * Return the session's window, creating it unfocused if needed. Callers hold the session
   * lock, so concurrent tab_creates in one session create one window. The session's group is
   * authoritative when it exists. A brand-new window comes with one tab, opened at `url` and
   * handed back as `firstTab`. Never reuses another session's window or the TabCrew window.
   */
  private async ensureSessionWindow(shortId: string, url: string): Promise<{ windowId: number; firstTab?: chrome.tabs.Tab }> {
    const state = await this.load();
    const live = await this.liveSessionGroup(shortId);
    if (live?.rec.kind === "session" && (await isNormalWindow(live.windowId))) {
      if (state.sessionWindows[shortId] !== live.windowId) {
        state.sessionWindows[shortId] = live.windowId;
        await this.save();
      }
      return { windowId: live.windowId };
    }
    const stored = state.sessionWindows[shortId];
    if (stored !== undefined) {
      const sharedWith =
        stored === state.tabcrewWindow ||
        Object.entries(state.sessionWindows).some(([other, id]) => other !== shortId && id === stored);
      if (!sharedWith && (await isNormalWindow(stored))) return { windowId: stored };
      delete state.sessionWindows[shortId];
    }
    const win = await chrome.windows.create({ url, focused: false, state: "normal", type: "normal" });
    if (!win || typeof win.id !== "number") throw new OpError("internal", "could not create the session window");
    state.sessionWindows[shortId] = win.id;
    await this.save();
    const firstTab = win.tabs?.[0];
    return firstTab ? { windowId: win.id, firstTab } : { windowId: win.id };
  }

  /** Adds the tab to the session's own group (kind `session`, created in `windowId`); returns the group id. */
  private async addToSessionGroup(session: V2SessionRef, tabId: number, windowId: number, collapsed = false): Promise<number> {
    const state = await this.load();
    const live = await this.liveSessionGroup(session.short_id);
    let groupId: number;
    if (live?.rec.kind === "session") {
      groupId = live.groupId;
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      const title = v2GroupTitle(session);
      await chrome.tabGroups.update(groupId, { title, collapsed });
      state.managedGroups[groupId] = { name: title, windowId, kind: "session" };
      state.sessionGroups[session.short_id] = groupId;
    }
    state.tabOwners[tabId] = session.short_id;
    await this.save();
    return groupId;
  }

  /**
   * tab_create for a `user_window` session: a background tab in the user's window, inside the
   * session's collapsed group. Never focuses a window or changes its active tab. Returns null
   * (nothing created) when there is no user window.
   */
  private async createInUserWindow(session: V2SessionRef, url: string): Promise<V2TabInfo | null> {
    const shortId = session.short_id;
    const state = await this.load();
    let windowId: number | null = null;
    let wasCollapsed = true;
    const live = await this.liveSessionGroup(shortId);
    const existing = live?.rec.kind === "session" ? live : null;
    if (existing) {
      const group = await chrome.tabGroups.get(existing.groupId).catch(() => null);
      if (group && (await isNormalWindow(group.windowId))) {
        windowId = group.windowId;
        wasCollapsed = group.collapsed;
      }
    }
    windowId ??= await this.pickUserWindow(await this.nonUserWindowIds());
    if (windowId === null) return null;

    const previousActive = await activeTabId(windowId);
    const created = await chrome.tabs.create({ windowId, url, active: false });
    const tabId = created.id;
    if (typeof tabId !== "number") throw new OpError("internal", "Chrome did not return a tab id");
    state.placements[shortId] = "user_window";
    delete state.sessionWindows[shortId];
    try {
      const finalGroup = await this.addToSessionGroup(session, tabId, windowId, true);
      // Adding a tab can expand a collapsed group; keep it as it was.
      if (existing && wasCollapsed) {
        await chrome.tabGroups.update(finalGroup, { collapsed: true }).catch(() => undefined);
      }
    } catch (err) {
      await closeTabsUngrouped([tabId]).catch(() => undefined);
      throw err;
    } finally {
      if (previousActive !== undefined && (await activeTabId(windowId)) !== previousActive) {
        // Switches tabs inside that window only; it does not focus the window.
        await chrome.tabs.update(previousActive, { active: true }).catch(() => undefined);
      }
    }
    return toTabInfo(await chrome.tabs.get(tabId));
  }

  /** Windows that are not the user's: the TabCrew window and own-window sessions' windows. */
  private async nonUserWindowIds(): Promise<Set<number>> {
    const state = await this.load();
    const ids = new Set<number>(Object.values(state.sessionWindows));
    if (state.tabcrewWindow !== null) ids.add(state.tabcrewWindow);
    for (const rec of Object.values(state.managedGroups)) if (rec.kind !== "session") ids.add(rec.windowId);
    for (const [shortId, groupId] of Object.entries(state.sessionGroups)) {
      const rec = state.managedGroups[groupId];
      if (rec?.kind === "session" && (await this.inferPlacement(shortId, groupId, rec.windowId)) === "own_window") {
        ids.add(rec.windowId);
      }
    }
    return ids;
  }

  /**
   * A per-session group's placement: the remembered one, else own_window if its group is in the
   * window created for it, else user_window if that window holds any tab outside the group.
   */
  private async inferPlacement(shortId: string, groupId: number, windowId: number): Promise<Placement> {
    const state = await this.load();
    const known = state.placements[shortId];
    if (known) return known;
    if (state.sessionWindows[shortId] === windowId) return "own_window";
    const inWindow = await chrome.tabs.query({ windowId }).catch(() => []);
    return inWindow.some((t) => t.groupId !== groupId) ? "user_window" : "own_window";
  }

  /** Remove a session's tabs; a `user_window` session never leaves the user's window empty. */
  private async removeTabs(shortId: string, tabIds: number[]): Promise<void> {
    if (tabIds.length === 0) return;
    await this.closeTabsGuarded(tabIds, (await this.placementFor(shortId)) === "user_window");
  }

  private async closeTabsGuarded(tabIds: number[], inUserWindow: boolean): Promise<void> {
    if (tabIds.length === 0) return;
    if (inUserWindow) await keepWindowsOpen(tabIds);
    await closeTabsUngrouped(tabIds);
  }

  // ---------------------------------------------------------------------------
  // Internals: ownership
  // ---------------------------------------------------------------------------

  /**
   * The session's group if it is still TabCrew's: managed, open, and in its recorded window.
   * Otherwise the mapping is dropped (a group the user moved elsewhere stops being managed).
   */
  private async liveSessionGroup(shortId: string): Promise<LiveGroup | null> {
    const state = await this.load();
    const groupId = state.sessionGroups[shortId];
    if (groupId === undefined) return null;
    const rec = state.managedGroups[groupId];
    const group = rec ? await chrome.tabGroups.get(groupId).catch(() => null) : null;
    if (!rec || !group || group.windowId !== rec.windowId) {
      delete state.sessionGroups[shortId];
      if (rec) delete state.managedGroups[groupId];
      await this.save();
      return null;
    }
    return { groupId, windowId: group.windowId, rec, name: group.title || rec.name };
  }

  /**
   * The session's own tabs (owner map ∩ the session's live group). Entries whose tab moved out of
   * the group are dropped; entries of tabs that are gone are left to `handleTabRemoved` (which
   * reports them) and `reconcile`.
   */
  private async ownedTabs(shortId: string): Promise<chrome.tabs.Tab[]> {
    const state = await this.load();
    const ids = Object.keys(state.tabOwners).filter((id) => state.tabOwners[id] === shortId);
    if (ids.length === 0) return [];
    const live = await this.liveSessionGroup(shortId);
    const out: chrome.tabs.Tab[] = [];
    let changed = false;
    for (const id of ids) {
      const tab = await chrome.tabs.get(Number(id)).catch(() => null);
      if (!tab) continue;
      if (live && tab.groupId === live.groupId && tab.windowId === live.windowId) out.push(tab);
      else {
        delete state.tabOwners[id];
        changed = true;
      }
    }
    if (changed) await this.save();
    return out;
  }

  /** A managed group of `kind` titled `title` in `windowId` (live title), or null. */
  private async findManagedGroup(kind: ManagedGroupKind, title: string, windowId: number): Promise<number | null> {
    const state = await this.load();
    for (const [id, rec] of Object.entries(state.managedGroups)) {
      if (rec.kind !== kind || rec.windowId !== windowId) continue;
      const g = await chrome.tabGroups.get(Number(id)).catch(() => null);
      if (g && g.windowId === windowId && (g.title || rec.name) === title) return g.id;
    }
    return null;
  }

  private forgetSession(state: State, shortId: string): void {
    for (const [tabId, owner] of Object.entries(state.tabOwners)) if (owner === shortId) delete state.tabOwners[tabId];
    delete state.sessionGroups[shortId];
    delete state.sessionWindows[shortId];
    delete state.placements[shortId];
    delete state.labels[shortId];
  }

  /** Re-validate the whole state against the live browser and save it. */
  private async pruneAgainstBrowser(state: State): Promise<void> {
    const [allTabs, allGroups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
    validate(state, allTabs, allGroups);
    await this.save();
  }

  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.readState().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readState(): Promise<State> {
    for (;;) {
      await this.startup;
      const generation = this.generation;
      const [stored, runtime] = await Promise.all([
        chrome.storage.local.get([...OWNERSHIP_KEYS, MIGRATED_KEY]),
        chrome.storage.session.get([SESSION_WINDOWS_KEY, PLACEMENTS_KEY, SESSION_LABELS_KEY, FOCUS_ORDER_KEY]),
      ]);
      const own = parseOwnership(stored);
      const state: State = {
        tabOwners: { ...own.tabOwners },
        sessionGroups: { ...own.sessionGroups },
        managedGroups: { ...own.managedGroups },
        tabcrewWindow: own.tabcrewWindow,
        sessionWindows: numberRecord(runtime[SESSION_WINDOWS_KEY]),
        placements: isRecord(runtime[PLACEMENTS_KEY]) ? (runtime[PLACEMENTS_KEY] as Record<string, Placement>) : {},
        labels: isRecord(runtime[SESSION_LABELS_KEY]) ? (runtime[SESSION_LABELS_KEY] as Record<string, string>) : {},
        focusOrder: Array.isArray(runtime[FOCUS_ORDER_KEY])
          ? (runtime[FOCUS_ORDER_KEY] as unknown[]).filter((v): v is number => Number.isInteger(v))
          : [],
      };
      const [allTabs, allGroups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
      const migrate = stored[MIGRATED_KEY] !== true;
      if (migrate && Object.keys(state.tabOwners).length === 0) migrateLegacyGroups(state, allTabs, allGroups);
      validate(state, allTabs, allGroups);
      // A startup wipe happened meanwhile: never persist (resurrect) what was read before it.
      if (generation !== this.generation) continue;
      this.state = state;
      await this.save();
      if (migrate) await chrome.storage.local.set({ [MIGRATED_KEY]: true });
      return state;
    }
  }

  private async save(): Promise<void> {
    const state = this.state;
    if (!state) return;
    await Promise.all([
      chrome.storage.local.set({
        [TAB_OWNERS_KEY]: state.tabOwners,
        [SESSION_GROUPS_KEY]: state.sessionGroups,
        [MANAGED_GROUPS_KEY]: state.managedGroups,
        ...(state.tabcrewWindow !== null ? { [TABCREW_WINDOW_KEY]: state.tabcrewWindow } : {}),
      }),
      state.tabcrewWindow === null ? chrome.storage.local.remove(TABCREW_WINDOW_KEY) : Promise.resolve(),
      chrome.storage.session.set({
        [SESSION_WINDOWS_KEY]: state.sessionWindows,
        [PLACEMENTS_KEY]: state.placements,
        [SESSION_LABELS_KEY]: state.labels,
        [FOCUS_ORDER_KEY]: state.focusOrder,
      }),
    ]);
  }
}

/**
 * Drop entries that do not match the live browser: managed groups that are gone or left their
 * recorded window, a closed TabCrew window, session groups that are no longer managed, and owner
 * entries whose tab is gone or not in its session's group. Legacy (title) groups are never
 * trusted here; only the stored ids are.
 */
function validate(state: State, allTabs: chrome.tabs.Tab[], allGroups: chrome.tabGroups.TabGroup[]): void {
  const groups = new Map(allGroups.map((g) => [g.id, g]));
  for (const [id, rec] of Object.entries(state.managedGroups)) {
    const g = groups.get(Number(id));
    if (!g || g.windowId !== rec.windowId) delete state.managedGroups[id];
    else if (g.title && g.title !== rec.name) state.managedGroups[id] = { ...rec, name: g.title };
  }
  const windows = new Set(allTabs.map((t) => t.windowId));
  if (state.tabcrewWindow !== null && !windows.has(state.tabcrewWindow)) state.tabcrewWindow = null;
  const tabs = new Map<number, chrome.tabs.Tab>();
  for (const t of allTabs) if (typeof t.id === "number") tabs.set(t.id, t);
  for (const [shortId, groupId] of Object.entries(state.sessionGroups)) {
    if (!state.managedGroups[groupId]) delete state.sessionGroups[shortId];
  }
  for (const [tabId, owner] of Object.entries(state.tabOwners)) {
    const tab = tabs.get(Number(tabId));
    const groupId = state.sessionGroups[owner];
    if (!tab || groupId === undefined || tab.groupId !== groupId) delete state.tabOwners[tabId];
  }
}

/** One-time adoption of pre-shared-groups session groups (`<label> · <short_id>` titles). */
function migrateLegacyGroups(state: State, allTabs: chrome.tabs.Tab[], allGroups: chrome.tabGroups.TabGroup[]): void {
  for (const g of allGroups) {
    const parsed = v2ParseGroupTitle(g.title ?? "");
    if (!parsed || state.sessionGroups[parsed.short_id] !== undefined) continue;
    state.managedGroups[g.id] = { name: g.title ?? v2GroupTitle(parsed), windowId: g.windowId, kind: "session" };
    state.sessionGroups[parsed.short_id] = g.id;
    state.labels[parsed.short_id] ??= parsed.label;
    for (const t of allTabs) if (t.groupId === g.id && typeof t.id === "number") state.tabOwners[t.id] = parsed.short_id;
  }
}

/** Session groups whose managed group is gone are dropped (their owner entries go with validation). */
function dropDangling(state: State): void {
  for (const [shortId, groupId] of Object.entries(state.sessionGroups)) {
    if (!state.managedGroups[groupId]) delete state.sessionGroups[shortId];
  }
}

/** Distinct owners in the map (ascending tab id order, i.e. roughly creation order). */
function owners(state: State): string[] {
  return [...new Set(Object.values(state.tabOwners))];
}

function idsOf(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((t) => t.id).filter((id): id is number => typeof id === "number");
}

function requireGroupName(raw: unknown): string {
  const name = v2NormaliseGroupName(raw);
  if (name === null) {
    throw new OpError("invalid_args", "name must be 1-40 characters, not start with ✓ and not look like a session group title");
  }
  return name;
}

async function loadCreatedGroups(): Promise<string[]> {
  const stored = (await chrome.storage.local.get(CREATED_GROUPS_KEY))[CREATED_GROUPS_KEY];
  if (!Array.isArray(stored)) return [];
  const out: string[] = [];
  for (const v of stored) {
    const name = v2NormaliseGroupName(v);
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}

export function requireTabId(args: { tab_id?: unknown }): number {
  const id = args?.tab_id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new OpError("invalid_args", "tab_id must be a non-negative integer");
  }
  return id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isInteger(n)) out[k] = n;
  return out;
}

async function activeTabId(windowId: number): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
  return typeof tab?.id === "number" ? tab.id : undefined;
}

async function isNormalWindow(windowId: number): Promise<boolean> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win !== null && win.type === "normal";
}

/** Before tabs leave or close: give any window they would empty a blank tab, so Chrome never closes it. */
async function keepWindowsOpen(tabIds: number[]): Promise<void> {
  const leaving = new Set(tabIds);
  const windowIds = new Set<number>();
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) windowIds.add(tab.windowId);
  }
  for (const windowId of windowIds) {
    const rest = (await chrome.tabs.query({ windowId })).filter((t) => typeof t.id !== "number" || !leaving.has(t.id));
    if (rest.length === 0) await chrome.tabs.create({ windowId, active: false }).catch(() => undefined);
  }
}

/**
 * Close tabs without leaving a saved tab group behind. Chrome saves (and pins to the bookmarks
 * bar) a group whose tabs are closed while still grouped; ungrouping first lets the group vanish.
 */
export async function closeTabsUngrouped(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return;
  await chrome.tabs.ungroup(tabIds).catch(() => undefined);
  await chrome.tabs.remove(tabIds);
}
