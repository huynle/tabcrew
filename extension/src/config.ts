import {
  V2_EXTENSION_PORT,
  V2_HUB_EXTENSION_PORT,
  V2_PIN_SECRET_BYTES,
  v2IsPinSecret,
  type V2ConnectionMode,
  type V2SettingsPatch,
  type V2SettingsView,
} from "@tabcrew/shared/v2";

/** chrome.storage.local keys (user settings). */
export const TOKEN_KEY = "v2:token";
export const PORT_KEY = "v2:port";
/** Connection mode setting (`ModeSetting`); absent means "auto". */
export const MODE_KEY = "v2:mode";
/** Hub mode TOFU pin (`HubPin`); secret, never leaves the extension except to the hub on first pairing. */
export const HUB_PIN_KEY = "v2:hub_pin";
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

/**
 * How the extension connects: "auto" (default) is daemon mode when a daemon token is stored and hub
 * mode otherwise; "hub" / "daemon" force a mode (the popup's Connection override).
 */
export type ModeSetting = "auto" | "hub" | "daemon";
export type ConnectionMode = V2ConnectionMode;

export function parseModeSetting(value: unknown): ModeSetting {
  return value === "hub" || value === "daemon" ? value : "auto";
}

export function effectiveMode(setting: ModeSetting, token: string | null): ConnectionMode {
  if (setting !== "auto") return setting;
  return token ? "daemon" : "hub";
}

export async function saveModeSetting(setting: ModeSetting): Promise<void> {
  await chrome.storage.local.set({ [MODE_KEY]: parseModeSetting(setting) });
}

export function defaultPort(mode: ConnectionMode): number {
  return mode === "hub" ? V2_HUB_EXTENSION_PORT : V2_EXTENSION_PORT;
}

/**
 * Hub mode trust-on-first-use pin (`v2:hub_pin`). `confirmed` turns true once a hub answered
 * `welcome.pin = {state:"stored"}` for this secret; until then hellos hand the secret over
 * (`state:"new"`), afterwards they challenge the hub (`state:"pinned"`). Never shown or logged.
 */
export interface HubPin {
  readonly secret: string;
  readonly confirmed: boolean;
}

export function parseHubPin(value: unknown): HubPin | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { secret?: unknown; confirmed?: unknown };
  return v2IsPinSecret(v.secret) ? { secret: v.secret, confirmed: v.confirmed === true } : null;
}

/** `bytes` random bytes as lowercase hex (crypto.getRandomValues). */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadHubPin(): Promise<HubPin | null> {
  const stored = await chrome.storage.local.get(HUB_PIN_KEY);
  return parseHubPin(stored[HUB_PIN_KEY]);
}

async function storeFreshHubPin(): Promise<HubPin> {
  const pin: HubPin = { secret: randomHex(V2_PIN_SECRET_BYTES), confirmed: false };
  await chrome.storage.local.set({ [HUB_PIN_KEY]: pin });
  return pin;
}

let pinInFlight: Promise<HubPin> | null = null;

/** The stored hub pin, creating an unconfirmed one if there is none (one secret even when called concurrently). */
export function ensureHubPin(): Promise<HubPin> {
  if (!pinInFlight) {
    pinInFlight = (async () => (await loadHubPin()) ?? (await storeFreshHubPin()))().finally(() => {
      pinInFlight = null;
    });
  }
  return pinInFlight;
}

/** "Trust this hub": replace the pin with a fresh unconfirmed secret (the next hello sends `state:"new"`). */
export async function resetHubPin(): Promise<HubPin> {
  if (pinInFlight) await pinInFlight.catch(() => undefined);
  return storeFreshHubPin();
}

/** A hub stored `secret`: mark the pin confirmed if it is still the stored one. True if it changed. */
export async function confirmHubPin(secret: string): Promise<boolean> {
  const pin = await loadHubPin();
  if (!pin || pin.secret !== secret || pin.confirmed) return false;
  await chrome.storage.local.set({ [HUB_PIN_KEY]: { secret, confirmed: true } satisfies HubPin });
  return true;
}

export interface BridgeConfig {
  /** Daemon token. Never sent in hub mode. */
  readonly token: string | null;
  readonly port: number;
  /** Effective mode; absent means daemon mode. */
  readonly mode?: ConnectionMode;
  readonly modeSetting?: ModeSetting;
  /** Hub mode only: the TOFU pin (null until created). */
  readonly hubPin?: HubPin | null;
}

/** A valid port, or the default port of `mode` (daemon mode when not given). */
export function parsePort(value: unknown, mode: ConnectionMode = "daemon"): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536 ? n : defaultPort(mode);
}

export async function loadConfig(): Promise<Required<BridgeConfig>> {
  const stored = await chrome.storage.local.get([TOKEN_KEY, PORT_KEY, MODE_KEY, HUB_PIN_KEY]);
  const token = typeof stored[TOKEN_KEY] === "string" && stored[TOKEN_KEY].trim() ? stored[TOKEN_KEY].trim() : null;
  const modeSetting = parseModeSetting(stored[MODE_KEY]);
  const mode = effectiveMode(modeSetting, token);
  return { token, port: parsePort(stored[PORT_KEY], mode), mode, modeSetting, hubPin: parseHubPin(stored[HUB_PIN_KEY]) };
}

/**
 * Socket status of the bridge. `untrusted_hub`: hub mode, the hub failed the pin check or refused
 * ours (4403); no retries until the pin, mode or port changes.
 */
export type BridgeStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline" | "untrusted_hub";
/** Legacy popup status (daemon-mode vocabulary): the socket status, or `not_paired` when there is no token and pairing failed. */
export type PopupStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline" | "not_paired";
/** Hub-mode statuses for the popup. */
export type HubStatus = "connected" | "connecting" | "hub_not_running" | "untrusted_hub";
/** Full popup connection status: daemon-mode statuses plus the hub-mode ones. */
export type ConnectionStatus = PopupStatus | HubStatus;

/** The popup's connection status for `mode`, from the bridge status (or `not_paired`). */
export function connectionStatus(mode: ConnectionMode, status: BridgeStatus | "not_paired"): ConnectionStatus {
  if (mode === "hub" && status === "offline") return "hub_not_running";
  return status;
}

/** `ConnectionStatus` folded into the legacy `PopupStatus` (for popups that only know daemon mode). */
export function legacyPopupStatus(status: ConnectionStatus): PopupStatus {
  if (status === "hub_not_running") return "offline";
  if (status === "untrusted_hub") return "unauthorized";
  return status;
}

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
  | { type: "v2:settings_set"; patch: V2SettingsPatch }
  /**
   * Hub mode "Trust this hub": replace the TOFU pin with a fresh secret and reconnect handing it to
   * the hub (`state:"new"`). Answered with `PopupActionResult`.
   */
  | { type: "v2:trust_hub" };

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
  /** Daemon version; null for older services (0.4 and earlier), which do not announce it. */
  readonly version: string | null;
  /** The service answers popup settings requests. */
  readonly settings: boolean;
}

export interface PopupState {
  /** Legacy (daemon-mode vocabulary) status; hub statuses are folded in (see `legacyPopupStatus`). Prefer `connection`. */
  readonly status: PopupStatus;
  /** Full status incl. hub mode: connected | connecting | hub_not_running | untrusted_hub (hub), or the daemon statuses. */
  readonly connection?: ConnectionStatus;
  /** Effective connection mode. */
  readonly mode?: ConnectionMode;
  /** The stored mode setting (auto | hub | daemon). */
  readonly mode_setting?: ModeSetting;
  /** Hub mode: a hub has stored this extension's pin (the secret itself is never exposed). */
  readonly hub_pinned?: boolean;
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
