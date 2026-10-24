import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { v2NormaliseGroupName, type V2SessionRef, type V2TabInfo } from "@tabcrew/shared/v2";
import { DaemonError } from "./errors.js";
import { log } from "./log.js";

export interface Session {
  /** sha256 of the secret handle; the handle itself is never stored. */
  readonly key: string;
  readonly short_id: string;
  readonly label: string;
  /**
   * The TabCrew tab group the session joins (normalised by `v2NormaliseGroupName`). Missing: the
   * extension's default group. Changes when the group is renamed (`renameGroup`).
   */
  group?: string;
  readonly created_at: number;
  last_used_at: number;
  /** Set when the user pressed Stop; every call then fails with `stopped_by_user`. */
  stopped: boolean;
  readonly tabs: Set<number>;
}

export interface SessionRegistryOptions {
  /** Path of sessions.json; omit to keep the registry in memory only. */
  readonly file?: string;
  /** Sessions unused this long are closed by `sweepIdle`. 0 disables. */
  readonly idleTimeoutMs: number;
  readonly now?: () => number;
}

interface PersistedSession {
  key: string;
  short_id: string;
  label: string;
  group?: string;
  created_at: number;
  last_used_at: number;
  stopped?: boolean;
  tabs: number[];
}

/** Called whenever a session loses a tab (closed, gone, reconciled away, or session closed). */
export type TabRemovedListener = (tabId: number, shortId: string) => void;

const SHORT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const HANDLE_RE = /^s_[A-Za-z0-9_-]{22}$/;
const SHORT_ID_RE = /^[A-Za-z0-9_-]{8}$/;
export const DEFAULT_LABEL = "agent";
const MAX_LABEL = 40;

function hashHandle(handle: string): string {
  return createHash("sha256").update(handle).digest("base64url");
}

function newShortId(): string {
  // 64-symbol alphabet: each random byte maps uniformly via its low 6 bits.
  return Array.from(randomBytes(8), (b) => SHORT_ID_ALPHABET[b & 63]).join("");
}

function isTabId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Make a label safe for a tab-group title (`<label> · <short_id>`). */
export function normaliseLabel(label: string | undefined): string {
  const clean = (label ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/·/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL)
    .trim();
  return clean || DEFAULT_LABEL;
}

export function sessionRef(session: Session): V2SessionRef {
  return { short_id: session.short_id, label: session.label, ...(session.group !== undefined && { group: session.group }) };
}

/**
 * Browser sessions and their tab ownership. A session is identified by a secret handle
 * (`s_` + 128 random bits) that agents pass on every call, and by an independent public
 * `short_id` that the extension sees.
 */
export class SessionRegistry {
  private readonly byKey = new Map<string, Session>();
  private readonly byShortId = new Map<string, Session>();
  /** tab id -> owning session short_id. A tab belongs to at most one session. */
  private readonly tabOwner = new Map<number, string>();
  private readonly tabListeners: TabRemovedListener[] = [];
  private readonly now: () => number;

  constructor(private readonly options: SessionRegistryOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.byKey.size;
  }

  onTabRemoved(listener: TabRemovedListener): void {
    this.tabListeners.push(listener);
  }

  /** Open a session; an invalid `group` (see `v2NormaliseGroupName`) means the default group. */
  open(label?: string, group?: string): { handle: string; session: Session } {
    const handle = `s_${randomBytes(16).toString("base64url")}`;
    let shortId = newShortId();
    while (this.byShortId.has(shortId)) shortId = newShortId();
    const t = this.now();
    const groupName = v2NormaliseGroupName(group);
    const session: Session = {
      key: hashHandle(handle),
      short_id: shortId,
      label: normaliseLabel(label),
      ...(groupName !== null && { group: groupName }),
      created_at: t,
      last_used_at: t,
      stopped: false,
      tabs: new Set(),
    };
    this.insert(session);
    this.save();
    return { handle, session };
  }

  /** The short_id of a handle's session, without marking it used (for logs). */
  shortIdOf(handle: unknown): string | undefined {
    return typeof handle === "string" && HANDLE_RE.test(handle) ? this.byKey.get(hashHandle(handle))?.short_id : undefined;
  }

  /** Resolve a handle to its session and mark it used. Throws `bad_session` or `stopped_by_user`. */
  use(handle: unknown): Session {
    const session = typeof handle === "string" && HANDLE_RE.test(handle) ? this.byKey.get(hashHandle(handle)) : undefined;
    if (!session) {
      throw new DaemonError("bad_session", "unknown or closed session; call session_open and use the returned handle");
    }
    this.requireActive(session);
    session.last_used_at = this.now();
    return session;
  }

  /** Throws unless the session is still registered and not stopped (re-checked when queued work starts). */
  requireActive(session: Session): void {
    if (this.byKey.get(session.key) !== session) {
      throw new DaemonError("bad_session", "session was closed; call session_open for a new session");
    }
    if (session.stopped) {
      throw new DaemonError(
        "stopped_by_user",
        "the user pressed Stop for this session in Chrome; ask the user before continuing (a new session_open is required)",
      );
    }
  }

  getByShortId(shortId: string): Session | undefined {
    return this.byShortId.get(shortId);
  }

  list(): Session[] {
    return [...this.byKey.values()];
  }

  refs(): V2SessionRef[] {
    return this.list().map(sessionRef);
  }

  /** Throws `tab_not_owned` unless the session owns the tab. */
  requireTab(session: Session, tabId: number): void {
    if (!session.tabs.has(tabId) || this.tabOwner.get(tabId) !== session.short_id) {
      throw new DaemonError("tab_not_owned", `tab ${tabId} is not owned by this session; use tab_list or tab_create`);
    }
  }

  /**
   * Mark sessions stopped (one short_id, or every session for null). Their tabs stay open and
   * owned. Returns the sessions that were newly stopped.
   */
  stop(shortId: string | null): Session[] {
    const targets = shortId === null ? this.list() : [this.byShortId.get(shortId)].filter((s): s is Session => !!s);
    const stopped = targets.filter((s) => !s.stopped);
    for (const s of stopped) s.stopped = true;
    if (stopped.length) this.save();
    return stopped;
  }

  /** Remove the session. Returns it (with its tab set) or undefined if already gone. */
  close(session: Session): Session | undefined {
    if (this.byKey.get(session.key) !== session) return undefined;
    this.byKey.delete(session.key);
    this.byShortId.delete(session.short_id);
    const removed: number[] = [];
    for (const tabId of session.tabs) {
      if (this.tabOwner.get(tabId) === session.short_id) {
        this.tabOwner.delete(tabId);
        removed.push(tabId);
      }
    }
    this.save();
    for (const tabId of removed) this.emitRemoved(tabId, session.short_id);
    return session;
  }

  /**
   * Record that a session's group holds `tabId`. With `steal: false` (unsolicited extension
   * events) a tab already owned by another session is never moved; `tab_create` results are
   * authoritative and may take over a stale entry.
   */
  addTab(shortId: string, tabId: number, { steal = true }: { steal?: boolean } = {}): boolean {
    const session = this.byShortId.get(shortId);
    if (!session || !isTabId(tabId)) return false;
    const previous = this.tabOwner.get(tabId);
    if (previous === shortId) {
      session.tabs.add(tabId);
      return true;
    }
    if (previous !== undefined) {
      if (!steal) {
        log.warn(`ignored adoption of tab ${tabId} by ${shortId}: owned by another session`);
        return false;
      }
      this.byShortId.get(previous)?.tabs.delete(tabId);
    }
    session.tabs.add(tabId);
    this.tabOwner.set(tabId, shortId);
    this.save();
    if (previous !== undefined) this.emitRemoved(tabId, previous);
    return true;
  }

  removeTab(shortId: string, tabId: number): void {
    const session = this.byShortId.get(shortId);
    if (!session?.tabs.delete(tabId)) return;
    if (this.tabOwner.get(tabId) === shortId) this.tabOwner.delete(tabId);
    this.save();
    this.emitRemoved(tabId, shortId);
  }

  /**
   * Replace a session's tab set with the tabs the extension reports for its group.
   * Tabs owned by another session are excluded. Returns the tabs that remain.
   */
  setTabs(session: Session, tabs: readonly V2TabInfo[]): V2TabInfo[] {
    const kept = tabs.filter((t) => {
      if (!isTabId(t?.tab_id)) return false;
      const owner = this.tabOwner.get(t.tab_id);
      return owner === undefined || owner === session.short_id;
    });
    const next = new Set(kept.map((t) => t.tab_id));
    const removed: number[] = [];
    for (const tabId of session.tabs) {
      if (next.has(tabId)) continue;
      if (this.tabOwner.get(tabId) === session.short_id) this.tabOwner.delete(tabId);
      removed.push(tabId);
    }
    session.tabs.clear();
    for (const tabId of next) {
      session.tabs.add(tabId);
      this.tabOwner.set(tabId, session.short_id);
    }
    this.save();
    for (const tabId of removed) this.emitRemoved(tabId, session.short_id);
    return kept;
  }

  /**
   * Reconcile with the extension's `groups` event after (re)connecting. The extension is the
   * source of truth for which tabs exist: every known session is kept and its tabs become
   * exactly those in its group (none if it has no group). Groups for unknown sessions are
   * left alone and their tabs are never adopted by any session.
   */
  reconcile(groups: unknown): void {
    const valid = (Array.isArray(groups) ? groups : []).filter(
      (g): g is { short_id: string; tabs: unknown[] } =>
        !!g && typeof g === "object" && typeof g.short_id === "string" && Array.isArray(g.tabs),
    );
    const byShort = new Map<string, number[]>();
    for (const g of valid) {
      const ids = g.tabs.map((t) => (t as { tab_id?: unknown } | null)?.tab_id).filter(isTabId);
      byShort.set(g.short_id, [...(byShort.get(g.short_id) ?? []), ...ids]);
    }

    const before = new Map(this.tabOwner);
    this.tabOwner.clear();
    for (const session of this.byKey.values()) {
      session.tabs.clear();
      for (const tabId of byShort.get(session.short_id) ?? []) {
        if (this.tabOwner.has(tabId)) continue;
        session.tabs.add(tabId);
        this.tabOwner.set(tabId, session.short_id);
      }
    }
    const unknown = [...byShort.keys()].filter((id) => !this.byShortId.has(id)).length;
    if (unknown > 0) log.info(`reconcile: left ${unknown} group(s) of unknown sessions alone`);
    this.save();
    for (const [tabId, owner] of before) {
      if (this.tabOwner.get(tabId) !== owner) this.emitRemoved(tabId, owner);
    }
  }

  /**
   * A TabCrew group was renamed from `previous` to `name`: every session in it (by name), plus
   * `include` (the caller, which may have been using the default group), now carries `name`.
   * Returns the sessions that changed; an invalid `name` changes nothing.
   */
  renameGroup(previous: string, name: string, include?: Session): Session[] {
    const next = v2NormaliseGroupName(name);
    if (next === null) return [];
    const changed = this.list().filter(
      (s) => (s.group === previous || (s === include && s.group === undefined)) && s.group !== next,
    );
    for (const s of changed) s.group = next;
    if (changed.length) this.save();
    return changed;
  }

  /** Sessions whose last use is older than the idle timeout. */
  idleSessions(): Session[] {
    const timeout = this.options.idleTimeoutMs;
    if (!(timeout > 0)) return [];
    const cutoff = this.now() - timeout;
    return this.list().filter((s) => s.last_used_at <= cutoff);
  }

  load(): void {
    const file = this.options.file;
    if (!file || !existsSync(file)) return;
    let data: { version?: unknown; sessions?: unknown };
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      log.warn("sessions.json is not valid JSON; starting with no sessions");
      return;
    }
    if (data.version !== 1 || !Array.isArray(data.sessions)) {
      log.warn("sessions.json has an unknown format; starting with no sessions");
      return;
    }
    for (const raw of data.sessions as PersistedSession[]) {
      if (
        !raw ||
        typeof raw.key !== "string" ||
        typeof raw.short_id !== "string" ||
        !SHORT_ID_RE.test(raw.short_id) ||
        this.byShortId.has(raw.short_id) ||
        this.byKey.has(raw.key)
      ) {
        continue;
      }
      const group = v2NormaliseGroupName(raw.group);
      const session: Session = {
        key: raw.key,
        short_id: raw.short_id,
        label: normaliseLabel(raw.label),
        ...(group !== null && { group }),
        created_at: Number(raw.created_at) || this.now(),
        last_used_at: Number(raw.last_used_at) || this.now(),
        stopped: raw.stopped === true,
        tabs: new Set(),
      };
      this.insert(session);
      for (const tabId of Array.isArray(raw.tabs) ? raw.tabs : []) {
        if (isTabId(tabId) && !this.tabOwner.has(tabId)) {
          session.tabs.add(tabId);
          this.tabOwner.set(tabId, session.short_id);
        }
      }
    }
  }

  /**
   * Write sessions.json atomically: synchronous write to a temp file, then rename. Saves run on
   * the single JS thread, so concurrent tool calls can never interleave a write.
   */
  save(): void {
    const file = this.options.file;
    if (!file) return;
    const sessions: PersistedSession[] = this.list().map((s) => ({
      key: s.key,
      short_id: s.short_id,
      label: s.label,
      ...(s.group !== undefined && { group: s.group }),
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      ...(s.stopped && { stopped: true }),
      tabs: [...s.tabs],
    }));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      log.error(`failed to save sessions.json: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }

  private emitRemoved(tabId: number, shortId: string): void {
    for (const listener of this.tabListeners) {
      try {
        listener(tabId, shortId);
      } catch (err) {
        log.error(`tab listener failed: ${(err as Error).message}`);
      }
    }
  }

  private insert(session: Session): void {
    this.byKey.set(session.key, session);
    this.byShortId.set(session.short_id, session);
  }
}
