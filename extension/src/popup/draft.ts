/**
 * The model provider form's unsaved draft, kept in chrome.storage.session (in memory, extension
 * pages only, gone when the browser restarts; never chrome.storage.local or sync). Chrome closes
 * the popup when it shows the host-permission prompt, so the form is written here on every input
 * and restored when the popup reopens. Cleared on Save and Remove.
 */
import { PROVIDER_PRESETS, normalizeBaseUrl, type ProviderSettings } from "../model/settings.js";
import { providerFormFrom, type HeaderRow, type ProviderForm } from "./view.js";

export const DRAFT_KEY = "v2:provider_draft";

/** The hint shown when a draft was put back into the form. */
export const DRAFT_RESTORED = "Unsaved changes restored.";

const STRING_FIELDS = ["base_url", "api_key", "decision_model", "text_model", "fallback_text_model"] as const;

function isHeaderRow(value: unknown): value is HeaderRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.name === "string" && typeof row.value === "string";
}

export function parseProviderDraft(value: unknown): ProviderForm | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!PROVIDER_PRESETS.some((p) => p.id === v.preset)) return null;
  if (!STRING_FIELDS.every((k) => typeof v[k] === "string")) return null;
  if (!Array.isArray(v.headers) || !v.headers.every(isHeaderRow)) return null;
  return {
    preset: v.preset as ProviderForm["preset"],
    base_url: v.base_url as string,
    api_key: v.api_key as string,
    headers: v.headers.map((h: HeaderRow) => ({ name: h.name, value: h.value })),
    decision_model: v.decision_model as string,
    text_model: v.text_model as string,
    fallback_text_model: v.fallback_text_model as string,
  };
}

function comparable(form: ProviderForm) {
  const base = normalizeBaseUrl(form.base_url);
  return JSON.stringify([
    form.preset,
    base.ok ? base.url : form.base_url.trim(),
    form.headers.map((h) => [h.name.trim(), h.value.trim()]).filter(([name, value]) => name || value),
    form.decision_model.trim(),
    form.text_model.trim(),
    form.fallback_text_model.trim(),
  ]);
}

/** True if the draft holds something the saved settings (or the empty form) don't. */
export function draftDiffers(draft: ProviderForm, saved: ProviderSettings | null): boolean {
  const key = draft.api_key.trim();
  if (key && key !== saved?.api_key) return true;
  return comparable(draft) !== comparable(providerFormFrom(saved));
}

export async function loadProviderDraft(): Promise<ProviderForm | null> {
  const stored = await chrome.storage.session.get(DRAFT_KEY);
  return parseProviderDraft(stored[DRAFT_KEY]);
}

/** Starts the write in the calling turn (not after an await), so a popup closing next keeps it. */
export function saveProviderDraft(form: ProviderForm): Promise<void> {
  return chrome.storage.session.set({ [DRAFT_KEY]: form });
}

export function clearProviderDraft(): Promise<void> {
  return chrome.storage.session.remove(DRAFT_KEY);
}
