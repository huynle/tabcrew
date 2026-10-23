import type { V2SettingsPatch, V2SettingsView } from "@tabcrew/shared/v2";
import {
  PORT_KEY,
  TOKEN_KEY,
  parseModeSetting,
  saveModeSetting,
  type ConnectionMode,
  type PopupActionResult,
  type PopupCloseResult,
  type PopupRequest,
  type PopupSettingsResult,
  type PopupState,
  type PopupStopResult,
} from "../config.js";
import { listModels, probeProvider, type ConnectionInput, type ProbeDeps } from "../model/probe.js";
import {
  PROVIDER_PRESETS,
  clearProviderSettings,
  loadProviderSettings,
  normalizeBaseUrl,
  originPattern,
  presetFor,
  recommendedModels,
  saveProviderSettings,
  type ProviderSettings,
} from "../model/settings.js";
import { DRAFT_RESTORED, clearProviderDraft, draftDiffers, loadProviderDraft, saveProviderDraft } from "./draft.js";
import { bindPlacementRadios } from "./placement.js";
import {
  CUSTOM_MODEL,
  buildProvider,
  chatModelIds,
  connectionBadge,
  connectionHint,
  finishedRows,
  keyStatus,
  modeNote,
  modelField,
  modelPicker,
  modelsStatus,
  pickedModel,
  popupMode,
  portField,
  portSetting,
  probeInput,
  probeSummary,
  providerFormFrom,
  providerKeyStatus,
  removeKeyPrompt,
  sessionRows,
  settingPatch,
  settingsAccess,
  type HeaderRow,
  type ModelSlot,
  type ModelsLoad,
  type ProviderField,
  type ProviderForm,
  type SettingsAccess,
} from "./view.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function button(text: string, onClick: () => void, opts: { title?: string; className?: string } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  if (opts.title) b.title = opts.title;
  if (opts.className) b.className = opts.className;
  b.addEventListener("click", onClick);
  return b;
}

function plural(n: number): string {
  return `${n} tab${n === 1 ? "" : "s"}`;
}

function send<T>(msg: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function refresh(): Promise<void> {
  const state = await send<PopupState>({ type: "v2:get_state" }).catch(() => null);
  if (!state) return;
  const badge = connectionBadge(state);
  const status = $("status");
  status.textContent = badge.text;
  status.className = badge.className;
  $<HTMLParagraphElement>("token-note").textContent = state.token_set ? "Token saved." : "No token saved.";
  renderMode(state);
  const hint = connectionHint(state);
  $("setup-hint").hidden = hint === null;
  if (hint) {
    $("setup-text").textContent = hint.text;
    $("setup-row").hidden = hint.command === null;
    $("setup-command").textContent = hint.command ?? "";
    $("setup-detail").textContent = hint.detail ?? "";
    $("trust-row").hidden = !hint.trust;
  }
  setAccess(settingsAccess(state));
  const field = portField(state);
  $("port-label").textContent = field.label;
  const port = $<HTMLInputElement>("port");
  port.placeholder = field.placeholder;
  if (document.activeElement !== port) port.value = field.value;

  const list = $<HTMLUListElement>("sessions");
  list.replaceChildren();
  if (state.sessions.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No active sessions";
    li.className = "meta";
    list.append(li);
  }
  for (const row of sessionRows(state.sessions)) {
    const li = document.createElement("li");
    if (row.stopped) li.className = "stopped";
    const name = document.createElement("span");
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` ${row.meta}`;
    name.append(meta);
    li.append(name);
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(button("Show", () => void showSession(row.short_id), { title: "Bring this session's window to the front" }));
    if (row.action === "stop") {
      actions.append(button("Stop", () => void stopSession(row.short_id), { className: "danger" }));
    } else if (row.action === "close_tabs") {
      actions.append(button("Close tabs", () => void closeStoppedTabs(row.short_id), { title: "Close this stopped session's tabs" }));
    }
    li.append(actions);
    list.append(li);
  }

  const finished = finishedRows(state.finished ?? []);
  $("finished-section").hidden = finished.length === 0;
  const flist = $<HTMLUListElement>("finished");
  flist.replaceChildren();
  for (const row of finished) {
    const li = document.createElement("li");
    li.className = "finished";
    const name = document.createElement("span");
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ` ${row.meta}`;
    name.append(meta);
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(
      button("Open", () => void openFinished(row.group_id), { title: "Expand this group and switch to it" }),
      button("Close", () => void closeFinished(row.group_id), { title: "Close this finished session's tabs" }),
    );
    li.append(name, actions);
    flist.append(li);
  }
}

async function showSession(shortId: string): Promise<void> {
  const result = await send<PopupActionResult>({ type: "v2:show_session", short_id: shortId }).catch(
    (): PopupActionResult => ({ ok: false, error: "extension not responding" }),
  );
  if (!result.ok) $<HTMLParagraphElement>("stop-note").textContent = `Show failed: ${result.error}`;
}

async function openFinished(groupId: number): Promise<void> {
  const result = await send<PopupActionResult>({ type: "v2:open_finished", group_id: groupId }).catch(
    (): PopupActionResult => ({ ok: false, error: "extension not responding" }),
  );
  if (!result.ok) $<HTMLParagraphElement>("finished-note").textContent = `Open failed: ${result.error}`;
  void refresh();
}

async function closeFinished(groupId: number | null): Promise<void> {
  const msg: PopupRequest = groupId === null ? { type: "v2:close_all_finished" } : { type: "v2:close_finished", group_id: groupId };
  const result = await send<PopupCloseResult>(msg).catch(
    (): PopupCloseResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("finished-note").textContent = result.ok
    ? `Closed ${plural(result.closed_tabs)}.`
    : `Close failed: ${result.error}`;
  void refresh();
}

async function stopSession(shortId: string | null): Promise<void> {
  const result = await send<PopupStopResult>({ type: "v2:stop", short_id: shortId }).catch(
    (): PopupStopResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("stop-note").textContent = result.ok
    ? shortId
      ? `Stop sent for ${shortId}.`
      : "Stop sent for all sessions."
    : `Stop failed: ${result.error}`;
  void refresh();
}

async function closeStoppedTabs(shortId: string): Promise<void> {
  const result = await send<PopupCloseResult>({ type: "v2:close_session_tabs", short_id: shortId }).catch(
    (): PopupCloseResult => ({ ok: false, error: "extension not responding" }),
  );
  $<HTMLParagraphElement>("stop-note").textContent = result.ok
    ? `Closed ${plural(result.closed_tabs)} of ${shortId}.`
    : `Close failed: ${result.error}`;
  void refresh();
}

$<HTMLInputElement>("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save-token").click();
});

$("save-token").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("token");
  const token = input.value.trim();
  if (!token) return;
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  input.value = "";
  $<HTMLParagraphElement>("token-note").textContent = "Token saved.";
  setTimeout(() => void refresh(), 300);
});

$("save-port").addEventListener("click", async () => {
  const port = portSetting($<HTMLInputElement>("port").value, mode);
  if (port === null) await chrome.storage.local.remove(PORT_KEY);
  else await chrome.storage.local.set({ [PORT_KEY]: port });
  setTimeout(() => void refresh(), 300);
});

// ---------------------------------------------------------------------------
// Connection mode (Auto | Hub | Daemon). Hub mode hides the daemon-only settings and shows the
// Model provider; daemon mode keeps the Advanced section exactly as before.
// ---------------------------------------------------------------------------

/** The effective mode of the last state (daemon until the first state arrives). */
let mode: ConnectionMode = "daemon";
let modeKnown = false;

function renderMode(state: PopupState): void {
  const next = popupMode(state);
  const select = $<HTMLSelectElement>("mode");
  if (document.activeElement !== select) select.value = state.mode_setting ?? "auto";
  $("mode-note").textContent = modeNote(state);
  if (modeKnown && next === mode) return;
  const first = !modeKnown;
  mode = next;
  modeKnown = true;
  document.querySelectorAll<HTMLElement>(".daemon-only").forEach((el) => (el.hidden = mode !== "daemon"));
  document.querySelectorAll<HTMLElement>(".hub-only").forEach((el) => (el.hidden = mode !== "hub"));
  if (mode === "hub") void loadProvider(first);
}

$<HTMLSelectElement>("mode").addEventListener("change", async (e) => {
  await saveModeSetting(parseModeSetting((e.target as HTMLSelectElement).value));
  setTimeout(() => void refresh(), 300);
});

$("trust-hub").addEventListener("click", async () => {
  const trust = $<HTMLButtonElement>("trust-hub");
  trust.disabled = true;
  $("trust-note").textContent = "Reconnecting…";
  const result = await send<PopupActionResult>({ type: "v2:trust_hub" }).catch(
    (): PopupActionResult => ({ ok: false, error: "extension not responding" }),
  );
  $("trust-note").textContent = result.ok ? "" : `Failed: ${result.error}`;
  trust.disabled = false;
  setTimeout(() => void refresh(), 500);
});

// ---------------------------------------------------------------------------
// Model provider (hub mode): stored in chrome.storage.local (v2:provider) and used by the service
// worker's model_call proxy. The key input is write-only. Load models, Test and Save ask for host
// access to the provider's origin synchronously in the click (a user gesture), before anything is
// awaited; opening the popup only lists the models when access was already granted. Chrome closes
// the popup while it shows that prompt, so every edit is kept as a draft in chrome.storage.session
// (see draft.ts) and put back, with the models listed, when the popup reopens.
// ---------------------------------------------------------------------------

let savedProvider: ProviderSettings | null = null;
let providerLoaded = false;
/** Chat model ids listed by the provider at `modelsBase`; null until loaded (or after the URL changed). */
let modelChoices: readonly string[] | null = null;
let modelsBase: string | null = null;

const FETCH_DEPS: ProbeDeps = { fetch: (url, init) => fetch(url, init) };

const MODEL_SELECTS: Record<ModelSlot, string> = {
  decision_model: "provider-decision-model",
  text_model: "provider-text-model",
  fallback_text_model: "provider-fallback-model",
};
const MODEL_SLOTS = Object.keys(MODEL_SELECTS) as ModelSlot[];
const modelSelect = (slot: ModelSlot) => $<HTMLSelectElement>(MODEL_SELECTS[slot]);
const customInput = (slot: ModelSlot) => $<HTMLInputElement>(`${MODEL_SELECTS[slot]}-custom`);

const PROVIDER_INPUTS: Record<"base_url" | "api_key", string> = {
  base_url: "provider-base-url",
  api_key: "provider-key",
};

for (const preset of PROVIDER_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.base_url ? `${preset.label} (${new URL(preset.base_url).host})` : preset.label;
  $<HTMLSelectElement>("provider-preset").append(option);
}

async function loadProvider(openIfMissing: boolean): Promise<void> {
  if (providerLoaded) return;
  providerLoaded = true;
  savedProvider = await loadProviderSettings().catch(() => null);
  const draft = await loadProviderDraft().catch(() => null);
  const restore = draft !== null && draftDiffers(draft, savedProvider);
  if (draft !== null && !restore) void clearProviderDraft().catch(() => undefined);
  fillProviderForm(restore ? draft : providerFormFrom(savedProvider));
  note("provider-draft-note", restore ? DRAFT_RESTORED : "", restore ? "warn" : "");
  if (restore || (openIfMissing && !savedProvider)) $<HTMLDetailsElement>("advanced").open = true;
  if (restore) {
    const input = probeInput(draft, savedProvider);
    if (input.ok) void autoLoadModels(input.input);
  } else if (savedProvider) {
    void autoLoadModels(savedProvider);
  }
}

/** On open: list the (saved or restored) provider's models if access was already granted (never prompts). */
async function autoLoadModels(settings: ConnectionInput): Promise<void> {
  const base = normalizeBaseUrl(settings.base_url);
  if (!base.ok) return;
  const granted = await chrome.permissions.contains({ origins: [originPattern(base.origin)] }).catch(() => false);
  if (!granted) return;
  note("provider-models-status", "Loading models…");
  showModels(settings.base_url, await listModels(settings, FETCH_DEPS));
}

function normalizedBase(raw: string): string | null {
  const base = normalizeBaseUrl(raw);
  return base.ok ? base.url : null;
}

/** Forget the listed models when the base URL no longer matches them. */
function syncModelsBase(): void {
  if (modelsBase === null || normalizedBase($<HTMLInputElement>("provider-base-url").value) === modelsBase) return;
  modelChoices = null;
  modelsBase = null;
  note("provider-models-status", "");
  renderModelPickers(currentModels());
}

/** Rebuild the three dropdowns for these values; true if a recommendation was preselected. */
function renderModelPickers(values: Readonly<Record<ModelSlot, string>>): boolean {
  const recommended = recommendedModels($<HTMLInputElement>("provider-base-url").value);
  let preselected = false;
  for (const slot of MODEL_SLOTS) {
    const view = modelPicker({
      slot,
      models: modelChoices,
      value: values[slot],
      saved: savedProvider?.[slot] ?? "",
      saved_provider: savedProvider !== null,
      recommended: recommended?.[slot],
    });
    const select = modelSelect(slot);
    select.replaceChildren(
      ...view.options.map((o) => {
        const option = document.createElement("option");
        option.value = o.value;
        option.textContent = o.label;
        option.disabled = o.disabled;
        return option;
      }),
    );
    select.value = view.selected;
    const custom = customInput(slot);
    custom.hidden = view.custom === null;
    if (view.custom !== null) custom.value = view.custom;
    preselected ||= view.preselected;
  }
  return preselected;
}

function currentModels(): Record<ModelSlot, string> {
  const values = {} as Record<ModelSlot, string>;
  for (const slot of MODEL_SLOTS) values[slot] = pickedModel(modelSelect(slot).value, customInput(slot).value);
  return values;
}

/** Show a model list result for `baseUrl` (ignored if the URL was changed meanwhile). */
function showModels(baseUrl: string, load: ModelsLoad): void {
  const base = normalizedBase(baseUrl);
  if (base === null || normalizedBase($<HTMLInputElement>("provider-base-url").value) !== base) return;
  if (load.ok) {
    modelChoices = chatModelIds(load.models);
    modelsBase = base;
  }
  const preselected = renderModelPickers(currentModels());
  const status = modelsStatus(load, baseUrl, preselected);
  note("provider-models-status", status.text, status.tone);
}

for (const slot of MODEL_SLOTS) {
  modelSelect(slot).addEventListener("change", () => {
    const custom = customInput(slot);
    custom.hidden = modelSelect(slot).value !== CUSTOM_MODEL;
    if (!custom.hidden) custom.focus();
  });
}

function headerRow(row: HeaderRow): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "row header-row";
  const name = document.createElement("input");
  name.className = "header-name";
  name.placeholder = "Name";
  name.value = row.name;
  name.spellcheck = false;
  const value = document.createElement("input");
  value.className = "header-value";
  value.placeholder = "Value";
  value.value = row.value;
  value.spellcheck = false;
  value.autocomplete = "off";
  const remove = () => {
    div.remove();
    persistDraft();
  };
  div.append(name, value, button("×", remove, { title: "Remove this header", className: "danger" }));
  return div;
}

function fillProviderForm(form: ProviderForm): void {
  $<HTMLSelectElement>("provider-preset").value = form.preset;
  $<HTMLInputElement>("provider-base-url").value = form.base_url;
  $<HTMLInputElement>("provider-key").value = form.api_key;
  $("provider-headers").replaceChildren(...form.headers.map(headerRow));
  syncModelsBase();
  renderModelPickers(form);
  renderProviderKey();
}

function renderProviderKey(): void {
  const status = providerKeyStatus(savedProvider, $<HTMLInputElement>("provider-key").value);
  note("provider-key-status", status.text, status.tone);
  $<HTMLButtonElement>("remove-provider").disabled = savedProvider === null;
}

function readProviderForm(): ProviderForm {
  const value = (id: string) => $<HTMLInputElement>(id).value;
  const headers = Array.from(document.querySelectorAll<HTMLDivElement>("#provider-headers .header-row"), (row) => ({
    name: row.querySelector<HTMLInputElement>(".header-name")?.value ?? "",
    value: row.querySelector<HTMLInputElement>(".header-value")?.value ?? "",
  }));
  return {
    preset: PROVIDER_PRESETS.find((p) => p.id === value("provider-preset"))?.id ?? presetFor(value("provider-base-url")),
    base_url: value("provider-base-url"),
    api_key: value("provider-key"),
    headers,
    ...currentModels(),
  };
}

/** The control to mark for a form problem: the custom input when a dropdown is on Custom…. */
function fieldControl(field: ProviderField): HTMLElement {
  if (field === "headers") return $("provider-headers");
  if (field === "base_url" || field === "api_key") return $(PROVIDER_INPUTS[field]);
  return customInput(field).hidden ? modelSelect(field) : customInput(field);
}

/** Show a form problem in `noteId` (next to the button that was clicked) and mark + focus the field. */
function providerProblem(noteId: string, field: ProviderField, error: string): void {
  note(noteId, error, "error");
  const control = fieldControl(field);
  control.classList.add("invalid");
  control.setAttribute("aria-invalid", "true");
  const focusable = field === "headers" ? control.querySelector<HTMLInputElement>("input") : control;
  (focusable ?? $("add-header")).focus();
}

function clearProblems(): void {
  document.querySelectorAll<HTMLElement>("#provider-group .invalid").forEach((el) => {
    el.classList.remove("invalid");
    el.removeAttribute("aria-invalid");
  });
}

/** Keep the form as a draft (started in this turn, so it survives the popup closing next). */
function persistDraft(form: ProviderForm = readProviderForm()): void {
  void saveProviderDraft(form).catch(() => undefined);
}

// Every edit in the provider group (typing, dropdowns, preset) is kept; programmatic fills aren't
// events, so loading or restoring the form never writes a draft by itself.
$("provider-group").addEventListener("input", () => {
  clearProblems();
  persistDraft();
});
$("provider-group").addEventListener("change", () => persistDraft());

$<HTMLSelectElement>("provider-preset").addEventListener("change", (e) => {
  const preset = PROVIDER_PRESETS.find((p) => p.id === (e.target as HTMLSelectElement).value);
  const url = $<HTMLInputElement>("provider-base-url");
  if (preset?.base_url) url.value = preset.base_url;
  else url.focus();
  syncModelsBase();
});

$<HTMLInputElement>("provider-base-url").addEventListener("input", (e) => {
  $<HTMLSelectElement>("provider-preset").value = presetFor((e.target as HTMLInputElement).value);
  syncModelsBase();
});

$<HTMLInputElement>("provider-key").addEventListener("input", () => renderProviderKey());

$("load-models").addEventListener("click", async () => {
  clearProblems();
  const form = readProviderForm();
  const input = probeInput(form, savedProvider);
  if (!input.ok) return providerProblem("provider-models-status", input.field, input.error);
  // The draft first (the prompt closes the popup), then the request synchronously in the click:
  // Chrome only shows the prompt during a user gesture (and resolves at once if already granted).
  persistDraft(form);
  const granted = chrome.permissions.request({ origins: [originPattern(input.origin)] });
  const loadButton = $<HTMLButtonElement>("load-models");
  loadButton.disabled = true;
  note("provider-models-status", "Loading models…");
  try {
    if (!(await granted.catch(() => false))) return showModels(input.input.base_url, { ok: false, denied: true });
    showModels(input.input.base_url, await listModels(input.input, FETCH_DEPS));
  } finally {
    loadButton.disabled = false;
  }
});

$("add-header").addEventListener("click", () => {
  const row = headerRow({ name: "", value: "" });
  $("provider-headers").append(row);
  row.querySelector<HTMLInputElement>(".header-name")?.focus();
});

$("test-provider").addEventListener("click", async () => {
  clearProblems();
  const form = readProviderForm();
  const input = probeInput(form, savedProvider);
  if (!input.ok) return providerProblem("provider-note", input.field, input.error);
  // The draft first (the prompt closes the popup), then the request synchronously in the click.
  persistDraft(form);
  const granted = chrome.permissions.request({ origins: [originPattern(input.origin)] });
  const testButton = $<HTMLButtonElement>("test-provider");
  testButton.disabled = true;
  note("provider-note", "Testing…");
  try {
    if (!(await granted.catch(() => false))) {
      note("provider-note", `✗ Access to ${input.origin} was not granted.`, "error");
      return;
    }
    const result = await probeProvider(input.input, FETCH_DEPS);
    showModels(input.input.base_url, result.models_error ? { ok: false, error: result.models_error } : { ok: true, models: result.models });
    const summary = probeSummary(result);
    note("provider-note", summary.text, summary.ok ? "ok" : "error");
  } finally {
    testButton.disabled = false;
  }
});

$("save-provider").addEventListener("click", async () => {
  clearProblems();
  const built = buildProvider(readProviderForm(), savedProvider);
  if (!built.ok) return providerProblem("provider-note", built.field, built.error);
  // Synchronously in the click (user gesture), and the settings are written in the same turn so a
  // popup closed by the permission prompt still saves them (the proxy re-checks access per call).
  const granted = chrome.permissions.request({ origins: [originPattern(built.origin)] });
  const stored = saveProviderSettings(built.settings);
  try {
    await stored;
  } catch (err) {
    note("provider-note", err instanceof Error ? err.message : String(err), "error");
    return;
  }
  savedProvider = built.settings;
  void clearProviderDraft().catch(() => undefined);
  note("provider-draft-note", "");
  fillProviderForm(providerFormFrom(savedProvider));
  if (await granted.catch(() => false)) {
    note("provider-note", "Saved. The next browse uses it.");
  } else {
    note("provider-note", `Saved, but TabCrew can't call ${built.origin} until you allow access: click Save again and choose Allow.`, "warn");
  }
});

{
  const remove = $<HTMLButtonElement>("remove-provider");
  let armed: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    clearTimeout(armed);
    armed = undefined;
    remove.textContent = "Remove";
  };
  remove.addEventListener("click", async () => {
    if (armed === undefined) {
      remove.textContent = "Confirm remove";
      note("provider-note", "Remove the model provider and its key? browse will stop working. Click Confirm remove to continue.", "warn");
      armed = setTimeout(() => {
        disarm();
        note("provider-note", "");
      }, 5000);
      return;
    }
    disarm();
    await clearProviderSettings();
    await clearProviderDraft().catch(() => undefined);
    note("provider-draft-note", "");
    savedProvider = null;
    fillProviderForm(providerFormFrom(null));
    note("provider-note", "Removed.");
  });
}

void bindPlacementRadios(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="placement"]')));

$("stop-all").addEventListener("click", () => void stopSession(null));
$("close-all-finished").addEventListener("click", () => void closeFinished(null));

// ---------------------------------------------------------------------------
// Daemon settings (Advanced). Values go straight to the daemon, which keeps keys in
// ~/.tabcrew/env; nothing here is stored in chrome.storage. Loaded when the popup connects to a
// service that supports them and after each save, not on every poll, so typing is never
// overwritten. An outdated service gets the update hint instead and is never asked.
// ---------------------------------------------------------------------------

let access: SettingsAccess = "offline";
let settings: V2SettingsView | null = null;
let saving = false;

function note(id: string, text: string, tone: "" | "error" | "warn" | "ok" = ""): void {
  const el = $<HTMLParagraphElement>(id);
  el.textContent = text;
  el.className = tone ? `note ${tone}` : "note";
}

function setAccess(next: SettingsAccess): void {
  if (next === access) return;
  access = next;
  if (access === "ready") void loadSettings();
  else renderSettings();
}

async function loadSettings(): Promise<void> {
  const result = await send<PopupSettingsResult>({ type: "v2:settings_get" }).catch(
    (): PopupSettingsResult => ({ ok: false, error: "extension not responding" }),
  );
  if (result.ok) {
    settings = result.settings;
    note("settings-note", "");
  } else {
    note("settings-note", `Could not load settings: ${result.error}`, "error");
  }
  renderSettings();
}

interface KeyControls {
  readonly status: string;
  readonly input: string;
  readonly save: string;
  readonly remove: string;
}
const OPENROUTER_KEY: KeyControls = { status: "openrouter-status", input: "openrouter-key", save: "save-openrouter", remove: "remove-openrouter" };
const TEXT_KEY: KeyControls = { status: "text-key-status", input: "text-key", save: "save-text-key", remove: "remove-text-key" };

function renderKey(ids: KeyControls, view: V2SettingsView["openrouter_api_key"] | V2SettingsView["text_model_api_key"], required: boolean) {
  const status = keyStatus(view, required);
  note(ids.status, status.text, status.warn ? "error" : "");
  $<HTMLInputElement>(ids.input).disabled = status.locked;
  $<HTMLButtonElement>(ids.save).disabled = status.locked;
  $<HTMLButtonElement>(ids.remove).disabled = !status.removable;
}

function renderModel(inputId: string, view: V2SettingsView["jev_model"], fill: boolean, defaultLabel?: string): boolean {
  const field = modelField(view, defaultLabel);
  const input = $<HTMLInputElement>(inputId);
  if (fill) input.value = field.value;
  input.placeholder = field.placeholder;
  input.disabled = field.locked;
  note(`${inputId}-note`, field.note);
  return field.locked;
}

/**
 * Show the last loaded settings; everything is disabled while offline or saving. `fill: false`
 * keeps what the user typed (after a failed save).
 */
function renderSettings(fill = true): void {
  const usable = access === "ready" && settings !== null && !saving;
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".setting").forEach((el) => (el.disabled = !usable));
  if (access !== "ready") {
    const why =
      access === "outdated"
        ? "Update the TabCrew service (see above) to change settings here."
        : access === "waiting"
          ? "Connecting…"
          : "Connect to the TabCrew service to change settings.";
    note("openrouter-status", why);
    note("text-key-status", "");
    if (access === "outdated") note("settings-note", "");
    return;
  }
  if (!settings || saving) return;
  renderKey(OPENROUTER_KEY, settings.openrouter_api_key, true);
  renderKey(TEXT_KEY, settings.text_model_api_key, false);
  const jevLocked = renderModel("jev-model", settings.jev_model, fill);
  const textLocked = renderModel("text-model", settings.text_model, fill);
  $<HTMLButtonElement>("save-models").disabled = jevLocked && textLocked;
  const urlLocked = renderModel("text-base-url", settings.text_model_base_url, fill, "OpenRouter");
  $<HTMLButtonElement>("save-text-base-url").disabled = urlLocked;
}

/** Send a patch to the daemon; report errors and warnings in `noteId`. */
async function saveSettings(patch: V2SettingsPatch, noteId: string, done: string, pending = "Saving…"): Promise<boolean> {
  saving = true;
  renderSettings();
  note(noteId, pending);
  const result = await send<PopupSettingsResult>({ type: "v2:settings_set", patch }).catch(
    (): PopupSettingsResult => ({ ok: false, error: "extension not responding" }),
  );
  saving = false;
  if (result.ok) {
    settings = result.settings;
    note(noteId, result.warnings.length > 0 ? result.warnings.join(" ") : done, result.warnings.length > 0 ? "warn" : "");
  } else {
    note(noteId, result.error, "error");
  }
  renderSettings(result.ok);
  return result.ok;
}

function bindKey(ids: KeyControls, field: "openrouter_api_key" | "text_model_api_key", noteId: string): void {
  const input = $<HTMLInputElement>(ids.input);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $(ids.save).click();
  });
  $(ids.save).addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      note(noteId, "Paste a key first.", "error");
      return;
    }
    const checking = field === "openrouter_api_key" ? "Checking the key with OpenRouter…" : "Saving…";
    if (await saveSettings({ [field]: value }, noteId, "Saved. The next browse uses it.", checking)) input.value = "";
  });
  const remove = $<HTMLButtonElement>(ids.remove);
  const idleLabel = remove.textContent ?? "Remove";
  let armed: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    clearTimeout(armed);
    armed = undefined;
    remove.textContent = idleLabel;
  };
  remove.addEventListener("click", () => {
    if (armed === undefined) {
      const prompt = removeKeyPrompt(field);
      remove.textContent = prompt.confirmLabel;
      note(noteId, prompt.warning, "warn");
      armed = setTimeout(() => {
        disarm();
        note(noteId, "");
      }, 5000);
      return;
    }
    disarm();
    void saveSettings({ [field]: null }, noteId, "Removed.");
  });
}

bindKey(OPENROUTER_KEY, "openrouter_api_key", "openrouter-note");
bindKey(TEXT_KEY, "text_model_api_key", "text-key-note");

$("save-models").addEventListener("click", () => {
  if (!settings) return;
  const patch: { -readonly [K in keyof V2SettingsPatch]: V2SettingsPatch[K] } = {};
  const jev = settingPatch($<HTMLInputElement>("jev-model").value, settings.jev_model);
  const text = settingPatch($<HTMLInputElement>("text-model").value, settings.text_model);
  if (jev !== undefined) patch.jev_model = jev;
  if (text !== undefined) patch.text_model = text;
  if (Object.keys(patch).length === 0) {
    note("models-note", "No changes.");
    return;
  }
  void saveSettings(patch, "models-note", "Saved. The next browse uses them.");
});

$("save-text-base-url").addEventListener("click", () => {
  if (!settings) return;
  const url = settingPatch($<HTMLInputElement>("text-base-url").value, settings.text_model_base_url);
  if (url === undefined) {
    note("text-base-url-note", "No changes.");
    return;
  }
  void saveSettings({ text_model_base_url: url }, "text-base-url-note", url === null ? "Back to OpenRouter." : "Saved.");
});

$("copy-setup").addEventListener("click", async () => {
  const command = $("setup-command").textContent ?? "";
  const copied = await navigator.clipboard.writeText(command).then(
    () => true,
    () => false,
  );
  $("copy-setup").textContent = copied ? "Copied" : "Select + copy";
  setTimeout(() => ($("copy-setup").textContent = "Copy"), 1500);
});

renderSettings();

void refresh();
setInterval(() => void refresh(), 1500);
