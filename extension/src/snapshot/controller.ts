/**
 * Per-tab snapshots and actions over the tab's chrome.debugger session.
 *
 * Only the latest snapshot per tab is kept, in memory. Its private freshness data (page key,
 * per-node guards, marker, and the full action list including geometry) never leaves the
 * extension; the daemon only receives a `V2Snapshot`.
 */

import type { V2Action, V2ActResult, V2Snapshot } from "@tabcrew/shared/v2";
import { runAct, type ActArgs } from "../act.js";
import { OpError } from "../errors.js";
import { fingerprint } from "./fingerprint.js";
import { SNAPSHOT_SOURCE } from "./scripts.js";

export type Send = (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface PageDeps {
  send: Send;
  /** Meta (mac) vs Ctrl (elsewhere) for select-all. */
  isMac: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** One element/control action as the page script returns it (with private geometry). */
export interface RawAction {
  id: string;
  kind: V2Action["kind"];
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  rect?: { x: number; y: number; w: number; h: number };
  delta?: number;
}

export interface RawSnapshot {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  /** `areas`: [node, scrollTop, scrollHeight] per offered scroll area (part of the fingerprint). */
  scroll: { y: number; height: number; areas?: [number, number, number][] };
  actions: RawAction[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
}

/** Private, per-tab state of the latest snapshot. */
export interface PageState {
  fingerprint: string;
  raw: RawSnapshot;
}

export const SNAPSHOT_ATTEMPTS = 10;
export const SNAPSHOT_RETRY_MS = 20;

export type EvalResult = { ok: true; value: unknown } | { ok: false; reason: string };

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export async function evaluate(send: Send, tabId: number, expression: string, awaitPromise = false): Promise<EvalResult> {
  const params: Record<string, unknown> = { expression, returnByValue: true };
  if (awaitPromise) params.awaitPromise = true;
  const r = (await send(tabId, "Runtime.evaluate", params)) as EvaluateResponse | undefined;
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    return { ok: false, reason: (d.exception?.description ?? d.text ?? "exception").split("\n")[0]! };
  }
  return { ok: true, value: r?.result?.value ?? null };
}

const WIRE_KEYS = ["id", "kind", "label", "node", "role", "value", "current_value", "checked", "selected", "expanded"] as const;

export function toWireAction(a: RawAction): V2Action {
  const out: Record<string, unknown> = {};
  for (const key of WIRE_KEYS) if (a[key] !== undefined && a[key] !== null) out[key] = a[key];
  return out as unknown as V2Action;
}

function isRawSnapshot(v: unknown): v is RawSnapshot {
  const s = v as RawSnapshot | null;
  return !!s && typeof s === "object" && typeof s.url === "string" && Array.isArray(s.actions) && !!s.scroll;
}

export class PageController {
  private readonly states = new Map<number, PageState>();
  private readonly tails = new Map<number, Promise<unknown>>();
  readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly deps: PageDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Latest snapshot state for a tab (tests and act). */
  latest(tabId: number): PageState | undefined {
    return this.states.get(tabId);
  }

  /** Drop a tab's snapshot (navigation, debugger detach, tab closed). */
  forget(tabId: number): void {
    this.states.delete(tabId);
  }

  snapshot(tabId: number): Promise<V2Snapshot> {
    return this.serial(tabId, async () => this.toWire(await this.capture(tabId)));
  }

  act(tabId: number, args: ActArgs): Promise<V2ActResult> {
    return this.serial(tabId, () => runAct(this, tabId, args));
  }

  /**
   * Take a snapshot and make it the tab's latest. Retries evaluation exceptions and the
   * "document is navigating" null up to 10 times, then fails with stale_page.
   */
  async capture(tabId: number): Promise<PageState> {
    let last = "the document is navigating";
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(SNAPSHOT_RETRY_MS);
      let result: EvalResult;
      try {
        result = await evaluate(this.deps.send, tabId, SNAPSHOT_SOURCE);
      } catch (err) {
        if (err instanceof OpError) throw err;
        last = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!result.ok) {
        last = result.reason;
        continue;
      }
      if (result.value === null) {
        last = "the document is navigating";
        continue;
      }
      if (!isRawSnapshot(result.value)) throw new OpError("internal", "snapshot script returned an unexpected value");
      const raw = result.value;
      const state: PageState = {
        fingerprint: await fingerprint({ url: raw.url, text: raw.text, actions: raw.actions, scroll: raw.scroll }),
        raw,
      };
      this.states.set(tabId, state);
      return state;
    }
    throw new OpError("stale_page", `Page did not settle (${last.slice(0, 120)}). Observe again.`);
  }

  private toWire(state: PageState): V2Snapshot {
    const { raw } = state;
    return {
      url: raw.url,
      title: raw.title,
      viewport: { w: raw.w, h: raw.h },
      scroll: { y: raw.scroll.y, height: raw.scroll.height },
      text: raw.text,
      actions: raw.actions.map(toWireAction),
      omitted_actions: raw.omitted_actions,
      fingerprint: state.fingerprint,
    };
  }

  /** Snapshot/act calls on one tab run in order (the daemon also queues per tab). */
  private serial<T>(tabId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(tabId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(tabId, tail);
    void tail.then(() => {
      if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
    });
    return next;
  }
}
