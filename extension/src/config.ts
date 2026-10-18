import { V2_EXTENSION_PORT, type V2SettingsPatch, type V2SettingsView } from "@tabcrew/shared/v2";

/** chrome.storage.local keys (user settings). */
export const TOKEN_KEY = "v2:token";
export const PORT_KEY = "v2:port";
/** Where new sessions open their tabs (see `Placement`); absent means "own_window". */
export const PLACEMENT_KEY = "v2:placement";

/** chrome.storage.session keys (rebuildable runtime state). */
export const SESSION_WINDOWS_KEY = "v2:sessionWindows";
export const GROUPS_KEY = "v2:groups";
export const TAB_SESSIONS_KEY = "v2:tabSessions";
/** short_ids the user stopped from the popup; pruned once their group is gone. */
export const STOPPED_KEY = "v2:stoppedSessions";
/** Groups of finished sessions handed to the user (groupId → label, time); pruned once the group is gone. */
export const RELEASED_KEY = "v2:releasedGroups";
/** Recently focused window ids, most recent first (picks where finished groups go). */
export const FOCUS_ORDER_KEY = "v2:windowFocusOrder";
/** short_id → placement decided at the session's first tab_create. */
export const PLACEMENTS_KEY = "v2:placements";

/**
 * - `own_window`: one unfocused window per session; the target tab is activated within it.
 * - `user_window`: a collapsed group in the user's window; tabs are never activated.
 */
export type Placement = "own_window" | "user_window";

export function parsePlacement(value: unknown): Placement {
  return value === "user_window" ? "user_window" : "own_window";
}

export async function loadPlacement(): Promise<Placement> {
  const stored = await chrome.storage.local.get(PLACEMENT_KEY);
  return parsePlacement(stored[PLACEMENT_KEY]);
}

export async function savePlacement(placement: Placement): Promise<void> {
  await chrome.storage.local.set({ [PLACEMENT_KEY]: parsePlacement(placement) });
}

export interface BridgeConfig {
  readonly token: string | null;
  readonly port: number;
}

export function parsePort(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536 ? n : V2_EXTENSION_PORT;
}

export async function loadConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get([TOKEN_KEY, PORT_KEY]);
  const token = typeof stored[TOKEN_KEY] === "string" && stored[TOKEN_KEY].trim() ? stored[TOKEN_KEY].trim() : null;
  return { token, port: parsePort(stored[PORT_KEY]) };
}

/** Status shown in the popup. */
export type BridgeStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline";
/** Popup status: the socket status, or `not_paired` when there is no token and pairing failed. */
export type PopupStatus = BridgeStatus | "not_paired";

/** Messages between the popup and the service worker (chrome.runtime.sendMessage). */
export type PopupRequest =
  | { type: "v2:get_state" }
  | { type: "v2:stop"; short_id: string | null }
  | { type: "v2:close_session_tabs"; short_id: string }
  | { type: "v2:show_session"; short_id: string }
  | { type: "v2:open_finished"; group_id: number }
  | { type: "v2:close_finished"; group_id: number }
  | { type: "v2:close_all_finished" }
  /** Daemon settings (relayed to the daemon; the extension never stores them). */
  | { type: "v2:settings_get" }
  | { type: "v2:settings_set"; patch: V2SettingsPatch };

export interface PopupSessionInfo {
  readonly short_id: string;
  readonly label: string;
  readonly tab_count: number;
  /** The user pressed Stop for this session (its tabs stay open until closed). */
  readonly stopped?: boolean;
}

/** A finished session's group, handed to the user. */
export interface PopupFinishedInfo {
  readonly group_id: number;
  readonly label: string;
  readonly tab_count: number;
}

/** The connected TabCrew service, from its `welcome`. */
export interface ServiceInfo {
  /** Daemon version; null for services before 0.5, which do not announce it. */
  readonly version: string | null;
  /** The service answers popup settings requests. */
  readonly settings: boolean;
}

export interface PopupState {
  readonly status: PopupStatus;
  readonly port: number;
  readonly token_set: boolean;
  /** Last pairing error (no token involved), when not paired. */
  readonly pairing_error?: string | null;
  readonly sessions: readonly PopupSessionInfo[];
  readonly finished: readonly PopupFinishedInfo[];
  /** Null while not connected (or before the service's welcome arrived). */
  readonly service?: ServiceInfo | null;
}

export type PopupStopResult = { ok: true } | { ok: false; error: string };
export type PopupCloseResult = { ok: true; closed_tabs: number } | { ok: false; error: string };
export type PopupActionResult = { ok: true } | { ok: false; error: string };
/** Daemon settings for the popup: keys are redacted by the daemon (source + last 4 characters). */
export type PopupSettingsResult =
  | { ok: true; settings: V2SettingsView; warnings: string[] }
  | { ok: false; error: string };
