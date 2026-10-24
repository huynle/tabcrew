/**
 * TabCrew wire protocol (v2) between the daemon and the extension.
 *
 * Transport: one WebSocket (JSON text frames) from the extension to the daemon at
 * ws://127.0.0.1:{V2_EXTENSION_PORT}. The extension connects out and must send a
 * `hello` with the shared token as its first frame. The daemon owns sessions and
 * policy; the extension only observes and acts on tabs inside a session's group.
 * See docs/plans/2026-10-11-v2-sessions-jev-design.md.
 *
 * Hub mode (no launchd daemon, no token, no native messaging): the same daemon code runs as a
 * "hub" listening on {V2_HUB_EXTENSION_PORT}. The extension's `hello` then carries `mode: "hub"`
 * and a trust-on-first-use `pin` instead of a token, and the hub may proxy model calls through the
 * extension (`model_call` / `model_result`) so the provider key never leaves the browser.
 */

export const V2_PROTOCOL_VERSION = 2;
export const V2_MCP_PORT = 8770;
export const V2_EXTENSION_PORT = 8771;
/** Default extension WebSocket port of a hub (8771 is often taken, e.g. by ewp-mcp). */
export const V2_HUB_EXTENSION_PORT = 8775;

/** Close code: bad or missing hello (wrong protocol, bad daemon-mode token, timeout, non-hello first frame). */
export const V2_CLOSE_BAD_HELLO = 4401;
/** Close code, hub mode: the TOFU pin does not match (pinned to another secret, unknown pin, or a failed proof). */
export const V2_CLOSE_PIN_MISMATCH = 4403;
/** Close code: a newer extension connection replaced this one. */
export const V2_CLOSE_REPLACED = 4409;

/** Typed error codes returned to agents (design §4). */
export const V2_ERROR_CODES = [
  "bad_session",
  "tab_not_owned",
  "tab_gone",
  "stale_page",
  "target_covered",
  "target_invalid",
  "stopped_by_user",
  "extension_offline",
  "model_error",
  /** Hub mode: the extension has no model provider configured (set one in the TabCrew popup). */
  "model_not_configured",
  "outcome_unknown",
  "invalid_args",
  "unauthorized",
  "internal",
] as const;
export type V2ErrorCode = (typeof V2_ERROR_CODES)[number];

export interface V2Error {
  readonly code: V2ErrorCode;
  /** One-line hint for the agent. Never a stack trace. */
  readonly message: string;
}

/** Session identity as the extension sees it. The full handle never leaves the daemon. */
export interface V2SessionRef {
  /** Random 8-char id assigned by the daemon, independent of the secret handle. */
  readonly short_id: string;
  /** Human label shown in the tab group title as `<label> · <short_id>`. */
  readonly label: string;
  /**
   * Shared tab groups: the TabCrew group the session asked to join (`session_open({group})`),
   * already normalised by `v2NormaliseGroupName`. Missing: the user's default group name.
   * Older daemons never send it; older extensions ignore it.
   */
  readonly group?: string;
  /**
   * `session_open({foreground: true})`: page ops make the session's tab the active tab of its
   * window (faster: Chrome throttles background tabs). Missing: the tabs stay in the background
   * and never take over the user's view. Older extensions ignore it (they always activate).
   */
  readonly foreground?: true;
}

// ---------------------------------------------------------------------------
// Shared tab groups: every session's tabs live in a TabCrew-managed group (default "TabCrew") in
// one TabCrew window. Ownership is tracked per tab by the extension, not by the group title.
// ---------------------------------------------------------------------------

/**
 * What happens to a session's tabs when it finishes (`session_release.args.tabs`):
 * - `keep`: the tabs stay in their TabCrew group, marked finished (no longer owned by any agent).
 * - `close`: the tabs are closed.
 * - `collect`: the tabs move into one collapsed `v2CollectGroupTitle()` group in the TabCrew window.
 */
export const V2_FINISH_MODES = ["keep", "close", "collect"] as const;
export type V2FinishMode = (typeof V2_FINISH_MODES)[number];

export function v2IsFinishMode(value: unknown): value is V2FinishMode {
  return typeof value === "string" && (V2_FINISH_MODES as readonly string[]).includes(value);
}

/** Extension feature (in `hello.features`): it understands shared groups (`group`, finish modes, group ops). */
export const V2_EXT_FEATURE_GROUPS = "groups";
/** The default name of the shared TabCrew group (the user can change it in the popup). */
export const V2_DEFAULT_GROUP_NAME = "TabCrew";
/** Longest group name, in characters (code points), after normalising. */
export const V2_GROUP_NAME_MAX_LENGTH = 40;
/** Prefix of finished-session group titles (`v2ReleasedGroupTitle`, `v2CollectGroupTitle`); reserved. */
const FINISHED_PREFIX = "✓ ";
const CONTROL_CHARS_RE = /\p{Cc}/u;

/**
 * A valid TabCrew group name, or null. Trims and collapses whitespace runs (tabs/newlines
 * included) to one space; then rejects empty names, names longer than V2_GROUP_NAME_MAX_LENGTH
 * characters, names with other control characters, names starting with "✓ " (reserved for
 * finished groups) and names that parse as a legacy per-session title (`<label> · <8 chars>`).
 */
export function v2NormaliseGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || [...name].length > V2_GROUP_NAME_MAX_LENGTH) return null;
  if (CONTROL_CHARS_RE.test(name) || name.startsWith(FINISHED_PREFIX)) return null;
  return v2ParseGroupTitle(name) ? null : name;
}

/** Title of the `collect` group: `✓ <name>` (`✓ TabCrew` when the name is missing or invalid). */
export function v2CollectGroupTitle(name?: string): string {
  return `${FINISHED_PREFIX}${v2NormaliseGroupName(name) ?? V2_DEFAULT_GROUP_NAME}`;
}

export interface V2TabInfo {
  readonly tab_id: number;
  readonly url: string;
  readonly title: string;
  /** Tab that opened this one (pop-ups / target=_blank), if any. */
  readonly opener_tab_id?: number;
}

// ---------------------------------------------------------------------------
// Page observation (phase 4). Mirrors jev-ultrafast snapshot.js semantics.
// ---------------------------------------------------------------------------

export type V2ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

/**
 * One executable action. Element actions share `node` (an opaque per-document integer that
 * refers to a live DOM node held by the extension); one node may yield several actions
 * (e.g. "fill" + "Open <label>" click, or one "select" per selectable option).
 */
export interface V2Action {
  /**
   * "e1".."e250" for element actions; "scroll_down" | "scroll_up" (page) | "scroll_down_<n>" |
   * "scroll_up_<n>" (scroll area n, 1..5: a dialog or panel; `node` is the area) | "wait" for controls.
   */
  readonly id: string;
  readonly kind: V2ActionKind;
  readonly label: string;
  readonly node?: number;
  readonly role?: string;
  /** Current value (fill/click), or the option value to select (select). */
  readonly value?: string;
  /** Select only: the currently selected option label(s). */
  readonly current_value?: string;
  readonly checked?: string;
  readonly selected?: string;
  readonly expanded?: string;
}

export interface V2Snapshot {
  readonly url: string;
  readonly title: string;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly scroll: { readonly y: number; readonly height: number };
  /** Visible text only, at most 6000 chars. Never includes password/file/hidden inputs. */
  readonly text: string;
  /** At most 250 element actions, then scroll/wait controls. */
  readonly actions: readonly V2Action[];
  readonly omitted_actions: number;
  /** sha256 hex over {url, text, actions, scroll}; quote it back to `act`. */
  readonly fingerprint: string;
}

export interface V2ConsoleEntry {
  readonly level: "log" | "info" | "warning" | "error" | "debug" | "exception";
  /** At most 500 chars. */
  readonly text: string;
  readonly url?: string;
  readonly t: number;
}

export interface V2NetworkEntry {
  readonly method: string;
  /** Origin + path only; query string and fragment removed. */
  readonly url: string;
  readonly status: number | null;
  readonly type: string;
  readonly failed?: string;
  readonly ms: number | null;
  readonly t: number;
}

export interface V2ActResult {
  readonly executed: string;
  /** Fingerprint of a fresh snapshot taken after the post-input settle wait, if readable. */
  readonly page_changed: boolean | null;
}

// ---------------------------------------------------------------------------
// Operations (daemon -> extension). Each has typed args and result.
// Phase 2 implements: tab_create, tab_list, tab_close, session_close, screenshot.
// session_release (hand tabs to the user) is what the daemon uses when a session finishes.
// Phase 4 adds snapshot/act; phase 6 adds navigate, read_text, debug_logs. Shared groups add
// group_rename / group_list (only sent to extensions announcing V2_EXT_FEATURE_GROUPS).
// ---------------------------------------------------------------------------

export interface V2OpMap {
  tab_create: { args: { url?: string }; result: V2TabInfo };
  tab_list: { args: Record<string, never>; result: { tabs: V2TabInfo[] } };
  tab_close: { args: { tab_id: number }; result: { closed: true } };
  /** Close every tab in the session's group and forget the group. */
  session_close: { args: Record<string, never>; result: { closed_tabs: number } };
  /**
   * Hand the session's tabs over to the user and forget the session: the extension detaches the
   * debugger from each tab, moves the group into the user's last-focused non-session window as a
   * collapsed group titled `v2ReleasedGroupTitle(label)` (never focusing a window or changing the
   * user's active tab), and stops treating the tabs as owned. No `tab_removed` is sent for them.
   * `moved` is false when no user window exists and the group stays where it is. Idempotent: an
   * unknown session yields `{kept_tabs: 0, moved: false}`.
   *
   * Shared groups (extension feature `groups`): `tabs` picks the finish mode (missing: the
   * user's default from the popup); the result then reports the `mode` applied and, for `close`,
   * `closed_tabs`. Older extensions ignore `tabs` and never send `mode` / `closed_tabs`.
   */
  session_release: {
    args: { tabs?: V2FinishMode };
    result: { kept_tabs: number; moved: boolean; closed_tabs?: number; mode?: V2FinishMode };
  };
  /**
   * Shared groups: rename a TabCrew-managed group (default: the caller's group; `group` names
   * another TabCrew group). `name` must pass `v2NormaliseGroupName`. Never touches the user's
   * own groups. Returns the applied (normalised) name and the previous one.
   */
  group_rename: { args: { group?: string; name: string }; result: { name: string; previous: string } };
  /** Shared groups: the TabCrew-managed group names (never user groups, tab ids or counts). */
  group_list: {
    args: Record<string, never>;
    result: { groups: { name: string; /** The caller's session is in this group. */ mine: boolean }[] };
  };
  screenshot: {
    args: { tab_id: number; format?: "jpeg" | "png"; quality?: number };
    result: { media_type: "image/jpeg" | "image/png"; data: string; width: number; height: number };
  };
  /** Atomic read of visible text + indexed controls (port of jev-ultrafast snapshot.js). */
  snapshot: { args: { tab_id: number }; result: V2Snapshot };
  /**
   * Execute one action from the snapshot identified by `fingerprint`. The extension re-checks
   * freshness (page key + per-node guard for click/select, full marker otherwise) and occlusion
   * immediately before input, and never retries. `text` is required for kind "fill".
   * Errors: stale_page (nothing executed), target_covered / target_invalid (nothing executed),
   * outcome_unknown (input may have been delivered but the result could not be confirmed).
   */
  act: { args: { tab_id: number; fingerprint: string; action_id: string; text?: string }; result: V2ActResult };
  navigate: {
    args: { tab_id: number; url?: string; action?: "url" | "back" | "forward" | "reload" };
    result: V2TabInfo;
  };
  read_text: { args: { tab_id: number; max_length?: number }; result: { text: string; url: string; title: string } };
  /**
   * Recent console messages or network requests for one owned tab, captured since the extension
   * attached to it (ring buffer, newest last). Network entries never include headers, cookies,
   * bodies or query strings.
   */
  debug_logs: {
    args: { tab_id: number; source: "console" | "network"; limit?: number; only_errors?: boolean };
    result: { entries: V2ConsoleEntry[] | V2NetworkEntry[]; dropped: number };
  };
}
export type V2Op = keyof V2OpMap;

/** Compile-time complete set of ops (a missing or unknown key is a type error). */
const V2_OP_SET: { readonly [K in V2Op]: true } = {
  tab_create: true,
  tab_list: true,
  tab_close: true,
  session_close: true,
  session_release: true,
  group_rename: true,
  group_list: true,
  screenshot: true,
  snapshot: true,
  act: true,
  navigate: true,
  read_text: true,
  debug_logs: true,
};
export const V2_OPS: readonly V2Op[] = Object.keys(V2_OP_SET) as V2Op[];

export function v2IsOp(value: unknown): value is V2Op {
  return typeof value === "string" && (V2_OPS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Extension -> daemon requests (the popup's settings). Answered with `ext_response`.
// Keys never travel back in full: the daemon only reports where a key comes from and its last
// 4 characters. The extension never stores what it sends here.
// ---------------------------------------------------------------------------

/** Where a secret comes from: the real process environment, `<home>/env`, or nowhere. */
export type V2KeySource = "env" | "file" | "unset";
/** Where a setting's effective value comes from (`file` = config.toml or `<home>/env`). */
export type V2ValueSource = "env" | "file" | "default";

export interface V2KeyView {
  readonly source: V2KeySource;
  /** Last 4 characters of the key, or null when unset. */
  readonly hint: string | null;
}

export interface V2ValueView {
  /** Effective value (null: not set, e.g. the text model base URL defaults to OpenRouter). */
  readonly value: string | null;
  readonly source: V2ValueSource;
  readonly default: string | null;
}

export interface V2SettingsView {
  readonly openrouter_api_key: V2KeyView & {
    /** Result of the last check this daemon ran (null: not checked since it started). */
    readonly check: "valid" | "unreachable" | null;
  };
  readonly text_model_api_key: V2KeyView;
  readonly jev_model: V2ValueView;
  readonly text_model: V2ValueView;
  readonly text_model_base_url: V2ValueView;
}

/** Partial update. `null` removes a key / resets a setting to its default. */
export interface V2SettingsPatch {
  readonly openrouter_api_key?: string | null;
  readonly text_model_api_key?: string | null;
  readonly text_model_base_url?: string | null;
  readonly jev_model?: string | null;
  readonly text_model?: string | null;
}

export interface V2ExtOpMap {
  settings_get: { args: Record<string, never>; result: V2SettingsView };
  settings_set: {
    args: V2SettingsPatch;
    result: { settings: V2SettingsView; updated: string[]; warnings: string[] };
  };
}
export type V2ExtOp = keyof V2ExtOpMap;
export const V2_EXT_OPS: readonly V2ExtOp[] = ["settings_get", "settings_set"];

export function v2IsExtOp(value: unknown): value is V2ExtOp {
  return typeof value === "string" && (V2_EXT_OPS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** How the extension talks to the service: a launchd daemon (token) or a hub (TOFU pin, no token). */
export type V2ConnectionMode = "hub" | "daemon";

/** extension -> daemon, first frame. */
export interface V2Hello {
  readonly type: "hello";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  /** Daemon mode: the shared token. Hub mode: absent or empty (the hub authenticates with `pin`). */
  readonly token?: string;
  readonly extension_version: string;
  /** Optional. Which mode the extension believes it is in. Missing: an older (daemon-mode) extension. */
  readonly mode?: V2ConnectionMode;
  /** Optional capabilities of the extension (see `V2_EXT_FEATURE_*`). Missing means none. */
  readonly features?: readonly string[];
  /** Hub mode only: the trust-on-first-use pin (see `V2HelloPin`). */
  readonly pin?: V2HelloPin;
}

/** daemon -> extension after a valid hello. Invalid hello closes with code 4401 (hub mode pin mismatch: 4403). */
export interface V2Welcome {
  readonly type: "welcome";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  /** Sessions the daemon knows, so the extension can reconcile its tab groups. */
  readonly sessions: readonly V2SessionRef[];
  /** The daemon's package version. Optional: older daemons (0.4 and earlier) do not send it. */
  readonly daemon_version?: string;
  /**
   * Optional capabilities beyond the base protocol (see `V2_FEATURE_*`). Missing means none, which is
   * how the extension recognizes an older daemon (protocol 2 stays compatible for everything else).
   */
  readonly features?: readonly string[];
  /** Hub mode only: the hub's answer to `hello.pin` (see `V2WelcomePin`). */
  readonly pin?: V2WelcomePin;
}

/** The daemon answers `ext_request` settings_get / settings_set (popup settings). */
export const V2_FEATURE_SETTINGS = "settings";
/** The service is a hub (no token, TOFU pin, may send `model_call`). */
export const V2_FEATURE_HUB = "hub";
/** Extension feature (in `hello.features`): it answers `model_call` with `model_result`. */
export const V2_EXT_FEATURE_MODEL_CALL = "model_call";

/** What the extension knows about the connected daemon, from its `welcome`. */
export interface V2ServiceInfo {
  readonly version: string | null;
  readonly features: readonly string[];
}

/** Read the optional version and features of a `welcome` (old daemons send neither; bad values are ignored). */
export function v2ServiceInfo(welcome: unknown): V2ServiceInfo {
  const w = asRecord(welcome);
  return { version: readVersion(w.daemon_version), features: readFeatures(w.features) };
}

/** What the daemon/hub knows about the connected extension, from its `hello`. */
export interface V2HelloFeatures {
  readonly version: string | null;
  /** Null when the extension does not say (extensions 0.5 and earlier). */
  readonly mode: V2ConnectionMode | null;
  readonly features: readonly string[];
}

/** Read the optional version, mode and features of a `hello` (old extensions send no mode/features; bad values are ignored). */
export function v2HelloFeatures(hello: unknown): V2HelloFeatures {
  const h = asRecord(hello);
  const mode = h.mode === "hub" || h.mode === "daemon" ? h.mode : null;
  return { version: readVersion(h.extension_version), mode, features: readFeatures(h.features) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readVersion(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 40) : null;
}

function readFeatures(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 40) : [];
}

// ---------------------------------------------------------------------------
// Hub mode: trust-on-first-use pin with a mutual HMAC challenge.
//
// Hub mode has no token, and Origin alone does not stop a local process from posing as the hub
// or as the extension. On first pairing (or a user-approved re-trust) the extension generates a
// 32-byte secret and sends it in `hello.pin = {state:"new", secret}`; the hub stores it and
// answers `welcome.pin = {state:"stored"}`. On later connections both sides prove they hold it:
//   1. extension: `hello.pin = {state:"pinned", nonce_e}` (fresh 16-byte nonce)
//   2. hub: `welcome.pin = {state:"challenge", nonce_h, hub_proof}` with
//      hub_proof = HMAC-SHA256(secret, v2HubProofInput({nonce_e, nonce_h})); the extension
//      verifies it and disconnects on mismatch (a fake hub).
//   3. extension: `{type:"auth", ext_proof}` with ext_proof = HMAC-SHA256(secret, v2ExtProofInput(...)).
//      The hub verifies it and closes with V2_CLOSE_PIN_MISMATCH on mismatch. Until a valid `auth`
//      arrives the hub treats the connection as unauthenticated (no requests, no other frames).
// The hub also closes with V2_CLOSE_PIN_MISMATCH for `new` when already pinned to another secret,
// for `pinned` when it has no pin, and for a hub-mode hello without a valid pin.
// HMAC key = the 32 secret bytes (hex-decoded), message = the UTF-8 input string, output = lowercase
// hex. The HMAC itself is computed per platform (node:crypto / WebCrypto). Secrets are never logged.
// ---------------------------------------------------------------------------

/** Pin secret: 32 random bytes as 64 lowercase hex characters. */
export const V2_PIN_SECRET_BYTES = 32;
/** Challenge nonces (nonce_e, nonce_h): 16 random bytes as 32 lowercase hex characters. */
export const V2_PIN_NONCE_BYTES = 16;

/** `hello.pin` */
export type V2HelloPin =
  /** First pairing or user-approved re-trust: hand the hub a fresh secret. */
  | { readonly state: "new"; readonly secret: string }
  /** Already paired: challenge the hub with a fresh extension nonce. */
  | { readonly state: "pinned"; readonly nonce_e: string };

/** `welcome.pin` */
export type V2WelcomePin =
  /** The hub stored the secret from `{state:"new"}`. */
  | { readonly state: "stored" }
  /** Answer to `{state:"pinned"}`: the hub's proof plus its own nonce for the extension's `auth`. */
  | { readonly state: "challenge"; readonly nonce_h: string; readonly hub_proof: string };

/** extension -> hub, right after a `welcome` with `pin.state === "challenge"`. */
export interface V2Auth {
  readonly type: "auth";
  readonly ext_proof: string;
}

const HEX_RE = /^[0-9a-f]+$/;

function isHex(value: unknown, chars: number): value is string {
  return typeof value === "string" && value.length === chars && HEX_RE.test(value);
}

export function v2IsPinSecret(value: unknown): value is string {
  return isHex(value, V2_PIN_SECRET_BYTES * 2);
}

export function v2IsPinNonce(value: unknown): value is string {
  return isHex(value, V2_PIN_NONCE_BYTES * 2);
}

/** An HMAC-SHA256 proof: 64 lowercase hex characters. */
export function v2IsPinProof(value: unknown): value is string {
  return isHex(value, 64);
}

/** The valid pin of a `hello`, or null (missing or malformed). Unknown fields are dropped. */
export function v2HelloPin(hello: unknown): V2HelloPin | null {
  const pin = asRecord(asRecord(hello).pin);
  if (pin.state === "new" && v2IsPinSecret(pin.secret)) return { state: "new", secret: pin.secret };
  if (pin.state === "pinned" && v2IsPinNonce(pin.nonce_e)) return { state: "pinned", nonce_e: pin.nonce_e };
  return null;
}

/** The valid pin of a `welcome`, or null (missing, e.g. a daemon-mode welcome, or malformed). */
export function v2WelcomePin(welcome: unknown): V2WelcomePin | null {
  const pin = asRecord(asRecord(welcome).pin);
  if (pin.state === "stored") return { state: "stored" };
  if (pin.state === "challenge" && v2IsPinNonce(pin.nonce_h) && v2IsPinProof(pin.hub_proof)) {
    return { state: "challenge", nonce_h: pin.nonce_h, hub_proof: pin.hub_proof };
  }
  return null;
}

/** `ext_proof` of a well-formed `auth` frame, or null. */
export function v2AuthProof(frame: unknown): string | null {
  const f = asRecord(frame);
  return f.type === "auth" && v2IsPinProof(f.ext_proof) ? f.ext_proof : null;
}

export interface V2PinNonces {
  readonly nonce_e: string;
  readonly nonce_h: string;
}

function checkNonces({ nonce_e, nonce_h }: V2PinNonces): void {
  if (!v2IsPinNonce(nonce_e) || !v2IsPinNonce(nonce_h)) throw new TypeError("pin nonces must be 32 lowercase hex characters");
}

/** HMAC input of the hub's proof: `tabcrew-hub|<nonce_e>|<nonce_h>`. Throws TypeError on a malformed nonce. */
export function v2HubProofInput(nonces: V2PinNonces): string {
  checkNonces(nonces);
  return `tabcrew-hub|${nonces.nonce_e}|${nonces.nonce_h}`;
}

/** HMAC input of the extension's proof: `tabcrew-ext|<nonce_h>|<nonce_e>`. Throws TypeError on a malformed nonce. */
export function v2ExtProofInput(nonces: V2PinNonces): string {
  checkNonces(nonces);
  return `tabcrew-ext|${nonces.nonce_h}|${nonces.nonce_e}`;
}

/** Constant-time comparison of two proofs (false for different lengths or empty strings). */
export function v2ProofEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Hub mode: model calls proxied through the extension (hub -> extension `model_call`,
// extension -> hub `model_result`, same id). Not operations: no session, not in V2OpMap.
// The extension owns the provider settings: it injects the model, base URL, Authorization and
// custom headers, POSTs only to {base}/chat/completions, and never accepts any of those from the
// hub. The key never leaves the extension. The hub keeps timeouts/retries/reply parsing.
// ---------------------------------------------------------------------------

/** Which configured model to call. Hub mode decisions are chat-only (no Jev Decisions API). */
export const V2_MODEL_PURPOSES = ["chat_decision", "text", "text_fallback"] as const;
export type V2ModelPurpose = (typeof V2_MODEL_PURPOSES)[number];

export function v2IsModelPurpose(value: unknown): value is V2ModelPurpose {
  return typeof value === "string" && (V2_MODEL_PURPOSES as readonly string[]).includes(value);
}

export interface V2ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** The only chat-completions body fields the hub may set (the extension adds `model`). */
export interface V2ModelCallBody {
  readonly messages: readonly V2ModelMessage[];
  /** 1..32000 */
  readonly max_tokens: number;
  readonly response_format?: { readonly type: "json_object" | "text" };
}

/** Upper bound of `model_call.timeout_ms`. */
export const V2_MODEL_CALL_MAX_TIMEOUT_MS = 120_000;
const MODEL_MAX_TOKENS = 32_000;

/** hub -> extension */
export interface V2ModelCall {
  readonly type: "model_call";
  readonly id: string;
  readonly purpose: V2ModelPurpose;
  readonly body: V2ModelCallBody;
  /** The extension aborts the fetch after this long (1..V2_MODEL_CALL_MAX_TIMEOUT_MS). */
  readonly timeout_ms: number;
}

/**
 * extension -> hub. `ok: true` whenever the provider answered, whatever the HTTP status (the hub
 * maps 401/403/404/429/5xx); `json` is the parsed reply body or null when it was not JSON.
 * `ok: false` when no reply exists: `model_not_configured` (no provider / no model for the purpose)
 * or `model_error` (network/TLS failure, timeout, missing host permission). Messages never contain the key.
 */
export type V2ModelResult =
  | {
      readonly type: "model_result";
      readonly id: string;
      readonly ok: true;
      readonly result: { readonly status: number; readonly json: unknown; readonly model: string };
    }
  | { readonly type: "model_result"; readonly id: string; readonly ok: false; readonly error: V2Error };

function isFrameId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseModelBody(value: unknown): V2ModelCallBody | null {
  const b = asRecord(value);
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;
  const messages: V2ModelMessage[] = [];
  for (const m of b.messages as unknown[]) {
    const r = asRecord(m);
    if ((r.role !== "system" && r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") return null;
    messages.push({ role: r.role, content: r.content });
  }
  if (!isIntIn(b.max_tokens, 1, MODEL_MAX_TOKENS)) return null;
  if (b.response_format === undefined) return { messages, max_tokens: b.max_tokens };
  const type = asRecord(b.response_format).type;
  if (type !== "json_object" && type !== "text") return null;
  return { messages, max_tokens: b.max_tokens, response_format: { type } };
}

/**
 * A well-formed `model_call`, rebuilt from the allowed fields only (anything else the hub sent,
 * e.g. `body.model`, a URL or headers, is dropped), or null.
 */
export function v2ParseModelCall(frame: unknown): V2ModelCall | null {
  const f = asRecord(frame);
  if (f.type !== "model_call" || !isFrameId(f.id) || !v2IsModelPurpose(f.purpose)) return null;
  if (!isIntIn(f.timeout_ms, 1, V2_MODEL_CALL_MAX_TIMEOUT_MS)) return null;
  const body = parseModelBody(f.body);
  return body ? { type: "model_call", id: f.id, purpose: f.purpose, body, timeout_ms: f.timeout_ms } : null;
}

/** A well-formed `model_result` (only the known fields kept), or null. */
export function v2ParseModelResult(frame: unknown): V2ModelResult | null {
  const f = asRecord(frame);
  if (f.type !== "model_result" || !isFrameId(f.id)) return null;
  if (f.ok === true) {
    const r = asRecord(f.result);
    if (!isIntIn(r.status, 100, 599) || typeof r.model !== "string" || !r.model || r.model.length > 200) return null;
    return { type: "model_result", id: f.id, ok: true, result: { status: r.status, json: r.json ?? null, model: r.model } };
  }
  if (f.ok === false) {
    const e = asRecord(f.error);
    if (!(V2_ERROR_CODES as readonly unknown[]).includes(e.code) || typeof e.message !== "string") return null;
    return { type: "model_result", id: f.id, ok: false, error: { code: e.code as V2ErrorCode, message: e.message.slice(0, 500) } };
  }
  return null;
}

/** daemon -> extension */
export interface V2Request<K extends V2Op = V2Op> {
  readonly type: "request";
  readonly id: string;
  readonly op: K;
  readonly session: V2SessionRef;
  readonly args: V2OpMap[K]["args"];
}

/** extension -> daemon */
export type V2Response<K extends V2Op = V2Op> =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly result: V2OpMap[K]["result"] }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: V2Error };

/** extension -> daemon, unsolicited. */
export type V2Event =
  /** Sent right after welcome: the session groups that exist in the browser. */
  | {
      readonly type: "event";
      readonly event: "groups";
      readonly groups: readonly {
        readonly short_id: string;
        readonly tabs: readonly V2TabInfo[];
        /** Shared groups: the name of the TabCrew group the session's tabs are in. */
        readonly group?: string;
      }[];
    }
  /** A tab opened by an owned tab joined that tab's session group. */
  | { readonly type: "event"; readonly event: "tab_adopted"; readonly short_id: string; readonly tab: V2TabInfo }
  /** A session tab was closed (by the user or the page). */
  | { readonly type: "event"; readonly event: "tab_removed"; readonly short_id: string; readonly tab_id: number }
  /** The user pressed Stop for one session, or for all (short_id null). */
  | { readonly type: "event"; readonly event: "stop"; readonly short_id: string | null };

/** extension -> daemon: a request the daemon answers with `ext_response` (same id). */
export interface V2ExtRequest<K extends V2ExtOp = V2ExtOp> {
  readonly type: "ext_request";
  readonly id: string;
  readonly op: K;
  readonly args: V2ExtOpMap[K]["args"];
}

/** daemon -> extension */
export type V2ExtResponse<K extends V2ExtOp = V2ExtOp> =
  | { readonly type: "ext_response"; readonly id: string; readonly ok: true; readonly result: V2ExtOpMap[K]["result"] }
  | { readonly type: "ext_response"; readonly id: string; readonly ok: false; readonly error: V2Error };

export interface V2Ping {
  readonly type: "ping";
  readonly t: number;
}
export interface V2Pong {
  readonly type: "pong";
  readonly t: number;
}

export type V2ExtensionFrame = V2Hello | V2Auth | V2Response | V2Event | V2Pong | V2ExtRequest | V2ModelResult;
export type V2DaemonFrame = V2Welcome | V2Request | V2Ping | V2ExtResponse | V2ModelCall;

export function v2GroupTitle(session: V2SessionRef): string {
  return `${session.label} · ${session.short_id}`;
}

/**
 * Title of a finished session's group handed to the user: `✓ <label>`. It never parses as a
 * session group (a label that itself ends in ` · <8 chars>` gets its separators replaced).
 */
export function v2ReleasedGroupTitle(label: string): string {
  const title = `✓ ${label}`;
  return v2ParseGroupTitle(title) ? `✓ ${label.replace(/ · /g, " - ")}` : title;
}

/** Parse `<label> · <short_id>`; returns null for groups that are not v2 session groups. */
export function v2ParseGroupTitle(title: string): V2SessionRef | null {
  const m = /^(.*) · ([A-Za-z0-9_-]{8})$/.exec(title);
  return m ? { label: m[1], short_id: m[2] } : null;
}
