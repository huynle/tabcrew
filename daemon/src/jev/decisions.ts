import type { V2Action, V2ModelCallBody, V2ModelPurpose } from "@tabcrew/shared/v2";
import type { ExtensionBridge } from "../bridge.js";
import { DaemonError } from "../errors.js";
import { scrollChoices, type ActionSpace, type ElementOperation, type ScrollOperation } from "../observe.js";
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
  /** Who picks each step: Jev Decisions API (default), a chat LLM, or Jev with chat fallback when the API is unavailable. */
  readonly decisionProvider?: DecisionProvider;
  /** Chat-completion model used by the "chat" and "auto" providers. */
  readonly decisionModel?: string;
  /** Chat decision overrides: key (default: the OpenRouter key), OpenAI-compatible base URL (default: OpenRouter), reasoning effort or "none". */
  readonly decisionModelApiKey?: string;
  readonly decisionModelBaseUrl?: string;
  readonly decisionModelReasoning?: string;
  /**
   * How model requests are sent. Unset/HTTP: daemon mode (keys, URLs, OpenRouter fields from these
   * settings). model_call: hub mode — the extension owns provider, model and key; decisions are chat-only.
   */
  readonly transport?: ModelTransport;
}

/** Hub mode: model calls go through the extension (`model_call`). */
export function viaExtension(settings: Pick<ModelSettings, "transport">): boolean {
  return settings.transport?.kind === "model_call";
}

export const DECISION_PROVIDERS = ["jev", "chat", "auto"] as const;
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number];

const RETRY_STATUSES = new Set([429, 503, 529]);
const MAX_RETRIES = 2;

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function modelError(message: string): DaemonError {
  return new DaemonError("model_error", message);
}

/** The provider could not be reached or is not serving the endpoint (connection, timeout, 404, 408, 429, 5xx). */
export class ModelUnavailableError extends DaemonError {
  constructor(message: string) {
    super("model_error", message);
  }
}

function unavailableStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * One model request. HTTP (daemon mode) needs `url`, `key` and sends `body` as is; model_call (hub
 * mode) needs `purpose` and forwards only `messages`, `max_tokens` and `response_format` (the
 * extension injects model, URL and credentials).
 */
export interface ModelRequest {
  readonly purpose?: V2ModelPurpose;
  readonly url?: string;
  readonly key?: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A provider reply, whatever its HTTP status. */
export interface TransportReply {
  readonly status: number;
  /** The model that answered, when the transport knows it (model_call). */
  readonly model?: string;
  /** The reply body (called for 2xx only); throws `model_error` when it is not JSON. */
  json(): Promise<unknown>;
  /** Drop an unread body. */
  discard(): Promise<void>;
}

/** How model requests reach the provider. Retries and status classification live in `sendModel`. */
export interface ModelTransport {
  readonly kind: "http" | "model_call";
  /** One attempt. Throws `ModelUnavailableError` when no reply exists; other DaemonErrors pass through. */
  exchange(request: ModelRequest, timeoutMs: number): Promise<TransportReply>;
  /** Extra guidance appended to a non-2xx status message. */
  statusHint?(status: number, json: unknown): string;
}

/** Daemon mode: POST JSON with bearer auth straight to the provider. */
export const httpTransport: ModelTransport = {
  kind: "http",
  async exchange(request, timeoutMs) {
    if (!request.url || request.key === undefined) throw new DaemonError("internal", "HTTP model request without url or key");
    let response: Response;
    try {
      response = await globalThis.fetch(request.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${request.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ModelUnavailableError(
        isTimeout(err) ? "Model request timed out; no action executed." : "Model connection failed; no action executed.",
      );
    }
    return {
      status: response.status,
      async json() {
        try {
          return await response.json();
        } catch (err) {
          throw modelError(
            isTimeout(err) ? "Model response timed out; no action executed." : "Model provider returned invalid JSON; no action executed.",
          );
        }
      },
      async discard() {
        await response.body?.cancel().catch(() => {});
      },
    };
  },
};

/** Where hub-mode users fix provider settings. */
export const HUB_PROVIDER_SETTINGS = "the TabCrew popup (Model provider)";

/** Hub mode: `model_not_configured` from the extension becomes a `model_error` the agent can relay; other errors pass through. */
export function notConfiguredError(err: unknown): unknown {
  if (!(err instanceof DaemonError) || err.code !== "model_not_configured") return err;
  const detail = err.message.replace(/[\s.;]+$/, "");
  return modelError(`No model provider available (${detail}): set the provider, key and models in ${HUB_PROVIDER_SETTINGS}; no action executed.`);
}

function providerMessage(json: unknown): string {
  const error = (json as { error?: unknown } | null)?.error;
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

/**
 * Hub mode: the extension calls its configured provider (`ExtensionBridge.modelCall`). The hub
 * chooses only the purpose and the chat body; it never sends a model, URL, key or extra fields.
 */
export function modelCallTransport(bridge: Pick<ExtensionBridge, "modelCall">): ModelTransport {
  return {
    kind: "model_call",
    async exchange(request, timeoutMs) {
      if (!request.purpose) throw new DaemonError("internal", "model_call request without a purpose");
      const b = request.body as Partial<V2ModelCallBody>;
      const body = {
        messages: b.messages ?? [],
        max_tokens: b.max_tokens ?? 0,
        ...(b.response_format && { response_format: b.response_format }),
      } as V2ModelCallBody;
      const result = await bridge.modelCall(request.purpose, body, timeoutMs);
      return {
        status: result.status,
        model: result.model,
        async json() {
          if (result.json === null || result.json === undefined) throw modelError("Model provider returned invalid JSON; no action executed.");
          return result.json;
        },
        async discard() {},
      };
    },
    statusHint(status, json) {
      const detail = providerMessage(json);
      const fix =
        status === 401 || status === 403
          ? `; check the API key and headers in ${HUB_PROVIDER_SETTINGS}`
          : status === 404
            ? `; check the base URL and model in ${HUB_PROVIDER_SETTINGS}`
            : "";
      return `${detail ? ` (${detail})` : ""}${fix}`;
    },
  };
}

/**
 * Send one model request over `transport`. Retries only 429/503/529, at most twice, with
 * exponential backoff; 404/408/429/5xx and no reply are `ModelUnavailableError`, other non-2xx
 * statuses and invalid JSON plain `model_error`.
 */
export async function sendModel(
  transport: ModelTransport,
  request: ModelRequest,
  settings: Pick<ModelSettings, "retryBaseMs" | "timeoutMs">,
): Promise<{ json: unknown; model: string | undefined }> {
  const base = settings.retryBaseMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    const reply = await transport.exchange(request, settings.timeoutMs ?? 25_000);
    if (RETRY_STATUSES.has(reply.status) && attempt < MAX_RETRIES) {
      await reply.discard();
      await new Promise((r) => setTimeout(r, base * 2 ** attempt));
      continue;
    }
    if (reply.status < 200 || reply.status > 299) {
      let hint = "";
      if (transport.statusHint) hint = transport.statusHint(reply.status, await reply.json().catch(() => null));
      else await reply.discard();
      const message = `Model provider returned HTTP ${reply.status}${hint}; no action executed.`;
      throw unavailableStatus(reply.status) ? new ModelUnavailableError(message) : modelError(message);
    }
    return { json: await reply.json(), model: reply.model };
  }
}

/** POST JSON with bearer auth (HTTP transport). Retries only 429/503/529, at most twice, with exponential backoff. */
export async function postJson(url: string, key: string, body: unknown, settings: Pick<ModelSettings, "retryBaseMs" | "timeoutMs">): Promise<unknown> {
  return (await sendModel(httpTransport, { url, key, body: body as Record<string, unknown> }, settings)).json;
}

/** `usage.cost` as a number: OpenRouter sends a number, Provider `{input_cost, output_cost, total_cost}`. */
export function parseCost(usage: unknown): number {
  const cost = (usage as { cost?: unknown } | null | undefined)?.cost;
  const value = cost && typeof cost === "object" ? (cost as { total_cost?: unknown }).total_cost : cost;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
/** The operation label when a scroll operation has several targets (its target head picks one). */
const SCROLL_CHOICE_LABELS: Readonly<Record<ScrollOperation, string>> = {
  SCROLL_DOWN: "Scroll down in one of the scroll areas (the page, an open dialog or a panel); a target question chooses which.",
  SCROLL_UP: "Scroll up in one of the scroll areas (the page, an open dialog or a panel); a target question chooses which.",
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

/** The target question name for an element or scroll operation, e.g. `click_target`, `scroll_down_target`. */
export function targetQuestion(operation: string): string {
  return `${operation.toLowerCase()}_target`;
}

/**
 * Port of jev-ultrafast `choose` request building: one `operation` question plus one target head
 * per available element operation, and (TabCrew) per scroll operation with several scroll targets
 * (page, dialog, panel). A scroll operation with one target gets no head, as before.
 */
export function buildDecisionRequest(
  page: PageState,
  space: ActionSpace,
  goal: string,
  history: readonly HistoryEntry[],
  model: string,
): DecisionRequest {
  const criteria: Record<string, string> = {};
  const scrolls = scrollChoices(space);
  for (const operation of space.targets.keys()) criteria[operation] = OPERATION_LABELS[operation];
  for (const control of space.controls) {
    if (control.operation in criteria) continue;
    const several = control.operation !== "WAIT" && scrolls.has(control.operation);
    criteria[control.operation] = several ? SCROLL_CHOICE_LABELS[control.operation as ScrollOperation] : control.label;
  }
  criteria.DONE = DONE_LABEL;
  criteria.BLOCKED = BLOCKED_LABEL;

  const questions: Record<string, unknown> = {
    operation: { type: "choice", criteria, instructions: { goal, rules: NEXT_ACTION } },
  };
  for (const [operation, candidates] of space.targets) {
    const targetCriteria: Record<string, unknown> = {};
    for (const [index, action] of candidates) targetCriteria[index] = targetCriterion(index, action);
    questions[targetQuestion(operation)] = {
      type: "choice",
      criteria: targetCriteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }
  for (const [operation, candidates] of scrolls) {
    const targetCriteria: Record<string, unknown> = {};
    for (const [target, action] of candidates) targetCriteria[target] = { element: `[${target}] ${action.label}` };
    questions[targetQuestion(operation)] = {
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
  /** Which provider made this decision, and with which model. */
  readonly provider: "jev" | "chat";
  readonly model: string;
  /** The chat model's one-line rationale (chat provider only). */
  readonly reason?: string;
  /** An element/control operation, or DONE / BLOCKED. */
  readonly operation: string;
  /** Element target ("3", "3:2") for CLICK/TYPE_TEXT/SELECT, scroll target ("page", "s1") when several were offered, otherwise null. */
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
export async function chooseJev(
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
  const usage: DecisionUsage = { input_tokens: num(rawUsage.input_tokens), output_tokens: num(rawUsage.output_tokens), cost: parseCost(rawUsage) };
  const answerMap = answers as Record<string, unknown>;

  const opAnswer = validateChoice(answerMap.operation, request.operations);
  const operation = opAnswer.choice;
  const candidates = space.targets.get(operation as ElementOperation) ?? scrollChoices(space).get(operation as ScrollOperation);
  if (candidates) {
    // Unused target heads cannot cause an action; validate only the chosen operation's head.
    const targetAnswer = validateChoice(answerMap[targetQuestion(operation)], [...candidates.keys()]);
    const target = targetAnswer.choice;
    return {
      provider: "jev",
      model: settings.jevModel,
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
    provider: "jev",
    model: settings.jevModel,
    operation,
    target: null,
    action: control,
    probability: opAnswer.probabilities[operation],
    confidence: opAnswer.confidence,
    decision_ms,
    usage,
  };
}
