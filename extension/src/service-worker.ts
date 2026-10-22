/**
 * TabCrew service worker: wires the daemon bridge relay, session tab groups, and CDP.
 * The daemon WebSocket itself lives in the offscreen document (see offscreen/), so a blocked
 * socket cannot stall request handling here.
 * Hub mode (auto without a daemon token, or the "hub" override): the pin lives in chrome.storage
 * here and is pushed to the offscreen bridge; model calls from the hub run here.
 * All Chrome listeners are registered synchronously at top level (MV3 requirement).
 */

import type { V2SettingsView } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import {
  HUB_PIN_KEY,
  MODE_KEY,
  PORT_KEY,
  TOKEN_KEY,
  confirmHubPin,
  connectionStatus,
  ensureHubPin,
  legacyPopupStatus,
  loadConfig,
  resetHubPin,
  type PopupActionResult,
  type PopupCloseResult,
  type PopupRequest,
  type PopupSettingsResult,
  type PopupState,
  type PopupStopResult,
} from "./config.js";
import { ensureOffscreenDocument } from "./offscreen-client.js";
import { handleRequest } from "./ops.js";
import { Pairing } from "./pairing.js";
import { BRIDGE_PORT_NAME } from "./relay-protocol.js";
import { BridgeRelay, modelNotConfigured } from "./relay.js";
import { PageController } from "./snapshot/controller.js";
import { StoppedSessions } from "./stopped.js";
import { TabManager } from "./tabs.js";

const KEEPALIVE_ALARM = "v2-bridge-keepalive";

/** The config for the offscreen bridge: in hub mode a pin always exists (created on first use). */
async function loadBridgeConfig() {
  const config = await loadConfig();
  if (config.mode === "hub" && !config.hubPin) return { ...config, hubPin: await ensureHubPin() };
  return config;
}

const cdp = new CdpManager();
const page = new PageController({
  send: (tabId, method, params) => cdp.send(tabId, method, params),
  isMac: () => chrome.runtime.getPlatformInfo().then((info) => info.os === "mac"),
});
const stopped = new StoppedSessions();
const pairing = new Pairing({
  sendNativeMessage: (host, message) => chrome.runtime.sendNativeMessage(host, message),
  loadToken: async () => (await loadConfig()).token,
  // Fires storage.onChanged, which pushes the new token to the offscreen bridge.
  saveToken: (token) => chrome.storage.local.set({ [TOKEN_KEY]: token }),
  loadModeSetting: async () => (await loadConfig()).modeSetting,
});
const tabs = new TabManager((event) => {
  bridge.sendEvent(event);
});
const bridge: BridgeRelay = new BridgeRelay({
  loadConfig: loadBridgeConfig,
  ensureOffscreen: ensureOffscreenDocument,
  handleRequest: (req) => handleRequest(req, { tabs, cdp, page }),
  onWelcome: async () => {
    const groups = await tabs.reconcile();
    bridge.sendEvent({ type: "event", event: "groups", groups });
  },
  onStatus: (status) => {
    // The daemon rejected the stored token: its token may have changed, so ask the host once.
    if (status === "unauthorized") {
      void loadConfig()
        .then((config) => (config.mode === "daemon" ? pairing.repair(config.token) : false))
        .catch(() => false);
    }
  },
  // Replaced by the model provider proxy (hub mode); until then every call is model_not_configured.
  handleModelCall: modelNotConfigured,
  // Fires storage.onChanged, which re-pushes the (now confirmed) pin without forcing a reconnect.
  onHubPinStored: async (secret) => void (await confirmHubPin(secret)),
});

/** Pair if needed, then make sure the bridge is up. */
function ensureBridge(): void {
  void pairing.ensurePaired().catch(() => undefined);
  void bridge.ensure();
}

chrome.tabs.onCreated.addListener((tab) => {
  void tabs.handleTabCreated(tab).catch((err) => console.warn("[v2] adopt failed:", err));
});
chrome.tabs.onActivated.addListener((info) => {
  tabs.handleTabActivated(info);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.forgetTab(tabId);
  page.forget(tabId);
  void tabs.handleTabRemoved(tabId).catch((err) => console.warn("[v2] tab removal failed:", err));
});
chrome.windows.onRemoved.addListener((windowId) => {
  void tabs.handleWindowRemoved(windowId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  void tabs.handleWindowFocused(windowId).catch(() => undefined);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  cdp.handleDetach(source, reason);
  if (typeof source.tabId === "number") page.forget(source.tabId);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  // A new top-level document makes the tab's snapshot (and its node handles) meaningless.
  if (method === "Page.frameNavigated") {
    const frame = (params as { frame?: { parentId?: string } } | undefined)?.frame;
    if (frame && !frame.parentId) page.forget(source.tabId);
  }
  cdp.handleEvent(source.tabId, method, params);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (TOKEN_KEY in changes || PORT_KEY in changes || MODE_KEY in changes) {
    void bridge.pushConfig(true);
    // A mode switch to daemon mode may need pairing.
    if (MODE_KEY in changes) void pairing.ensurePaired().catch(() => undefined);
  } else if (HUB_PIN_KEY in changes) {
    // The offscreen bridge reconnects only if the secret changed ("Trust this hub"), not for a confirmation.
    void bridge.pushConfig(false);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === BRIDGE_PORT_NAME) bridge.attach(port);
});
chrome.runtime.onStartup.addListener(() => ensureBridge());
chrome.runtime.onInstalled.addListener(() => ensureBridge());

chrome.alarms.onAlarm.addListener((alarm) => {
  // Also retries pairing while unpaired.
  if (alarm.name === KEEPALIVE_ALARM) ensureBridge();
});
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, sendResponse) => {
  if (message?.type === "v2:get_state") {
    void Promise.all([
      loadConfig(),
      tabs
        .listSessionGroups()
        .then((sessions) => stopped.annotate(sessions))
        .catch(() => []),
      tabs.listFinished().catch(() => []),
    ]).then(([config, sessions, finished]) => {
      const unpaired = config.mode === "daemon" && config.token === null && pairing.lastError !== null;
      const connection = connectionStatus(config.mode, unpaired ? "not_paired" : bridge.status);
      const state: PopupState = {
        status: legacyPopupStatus(connection),
        connection,
        mode: config.mode,
        mode_setting: config.modeSetting,
        hub_pinned: config.hubPin?.confirmed === true,
        port: config.port,
        token_set: config.token !== null,
        pairing_error: unpaired ? pairing.lastError : null,
        sessions,
        finished,
        service: bridge.status === "connected" ? bridge.service : null,
      };
      sendResponse(state);
    });
    return true;
  }
  if (message?.type === "v2:trust_hub") {
    // Fires storage.onChanged: the offscreen bridge reconnects handing the new secret to the hub.
    void popupAction(async () => void (await resetHubPin())).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:stop") {
    void stopFromPopup(message.short_id).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_session_tabs") {
    void closeStoppedTabs(message.short_id).then(sendResponse);
    return true;
  }
  // The remaining popup actions are direct user clicks, so focusing a window is allowed there.
  if (message?.type === "v2:show_session") {
    void popupAction(() => tabs.showSession(String(message.short_id))).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:open_finished") {
    void popupAction(() => tabs.openFinished(message.group_id)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_finished") {
    void popupClose(() => tabs.closeFinished(message.group_id)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:close_all_finished") {
    void popupClose(() => tabs.closeAllFinished()).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:settings_get") {
    void popupSettings(async () => ({ settings: await bridge.daemonRequest("settings_get", {}), warnings: [] })).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:settings_set") {
    // The patch may hold an API key: relay it to the daemon only; never log or store it here.
    const patch = message.patch;
    void popupSettings(async () => {
      if (!patch || typeof patch !== "object") throw new Error("settings_set needs a patch");
      const { settings, warnings } = await bridge.daemonRequest("settings_set", patch);
      return { settings, warnings };
    }).then(sendResponse);
    return true;
  }
  return false;
});

async function popupSettings(
  fn: () => Promise<{ settings: V2SettingsView; warnings: string[] }>,
): Promise<PopupSettingsResult> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function stopFromPopup(shortId: string | null): Promise<PopupStopResult> {
  const sent = bridge.sendEvent({ type: "event", event: "stop", short_id: shortId });
  if (!sent) return { ok: false, error: "not connected to the daemon" };
  const ids = shortId !== null ? [shortId] : (await tabs.listSessionGroups().catch(() => [])).map((s) => s.short_id);
  await stopped.add(ids).catch(() => undefined);
  return { ok: true };
}

async function popupAction(fn: () => Promise<void>): Promise<PopupActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function popupClose(fn: () => Promise<{ closed_tabs: number }>): Promise<PopupCloseResult> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Closing tabs from the popup is a user action, offered only for sessions the user stopped. */
async function closeStoppedTabs(shortId: unknown): Promise<PopupCloseResult> {
  if (typeof shortId !== "string" || !(await stopped.has(shortId))) {
    return { ok: false, error: "only a stopped session's tabs can be closed here" };
  }
  try {
    return { ok: true, ...(await tabs.closeSessionTabsLocally(shortId)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ensureBridge();
