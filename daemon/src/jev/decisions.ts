import type { V2Action } from "@tabcrew/shared/v2";
import { DaemonError } from "../errors.js";
import type { ActionSpace, ElementOperation } from "../observe.js";
import { NEXT_ACTION, TARGET } from "./questions.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const MISSING_KEY_MESSAGE =
  "no OpenRouter API key: ask the user to add one in the TabCrew extension popup (Advanced), or set OPENROUTER_API_KEY in ~/.tabcrew/env (npx tabcrew setup does this) and restart the daemon";

/** Model configuration shared by the Decisions client and the text helper. */
export interface ModelSettings {
  readonly jevModel: string;
  readonly textModel: string;
  readonly openrouterApiKey: string | undefined;
  readonly textModelApiKey?: string;
  readonly textModelBaseUrl?: string;
  /** Reasoning effort for the text helper, or "none" (default) to disable reasoning. */
  readonly textModelReasoning: string;
  /** Tried once if the text model times out or fails (null disables). */
  readonly textModelFallback?: string | null;
  /** Per-attempt text helper budget (default 3 s). */
  readonly textModelTimeoutMs?: number;
  /** Backoff base for 429/503/529 retries: base·2^attempt (default 500 ms). */
  readonly retryBaseMs?: number;
  /** Per-request timeout (default 25 s). */
  readonly timeoutMs?: number;
}

const RETRY_STATUSES = new Set([429, 503, 529]);
const MAX_RETRIES = 2;

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function modelError(message: string): DaemonError {
  return new DaemonError("model_error", message);
}

/** POST JSON with bearer auth. Retries only 429/503/529, at most twice, with exponential backoff. */
export async function postJson(url: string, key: string, body: unknown, settings: Pick<ModelSettings, "retryBaseMs" | "timeoutMs">): Promise<unknown> {
  const base = settings.retryBaseMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs ?? 25_000),
      });
    } catch (err) {
      throw modelError(isTimeout(err) ? "Model request timed out; no action executed." : "Model connection failed; no action executed.");
    }
    if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
      await response.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, base * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw modelError(`Model provider returned HTTP ${response.status}; no action executed.`);
    }
    try {
      return await response.json();
    } catch (err) {
      throw modelError(
        isTimeout(err) ? "Model response timed out; no action executed." : "Model provider returned invalid JSON; no action executed.",
      );
    }
  }
}

export interface ChoiceAnswer {
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

function isUnitNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Port of jev-ultrafast `validate_choice`: reject anything we would have to guess about. */
export function validateChoice(answer: unknown, ids: readonly string[]): ChoiceAnswer {
  const a = answer as Partial<ChoiceAnswer> | null | undefined;
  const probabilities = a?.probabilities;
  let valid = false;
  if (a && typeof a === "object" && probabilities && typeof probabilities === "object" && !Array.isArray(probabilities)) {
    const keys = Object.keys(probabilities);
    const values = Object.values(probabilities) as unknown[];
    const idSet = new Set(ids);
    valid =
      typeof a.choice === "string" &&
      idSet.has(a.choice) &&
      keys.length === idSet.size &&
      keys.every((k) => idSet.has(k)) &&
      [...values, a.confidence].every(isUnitNumber) &&
      Math.abs((values as number[]).reduce((s, n) => s + n, 0) - 1) < 0.02 &&
      probabilities[a.choice] >= Math.max(...(values as number[])) - 1e-6;
  }
  if (!valid) throw modelError("Invalid Jev response; no action executed.");
  return a as ChoiceAnswer;
}

export interface HistoryEntry {
  /** Executed action label. */
  readonly action: string;
  readonly kind: string;
  readonly text: string | null;
  page_changed: boolean | null;
}

export interface PageState {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

const OPERATION_LABELS: Readonly<Record<ElementOperation, string>> = {
  CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
  TYPE_TEXT: "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
  SELECT: "Select an observed dropdown value.",
};
const DONE_LABEL = "Every requirement is visibly satisfied.";
const BLOCKED_LABEL = "No supported operation can progress.";

export interface DecisionRequest {
  readonly body: {
    readonly model: string;
    readonly state: Record<string, unknown>;
    readonly questions: Record<string, unknown>;
  };
  /** Operation ids offered in the `operation` question, in order. */
  readonly operations: string[];
}

function targetCriterion(index: string, action: V2Action): Record<string, unknown> {
  return {
    element: `[${index}] ${action.label}`,
    current_value: action.current_value ?? action.value ?? "",
    ...(action.role !== undefined && { role: action.role }),
    ...(action.checked !== undefined && { checked: action.checked }),
    ...(action.selected !== undefined && { selected: action.selected }),
    ...(action.expanded !== undefined && { expanded: action.expanded }),
  };
}

/** Port of jev-ultrafast `choose` request building: one `operation` question plus one target head per available element operation. */
export function buildDecisionRequest(
  page: PageState,
  space: ActionSpace,
  goal: string,
  history: readonly HistoryEntry[],
  model: string,
): DecisionRequest {
  const criteria: Record<string, string> = {};
  for (const operation of space.targets.keys()) criteria[operation] = OPERATION_LABELS[operation];
  for (const control of space.controls) criteria[control.operation] = control.label;
  criteria.DONE = DONE_LABEL;
  criteria.BLOCKED = BLOCKED_LABEL;

  const questions: Record<string, unknown> = {
    operation: { type: "choice", criteria, instructions: { goal, rules: NEXT_ACTION } },
  };
  for (const [operation, candidates] of space.targets) {
    const targetCriteria: Record<string, unknown> = {};
    for (const [index, action] of candidates) targetCriteria[index] = targetCriterion(index, action);
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: targetCriteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }
  return {
    body: {
      model,
      state: {
        page: { url: page.url, title: page.title, text: page.text },
        elements: space.elements.map((e) => ({ ...e, index: String(e.index) })),
        recent_actions: history.slice(-10).map((h) => ({ action: h.action, kind: h.kind, text: h.text, page_changed: h.page_changed })),
      },
      questions,
    },
    operations: Object.keys(criteria),
  };
}

export interface DecisionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost: number;
}

export interface Decision {
  /** An element/control operation, or DONE / BLOCKED. */
  readonly operation: string;
  /** Element target ("3", "3:2") for CLICK/TYPE_TEXT/SELECT, otherwise null. */
  readonly target: string | null;
  /** The snapshot action to execute; null for DONE / BLOCKED. */
  readonly action: V2Action | null;
  /** Probability of the executed choice (the target head for element operations). */
  readonly probability: number;
  /** Confidence of the operation head. */
  readonly confidence: number;
  readonly decision_ms: number;
  readonly usage: DecisionUsage;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One Decisions request; only the chosen operation's target head is consumed and validated. */
export async function choose(
  page: PageState,
  space: ActionSpace,
  goal: string,
  history: readonly HistoryEntry[],
  settings: ModelSettings,
): Promise<Decision> {
  const key = settings.openrouterApiKey;
  if (!key) throw modelError(MISSING_KEY_MESSAGE);
  const request = buildDecisionRequest(page, space, goal, history, settings.jevModel);
  const started = performance.now();
  const result = (await postJson(DECISIONS_URL, key, request.body, settings)) as { answers?: unknown; usage?: Record<string, unknown> } | null;
  const decision_ms = Math.round(performance.now() - started);
  const answers = result && typeof result === "object" ? result.answers : undefined;
  if (!answers || typeof answers !== "object") throw modelError("Invalid Jev response; no action executed.");
  const rawUsage = result?.usage ?? {};
  const usage: DecisionUsage = { input_tokens: num(rawUsage.input_tokens), output_tokens: num(rawUsage.output_tokens), cost: num(rawUsage.cost) };
  const answerMap = answers as Record<string, unknown>;

  const opAnswer = validateChoice(answerMap.operation, request.operations);
  const operation = opAnswer.choice;
  const candidates = space.targets.get(operation as ElementOperation);
  if (candidates) {
    // Unused target heads cannot cause an action; validate only the chosen operation's head.
    const targetAnswer = validateChoice(answerMap[`${operation.toLowerCase()}_target`], [...candidates.keys()]);
    const target = targetAnswer.choice;
    return {
      operation,
      target,
      action: candidates.get(target)!,
      probability: targetAnswer.probabilities[target],
      confidence: opAnswer.confidence,
      decision_ms,
      usage,
    };
  }
  const control = space.controlActions.get(operation as "SCROLL_UP" | "SCROLL_DOWN" | "WAIT") ?? null;
  return {
    operation,
    target: null,
    action: control,
    probability: opAnswer.probabilities[operation],
    confidence: opAnswer.confidence,
    decision_ms,
    usage,
  };
}
