/**
 * The popup's provider checks: "Load models" (GET {base}/models, fills the model dropdowns) and
 * "Test" (the same list plus a tiny json_object chat call with the decision model). Run in the popup
 * with the form's values, using the same headers, fetch options and redaction as the model_call proxy.
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

/** What listing the models needs: no model names. */
export type ConnectionInput = Pick<ProviderSettings, "base_url" | "api_key" | "headers">;

export type ModelList = { readonly ok: true; readonly models: readonly string[] } | { readonly ok: false; readonly error: string };

/** GET {base}/models: the provider's model ids (sorted, unique), or why the list is unavailable. */
export async function listModels(input: ConnectionInput, deps: ProbeDeps): Promise<ModelList> {
  const base = normalizeBaseUrl(input.base_url);
  if (!base.ok) return { ok: false, error: base.error };
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const secrets = providerSecrets(input);
  try {
    const response = await deps.fetch(`${base.url}/models`, {
      ...PROVIDER_FETCH_INIT,
      method: "GET",
      headers: providerHeaders(input, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readCapped(response, MAX_REPLY_BYTES);
    return response.ok ? { ok: true, models: modelIds(parseJsonOrNull(text)) } : { ok: false, error: httpError(response.status, text, secrets) };
  } catch (err) {
    return { ok: false, error: fetchFailure(err, base.origin, timeoutMs, secrets) };
  }
}

/** A tiny json_object chat call with the decision model; null when none is set (or the URL is invalid). */
export async function checkChat(input: ProbeInput, deps: ProbeDeps): Promise<ChatProbe | null> {
  const base = normalizeBaseUrl(input.base_url);
  const model = input.decision_model.trim();
  if (!base.ok || !model) return null;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const secrets = providerSecrets(input);
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
    return response.ok ? { ok: true, model, ms: now() - started } : { ok: false, error: httpError(response.status, text, secrets) };
  } catch (err) {
    return { ok: false, error: fetchFailure(err, base.origin, timeoutMs, secrets) };
  }
}

/** The Test button: the model list, then the chat check. */
export async function probeProvider(input: ProbeInput, deps: ProbeDeps): Promise<ProbeResult> {
  const list = await listModels(input, deps);
  const chat = await checkChat(input, deps);
  return list.ok ? { models: list.models, models_error: null, chat } : { models: [], models_error: list.error, chat };
}
