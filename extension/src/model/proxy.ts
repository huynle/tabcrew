/**
 * Hub mode `model_call` proxy (runs in the service worker). The hub only chooses the purpose, the
 * messages, max_tokens and response_format; the URL ({base_url}/chat/completions), the model, the
 * key and the headers come from the popup's provider settings, so the key never leaves Chrome and
 * the hub cannot send it anywhere else. Every HTTP reply is `ok: true` (the hub maps statuses and
 * retries); `model_not_configured` = fix the popup settings (never retried); `model_error` =
 * network/TLS failure, timeout, oversized reply or the local rate limit. Error messages never
 * contain the key or custom header values.
 */

import type { V2ModelCall, V2ModelCallBody } from "@tabcrew/shared/v2";
import { MODEL_NOT_CONFIGURED_MESSAGE, type ModelCallOutcome } from "../relay.js";
import {
  MAX_REPLY_BYTES,
  PROVIDER_FETCH_INIT,
  fetchFailure,
  parseJsonOrNull,
  providerHeaders,
  providerSecrets,
  readCapped,
} from "./http.js";
import { loadProviderSettings, modelFor, normalizeBaseUrl, originPattern, validateHeaders, type ProviderSettings } from "./settings.js";

/** Upper bound for `max_tokens` sent to the provider (the hub may ask for more). */
export const MAX_TOKENS_CAP = 4096;
export const MAX_CONCURRENT_CALLS = 8;
export const MAX_CALLS_PER_MINUTE = 120;

export { MAX_REPLY_BYTES, redactSecrets } from "./http.js";

export interface ModelProxyDeps {
  loadSettings(): Promise<ProviderSettings | null>;
  /** chrome.permissions.contains for one origin pattern. */
  hasPermission(pattern: string): Promise<boolean>;
  fetch: typeof fetch;
  now?: () => number;
  maxReplyBytes?: number;
}

const PURPOSE_LABEL: Record<V2ModelCall["purpose"], string> = {
  chat_decision: "decision model",
  text: "text model",
  text_fallback: "fallback text model",
};

/** The chat-completions body: only whitelisted fields, the configured model, max_tokens capped. */
function chatBody(model: string, body: V2ModelCallBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: Math.min(Math.max(1, Math.floor(body.max_tokens)), MAX_TOKENS_CAP),
  };
  const format = body.response_format?.type;
  if (format === "json_object" || format === "text") out.response_format = { type: format };
  return out;
}

function notConfigured(message: string): ModelCallOutcome {
  return { ok: false, error: { code: "model_not_configured", message } };
}

function modelError(message: string): ModelCallOutcome {
  return { ok: false, error: { code: "model_error", message } };
}

/** At most `max` in flight and `perMinute` started in any 60 s window. */
class RateLimiter {
  private inFlight = 0;
  private starts: number[] = [];
  constructor(
    private readonly now: () => number,
    private readonly max = MAX_CONCURRENT_CALLS,
    private readonly perMinute = MAX_CALLS_PER_MINUTE,
  ) {}

  /** A release function, or null when over the limit. */
  acquire(): (() => void) | null {
    const now = this.now();
    this.starts = this.starts.filter((t) => now - t < 60_000);
    if (this.inFlight >= this.max || this.starts.length >= this.perMinute) return null;
    this.inFlight++;
    this.starts.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
  }
}

export function createModelProxy(deps: ModelProxyDeps): (call: V2ModelCall) => Promise<ModelCallOutcome> {
  const limiter = new RateLimiter(deps.now ?? Date.now);
  const maxReplyBytes = deps.maxReplyBytes ?? MAX_REPLY_BYTES;

  return async (call) => {
    const settings = await deps.loadSettings();
    if (!settings) return notConfigured(MODEL_NOT_CONFIGURED_MESSAGE);
    const model = modelFor(settings, call.purpose);
    if (!model) return notConfigured(`no ${PURPOSE_LABEL[call.purpose]} set: set one in the TabCrew popup (Model provider)`);
    // Defense in depth: the stored settings were validated on save, check again before using them.
    const base = normalizeBaseUrl(settings.base_url);
    if (!base.ok) return notConfigured(`invalid model provider base URL: ${base.error}`);
    const headersError = validateHeaders(settings.headers);
    if (headersError) return notConfigured(`invalid model provider headers: ${headersError}`);
    if (!settings.api_key || /[\r\n\0]/.test(settings.api_key)) return notConfigured(MODEL_NOT_CONFIGURED_MESSAGE);

    const granted = await deps.hasPermission(originPattern(base.origin)).catch(() => false);
    if (!granted) return notConfigured(`grant access to ${base.origin} in the TabCrew popup (Model provider → Save)`);

    const release = limiter.acquire();
    if (!release) {
      return modelError(`too many model calls at once (TabCrew allows ${MAX_CONCURRENT_CALLS} concurrent, ${MAX_CALLS_PER_MINUTE} per minute)`);
    }
    const secrets = providerSecrets(settings);
    try {
      const response = await deps.fetch(`${base.url}/chat/completions`, {
        ...PROVIDER_FETCH_INIT,
        method: "POST",
        headers: providerHeaders(settings, true),
        body: JSON.stringify(chatBody(model, call.body)),
        signal: AbortSignal.timeout(call.timeout_ms),
      });
      const text = await readCapped(response, maxReplyBytes);
      return { ok: true, result: { status: response.status, json: parseJsonOrNull(text), model } };
    } catch (err) {
      return modelError(fetchFailure(err, base.origin, call.timeout_ms, secrets));
    } finally {
      release();
    }
  };
}

/** The service worker's model_call handler: chrome.storage settings, chrome.permissions, global fetch. */
export const handleModelCall = createModelProxy({
  loadSettings: loadProviderSettings,
  hasPermission: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
  fetch: (input, init) => fetch(input, init),
});
