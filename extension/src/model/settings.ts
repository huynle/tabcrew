/**
 * Hub mode model provider settings (`v2:provider` in chrome.storage.local). Entered in the popup;
 * read by the service worker's model_call proxy. The API key never leaves the extension except as
 * the `Authorization` header of requests to `base_url`.
 */


export const PROVIDER_KEY = "v2:provider";

export * from "@tabcrew/shared/provider";
import { normalizeBaseUrl, parseProviderSettings, validateHeaders, type ProviderSettings } from "@tabcrew/shared/provider";

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
