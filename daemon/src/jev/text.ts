import type { V2Action } from "@tabcrew/shared/v2";
import { DaemonError } from "../errors.js";
import { MAX_TYPE_TEXT } from "../observe.js";
import {
  httpTransport,
  MISSING_KEY_MESSAGE,
  notConfiguredError,
  OPENROUTER_URL,
  parseCost,
  sendModel,
  viaExtension,
  type HistoryEntry,
  type ModelSettings,
  type PageState,
} from "./decisions.js";
import { TEXT_VALUE } from "./questions.js";

const INVALID_TEXT = "Text helper returned no valid field value; nothing typed.";

export interface FieldContext {
  readonly goal: string;
  readonly field: { readonly label: string | null; readonly role: string | null; readonly value: string | null };
  readonly page: { readonly title: string; readonly text: string };
  readonly recent_actions: { readonly action: string; readonly text: string | null }[];
}

/** Port of jev-ultrafast `field_context`: the text helper's entire input besides its fixed instructions. */
export function fieldContext(goal: string, action: V2Action, page: PageState, history: readonly HistoryEntry[]): FieldContext {
  return {
    goal,
    field: { label: action.label ?? null, role: action.role ?? null, value: action.value ?? null },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
  };
}

/** Parse the helper's reply: strictly `{"text": str}` (1..2000 chars, not blank); a Markdown fence is tolerated. */
export function parseTextReply(content: unknown): string {
  if (typeof content !== "string") throw new DaemonError("model_error", INVALID_TEXT);
  let body = content.trim();
  // Some text models wrap or trail their JSON with a Markdown fence; strip only that.
  if (body.startsWith("```json")) body = body.slice(7);
  if (body.startsWith("```")) body = body.slice(3);
  if (body.endsWith("```")) body = body.slice(0, -3);
  body = body.trim();
  let output: unknown;
  try {
    output = JSON.parse(body);
  } catch {
    throw new DaemonError("model_error", INVALID_TEXT);
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new DaemonError("model_error", INVALID_TEXT);
  const keys = Object.keys(output);
  const value = (output as { text?: unknown }).text;
  if (keys.length !== 1 || keys[0] !== "text" || typeof value !== "string" || !value.trim() || value.length > MAX_TYPE_TEXT) {
    throw new DaemonError("model_error", INVALID_TEXT);
  }
  return value;
}

export function reasoningFor(base: string, setting: string): Record<string, unknown> {
  if (setting === "none") return { reasoning: { enabled: false } };
  if (base.includes("api.deepseek.com/")) return { thinking: { type: "disabled" } };
  return { reasoning: { effort: setting } };
}

export interface FieldText {
  readonly text: string;
  readonly model: string;
  readonly text_ms: number;
  readonly cost: number;
}

/** Hub mode per-attempt text budget: the call also crosses the extension (and may wake its service worker). */
export const HUB_TEXT_TIMEOUT_MS = 8_000;

/** Ask the text helper for the value of one field. Throws `model_error`; nothing is typed on failure. */
export async function fieldText(context: FieldContext, settings: ModelSettings): Promise<FieldText> {
  if (viaExtension(settings)) return hubFieldText(context, settings);
  const key = settings.textModelApiKey || settings.openrouterApiKey;
  if (!key) throw new DaemonError("model_error", MISSING_KEY_MESSAGE);
  const models = [settings.textModel];
  if (settings.textModelFallback && settings.textModelFallback !== settings.textModel) models.push(settings.textModelFallback);
  const started = performance.now();
  let lastError: unknown;
  // Generating text is not a browser mutation, so one fallback attempt is safe: nothing has been typed yet.
  for (const model of models) {
    try {
      const { text, cost } = await askTextModel(model, key, context, settings);
      return { text, model, text_ms: Math.round(performance.now() - started), cost };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function textMessages(context: FieldContext) {
  return [
    { role: "system", content: TEXT_VALUE },
    { role: "user", content: JSON.stringify(context) },
  ];
}

function textReplyOf(json: unknown): { text: string; cost: number } {
  const result = json as { choices?: { message?: { content?: unknown } }[]; usage?: unknown } | null;
  return { text: parseTextReply(result?.choices?.[0]?.message?.content), cost: parseCost(result?.usage) };
}

/**
 * Hub mode: purpose `text`, then once `text_fallback`. The extension owns both models; it answers
 * `model_not_configured` for a purpose it has no model for, which for the fallback means "none" and
 * surfaces the first error instead.
 */
async function hubFieldText(context: FieldContext, settings: ModelSettings): Promise<FieldText> {
  const options = { retryBaseMs: settings.retryBaseMs, timeoutMs: settings.textModelTimeoutMs ?? HUB_TEXT_TIMEOUT_MS };
  const body = { messages: textMessages(context), max_tokens: 1024, response_format: { type: "json_object" } };
  const started = performance.now();
  const ask = async (purpose: "text" | "text_fallback"): Promise<FieldText> => {
    const sent = await sendModel(settings.transport!, { purpose, body }, options);
    const { text, cost } = textReplyOf(sent.json);
    return { text, model: sent.model ?? purpose, text_ms: Math.round(performance.now() - started), cost };
  };
  let firstError: unknown;
  try {
    return await ask("text");
  } catch (err) {
    firstError = err;
  }
  // Generating text is not a browser mutation, so one fallback attempt is safe: nothing has been typed yet.
  try {
    return await ask("text_fallback");
  } catch (err) {
    const noFallback = err instanceof DaemonError && err.code === "model_not_configured";
    throw notConfiguredError(noFallback ? firstError : err);
  }
}

async function askTextModel(
  model: string,
  key: string,
  context: FieldContext,
  settings: ModelSettings,
): Promise<{ text: string; cost: number }> {
  const base = (settings.textModelBaseUrl ?? OPENROUTER_URL).replace(/\/+$/, "");
  const sent = await sendModel(
    settings.transport ?? httpTransport,
    {
      url: `${base}/chat/completions`,
      key,
      body: {
        model,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        ...reasoningFor(`${base}/`, settings.textModelReasoning),
        messages: textMessages(context),
      },
    },
    { retryBaseMs: settings.retryBaseMs, timeoutMs: settings.textModelTimeoutMs ?? 3_000 },
  );
  return textReplyOf(sent.json);
}
