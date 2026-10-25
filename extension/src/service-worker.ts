/**
 * TabCrew service worker: wires the daemon bridge relay, session tabs (shared TabCrew window and
 * groups, per-tab ownership; see tabs.ts), and CDP.
 * The daemon WebSocket itself lives in the offscreen document (see offscreen/), so a blocked
 * socket cannot stall request handling here.
 * Hub mode (auto without a daemon token, or the "hub" override): the pin lives in chrome.storage
 * here and is pushed to the offscreen bridge; model calls from the hub run here.
 * Online mode (signed in to a TabCrew relay, see online.ts): the refresh token lives in
 * chrome.storage here; the offscreen bridge only ever gets the relay URL and a short-lived access
 * token. Model calls from the relay run here too.
 * All Chrome listeners are registered synchronously at top level (MV3 requirement).
 */

import { v2IsFinishMode, type V2SettingsView } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import {
  HUB_PIN_KEY,
  MODE_KEY,
  OWN_MODEL_KEY,
  loadOwnModel,
  ONLINE_PREFS_KEY,
  PAUSED_KEY,
  PORT_KEY,
  TOKEN_KEY,
  confirmHubPin,
  connectionStatus,
  ensureHubPin,
  legacyPopupStatus,
  loadConfig,
  loadFinishMode,
  loadGroupName,
  resetHubPin,
  saveFinishMode,
  saveGroupName,
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
import { handleModelCall } from "./model/proxy.js";
import { BridgeRelay } from "./relay.js";
import {
  DEFAULT_RELAY_URL,
  ONLINE_KEY,
  freshAccess,
  parseOnlineAccount,
  signIn,
  signOut,
  signedIn,
  type OnlineAccount,
  type OnlineDeps,
} from "./online.js";
import { PageController } from "./snapshot/controller.js";
import { StoppedSessions } from "./stopped.js";
import { TabManager } from "./tabs.js";

const KEEPALIVE_ALARM = "v2-bridge-keepalive";

const onlineDeps: OnlineDeps = {
  fetch: (input, init) => fetch(input, init),
  launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
  get redirectUrl() {
    return chrome.identity.getRedirectURL("online");
  },
  load: async () => parseOnlineAccount((await chrome.storage.local.get(ONLINE_KEY))[ONLINE_KEY]),
  save: (account: OnlineAccount | null) =>
    account ? chrome.storage.local.set({ [ONLINE_KEY]: account }) : chrome.storage.local.remove(ONLINE_KEY),
  now: () => Date.now(),
};

/**
 * The config for the offscreen bridge: in hub mode a pin always exists (created on first use); in
 * online mode a fresh access token (refreshed first if it is about to expire).
 */
async function loadBridgeConfig() {
  const config = await loadConfig();
  if (config.mode === "hub" && !config.hubPin) return { ...config, hubPin: await ensureHubPin() };
  if (config.mode === "online") {
    const access = await freshAccess(onlineDeps);
    return { ...config, online: access && { ...access, ownModel: await loadOwnModel() } };
  }
  return config;
}

/** The last sign-in failure, for the popup (it closes while the sign-in window is open). */
let onlineError: string | null = null;

async function onlinePrefs(): Promise<{ relay_url: string; browser_name: string }> {
  const raw = (await chrome.storage.local.get(ONLINE_PREFS_KEY))[ONLINE_PREFS_KEY] as Record<string, unknown> | undefined;
  return {
    relay_url: typeof raw?.relay_url === "string" ? raw.relay_url.slice(0, 300) : "",
    browser_name: typeof raw?.browser_name === "string" ? raw.browser_name.slice(0, 40) : "",
  };
}

async function agentsPaused(): Promise<boolean> {
  return (await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY] === true;
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
/** A finished session's tab goes back to the user: no debugger, no cached snapshot. */
const releaseTab = async (tabId: number) => {
  await cdp.detach(tabId);
  page.forget(tabId);
};
const bridge: BridgeRelay = new BridgeRelay({
  loadConfig: loadBridgeConfig,
  ensureOffscreen: ensureOffscreenDocument,
  handleRequest: (req) => handleRequest(req, { tabs, cdp, page }),
  onWelcome: async (welcome) => {
    // Sessions the service no longer knows are finished with the user's default mode.
    const sessions = Array.isArray(welcome?.sessions) ? welcome.sessions : undefined;
    const groups = await tabs.reconcile(sessions, releaseTab);
    bridge.sendEvent({ type: "event", event: "groups", groups });
  },
  onStatus: (status) => {
    if (status !== "unauthorized") return;
    void loadConfig()
      .then(async (config) => {
        // The daemon rejected the stored token: its token may have changed, so ask the host once.
        if (config.mode === "daemon") return pairing.repair(config.token);
        // The relay refused the access token (expired, revoked): refresh once and reconnect. A
        // rejected refresh forgets the tokens, and the push below then reports signed_out.
        if (config.mode === "online") {
          await freshAccess(onlineDeps, { force: true });
          await bridge.pushConfig(true);
        }
        return false;
      })
      .catch(() => false);
  },
  isPaused: agentsPaused,
  // Hub mode: the popup's model provider settings; the key never leaves the extension.
  handleModelCall,
  // Fires storage.onChanged, which re-pushes the (now confirmed) pin without forcing a reconnect.
  onHubPinStored: async (secret) => void (await confirmHubPin(secret)),
});

/** Pair if needed, then make sure the bridge is up (online: keep the access token fresh too). */
function ensureBridge(): void {
  void pairing.ensurePaired().catch(() => undefined);
  void bridge.ensure();
  void loadConfig()
    .then((config) => (config.mode === "online" ? freshAccess(onlineDeps) : null))
    .catch(() => null);
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
  } else if (OWN_MODEL_KEY in changes) {
    // Announce (or stop announcing) own_model: reconnect with the new hello.
    void bridge.pushConfig(true);
  } else if (HUB_PIN_KEY in changes) {
    // The offscreen bridge reconnects only if the secret changed ("Trust this hub"), not for a confirmation.
    void bridge.pushConfig(false);
  } else if (ONLINE_KEY in changes) {
    // Signing in or out (or another relay) reconnects; a rotated access token only updates the config.
    const before = parseOnlineAccount(changes[ONLINE_KEY]?.oldValue);
    const after = parseOnlineAccount(changes[ONLINE_KEY]?.newValue);
    const reconnect = signedIn(before) !== signedIn(after) || before?.relay_url !== after?.relay_url;
    void bridge.pushConfig(reconnect);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === BRIDGE_PORT_NAME) bridge.attach(port);
});
chrome.runtime.onStartup.addListener(() => {
  // Tab, group and window ids did not survive the browser restart: old TabCrew tabs become the
  // user's (fail closed). Every state load waits for this wipe.
  void tabs.handleStartup().catch((err) => console.warn("[v2] ownership wipe failed:", err));
  ensureBridge();
});
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
      tabs.popupGroups().catch(() => []),
      loadGroupName(),
      loadFinishMode(),
      onlineDeps.load(),
      agentsPaused(),
      onlinePrefs(),
    ]).then(([config, sessions, finished, groups, group_name, finish_mode, account, paused, prefs]) => {
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
        groups,
        group_name,
        finish_mode,
        online: signedIn(account)
          ? { relay_url: account!.relay_url, browser_name: account!.browser_name, signed_in: true, error: null }
          : {
              relay_url: prefs.relay_url || account?.relay_url || DEFAULT_RELAY_URL,
              browser_name: prefs.browser_name || account?.browser_name || "",
              signed_in: false,
              error: onlineError,
            },
        paused,
      };
      sendResponse(state);
    });
    return true;
  }
  // Shared groups settings and TabCrew groups (never the user's own groups).
  if (message?.type === "v2:rename_group") {
    void popupAction(() => tabs.renameGroupById(message.group_id, message.name)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:create_group") {
    void popupAction(() => tabs.createGroup(message.name)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:set_group_name") {
    void popupAction(async () => {
      if ((await saveGroupName(message.name)) === null) throw new Error("not a valid group name");
    }).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:set_finish_mode") {
    void popupAction(async () => {
      if (!v2IsFinishMode(message.mode)) throw new Error("finish mode must be keep, close or collect");
      await saveFinishMode(message.mode);
    }).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:trust_hub") {
    // Fires storage.onChanged: the offscreen bridge reconnects handing the new secret to the hub.
    void popupAction(async () => void (await resetHubPin())).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:online_sign_in") {
    // Started by the popup's Sign in click; the auth window outlives the popup closing.
    const relayUrl = String(message.relay_url ?? "").slice(0, 300);
    const browserName = String(message.browser_name ?? "").slice(0, 40);
    onlineError = null;
    void chrome.storage.local.set({ [ONLINE_PREFS_KEY]: { relay_url: relayUrl, browser_name: browserName } });
    void popupAction(async () => {
      await signIn(onlineDeps, { relayUrl, browserName });
    }).then((result) => {
      onlineError = result.ok ? null : result.error;
      sendResponse(result);
    });
    return true;
  }
  if (message?.type === "v2:online_prefs") {
    void popupAction(() =>
      chrome.storage.local.set({
        [ONLINE_PREFS_KEY]: { relay_url: String(message.relay_url ?? "").slice(0, 300), browser_name: String(message.browser_name ?? "").slice(0, 40) },
      }),
    ).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:online_sign_out") {
    void popupAction(() => signOut(onlineDeps)).then(sendResponse);
    return true;
  }
  if (message?.type === "v2:set_paused") {
    void popupAction(() => chrome.storage.local.set({ [PAUSED_KEY]: message.paused === true })).then(sendResponse);
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
