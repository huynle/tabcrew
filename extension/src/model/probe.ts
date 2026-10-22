/**
 * The popup's "Test" button: GET {base}/models (fills the model suggestions) and a tiny
 * json_object chat call with the decision model. Runs in the popup with the form's values, using
 * the same headers, fetch options and redaction as the model_call proxy.
 */

import {
  MAX_REPLY_BYTES,
  PROVIDER_FETCH_INIT,
  fetchFailure,
  parseJsonOrNull,
  providerHeaders,
  providerSecrets,
  readCapped,
  redactSecrets,
} from "./http.js";
import { normalizeBaseUrl, type ProviderSettings } from "./settings.js";

export type ProbeInput = Pick<ProviderSettings, "base_url" | "api_key" | "headers" | "decision_model">;

export type ChatProbe = { readonly ok: true; readonly model: string; readonly ms: number } | { readonly ok: false; readonly error: string };

export interface ProbeResult {
  /** Model ids from /models (sorted, unique); empty when the call failed. */
  readonly models: readonly string[];
  readonly models_error: string | null;
  /** null when no decision model is set (or the URL is invalid). */
  readonly chat: ChatProbe | null;
}

export interface ProbeDeps {
  fetch: typeof fetch;
  now?: () => number;
  /** Per request (default 20 s). */
  timeoutMs?: number;
}

const PROBE_PROMPT = 'Reply with exactly this JSON object: {"ok":true}';

function hintFor(status: number): string {
  if (status === 401 || status === 403) return " (check the API key and headers)";
  if (status === 404) return " (check the model name and base URL)";
  return "";
}

/** "HTTP <status>: <provider message> (<hint>)", secrets redacted. */
function httpError(status: number, text: string, secrets: readonly string[]): string {
  const json = parseJsonOrNull(text) as { error?: unknown; message?: unknown } | null;
  const error = json?.error as { message?: unknown } | string | undefined;
  const raw =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : typeof json?.message === "string"
          ? json.message
          : text.trim();
  const message = redactSecrets(raw.replace(/\s+/g, " "), secrets).slice(0, 200);
  return `HTTP ${status}${message ? `: ${message}` : ""}${hintFor(status)}`;
}

function modelIds(json: unknown): string[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

export async function probeProvider(input: ProbeInput, deps: ProbeDeps): Promise<ProbeResult> {
  const base = normalizeBaseUrl(input.base_url);
  if (!base.ok) return { models: [], models_error: base.error, chat: null };
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const secrets = providerSecrets(input);

  let models: string[] = [];
  let modelsError: string | null = null;
  try {
    const response = await deps.fetch(`${base.url}/models`, {
      ...PROVIDER_FETCH_INIT,
      method: "GET",
      headers: providerHeaders(input, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readCapped(response, MAX_REPLY_BYTES);
    if (response.ok) models = modelIds(parseJsonOrNull(text));
    else modelsError = httpError(response.status, text, secrets);
  } catch (err) {
    modelsError = fetchFailure(err, base.origin, timeoutMs, secrets);
  }

  const model = input.decision_model.trim();
  if (!model) return { models, models_error: modelsError, chat: null };
  let chat: ChatProbe;
  const started = now();
  try {
    const response = await deps.fetch(`${base.url}/chat/completions`, {
      ...PROVIDER_FETCH_INIT,
      method: "POST",
      headers: providerHeaders(input, true),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: 20,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readCapped(response, MAX_REPLY_BYTES);
    chat = response.ok ? { ok: true, model, ms: now() - started } : { ok: false, error: httpError(response.status, text, secrets) };
  } catch (err) {
    chat = { ok: false, error: fetchFailure(err, base.origin, timeoutMs, secrets) };
  }
  return { models, models_error: modelsError, chat };
}
