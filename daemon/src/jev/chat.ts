import { DaemonError } from "../errors.js";
import { log } from "../log.js";
import { scrollChoices, type ActionSpace, type ElementOperation, type ScrollOperation } from "../observe.js";
import {
  buildDecisionRequest,
  chooseJev,
  httpTransport,
  MISSING_KEY_MESSAGE,
  ModelUnavailableError,
  notConfiguredError,
  OPENROUTER_URL,
  parseCost,
  sendModel,
  targetQuestion,
  viaExtension,
  type Decision,
  type HistoryEntry,
  type ModelSettings,
  type PageState,
} from "./decisions.js";
import { NEXT_ACTION, TARGET } from "./questions.js";
import { reasoningFor } from "./text.js";

const INVALID_CHAT = "Invalid chat decision; no action executed.";
const MAX_REASON = 200;

export const CHAT_DECISION = `You operate a web browser for a user, one operation per turn.
You get the goal, the CURRENT page (url, title, text, numbered elements), recent actions, the
operations available now, and for each element operation the elements it may target.

Rules for choosing the operation:
${NEXT_ACTION}

Rules for choosing the target:
${TARGET}

For TYPE_TEXT choose only the field; a separate helper types the value from the goal.
When a dialog is open, what you need is usually inside it: scroll the dialog, not the page.
Reply with ONLY a JSON object, no Markdown:
{"operation": "<one offered operation id>", "target": "<offered target for CLICK/TYPE_TEXT/SELECT, or for SCROLL_UP/SCROLL_DOWN when targets are offered for it (null: the first one), else null>",
 "confidence": <0..1>, "reason": "<one short sentence>"}`;

export interface ChatReply {
  readonly operation: string;
  readonly target: string | null;
  readonly confidence: number;
  readonly reason: string;
}

function isUnitNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Parse and validate a chat reply against what was offered. Tolerates a Markdown fence or text
 * around the object. Operations in `optional` (scroll) may omit the target: null means the first listed.
 */
export function parseChatDecision(
  content: unknown,
  operations: readonly string[],
  targets: ReadonlyMap<string, readonly string[]>,
  optional: ReadonlySet<string> = new Set(),
): ChatReply {
  if (typeof content !== "string") throw new DaemonError("model_error", INVALID_CHAT);
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new DaemonError("model_error", INVALID_CHAT);
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new DaemonError("model_error", INVALID_CHAT);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DaemonError("model_error", INVALID_CHAT);
  const r = raw as Record<string, unknown>;
  const operation = typeof r.operation === "string" ? r.operation.trim().toUpperCase() : "";
  if (!operations.includes(operation)) throw new DaemonError("model_error", `${INVALID_CHAT} (unknown operation)`);
  let target: string | null = null;
  const candidates = targets.get(operation);
  if (candidates) {
    const t = typeof r.target === "number" ? String(r.target) : typeof r.target === "string" ? r.target.trim().replace(/^\[|\]$/g, "") : "";
    const omitted = optional.has(operation) && (r.target === null || r.target === undefined || t === "" || t === "null");
    if (!omitted && !candidates.includes(t)) throw new DaemonError("model_error", `${INVALID_CHAT} (target not offered for ${operation})`);
    target = omitted ? null : t;
  }
  const reason = typeof r.reason === "string" ? r.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "";
  return { operation, target, confidence: isUnitNumber(r.confidence) ? r.confidence : 0, reason };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function chatDecisionKey(settings: ModelSettings): string | undefined {
  return settings.decisionModelApiKey || settings.openrouterApiKey;
}

/**
 * One chat-completion decision over the same state and options a Jev Decisions request carries.
 * Daemon mode POSTs to the configured OpenAI-compatible endpoint with a key; hub mode sends only the
 * messages to the extension (`chat_decision`), which picks the model and reports it back.
 */
export async function chooseChat(
  page: PageState,
  space: ActionSpace,
  goal: string,
  history: readonly HistoryEntry[],
  settings: ModelSettings,
): Promise<Decision> {
  const hub = viaExtension(settings);
  const model = settings.decisionModel;
  if (!hub && !model) throw new DaemonError("model_error", "no decision_model configured for chat decisions");
  const key = hub ? undefined : chatDecisionKey(settings);
  if (!hub && !key) throw new DaemonError("model_error", MISSING_KEY_MESSAGE);
  const request = buildDecisionRequest(page, space, goal, history, model ?? "");
  const questions = request.body.questions as Record<string, { criteria: Record<string, unknown> }>;
  const targets = new Map<string, string[]>();
  const offered: Record<string, unknown> = {};
  const scrolls = scrollChoices(space);
  for (const operation of [...space.targets.keys(), ...scrolls.keys()]) {
    const criteria = questions[targetQuestion(operation)].criteria;
    targets.set(operation, Object.keys(criteria));
    offered[operation] = criteria;
  }
  const user = { goal, ...request.body.state, operations: questions.operation.criteria, targets: offered };
  const messages = [
    { role: "system", content: CHAT_DECISION },
    { role: "user", content: JSON.stringify(user) },
  ];
  const response_format = { type: "json_object" };

  const started = performance.now();
  let sent: { json: unknown; model: string | undefined };
  if (hub) {
    try {
      // No model and no OpenRouter `reasoning` field: the extension owns the provider settings.
      sent = await sendModel(settings.transport!, { purpose: "chat_decision", body: { messages, max_tokens: 400, response_format } }, settings);
    } catch (err) {
      throw notConfiguredError(err);
    }
  } else {
    const base = (settings.decisionModelBaseUrl ?? OPENROUTER_URL).replace(/\/+$/, "");
    sent = await sendModel(
      settings.transport ?? httpTransport,
      {
        url: `${base}/chat/completions`,
        key,
        body: {
          model,
          max_tokens: 400,
          response_format,
          ...reasoningFor(`${base}/`, settings.decisionModelReasoning ?? "none"),
          messages,
        },
      },
      settings,
    );
  }
  const result = sent.json as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> } | null;
  const decision_ms = Math.round(performance.now() - started);
  const reply = parseChatDecision(result?.choices?.[0]?.message?.content, request.operations, targets, new Set(scrolls.keys()));
  const usage = {
    input_tokens: num(result?.usage?.prompt_tokens),
    output_tokens: num(result?.usage?.completion_tokens),
    cost: parseCost(result?.usage),
  };
  const candidates = space.targets.get(reply.operation as ElementOperation) ?? scrolls.get(reply.operation as ScrollOperation);
  const action =
    candidates && reply.target !== null
      ? candidates.get(reply.target)!
      : (space.controlActions.get(reply.operation as "SCROLL_UP" | "SCROLL_DOWN" | "WAIT") ?? null);
  return {
    provider: "chat",
    model: sent.model ?? model ?? "chat",
    ...(reply.reason && { reason: reply.reason }),
    operation: reply.operation,
    target: reply.target,
    action,
    // Chat models give no calibrated distribution; both fields carry the model's self-reported confidence.
    probability: reply.confidence,
    confidence: reply.confidence,
    decision_ms,
    usage,
  };
}

/** Whether the configured provider has no key to make its first decision with. */
export function missingDecisionKey(settings: ModelSettings): boolean {
  // Hub mode: the key lives in the extension.
  if (viaExtension(settings)) return false;
  switch (settings.decisionProvider ?? "jev") {
    case "chat":
      return !chatDecisionKey(settings);
    case "auto":
      return !settings.openrouterApiKey && !chatDecisionKey(settings);
    default:
      return !settings.openrouterApiKey;
  }
}

export type Decide = (page: PageState, space: ActionSpace, goal: string, history: readonly HistoryEntry[]) => Promise<Decision>;

/**
 * The decision function for one browse run. "auto" asks Jev and switches to the chat model for the
 * rest of the run the first time the Decisions API is unavailable; other Jev errors still stop the run.
 */
export function decider(settings: ModelSettings): Decide {
  // Hub mode is chat-only: there is no Jev Decisions proxy.
  const provider = viaExtension(settings) ? "chat" : (settings.decisionProvider ?? "jev");
  if (provider === "chat") return (p, s, g, h) => chooseChat(p, s, g, h, settings);
  if (provider === "jev") return (p, s, g, h) => chooseJev(p, s, g, h, settings);
  let useChat = !settings.openrouterApiKey;
  return async (p, s, g, h) => {
    if (!useChat) {
      try {
        return await chooseJev(p, s, g, h, settings);
      } catch (err) {
        if (!(err instanceof ModelUnavailableError) || !settings.decisionModel) throw err;
        log.warn(`Jev Decisions unavailable (${err.message}); falling back to ${settings.decisionModel}`);
        useChat = true;
      }
    }
    return chooseChat(p, s, g, h, settings);
  };
}
