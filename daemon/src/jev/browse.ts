import type { V2Action, V2ActResult, V2Snapshot } from "@tabcrew/shared/v2";
import type { ExtensionBridge } from "../bridge.js";
import { DaemonError } from "../errors.js";
import { isCode, onTab } from "../lanes.js";
import { log } from "../log.js";
import { actionSpace, checkSnapshot, type ActionSpace, type JevElement, type ObservationCache } from "../observe.js";
import type { Scheduler } from "../scheduler.js";
import { sessionRef, type Session, type SessionRegistry } from "../sessions.js";
import { decider, missingDecisionKey } from "./chat.js";
import { MISSING_KEY_MESSAGE, type HistoryEntry, type ModelSettings, type ModelTransport } from "./decisions.js";
import { fieldContext, fieldText } from "./text.js";

export const DEFAULT_MAX_STEPS = 25;
export const MAX_MAX_STEPS = 50;
export const MAX_GOAL = 2000;
/** Stale-page retries per run; they do not count as steps. */
export const STALE_BUDGET = 10;
const FINAL_ROWS = 30;
const DONE_NOTE = "DONE is Jev's claim; verify the page yourself with observe/read the result";
/** Every browse result reminds the agent to clean up once it no longer needs the tab. */
export const CLOSE_REMINDER =
  "When you are finished, call session_close: your tabs stay open for the user to review in their window; close any throwaway tabs first with tab_close.";

/** FIFO counting semaphore for concurrent browse loops. */
export class Limiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // Hand the slot straight to the next waiter so later arrivals cannot overtake it.
      if (next) next();
      else this.active--;
    };
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}

export interface JevRuntime {
  /** Replaced when the popup changes settings; each browse reads it once when it starts. */
  settings: ModelSettings;
  readonly limiter: Limiter;
  /**
   * Hub mode: the model_call transport (bound to the extension bridge). Every browse uses it in
   * place of `settings.transport`, so a settings replacement never drops it.
   */
  transport?: ModelTransport;
}

export interface BrowseContext {
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  readonly scheduler: Scheduler;
  readonly observations: ObservationCache;
  readonly jev: JevRuntime;
}

export type BrowseStatus = "done" | "blocked" | "max_steps" | "stopped_by_user" | "model_error" | "outcome_unknown";

export interface BrowseStep {
  step: number;
  operation: string;
  target: string | null;
  label: string;
  probability: number;
  confidence: number;
  text?: string;
  page_changed: boolean | null;
  decision_ms: number;
  /** Chat decisions only: the model that chose this step and its one-line reason. */
  decider?: string;
  reason?: string;
  text_ms?: number;
  /** Set when the action was not (or not provably) executed: target_covered, target_invalid, outcome_unknown. */
  error?: string;
}

export interface BrowseUsage {
  decisions: number;
  decision_input_tokens: number;
  decision_cost_usd: number;
  text_calls: number;
  text_cost_usd: number;
}

export interface BrowseResult {
  status: BrowseStatus;
  note?: string;
  /** Why the loop stopped, for every status except done/max_steps. */
  message?: string;
  steps: BrowseStep[];
  final: { url: string; title: string; elements: string[] };
  usage: BrowseUsage;
  elapsed_ms: number;
  /** Cleanup reminder for the agent. */
  next: string;
}

interface Page {
  readonly snapshot: V2Snapshot;
  readonly space: ActionSpace;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Compact table row, e.g. `[3] combobox Where to? · London`. */
export function elementRow(e: JevElement): string {
  let row = `[${e.index}]${e.role ? ` ${e.role}` : ""} ${clip(e.label, 80) || "(no label)"}`;
  if (e.value) row += ` · ${clip(e.value, 60)}`;
  else if (e.operations.includes("TYPE_TEXT") || e.operations.includes("SELECT")) row += " · empty";
  if (e.checked === "true") row += " · checked";
  return row;
}

/** Three non-WAIT actions in a row that did not change the page. */
function stuck(history: readonly HistoryEntry[]): boolean {
  const last = history.slice(-3);
  return last.length === 3 && last.every((h) => h.page_changed === false && h.kind !== "wait");
}

/**
 * The Jev loop (port of jev-ultrafast agent.py): observe → choose → (text) → act → record →
 * observe. Each observe and each act is its own job on the tab's FIFO lane, so other calls on
 * the tab queue behind one step, not behind the whole loop. Browser actions are never retried.
 */
export async function runBrowse(
  ctx: BrowseContext,
  session: Session,
  tabId: number,
  goal: string,
  maxSteps: number,
): Promise<BrowseResult> {
  const { registry, bridge, observations, jev } = ctx;
  const settings: ModelSettings = jev.transport ? { ...jev.settings, transport: jev.transport } : jev.settings;
  const started = performance.now();
  const steps: BrowseStep[] = [];
  const history: HistoryEntry[] = [];
  const usage: BrowseUsage = { decisions: 0, decision_input_tokens: 0, decision_cost_usd: 0, text_calls: 0, text_cost_usd: 0 };
  let page: Page | null = null;
  let status: BrowseStatus = "blocked";
  let message: string | undefined;

  const finish = (): BrowseResult => {
    const elapsed_ms = Math.round(performance.now() - started);
    log.info(`browse ${session.short_id} tab ${tabId}: ${status} after ${steps.length} step(s) in ${elapsed_ms} ms`);
    const snap = page?.snapshot;
    return {
      status,
      ...(status === "done" && { note: DONE_NOTE }),
      next: CLOSE_REMINDER,
      ...(message !== undefined && { message }),
      steps,
      final: {
        url: typeof snap?.url === "string" ? snap.url : "",
        title: typeof snap?.title === "string" ? snap.title : "",
        elements: (page?.space.elements ?? []).slice(0, FINAL_ROWS).map(elementRow),
      },
      usage: {
        ...usage,
        decision_cost_usd: Number(usage.decision_cost_usd.toFixed(6)),
        text_cost_usd: Number(usage.text_cost_usd.toFixed(6)),
      },
      elapsed_ms,
    };
  };

  log.info(`browse ${session.short_id} tab ${tabId}: started (max_steps ${maxSteps})`);
  if (missingDecisionKey(settings)) {
    status = "model_error";
    message = MISSING_KEY_MESSAGE;
    return finish();
  }

  const ref = sessionRef(session);
  const observe = (): Promise<Page> =>
    onTab(ctx, session, tabId, async () => {
      const snapshot = checkSnapshot(await bridge.request(ref, "snapshot", { tab_id: tabId }));
      return { snapshot, space: actionSpace(snapshot.actions) };
    });
  const act = (fingerprint: string, action: V2Action, text: string | undefined): Promise<V2ActResult> =>
    onTab(ctx, session, tabId, async () => {
      const args: { tab_id: number; fingerprint: string; action_id: string; text?: string } = {
        tab_id: tabId,
        fingerprint,
        action_id: action.id,
      };
      if (action.kind === "fill") args.text = text;
      try {
        return await bridge.request(ref, "act", args);
      } finally {
        // The agent's own observation of this tab may no longer describe the page.
        observations.forget(session.short_id, tabId);
      }
    });

  let stale = 0;
  const staleRetry = async (): Promise<boolean> => {
    page = await observe();
    if (++stale <= STALE_BUDGET) return true;
    status = "blocked";
    message = `the page kept changing before an action could run (${STALE_BUDGET} stale retries)`;
    return false;
  };

  // The helper's value is reused across a stale retry only while its whole input is identical.
  type PendingText = { key: string; text: string; text_ms: number };
  let pendingText = null as PendingText | null;
  let acted = 0;

  const decide = decider(settings);
  const release = await jev.limiter.acquire();
  try {
    page = await observe();
    for (;;) {
      registry.requireActive(session);
      if (acted >= maxSteps) {
        status = "max_steps";
        break;
      }
      const current: Page = page;
      const decision = await decide(current.snapshot, current.space, goal, history);
      usage.decisions++;
      usage.decision_input_tokens += decision.usage.input_tokens;
      usage.decision_cost_usd += decision.usage.cost;
      const base = {
        operation: decision.operation,
        target: decision.target,
        probability: decision.probability,
        confidence: decision.confidence,
        decision_ms: decision.decision_ms,
        ...(decision.provider === "chat" && { decider: decision.model, ...(decision.reason && { reason: decision.reason }) }),
      };

      if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
        // Accept the claim only if the page is still the one it was made on.
        const fresh = await observe();
        if (fresh.snapshot.fingerprint !== current.snapshot.fingerprint) {
          page = fresh;
          if (++stale <= STALE_BUDGET) continue;
          status = "blocked";
          message = `the page kept changing before an action could run (${STALE_BUDGET} stale retries)`;
          break;
        }
        page = fresh;
        steps.push({ step: steps.length + 1, ...base, label: decision.operation, page_changed: false });
        status = decision.operation === "DONE" ? "done" : "blocked";
        if (status === "blocked") {
          message = `${decision.provider === "chat" ? decision.model : "Jev"} chose BLOCKED: no supported operation can progress`;
        }
        break;
      }

      const action = decision.action;
      if (!action) throw new DaemonError("model_error", "Jev chose an operation that is not available; no action executed.");
      let text: string | undefined;
      let text_ms: number | undefined;
      if (action.kind === "fill") {
        const context = fieldContext(goal, action, current.snapshot, history);
        const key = JSON.stringify(context);
        if (pendingText?.key === key) {
          ({ text, text_ms } = pendingText);
        } else {
          pendingText = null;
          const helper = await fieldText(context, settings);
          usage.text_calls++;
          usage.text_cost_usd += helper.cost;
          ({ text, text_ms } = helper);
          pendingText = { key, text, text_ms };
        }
      }

      const step: BrowseStep = {
        step: steps.length + 1,
        ...base,
        label: action.label,
        ...(text !== undefined && { text }),
        page_changed: null,
        ...(text_ms !== undefined && { text_ms }),
      };
      const entry: HistoryEntry = { action: action.label, kind: action.kind, text: text ?? null, page_changed: null };
      try {
        await act(current.snapshot.fingerprint, action, text);
      } catch (err) {
        if (isCode(err, "stale_page")) {
          if (await staleRetry()) continue;
          break;
        }
        if (isCode(err, "target_covered", "target_invalid")) {
          pendingText = null;
          acted++;
          step.page_changed = entry.page_changed = false;
          step.error = (err as DaemonError).code;
          steps.push(step);
          history.push(entry);
          page = await observe();
          if (stuck(history)) {
            status = "blocked";
            message = "3 actions in a row did not change the page";
            break;
          }
          continue;
        }
        if (isCode(err, "outcome_unknown")) {
          acted++;
          step.error = "outcome_unknown";
          steps.push(step);
          status = "outcome_unknown";
          message = (err as DaemonError).message;
          break;
        }
        throw err;
      }
      pendingText = null;
      acted++;
      // Record execution before observing: a failed observation must not erase the action.
      steps.push(step);
      history.push(entry);
      page = await observe();
      step.page_changed = entry.page_changed = page.snapshot.fingerprint !== current.snapshot.fingerprint;
      if (stuck(history)) {
        status = "blocked";
        message = "3 actions in a row did not change the page";
        break;
      }
    }
  } catch (err) {
    if (isCode(err, "stopped_by_user")) {
      status = "stopped_by_user";
      message = "the user pressed Stop for this session; ask the user before continuing";
    } else if (isCode(err, "model_error", "model_not_configured")) {
      status = "model_error";
      message = (err as DaemonError).message;
    } else {
      const code = err instanceof DaemonError ? err.code : "internal";
      log.info(`browse ${session.short_id} tab ${tabId}: failed (${code}) after ${steps.length} step(s)`);
      throw err;
    }
  } finally {
    release();
  }
  return finish();
}
