import { ONLINE_KEY, parseOnlineAccount, signedIn } from "./online.js";
import {
  V2_DEFAULT_GROUP_NAME,
  V2_EXTENSION_PORT,
  V2_HUB_EXTENSION_PORT,
  V2_PIN_SECRET_BYTES,
  v2IsFinishMode,
  v2IsPinSecret,
  v2NormaliseGroupName,
  type V2ConnectionMode,
  type V2FinishMode,
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
/** "Pause agents": while true every agent request and model call is refused, in every mode. */
export const PAUSED_KEY = "v2:agents_paused";
/**
 * Online mode: the relay URL and browser name as typed in the popup, saved as they are typed: the
 * popup closes when the sign-in window opens, so nothing may live only in the popup.
 */
export const ONLINE_PREFS_KEY = "v2:online_prefs";
/** Where new sessions open their tabs (see `Placement`); absent means "shared_window". */
export const PLACEMENT_KEY = "v2:placement";
/** Name of the default shared TabCrew group (`parseGroupName`); absent means "TabCrew". */
export const GROUP_NAME_KEY = "v2:group_name";
/** What happens to a finished session's tabs by default (`V2FinishMode`); absent means "keep". */
export const FINISH_MODE_KEY = "v2:finish_mode";

/*
 * chrome.storage.local keys (shared groups ownership; wiped on browser startup because tab,
 * group and window ids do not survive a Chrome restart). Parse with `parseOwnership`.
 */
/** tab id → short_id of the session that owns the tab (`TabOwners`). */
export const TAB_OWNERS_KEY = "v2:tabOwners";
/** short_id → id of the TabCrew group the session's tabs live in (`SessionGroups`). */
export const SESSION_GROUPS_KEY = "v2:sessionGroups";
/** group id → TabCrew-managed group (`ManagedGroups`); any group not listed belongs to the user. */
export const MANAGED_GROUPS_KEY = "v2:managedGroups";
/** Id of the one TabCrew window (`parseTabcrewWindow`), or absent. */
export const TABCREW_WINDOW_KEY = "v2:tabcrewWindow";
export const OWNERSHIP_KEYS = [TAB_OWNERS_KEY, SESSION_GROUPS_KEY, MANAGED_GROUPS_KEY, TABCREW_WINDOW_KEY] as const;

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
 * - `shared_window` (default): every session gets its own tab(s) inside a shared TabCrew group
 *   in the one TabCrew window (see `GROUP_NAME_KEY`).
 * - `own_window`: one unfocused window per session; the target tab is activated within it.
 * - `user_window`: a collapsed group in the user's window; tabs are never activated.
 */
export type Placement = "shared_window" | "own_window" | "user_window";

export function parsePlacement(value: unknown): Placement {
  return value === "own_window" || value === "user_window" ? value : "shared_window";
}

export async function loadPlacement(): Promise<Placement> {
  const stored = await chrome.storage.local.get(PLACEMENT_KEY);
  return parsePlacement(stored[PLACEMENT_KEY]);
}

export async function savePlacement(placement: Placement): Promise<void> {
  await chrome.storage.local.set({ [PLACEMENT_KEY]: parsePlacement(placement) });
}

/** The stored default group name, normalised (`v2NormaliseGroupName`); "TabCrew" when unset or invalid. */
export function parseGroupName(value: unknown): string {
  return v2NormaliseGroupName(value) ?? V2_DEFAULT_GROUP_NAME;
}

export async function loadGroupName(): Promise<string> {
  const stored = await chrome.storage.local.get(GROUP_NAME_KEY);
  return parseGroupName(stored[GROUP_NAME_KEY]);
}

/** Store the normalised name and return it; an invalid name is not stored (null). */
export async function saveGroupName(name: string): Promise<string | null> {
  const normalised = v2NormaliseGroupName(name);
  if (normalised === null) return null;
  await chrome.storage.local.set({ [GROUP_NAME_KEY]: normalised });
  return normalised;
}

/** The stored default finish mode; "keep" when unset or invalid. */
export function parseFinishMode(value: unknown): V2FinishMode {
  return v2IsFinishMode(value) ? value : "keep";
}

export async function loadFinishMode(): Promise<V2FinishMode> {
  const stored = await chrome.storage.local.get(FINISH_MODE_KEY);
  return parseFinishMode(stored[FINISH_MODE_KEY]);
}

export async function saveFinishMode(mode: V2FinishMode): Promise<void> {
  await chrome.storage.local.set({ [FINISH_MODE_KEY]: parseFinishMode(mode) });
}

// ---------------------------------------------------------------------------
// Shared groups ownership shapes (chrome.storage.local). Keys of id maps are the decimal ids as
// strings (JSON object keys). Parsers drop malformed entries rather than failing.
// ---------------------------------------------------------------------------

/** tab id → short_id. */
export type TabOwners = Record<string, string>;
/** short_id → group id. */
export type SessionGroups = Record<string, number>;
/** `shared`: a named TabCrew group; `collect`: the "✓ <name>" group; `session`: a per-session group (own_window / user_window). */
export type ManagedGroupKind = "shared" | "collect" | "session";
export interface ManagedGroup {
  /** Last known title (the group is tracked by id, so a rename in Chrome is safe). */
  readonly name: string;
  readonly windowId: number;
  readonly kind: ManagedGroupKind;
}
/** group id → managed group. */
export type ManagedGroups = Record<string, ManagedGroup>;

export interface OwnershipState {
  readonly tabOwners: TabOwners;
  readonly sessionGroups: SessionGroups;
  readonly managedGroups: ManagedGroups;
  readonly tabcrewWindow: number | null;
}

const MAX_SHORT_ID_LENGTH = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIdKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key);
}

function isShortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SHORT_ID_LENGTH;
}

const MANAGED_GROUP_KINDS: readonly string[] = ["shared", "collect", "session"] satisfies ManagedGroupKind[];

export function parseTabOwners(value: unknown): TabOwners {
  const out: TabOwners = {};
  if (!isPlainRecord(value)) return out;
  for (const [key, owner] of Object.entries(value)) if (isIdKey(key) && isShortId(owner)) out[key] = owner;
  return out;
}

export function parseSessionGroups(value: unknown): SessionGroups {
  const out: SessionGroups = {};
  if (!isPlainRecord(value)) return out;
  for (const [key, groupId] of Object.entries(value)) if (isShortId(key) && isId(groupId)) out[key] = groupId;
  return out;
}

export function parseManagedGroups(value: unknown): ManagedGroups {
  const out: ManagedGroups = {};
  if (!isPlainRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (!isIdKey(key) || !isPlainRecord(entry)) continue;
    const { name, windowId, kind } = entry;
    if (typeof name !== "string" || !name || !isId(windowId)) continue;
    if (typeof kind !== "string" || !MANAGED_GROUP_KINDS.includes(kind)) continue;
    out[key] = { name, windowId, kind: kind as ManagedGroupKind };
  }
  return out;
}

export function parseTabcrewWindow(value: unknown): number | null {
  return isId(value) ? value : null;
}

/** All ownership state from one `chrome.storage.local.get(OWNERSHIP_KEYS)` result. */
export function parseOwnership(stored: Record<string, unknown>): OwnershipState {
  return {
    tabOwners: parseTabOwners(stored[TAB_OWNERS_KEY]),
    sessionGroups: parseSessionGroups(stored[SESSION_GROUPS_KEY]),
    managedGroups: parseManagedGroups(stored[MANAGED_GROUPS_KEY]),
    tabcrewWindow: parseTabcrewWindow(stored[TABCREW_WINDOW_KEY]),
  };
}

/**
 * How the extension connects: "auto" (default) is daemon mode when a daemon token is stored, else
 * online mode when signed in to a relay, else hub mode; "hub" / "daemon" / "online" force a mode
 * (the popup's Connection override). A local setup comes first so pages never start going to a
 * relay without the user choosing it.
 */
export type ModeSetting = "auto" | "hub" | "daemon" | "online";
/** "online": the TabCrew Online relay (see online.ts); the others as in shared/v2. */
export type ConnectionMode = V2ConnectionMode | "online";

export function parseModeSetting(value: unknown): ModeSetting {
  return value === "hub" || value === "daemon" || value === "online" ? value : "auto";
}

export function effectiveMode(setting: ModeSetting, token: string | null, signedInOnline = false): ConnectionMode {
  if (setting !== "auto") return setting;
  if (token) return "daemon";
  return signedInOnline ? "online" : "hub";
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
  /** Online mode only: the relay socket URL and a fresh access token (null when signed out). */
  readonly online?: { readonly url: string; readonly accessToken: string; readonly ownModel?: boolean } | null;
}

/**
 * Online mode: "Use this browser's own provider" (popup). Off: the relay calls the provider set in
 * the TabCrew account; on: this extension answers model_call with the popup's Model provider.
 */
export const OWN_MODEL_KEY = "v2:onlineOwnModel";

export async function loadOwnModel(): Promise<boolean> {
  return (await chrome.storage.local.get(OWN_MODEL_KEY))[OWN_MODEL_KEY] === true;
}

/** A valid port, or the default port of `mode` (daemon mode when not given). */
export function parsePort(value: unknown, mode: ConnectionMode = "daemon"): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536 ? n : defaultPort(mode);
}

export async function loadConfig(): Promise<Required<BridgeConfig>> {
  const stored = await chrome.storage.local.get([TOKEN_KEY, PORT_KEY, MODE_KEY, HUB_PIN_KEY, ONLINE_KEY]);
  const token = typeof stored[TOKEN_KEY] === "string" && stored[TOKEN_KEY].trim() ? stored[TOKEN_KEY].trim() : null;
  const modeSetting = parseModeSetting(stored[MODE_KEY]);
  const mode = effectiveMode(modeSetting, token, signedIn(parseOnlineAccount(stored[ONLINE_KEY])));
  // The access token is filled in by the service worker (it may need a refresh first).
  return { token, port: parsePort(stored[PORT_KEY], mode), mode, modeSetting, hubPin: parseHubPin(stored[HUB_PIN_KEY]), online: null };
}

/**
 * Socket status of the bridge. `untrusted_hub`: hub mode, the hub failed the pin check or refused
 * ours (4403); no retries until the pin, mode or port changes.
 */
export type BridgeStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline" | "untrusted_hub" | "signed_out";
/** Legacy popup status (daemon-mode vocabulary): the socket status, or `not_paired` when there is no token and pairing failed. */
export type PopupStatus = "connected" | "connecting" | "needs_token" | "unauthorized" | "offline" | "not_paired";
/** Hub-mode statuses for the popup. */
export type HubStatus = "connected" | "connecting" | "hub_not_running" | "untrusted_hub";
/** Online-mode statuses for the popup. */
export type OnlineStatus = "connected" | "connecting" | "relay_offline" | "signed_out";
/** Full popup connection status: daemon-mode statuses plus the hub- and online-mode ones. */
export type ConnectionStatus = PopupStatus | HubStatus | OnlineStatus;

/** The popup's connection status for `mode`, from the bridge status (or `not_paired`). */
export function connectionStatus(mode: ConnectionMode, status: BridgeStatus | "not_paired"): ConnectionStatus {
  if (mode === "hub" && status === "offline") return "hub_not_running";
  if (mode === "online") {
    if (status === "offline") return "relay_offline";
    // A refused token is refreshed by the service worker; it signs out only if that fails.
    if (status === "unauthorized") return "connecting";
    if (status === "signed_out" || status === "connected" || status === "connecting") return status;
    return "relay_offline";
  }
  if (status === "signed_out") return "offline";
  return status;
}

/** `ConnectionStatus` folded into the legacy `PopupStatus` (for popups that only know daemon mode). */
export function legacyPopupStatus(status: ConnectionStatus): PopupStatus {
  if (status === "hub_not_running" || status === "relay_offline") return "offline";
  if (status === "untrusted_hub") return "unauthorized";
  if (status === "signed_out") return "needs_token";
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
  | { type: "v2:trust_hub" }
  /**
   * Shared groups (answered with `PopupActionResult`): rename a TabCrew-managed group by id,
   * create a named TabCrew group, set the default group name, set the default finish mode.
   * Names go through `v2NormaliseGroupName`; user groups are never renamed.
   */
  | { type: "v2:rename_group"; group_id: number; name: string }
  | { type: "v2:create_group"; name: string }
  | { type: "v2:set_group_name"; name: string }
  | { type: "v2:set_finish_mode"; mode: V2FinishMode }
  /** Online mode: sign in (launchWebAuthFlow from this user click), sign out. Answered with `PopupActionResult`. */
  | { type: "v2:online_sign_in"; relay_url: string; browser_name: string }
  | { type: "v2:online_sign_out" }
  /** The relay URL and browser name as typed (validated at sign-in). */
  | { type: "v2:online_prefs"; relay_url: string; browser_name: string }
  /** Pause agents in this browser (every mode). Answered with `PopupActionResult`. */
  | { type: "v2:set_paused"; paused: boolean };

/** A TabCrew-managed group, as the popup lists it. */
export interface PopupGroupInfo {
  readonly group_id: number;
  readonly name: string;
  /** Sessions with tabs in this group. */
  readonly active_sessions: number;
  /** Tabs of finished sessions kept in this group (finish mode `keep`). */
  readonly finished_tabs: number;
  /** This is the default group (named after `GROUP_NAME_KEY`). */
  readonly is_default: boolean;
}

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
  /** Shared groups: the TabCrew-managed groups (missing: an extension without shared groups). */
  readonly groups?: readonly PopupGroupInfo[];
  /** Shared groups: the default group name setting. */
  readonly group_name?: string;
  /** Shared groups: the default finish mode setting. */
  readonly finish_mode?: V2FinishMode;
  /** Online mode account (never the tokens). */
  readonly online?: {
    readonly relay_url: string;
    readonly browser_name: string;
    readonly signed_in: boolean;
    /** Why the last sign-in failed (shown when the popup reopens); null after a success. */
    readonly error?: string | null;
  };
  /** Agents are paused in this browser. */
  readonly paused?: boolean;
}

export type PopupStopResult = { ok: true } | { ok: false; error: string };
export type PopupCloseResult = { ok: true; closed_tabs: number } | { ok: false; error: string };
export type PopupActionResult = { ok: true } | { ok: false; error: string };
/** Daemon settings for the popup: keys are redacted by the daemon (source + last 4 characters). */
export type PopupSettingsResult =
  | { ok: true; settings: V2SettingsView; warnings: string[] }
  | { ok: false; error: string };
