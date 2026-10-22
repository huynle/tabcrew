import type { V2Action } from "@tabcrew/shared/v2";
import { DaemonError } from "../errors.js";
import { MAX_TYPE_TEXT } from "../observe.js";
import { MISSING_KEY_MESSAGE, OPENROUTER_URL, postJson, type HistoryEntry, type ModelSettings, type PageState } from "./decisions.js";
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

/** Ask the text helper for the value of one field. Throws `model_error`; nothing is typed on failure. */
export async function fieldText(context: FieldContext, settings: ModelSettings): Promise<FieldText> {
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

async function askTextModel(
  model: string,
  key: string,
  context: FieldContext,
  settings: ModelSettings,
): Promise<{ text: string; cost: number }> {
  const base = (settings.textModelBaseUrl ?? OPENROUTER_URL).replace(/\/+$/, "");
  const result = (await postJson(
    `${base}/chat/completions`,
    key,
    {
      model,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      ...reasoningFor(`${base}/`, settings.textModelReasoning),
      messages: [
        { role: "system", content: TEXT_VALUE },
        { role: "user", content: JSON.stringify(context) },
      ],
    },
    { retryBaseMs: settings.retryBaseMs, timeoutMs: settings.textModelTimeoutMs ?? 3_000 },
  )) as { choices?: { message?: { content?: unknown } }[]; usage?: { cost?: unknown } } | null;
  const text = parseTextReply(result?.choices?.[0]?.message?.content);
  const cost = result?.usage?.cost;
  return { text, cost: typeof cost === "number" && Number.isFinite(cost) ? cost : 0 };
}
