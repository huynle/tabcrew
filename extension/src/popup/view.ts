import type { V2KeyView, V2ValueView } from "@tabcrew/shared/v2";
import type { PopupFinishedInfo, PopupSessionInfo, PopupState } from "../config.js";

export interface SessionRow {
  readonly short_id: string;
  /** `<label> · <short_id>` */
  readonly name: string;
  /** e.g. "2 tabs" or "2 tabs · stopped" */
  readonly meta: string;
  readonly stopped: boolean;
  readonly action: "stop" | "close_tabs" | null;
}

export interface FinishedRow {
  readonly group_id: number;
  /** `✓ <label>` */
  readonly name: string;
  /** e.g. "2 tabs" */
  readonly meta: string;
}

function tabCount(n: number): string {
  return `${n} tab${n === 1 ? "" : "s"}`;
}

export function finishedRows(finished: readonly PopupFinishedInfo[]): FinishedRow[] {
  return finished.map((f) => ({ group_id: f.group_id, name: `✓ ${f.label}`, meta: tabCount(f.tab_count) }));
}

export function sessionRows(sessions: readonly PopupSessionInfo[]): SessionRow[] {
  return sessions.map((s) => {
    const stopped = s.stopped === true;
    const tabs = tabCount(s.tab_count);
    return {
      short_id: s.short_id,
      name: `${s.label} · ${s.short_id}`,
      meta: stopped ? `${tabs} · stopped` : tabs,
      stopped,
      action: stopped ? (s.tab_count > 0 ? "close_tabs" : null) : "stop",
    };
  });
}

export const SETUP_COMMAND = "npx tabcrew setup";
/** `@latest` so npx does not reuse a cached old version. */
export const UPDATE_COMMAND = "npx tabcrew@latest setup";

export interface KeyStatus {
  readonly text: string;
  /** Set in the daemon's environment: cannot be changed from the popup. */
  readonly locked: boolean;
  readonly removable: boolean;
  /** Show as a problem (a required key is missing). */
  readonly warn: boolean;
}

/** Status line for an API key. Only the daemon's redacted view (last 4 characters) is shown. */
export function keyStatus(key: V2KeyView & { check?: "valid" | "unreachable" | null }, required: boolean): KeyStatus {
  const tail = key.hint ? ` …${key.hint}` : "";
  switch (key.source) {
    case "env":
      return { text: `Set by environment${tail} (read-only)`, locked: true, removable: false, warn: false };
    case "file": {
      const unverified = key.check === "unreachable" ? " (not verified: OpenRouter was unreachable)" : "";
      return { text: `Set${tail}${unverified}`, locked: false, removable: true, warn: false };
    }
    default:
      return required
        ? { text: "Not set — browse disabled", locked: false, removable: false, warn: true }
        : { text: "Not set (uses the OpenRouter key)", locked: false, removable: false, warn: false };
  }
}

export interface ModelFieldState {
  /** Input value: empty means "use the default" (shown as the placeholder). */
  readonly value: string;
  readonly placeholder: string;
  readonly locked: boolean;
  readonly note: string;
}

export function modelField(setting: V2ValueView, defaultLabel?: string): ModelFieldState {
  const placeholder = setting.default ?? defaultLabel ?? "";
  if (setting.source === "env") {
    return { value: setting.value ?? "", placeholder, locked: true, note: "Set by environment (read-only)" };
  }
  return { value: setting.source === "file" ? (setting.value ?? "") : "", placeholder, locked: false, note: "" };
}

/**
 * What to send for one text setting: undefined (no change), the trimmed value, or null (back to the
 * default). An env-locked setting never changes.
 */
export function settingPatch(input: string, current: V2ValueView): string | null | undefined {
  if (current.source === "env") return undefined;
  const value = input.trim();
  if (!value) return current.source === "file" ? null : undefined;
  return current.source === "file" && value === current.value ? undefined : value;
}

export interface SetupHint {
  readonly text: string;
  readonly command: string;
  /** Extra detail, e.g. the pairing error. */
  readonly detail: string | null;
}

/**
 * The "install the local service" box, shown whenever the popup is not connected to the daemon, or
 * the "update it" box when the connected service is too old for popup settings.
 */
export function setupHint(state: PopupState): SetupHint | null {
  if (state.status === "connected") {
    if (settingsAccess(state) !== "outdated") return null;
    return {
      text: "Your TabCrew service is out of date. Update it to manage keys and models here:",
      command: UPDATE_COMMAND,
      detail: null,
    };
  }
  const missing = state.status === "not_paired" || state.status === "needs_token" || !state.token_set;
  return {
    text: missing
      ? "TabCrew needs its local service. In a terminal run:"
      : "Can't reach the TabCrew service. If it isn't installed, run:",
    command: SETUP_COMMAND,
    detail: state.status === "not_paired" ? (state.pairing_error ?? null) : null,
  };
}

/**
 * Whether the popup can use the daemon settings: `waiting` while connected but the service's
 * welcome is not known yet (settings are not requested then), `outdated` for a service without them.
 */
export type SettingsAccess = "ready" | "outdated" | "waiting" | "offline";

export function settingsAccess(state: PopupState): SettingsAccess {
  if (state.status !== "connected") return "offline";
  if (!state.service) return "waiting";
  return state.service.settings ? "ready" : "outdated";
}

export interface RemoveKeyPrompt {
  readonly confirmLabel: string;
  readonly warning: string;
}

/** Second-click confirmation shown before a key is removed. */
export function removeKeyPrompt(field: "openrouter_api_key" | "text_model_api_key"): RemoveKeyPrompt {
  const what =
    field === "openrouter_api_key"
      ? "Remove your OpenRouter key? browse will stop working."
      : "Remove the override key? The text model will use the OpenRouter key.";
  return { confirmLabel: "Confirm remove", warning: `${what} Click Confirm remove to continue.` };
}
