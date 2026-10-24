/**
 * Hub mode model provider settings (`v2:provider` in chrome.storage.local). Entered in the popup;
 * read by the service worker's model_call proxy. The API key never leaves the extension except as
 * the `Authorization` header of requests to `base_url`.
 */

import type { V2ModelPurpose } from "@tabcrew/shared/v2";

export const PROVIDER_KEY = "v2:provider";

/** An OpenAI-compatible chat-completions provider. Model names may be empty (not set yet). */
export interface ProviderSettings {
  readonly kind: "openai-compatible";
  /** Normalized: https (or http://localhost|127.0.0.1), no trailing slash, query, hash or credentials. */
  readonly base_url: string;
  readonly api_key: string;
  /** Extra request headers, e.g. OpenAI-Organization. */
  readonly headers: Readonly<Record<string, string>>;
  readonly decision_model: string;
  readonly text_model: string;
  readonly fallback_text_model?: string;
}

export type PresetId = "openrouter" | "openai" | "anthropic" | "gemini" | "custom";

/** Models suggested for a preset: marked "(recommended)" and preselected when listed and unset. */
export interface ModelRecommendation {
  readonly decision_model: string;
  readonly text_model: string;
  readonly fallback_text_model?: string;
}

export interface ProviderPreset {
  readonly id: PresetId;
  readonly label: string;
  /** null for Custom. */
  readonly base_url: string | null;
  readonly recommended: ModelRecommendation | null;
}

/** Public providers with an OpenAI-compatible chat-completions API. Self-hosted gateways
 * (OmniRoute, LiteLLM, Ollama, ...) use Custom with their own base URL. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // The daemon's defaults (DEFAULT_JEV_MODEL / DEFAULT_TEXT_MODEL).
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    recommended: { decision_model: "typesafe/jev-1.13", text_model: "inception/mercury-2.5" },
  },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", recommended: null },
  { id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com/v1", recommended: null },
  { id: "gemini", label: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", recommended: null },
  { id: "custom", label: "Custom (OmniRoute, LiteLLM, Ollama, ...)", base_url: null, recommended: null },
];

/** The preset whose base URL this is (trailing slashes ignored), else "custom". */
export function presetFor(baseUrl: string): PresetId {
  const url = baseUrl.trim().replace(/\/+$/, "");
  return PROVIDER_PRESETS.find((p) => p.base_url !== null && p.base_url === url)?.id ?? "custom";
}

/** The recommended models for this base URL's preset (null for a custom provider). */
export function recommendedModels(baseUrl: string): ModelRecommendation | null {
  const id = presetFor(baseUrl);
  return PROVIDER_PRESETS.find((p) => p.id === id)?.recommended ?? null;
}

export type BaseUrlResult = { ok: true; url: string; origin: string } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Validate and normalize a provider base URL. */
export function normalizeBaseUrl(raw: string): BaseUrlResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter the provider's base URL." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "Enter a valid URL, e.g. https://api.example.com/v1." };
  }
  if (url.protocol === "http:") {
    if (!LOCAL_HOSTS.has(url.hostname)) return { ok: false, error: "Use an https:// URL (http:// only for localhost)." };
  } else if (url.protocol !== "https:") {
    return { ok: false, error: "Use an https:// URL (http:// only for localhost)." };
  }
  if (url.username || url.password) return { ok: false, error: "The URL must not contain a user name or password." };
  if (url.search || url.hash || text.includes("?") || text.includes("#")) return { ok: false, error: "The URL must not contain ? or #." };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}`, origin: url.origin };
}

/** The `chrome.permissions` origin pattern for an origin. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

/** Headers TabCrew sets itself (or the browser controls); lower case. */
const RESERVED_HEADERS = new Set(["authorization", "host", "cookie", "content-length", "origin", "content-type"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 4096;

/** null if the custom headers are acceptable, else a message for the user. */
export function validateHeaders(headers: Readonly<Record<string, unknown>>): string | null {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) return `At most ${MAX_HEADERS} custom headers.`;
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return `"${name}" is an invalid header name.`;
    if (RESERVED_HEADERS.has(name.toLowerCase())) return `Header "${name}" is set by TabCrew and can't be overridden.`;
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) return `Header "${name}" has an invalid value (line breaks are not allowed).`;
    if (value.length > MAX_HEADER_VALUE) return `Header "${name}" is too long.`;
  }
  return null;
}

function modelName(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 200 || /[\r\n\0]/.test(value)) return null;
  return value.trim();
}

/** Settings that pass every check (rebuilt from the known fields), or null. */
export function parseProviderSettings(value: unknown): ProviderSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "openai-compatible" || typeof v.base_url !== "string") return null;
  const base = normalizeBaseUrl(v.base_url);
  if (!base.ok) return null;
  if (typeof v.api_key !== "string" || !v.api_key.trim() || /[\r\n\0]/.test(v.api_key)) return null;
  const headers = v.headers ?? {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  if (validateHeaders(headers as Record<string, unknown>) !== null) return null;
  const decision = modelName(v.decision_model);
  const text = modelName(v.text_model);
  const fallback = modelName(v.fallback_text_model);
  if (decision === null || text === null || fallback === null) return null;
  return {
    kind: "openai-compatible",
    base_url: base.url,
    api_key: v.api_key.trim(),
    headers: { ...(headers as Record<string, string>) },
    decision_model: decision,
    text_model: text,
    ...(fallback ? { fallback_text_model: fallback } : {}),
  };
}

/** The configured model for a model_call purpose, or null when not set. */
export function modelFor(settings: ProviderSettings, purpose: V2ModelPurpose): string | null {
  const name =
    purpose === "chat_decision" ? settings.decision_model : purpose === "text" ? settings.text_model : settings.fallback_text_model;
  return name ? name : null;
}

/** The last 4 characters of a key (empty for keys too short to hint safely). */
export function keyHint(key: string): string {
  return key.length >= 8 ? key.slice(-4) : "";
}

export async function loadProviderSettings(): Promise<ProviderSettings | null> {
  const stored = await chrome.storage.local.get(PROVIDER_KEY);
  return parseProviderSettings(stored[PROVIDER_KEY]);
}

/** Store settings after validating them (throws with a user-facing message if invalid). */
export async function saveProviderSettings(settings: ProviderSettings): Promise<void> {
  const base = normalizeBaseUrl(settings.base_url);
  if (!base.ok) throw new Error(base.error);
  const headersError = validateHeaders(settings.headers);
  if (headersError) throw new Error(headersError);
  const parsed = parseProviderSettings(settings);
  if (!parsed) throw new Error("Invalid model provider settings.");
  await chrome.storage.local.set({ [PROVIDER_KEY]: parsed });
}

export async function clearProviderSettings(): Promise<void> {
  await chrome.storage.local.remove(PROVIDER_KEY);
}
