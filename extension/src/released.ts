/**
 * Groups of finished sessions that were handed to the user (`✓ <label>`) or collected
 * (`✓ <name>`), kept in chrome.storage.session so the popup can list them under "Finished" and
 * adoption can ignore tabs they open. Entries are pruned once their group no longer exists.
 */

import { RELEASED_KEY } from "./config.js";

export interface ReleasedGroup {
  readonly label: string;
  /** Epoch ms when the session was released. */
  readonly released_at: number;
}

export class ReleasedGroups {
  /** Serialises read-modify-write updates (releases of different sessions may run concurrently). */
  private tail: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: (all: Record<string, ReleasedGroup>) => T | null): Promise<T | null> {
    const run = this.tail.then(async () => {
      const all = await this.all();
      const result = fn(all);
      if (result !== null) await chrome.storage.session.set({ [RELEASED_KEY]: all });
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async all(): Promise<Record<string, ReleasedGroup>> {
    const stored = (await chrome.storage.session.get(RELEASED_KEY))[RELEASED_KEY];
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const out: Record<string, ReleasedGroup> = {};
    for (const [id, v] of Object.entries(stored as Record<string, unknown>)) {
      const e = v as Partial<ReleasedGroup> | null;
      if (e && typeof e.label === "string" && typeof e.released_at === "number") {
        out[id] = { label: e.label, released_at: e.released_at };
      }
    }
    return out;
  }

  async has(groupId: number): Promise<boolean> {
    return String(groupId) in (await this.all());
  }

  async add(groupId: number, label: string, now = Date.now()): Promise<void> {
    await this.mutate((all) => {
      all[groupId] = { label, released_at: now };
      return true;
    });
  }

  async remove(groupId: number): Promise<void> {
    await this.mutate((all) => {
      if (!(String(groupId) in all)) return null;
      delete all[groupId];
      return true;
    });
  }

  /** Drop entries whose group is gone; returns the remaining entries. */
  async prune(liveGroupIds: ReadonlySet<number>): Promise<Record<string, ReleasedGroup>> {
    let kept: Record<string, ReleasedGroup> = {};
    await this.mutate((all) => {
      let changed = false;
      for (const id of Object.keys(all)) {
        if (!liveGroupIds.has(Number(id))) {
          delete all[id];
          changed = true;
        }
      }
      kept = { ...all };
      return changed ? true : null;
    });
    return kept;
  }
}

/** chrome.storage.session: tab id → group id of finished sessions' tabs kept in a TabCrew group (`keep`/`collect`). */
export const FINISHED_TABS_KEY = "v2:finishedTabs";

/**
 * Tabs of finished sessions that stayed in (or were collected into) a TabCrew-managed group, so
 * the popup can count them per group. They are owned by nobody; this is bookkeeping only.
 * Entries are dropped when the tab closes or leaves the recorded group.
 */
export class FinishedTabs {
  private tail: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: (all: Record<string, number>) => T | null): Promise<T | null> {
    const run = this.tail.then(async () => {
      const all = await this.all();
      const result = fn(all);
      if (result !== null) await chrome.storage.session.set({ [FINISHED_TABS_KEY]: all });
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async all(): Promise<Record<string, number>> {
    const stored = (await chrome.storage.session.get(FINISHED_TABS_KEY))[FINISHED_TABS_KEY];
    const out: Record<string, number> = {};
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return out;
    for (const [id, groupId] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof groupId === "number" && Number.isInteger(groupId)) out[id] = groupId;
    }
    return out;
  }

  async add(tabIds: readonly number[], groupId: number): Promise<void> {
    if (tabIds.length === 0) return;
    await this.mutate((all) => {
      for (const id of tabIds) all[id] = groupId;
      return true;
    });
  }

  async remove(tabId: number): Promise<void> {
    await this.mutate((all) => {
      if (!(String(tabId) in all)) return null;
      delete all[tabId];
      return true;
    });
  }

  /** Finished tabs still in `groupId` (checked against the live tabs; stale entries are dropped). */
  async count(groupId: number): Promise<number> {
    const entries = Object.entries(await this.all()).filter(([, g]) => g === groupId);
    let count = 0;
    const stale: string[] = [];
    for (const [id] of entries) {
      const tab = await chrome.tabs.get(Number(id)).catch(() => null);
      if (tab && tab.groupId === groupId) count++;
      else stale.push(id);
    }
    if (stale.length > 0) {
      await this.mutate((all) => {
        for (const id of stale) if (all[id] === groupId) delete all[id];
        return true;
      });
    }
    return count;
  }
}
