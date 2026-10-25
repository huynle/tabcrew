/**
 * Account model settings (TabCrew Online): one OpenAI-compatible provider per user, entered on
 * /settings and used by every browser of the account. Stored sealed (AES-256-GCM, bound to the
 * user id) with RELAY_SECRETS_KEY; the API key is never shown again or sent to a browser. The relay
 * calls the provider itself (`relayModelTransport`); a browser that turned on "use this browser's
 * own provider" (feature own_model) keeps answering model_call itself.
 */
import { DaemonError } from "@tabcrew/daemon/dist/errors.js";
import { ModelUnavailableError, modelCallTransport, type ModelTransport } from "@tabcrew/daemon/dist/jev/decisions.js";
import type { ExtensionBridge } from "@tabcrew/daemon/dist/bridge.js";
import {
  chatModels,
  modelFor,
  normalizeBaseUrl,
  parseProviderSettings,
  validateHeaders,
  type ProviderSettings,
} from "@tabcrew/shared/provider";
import { V2_EXT_FEATURE_ACCOUNT_MODEL, V2_EXT_FEATURE_OWN_MODEL, type V2ModelCallBody, type V2ModelPurpose } from "@tabcrew/shared/v2";
import { seal, unseal } from "./crypto.js";
import { EgressError, publicHttpsClient, type HttpClient } from "./egress.js";
import type { Store } from "./store/types.js";

export const MAX_TOKENS_CAP = 4096;
const CACHE_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;

export type SettingsCheck = { ok: true; settings: ProviderSettings } | { ok: false; error: string };

/** Validate settings for the relay: like the extension's rules, but https only (never localhost). */
export function checkAccountSettings(value: unknown): SettingsCheck {
  const v = (value ?? {}) as Record<string, unknown>;
  const base = normalizeBaseUrl(typeof v.base_url === "string" ? v.base_url : "");
  if (!base.ok) return { ok: false, error: base.error };
  if (!base.url.startsWith("https://")) return { ok: false, error: "Use an https:// URL. The relay can only reach public providers." };
  if (typeof v.api_key !== "string" || !v.api_key.trim()) return { ok: false, error: "Paste the provider's API key." };
  const headers = (v.headers ?? {}) as Record<string, unknown>;
  const headersError = validateHeaders(headers);
  if (headersError) return { ok: false, error: headersError };
  const settings = parseProviderSettings({ kind: "openai-compatible", ...v, base_url: base.url });
  if (!settings) return { ok: false, error: "Invalid model settings (check the model names)." };
  return { ok: true, settings };
}

export type ModelList = { ok: true; models: string[] } | { ok: false; error: string };

export interface ChatReply {
  readonly status: number;
  readonly json: unknown;
  readonly model: string;
}

export class AccountModels {
  private readonly cache = new Map<string, { at: number; value: ProviderSettings | null }>();
  private readonly http: HttpClient;
  private readonly now: () => number;

  constructor(
    private readonly o: {
      readonly store: Store;
      /** 32 bytes; null turns account model settings off (the page says so). */
      readonly key: Buffer | null;
      readonly http?: HttpClient;
      readonly now?: () => number;
    },
  ) {
    this.http = o.http ?? publicHttpsClient();
    this.now = o.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.o.key !== null;
  }

  async get(userId: string): Promise<ProviderSettings | null> {
    if (!this.o.key) return null;
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;
    const sealed = await this.o.store.getModelSettings(userId);
    const plain = sealed ? unseal(this.o.key, userId, sealed) : null;
    let value: ProviderSettings | null = null;
    if (plain) {
      try {
        value = parseProviderSettings(JSON.parse(plain));
      } catch {
        value = null;
      }
    }
    this.cache.set(userId, { at: this.now(), value });
    return value;
  }

  async save(userId: string, settings: ProviderSettings): Promise<void> {
    if (!this.o.key) throw new Error("account model settings are not enabled on this relay");
    await this.o.store.putModelSettings(userId, seal(this.o.key, userId, JSON.stringify(settings)));
    this.cache.set(userId, { at: this.now(), value: settings });
  }

  async remove(userId: string): Promise<void> {
    await this.o.store.deleteModelSettings(userId);
    this.cache.set(userId, { at: this.now(), value: null });
  }

  /** GET {base}/models: the provider's chat models (embeddings, speech... left out). */
  async listModels(settings: Pick<ProviderSettings, "base_url" | "api_key" | "headers">): Promise<ModelList> {
    try {
      const reply = await this.http({ method: "GET", url: `${settings.base_url}/models`, headers: headersFor(settings, false), timeoutMs: LIST_TIMEOUT_MS });
      const json = parseJson(reply.text);
      if (reply.status < 200 || reply.status >= 300) return { ok: false, error: statusMessage(reply.status, json) };
      const data = (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { ok: false, error: "The provider did not return a model list." };
      return { ok: true, models: chatModels(data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")) };
    } catch (err) {
      return { ok: false, error: egressMessage(err) };
    }
  }

  /** One chat completion with the configured model for `purpose` (model already resolved by the caller). */
  async chat(settings: ProviderSettings, model: string, body: V2ModelCallBody, timeoutMs: number): Promise<ChatReply> {
    const reply = await this.http({
      method: "POST",
      url: `${settings.base_url}/chat/completions`,
      headers: headersFor(settings, true),
      body: JSON.stringify(chatBody(model, body)),
      timeoutMs,
    });
    const json = parseJson(reply.text);
    const answered = (json as { model?: unknown } | null)?.model;
    return { status: reply.status, json, model: typeof answered === "string" && answered ? answered : model };
  }

  /** A tiny JSON chat request with the decision model. */
  async test(settings: ProviderSettings): Promise<{ ok: boolean; message: string }> {
    if (!settings.decision_model) return { ok: false, message: "Choose a decision model first." };
    try {
      const reply = await this.chat(
        settings,
        settings.decision_model,
        { messages: [{ role: "user", content: 'Reply with the JSON object {"ok": true} and nothing else.' }], max_tokens: 20, response_format: { type: "json_object" } },
        TEST_TIMEOUT_MS,
      );
      if (reply.status < 200 || reply.status >= 300) return { ok: false, message: statusMessage(reply.status, reply.json) };
      return { ok: true, message: `${reply.model} answered.` };
    } catch (err) {
      return { ok: false, message: egressMessage(err) };
    }
  }
}

function headersFor(settings: Pick<ProviderSettings, "api_key" | "headers">, json: boolean): Record<string, string> {
  return {
    ...settings.headers,
    authorization: `Bearer ${settings.api_key}`,
    accept: "application/json",
    "user-agent": "tabcrew-relay",
    ...(json && { "content-type": "application/json" }),
  };
}

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statusMessage(status: number, json: unknown): string {
  const error = (json as { error?: unknown } | null)?.error;
  const raw = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  const detail = typeof raw === "string" ? `: ${raw.replace(/\s+/g, " ").trim().slice(0, 200)}` : "";
  const hint = status === 401 || status === 403 ? " (check the API key and headers)" : status === 404 ? " (check the base URL)" : "";
  return `HTTP ${status}${detail}${hint}`;
}

function egressMessage(err: unknown): string {
  return err instanceof EgressError ? err.message : "the provider could not be reached";
}

/**
 * The relay's model transport for one browser tenant:
 * - the browser turned on its own provider (own_model) or predates account settings (no
 *   account_model feature) and the account has none: model_call to that browser, as in hub mode;
 * - otherwise the relay calls the account's provider.
 */
export function relayModelTransport(o: {
  readonly userId: string;
  readonly models: AccountModels;
  readonly bridge: ExtensionBridge;
  readonly settingsUrl: string;
}): ModelTransport {
  const viaBrowser = modelCallTransport(o.bridge);
  const where = `your TabCrew account (${o.settingsUrl})`;
  return {
    kind: "model_call",
    async exchange(request, timeoutMs) {
      const features = o.bridge.features;
      if (features.includes(V2_EXT_FEATURE_OWN_MODEL)) return viaBrowser.exchange(request, timeoutMs);
      const settings = await o.models.get(o.userId);
      if (!settings) {
        if (!features.includes(V2_EXT_FEATURE_ACCOUNT_MODEL)) return viaBrowser.exchange(request, timeoutMs);
        throw new DaemonError("model_error", `No model provider set: add a provider, API key and models in ${where}; no action executed.`);
      }
      const purpose = request.purpose as V2ModelPurpose | undefined;
      if (!purpose) throw new DaemonError("internal", "model request without a purpose");
      const model = modelFor(settings, purpose);
      if (!model) {
        if (purpose === "text_fallback") throw new DaemonError("model_not_configured", "no fallback text model");
        throw new DaemonError("model_error", `No ${purpose === "text" ? "text" : "decision"} model set: choose one in ${where}; no action executed.`);
      }
      const b = request.body as Partial<V2ModelCallBody>;
      const body = { messages: b.messages ?? [], max_tokens: b.max_tokens ?? 0, ...(b.response_format && { response_format: b.response_format }) } as V2ModelCallBody;
      let reply: ChatReply;
      try {
        reply = await o.models.chat(settings, model, body, timeoutMs);
      } catch (err) {
        throw new ModelUnavailableError(`Model provider unreachable (${egressMessage(err)}); no action executed.`);
      }
      return {
        status: reply.status,
        model: reply.model,
        async json() {
          if (reply.json === null || reply.json === undefined) throw new DaemonError("model_error", "Model provider returned invalid JSON; no action executed.");
          return reply.json;
        },
        async discard() {},
      };
    },
    statusHint(status, json) {
      const error = (json as { error?: unknown } | null)?.error;
      const raw = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
      const detail = typeof raw === "string" && raw.trim() ? ` (${raw.replace(/\s+/g, " ").trim().slice(0, 200)})` : "";
      const fix =
        status === 401 || status === 403 ? `; check the API key and headers in ${where}` : status === 404 ? `; check the base URL and model in ${where}` : "";
      return `${detail}${fix}`;
    },
  };
}
