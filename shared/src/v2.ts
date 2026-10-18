/**
 * TabCrew wire protocol (v2) between the daemon and the extension.
 *
 * Transport: one WebSocket (JSON text frames) from the extension to the daemon at
 * ws://127.0.0.1:{V2_EXTENSION_PORT}. The extension connects out and must send a
 * `hello` with the shared token as its first frame. The daemon owns sessions and
 * policy; the extension only observes and acts on tabs inside a session's group.
 * See docs/plans/2026-10-11-v2-sessions-jev-design.md.
 */

export const V2_PROTOCOL_VERSION = 2;
export const V2_MCP_PORT = 8770;
export const V2_EXTENSION_PORT = 8771;

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
  /** "e1".."e250" for element actions; "scroll_down" | "scroll_up" | "wait" for controls. */
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
// Phase 4 adds snapshot/act; phase 6 adds navigate, read_text, debug_logs.
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
   */
  session_release: { args: Record<string, never>; result: { kept_tabs: number; moved: boolean } };
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

/** extension -> daemon, first frame. */
export interface V2Hello {
  readonly type: "hello";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  readonly token: string;
  readonly extension_version: string;
}

/** daemon -> extension after a valid hello. Invalid hello closes with code 4401. */
export interface V2Welcome {
  readonly type: "welcome";
  readonly protocol: typeof V2_PROTOCOL_VERSION;
  /** Sessions the daemon knows, so the extension can reconcile its tab groups. */
  readonly sessions: readonly V2SessionRef[];
  /** The daemon's package version. Optional: daemons before 0.5 do not send it. */
  readonly daemon_version?: string;
  /**
   * Optional capabilities beyond the base protocol (see `V2_FEATURE_*`). Missing means none, which is
   * how the extension recognizes an older daemon (protocol 2 stays compatible for everything else).
   */
  readonly features?: readonly string[];
}

/** The daemon answers `ext_request` settings_get / settings_set (popup settings). */
export const V2_FEATURE_SETTINGS = "settings";

/** What the extension knows about the connected daemon, from its `welcome`. */
export interface V2ServiceInfo {
  readonly version: string | null;
  readonly features: readonly string[];
}

/** Read the optional version and features of a `welcome` (old daemons send neither; bad values are ignored). */
export function v2ServiceInfo(welcome: unknown): V2ServiceInfo {
  const w = (welcome && typeof welcome === "object" ? welcome : {}) as { daemon_version?: unknown; features?: unknown };
  const version = typeof w.daemon_version === "string" && w.daemon_version ? w.daemon_version.slice(0, 40) : null;
  const features = Array.isArray(w.features)
    ? w.features.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 40)
    : [];
  return { version, features };
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
  | { readonly type: "event"; readonly event: "groups"; readonly groups: readonly { readonly short_id: string; readonly tabs: readonly V2TabInfo[] }[] }
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

export type V2ExtensionFrame = V2Hello | V2Response | V2Event | V2Pong | V2ExtRequest;
export type V2DaemonFrame = V2Welcome | V2Request | V2Ping | V2ExtResponse;

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
