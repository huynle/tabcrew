import { V2_EXTENSION_PORT, type V2SettingsPatch, type V2SettingsView } from "@tabcrew/shared/v2";
import { NOT_PAIRED_TEXT } from "../pairing.js";
import {
  PORT_KEY,
  TOKEN_KEY,
  parsePort,
  type PopupStatus,
  type PopupActionResult,
  type PopupCloseResult,
  type PopupRequest,
  type PopupSettingsResult,
  type PopupState,
  type PopupStopResult,
} from "../config.js";
import { bindPlacementRadios } from "./placement.js";
import { finishedRows, keyStatus, modelField, removeKeyPrompt, sessionRows, settingPatch, setupHint } from "./view.js";

const STATUS_TEXT: Record<PopupStatus, string> = {
  connected: "connected",
  connecting: "connecting",
  needs_token: "pairing…",
  not_paired: NOT_PAIRED_TEXT,
  unauthorized: "unauthorized: check token",
  offline: "offline",
};

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
  const status = $("status");
  status.textContent = STATUS_TEXT[state.status];
  status.className = `status ${state.status}`;
  $<HTMLParagraphElement>("token-note").textContent = state.token_set ? "Token saved." : "No token saved.";
  const hint = setupHint(state);
  $("setup-hint").hidden = hint === null;
  if (hint) {
    $("setup-text").textContent = hint.text;
    $("setup-command").textContent = hint.command;
    $("setup-detail").textContent = hint.detail ?? "";
  }
  setConnected(state.status === "connected");
  const port = $<HTMLInputElement>("port");
  if (document.activeElement !== port) port.value = String(state.port);

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
  const raw = $<HTMLInputElement>("port").value;
  const port = parsePort(raw);
  if (port === V2_EXTENSION_PORT && String(raw).trim() !== String(V2_EXTENSION_PORT)) {
    await chrome.storage.local.remove(PORT_KEY);
  } else {
    await chrome.storage.local.set({ [PORT_KEY]: port });
  }
  setTimeout(() => void refresh(), 300);
});

void bindPlacementRadios(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="placement"]')));

$("stop-all").addEventListener("click", () => void stopSession(null));
$("close-all-finished").addEventListener("click", () => void closeFinished(null));

// ---------------------------------------------------------------------------
// Daemon settings (Advanced). Values go straight to the daemon, which keeps keys in
// ~/.tabcrew/env; nothing here is stored in chrome.storage. Loaded when the popup connects and
// after each save, not on every poll, so typing is never overwritten.
// ---------------------------------------------------------------------------

let connected = false;
let settings: V2SettingsView | null = null;
let saving = false;

function note(id: string, text: string, tone: "" | "error" | "warn" = ""): void {
  const el = $<HTMLParagraphElement>(id);
  el.textContent = text;
  el.className = tone ? `note ${tone}` : "note";
}

function setConnected(next: boolean): void {
  if (next === connected) return;
  connected = next;
  if (connected) void loadSettings();
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
  const usable = connected && settings !== null && !saving;
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".setting").forEach((el) => (el.disabled = !usable));
  if (!connected) {
    note("openrouter-status", "Connect to the TabCrew service to change settings.");
    note("text-key-status", "");
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
