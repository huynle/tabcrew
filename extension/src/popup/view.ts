import {
  V2_GROUP_NAME_MAX_LENGTH,
  v2CollectGroupTitle,
  v2NormaliseGroupName,
  v2ParseGroupTitle,
  type V2KeyView,
  type V2ValueView,
} from "@tabcrew/shared/v2";
import {
  defaultPort,
  parsePort,
  type ConnectionMode,
  type ConnectionStatus,
  type Placement,
  type PopupActionResult,
  type PopupFinishedInfo,
  type PopupGroupInfo,
  type PopupSessionInfo,
  type PopupState,
} from "../config.js";
import type { ModelList, ProbeInput, ProbeResult } from "../model/probe.js";
import { PROVIDER_PRESETS, keyHint, normalizeBaseUrl, presetFor, validateHeaders, type PresetId, type ProviderSettings } from "../model/settings.js";
import { NOT_PAIRED_TEXT } from "../pairing.js";

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
  // A hub has no daemon settings (keys live in the popup's Model provider instead): never ask it.
  if (state.mode === "hub") return "offline";
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

// ---------------------------------------------------------------------------
// Connection mode (Auto | Hub | Daemon) and hub mode.
// ---------------------------------------------------------------------------

/** The effective mode; older service workers do not report one and are daemon-only. */
export function popupMode(state: PopupState): ConnectionMode {
  return state.mode ?? "daemon";
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: "connected",
  connecting: "connecting",
  needs_token: "pairing…",
  not_paired: NOT_PAIRED_TEXT,
  unauthorized: "unauthorized: check token",
  offline: "offline",
  hub_not_running: "hub not running",
  untrusted_hub: "untrusted hub",
};

export interface ConnectionBadge {
  readonly text: string;
  readonly className: string;
}

/** The header status pill, from the full connection status (the legacy status for older workers). */
export function connectionBadge(state: PopupState): ConnectionBadge {
  const status = state.connection ?? state.status;
  return { text: STATUS_TEXT[status], className: `status ${status}` };
}

export const RESET_PIN_COMMAND = "tabcrew mcp reset-pin";

export interface ConnectionHint {
  readonly text: string;
  /** A terminal command to show with a Copy button, or null. */
  readonly command: string | null;
  readonly detail: string | null;
  /** Show the "Trust this hub" button. */
  readonly trust: boolean;
}

/** The hint box: setup/update in daemon mode, "start OpenCode" / trust in hub mode. */
export function connectionHint(state: PopupState): ConnectionHint | null {
  if (popupMode(state) === "daemon") {
    const hint = setupHint(state);
    return hint ? { ...hint, trust: false } : null;
  }
  switch (state.connection) {
    case "hub_not_running":
      return {
        text: "Start OpenCode — TabCrew starts with it.",
        command: null,
        detail: `The TabCrew hub listens on port ${state.port}; this popup connects as soon as it runs.`,
        trust: false,
      };
    case "untrusted_hub":
      return state.hub_pinned
        ? {
            text: "This TabCrew hub failed the trust check (it doesn't know this browser's pin). If you restarted or reset TabCrew yourself, trust it.",
            command: RESET_PIN_COMMAND,
            detail: "If trusting fails, the hub trusts another browser profile: run the command above in a terminal, then click Trust this hub again.",
            trust: true,
          }
        : {
            text: "The TabCrew hub already trusts another browser profile. To use it from this one, run in a terminal:",
            command: RESET_PIN_COMMAND,
            detail: "Then click Trust this hub.",
            trust: true,
          };
    default:
      return null;
  }
}

/** Below the Connection selector: what the setting means (and what Auto resolved to). */
export function modeNote(state: PopupState): string {
  const mode = popupMode(state);
  switch (state.mode_setting ?? "auto") {
    case "hub":
      return "Hub: OpenCode starts TabCrew; model calls use the provider above.";
    case "daemon":
      return "Daemon: the TabCrew service from npx tabcrew setup.";
    default:
      return mode === "hub" ? "Auto: hub mode (no daemon token saved)." : "Auto: daemon mode (a daemon token is saved).";
  }
}

export interface PortField {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
}

export function portField(state: PopupState): PortField {
  const mode = popupMode(state);
  return { label: mode === "hub" ? "Hub port" : "Daemon port", placeholder: String(defaultPort(mode)), value: String(state.port) };
}

/** The port to store, or null to remove the setting (empty, invalid or the mode's default). */
export function portSetting(raw: string, mode: ConnectionMode): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const port = parsePort(text, mode);
  return port === defaultPort(mode) ? null : port;
}

// ---------------------------------------------------------------------------
// Model provider form (hub mode). The key input is write-only: never filled from storage.
// ---------------------------------------------------------------------------

export interface HeaderRow {
  readonly name: string;
  readonly value: string;
}

export interface ProviderForm {
  readonly preset: PresetId;
  readonly base_url: string;
  /** What the user typed; empty keeps the saved key (same origin only). */
  readonly api_key: string;
  readonly headers: readonly HeaderRow[];
  readonly decision_model: string;
  readonly text_model: string;
  readonly fallback_text_model: string;
}

export function providerFormFrom(settings: ProviderSettings | null): ProviderForm {
  if (!settings) {
    const preset = PROVIDER_PRESETS[0];
    return { preset: preset.id, base_url: preset.base_url ?? "", api_key: "", headers: [], decision_model: "", text_model: "", fallback_text_model: "" };
  }
  return {
    preset: presetFor(settings.base_url),
    base_url: settings.base_url,
    api_key: "",
    headers: Object.entries(settings.headers).map(([name, value]) => ({ name, value })),
    decision_model: settings.decision_model,
    text_model: settings.text_model,
    fallback_text_model: settings.fallback_text_model ?? "",
  };
}

export interface ProviderKeyStatus {
  readonly text: string;
  readonly tone: "" | "warn" | "error";
}

/** The key status line; `typed` is what's in the (write-only) key input right now. */
export function providerKeyStatus(settings: ProviderSettings | null, typed = ""): ProviderKeyStatus {
  if (typed.trim()) return { text: "Not saved yet — click Save", tone: "warn" };
  if (!settings) return { text: "Not set — browse disabled", tone: "error" };
  const hint = keyHint(settings.api_key);
  return { text: `Set${hint ? ` …${hint}` : ""} (leave empty to keep it)`, tone: "" };
}

export type ProviderField = "base_url" | "api_key" | "headers" | "decision_model" | "text_model";
type FormError = { readonly ok: false; readonly field: ProviderField; readonly error: string };

function formError(field: ProviderField, error: string): FormError {
  return { ok: false, field, error };
}

/** URL, key and headers shared by Save and Test. The saved key is reused only for its own origin. */
function connectionPart(
  form: ProviderForm,
  saved: ProviderSettings | null,
): { ok: true; base_url: string; origin: string; api_key: string; headers: Record<string, string> } | FormError {
  const base = normalizeBaseUrl(form.base_url);
  if (!base.ok) return formError("base_url", base.error);
  let apiKey = form.api_key.trim();
  if (!apiKey) {
    if (!saved) return formError("api_key", "Paste an API key.");
    const savedBase = normalizeBaseUrl(saved.base_url);
    const savedOrigin = savedBase.ok ? savedBase.origin : saved.base_url;
    if (savedOrigin !== base.origin) {
      return formError("api_key", `Paste the API key for ${base.origin} (the saved key belongs to ${savedOrigin}).`);
    }
    apiKey = saved.api_key;
  }
  if (/[\r\n\0]/.test(apiKey)) return formError("api_key", "The API key must be on one line.");
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of form.headers) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!name) return formError("headers", "Give every header a name.");
    if (seen.has(name.toLowerCase())) return formError("headers", `Header "${name}" is listed twice.`);
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  const headersError = validateHeaders(headers);
  if (headersError) return formError("headers", headersError);
  return { ok: true, base_url: base.url, origin: base.origin, api_key: apiKey, headers };
}

export type BuildProviderResult = { readonly ok: true; readonly settings: ProviderSettings; readonly origin: string } | FormError;

/** The settings to store from the form (Save), or the first problem. */
export function buildProvider(form: ProviderForm, saved: ProviderSettings | null): BuildProviderResult {
  const conn = connectionPart(form, saved);
  if (!conn.ok) return conn;
  const decision = form.decision_model.trim();
  const text = form.text_model.trim();
  const fallback = form.fallback_text_model.trim();
  if (!decision) return formError("decision_model", "Enter a decision model.");
  if (!text) return formError("text_model", "Enter a text model.");
  return {
    ok: true,
    origin: conn.origin,
    settings: {
      kind: "openai-compatible",
      base_url: conn.base_url,
      api_key: conn.api_key,
      headers: conn.headers,
      decision_model: decision,
      text_model: text,
      ...(fallback ? { fallback_text_model: fallback } : {}),
    },
  };
}

export type ProbeInputResult = { readonly ok: true; readonly input: ProbeInput; readonly origin: string } | FormError;

/** What Load models and Test send: URL and key required, the decision model optional (Test only). */
export function probeInput(form: ProviderForm, saved: ProviderSettings | null): ProbeInputResult {
  const conn = connectionPart(form, saved);
  if (!conn.ok) return conn;
  return {
    ok: true,
    origin: conn.origin,
    input: { base_url: conn.base_url, api_key: conn.api_key, headers: conn.headers, decision_model: form.decision_model.trim() },
  };
}

export interface ProbeSummary {
  readonly ok: boolean;
  readonly text: string;
}

function modelCount(n: number): string {
  return `${n} model${n === 1 ? "" : "s"}`;
}

export function probeSummary(result: ProbeResult): ProbeSummary {
  const { chat, models, models_error } = result;
  if (chat && !chat.ok) return { ok: false, text: `✗ Chat call failed: ${chat.error}` };
  if (chat?.ok) {
    const answered = `${chat.model} answered in ${chat.ms} ms`;
    return models_error
      ? { ok: true, text: `✓ ${answered} (model list unavailable: ${models_error})` }
      : { ok: true, text: `✓ ${modelCount(models.length)} · ${answered}` };
  }
  if (models_error) return { ok: false, text: `✗ ${models_error}` };
  return { ok: true, text: `✓ ${modelCount(models.length)}. Set a decision model to test a chat call.` };
}

// ---------------------------------------------------------------------------
// Model dropdowns (hub mode): filled from GET {base}/models by Load models / Test (or on open when
// access is already granted), with the preset's recommendations and a Custom… text entry.
// ---------------------------------------------------------------------------

export type ModelSlot = "decision_model" | "text_model" | "fallback_text_model";

/** The dropdown value that reveals the custom model id input. */
export const CUSTOM_MODEL = "__custom__";

/** Ids that are not chat models (embeddings, speech, rerankers, moderation). */
const NON_CHAT_MODEL = /embed|whisper|tts|rerank|moderation/i;

/** The chat-capable model ids, sorted and unique. */
export function chatModelIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => !NON_CHAT_MODEL.test(id)))].sort();
}

export interface ModelOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

export interface ModelPickerInput {
  readonly slot: ModelSlot;
  /** Chat model ids from the provider, or null until they are loaded. */
  readonly models: readonly string[] | null;
  /** The field's current value. */
  readonly value: string;
  /** The stored value ("" when none). */
  readonly saved: string;
  /** The preset's recommendation for this field, if any. */
  readonly recommended: string | undefined;
  /** A provider is stored: an empty optional fallback then means "None" was chosen. */
  readonly saved_provider?: boolean;
}

export interface ModelPicker {
  readonly options: readonly ModelOption[];
  /** The option to select ("" = placeholder / None, CUSTOM_MODEL = custom input). */
  readonly selected: string;
  /** The custom input's text when Custom… is selected, else null (input hidden). */
  readonly custom: string | null;
  /** The recommendation was selected because the field was empty. */
  readonly preselected: boolean;
}

const option = (value: string, label: string, disabled = false): ModelOption => ({ value, label, disabled });

export function modelPicker(input: ModelPickerInput): ModelPicker {
  const value = input.value.trim();
  const models = input.models ?? [];
  const head =
    input.slot === "fallback_text_model"
      ? [option("", "None")]
      : [option("", input.models === null ? "Load models to choose…" : "Choose a model…", true)];
  const listed = models.map((id) => option(id, id === input.recommended ? `${id} (recommended)` : id));
  const custom = option(CUSTOM_MODEL, "Custom…");
  if (!value) {
    const keptNone = input.slot === "fallback_text_model" && input.saved_provider === true;
    const preselect = !keptNone && input.recommended !== undefined && models.includes(input.recommended);
    return { options: [...head, ...listed, custom], selected: preselect ? input.recommended! : "", custom: null, preselected: preselect };
  }
  if (models.includes(value)) return { options: [...head, ...listed, custom], selected: value, custom: null, preselected: false };
  if (value === input.saved.trim()) {
    return { options: [...head, option(value, `${value} (saved)`), ...listed, custom], selected: value, custom: null, preselected: false };
  }
  return { options: [...head, ...listed, custom], selected: CUSTOM_MODEL, custom: value, preselected: false };
}

/** The model a dropdown stands for: its value, or the custom input's text for Custom…. */
export function pickedModel(selected: string, customText: string): string {
  return selected === CUSTOM_MODEL ? customText.trim() : selected;
}

export type ModelsLoad = ModelList | { readonly ok: false; readonly denied: true };

export interface ModelsStatus {
  readonly text: string;
  readonly tone: "ok" | "warn" | "error";
}

/** The status line under Load models. */
export function modelsStatus(load: ModelsLoad, baseUrl: string, preselected: boolean): ModelsStatus {
  const base = normalizeBaseUrl(baseUrl);
  const origin = base.ok ? base.origin : baseUrl;
  const host = base.ok ? new URL(base.origin).host : baseUrl;
  if (!load.ok) {
    if ("denied" in load) {
      return { text: `✗ Access to ${origin} was not granted, so TabCrew can't list its models. Click Load models and choose Allow.`, tone: "error" };
    }
    return { text: `✗ ${load.error}`, tone: "error" };
  }
  const count = chatModelIds(load.models).length;
  if (count === 0) return { text: `${host} listed no chat models. Choose Custom… and type the model id.`, tone: "warn" };
  const picked = preselected ? " · recommended models picked, click Save to use them" : "";
  return { text: `✓ ${modelCount(count)} from ${host}${picked}`, tone: "ok" };
}

// ---------------------------------------------------------------------------
// Shared tab groups: the TabCrew groups list (rename / create), the default group name and the
// default finish behaviour. Names follow `v2NormaliseGroupName`; the service worker re-checks.
// ---------------------------------------------------------------------------

export type GroupNameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string };

/**
 * The normalised group name, or why it is refused. With `groups`, a name another TabCrew group
 * already has is refused too (`self`: the id of the group being renamed).
 */
export function checkGroupName(raw: string, groups: readonly PopupGroupInfo[] = [], self?: number): GroupNameCheck {
  const name = v2NormaliseGroupName(raw);
  if (name === null) return { ok: false, error: groupNameProblem(raw) };
  if (groups.some((g) => g.group_id !== self && g.name === name)) {
    return { ok: false, error: `A TabCrew group named "${name}" already exists.` };
  }
  return { ok: true, name };
}

function groupNameProblem(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return "Enter a group name.";
  if ([...name].length > V2_GROUP_NAME_MAX_LENGTH) return `Use at most ${V2_GROUP_NAME_MAX_LENGTH} characters.`;
  if (/\p{Cc}/u.test(name)) return "Remove control characters from the name.";
  if (name.startsWith("✓ ")) return 'Names can\'t start with "✓ " (used for finished tabs).';
  if (v2ParseGroupTitle(name)) return 'Names like "<label> · <8 characters>" are used for per-session groups.';
  return "Not a valid group name.";
}

export interface GroupRow {
  readonly group_id: number;
  readonly name: string;
  readonly is_default: boolean;
  /** A name without a Chrome group yet (negative id): it appears when a session joins it. */
  readonly pending: boolean;
  /** e.g. "2 agents · 3 finished tabs" */
  readonly meta: string;
}

function counted(n: number, one: string, many: string): string {
  return n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;
}

export function groupRows(groups: readonly PopupGroupInfo[] | undefined): GroupRow[] {
  return (groups ?? []).map((g) => {
    const pending = g.group_id < 0;
    const meta = pending
      ? "appears in Chrome when an agent uses it"
      : `${counted(g.active_sessions, "agent", "agents")} · ${counted(g.finished_tabs, "finished tab", "finished tabs")}`;
    return { group_id: g.group_id, name: g.name, is_default: g.is_default, pending, meta };
  });
}

/**
 * The Tab groups section: shown for the shared window placement, and for the other placements
 * while TabCrew groups are still open in Chrome. Never for an extension without shared groups.
 */
export function groupsSectionVisible(placement: Placement, groups: readonly PopupGroupInfo[] | undefined): boolean {
  if (!groups) return false;
  return placement === "shared_window" || groups.some((g) => g.group_id >= 0);
}

/** The "collect" finish option, named after the collect group (`✓ <default group name>`). */
export function collectLabel(groupName: string | undefined): string {
  return `Collect in "${v2CollectGroupTitle(groupName)}"`;
}

/**
 * The group a rename started on, in a fresh state: a live group by id; a name-only entry (whose
 * negative id shifts) or a group renamed meanwhile by its name; null when it is gone.
 */
export function renameTarget(groups: readonly PopupGroupInfo[] | undefined, edit: { readonly group_id: number; readonly name: string }): number | null {
  const list = groups ?? [];
  if (edit.group_id >= 0 && list.some((g) => g.group_id === edit.group_id)) return edit.group_id;
  return list.find((g) => g.name === edit.name)?.group_id ?? null;
}

export interface ActionNote {
  readonly text: string;
  readonly tone: "ok" | "error";
}

/** The note next to a control after a popup action. */
export function actionNote(result: PopupActionResult, done: string): ActionNote {
  if (result.ok) return { text: done, tone: "ok" };
  const error = result.error.trim().replace(/\.$/, "");
  return { text: `${error.charAt(0).toUpperCase()}${error.slice(1)}.`, tone: "error" };
}
