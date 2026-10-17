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

/** The "install the local service" box, shown whenever the popup is not connected to the daemon. */
export function setupHint(state: PopupState): SetupHint | null {
  if (state.status === "connected") return null;
  const missing = state.status === "not_paired" || state.status === "needs_token" || !state.token_set;
  return {
    text: missing
      ? "TabCrew needs its local service. In a terminal run:"
      : "Can't reach the TabCrew service. If it isn't installed, run:",
    command: SETUP_COMMAND,
    detail: state.status === "not_paired" ? (state.pairing_error ?? null) : null,
  };
}
