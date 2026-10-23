import { beforeEach, describe, expect, it } from "vitest";
import {
  FINISH_MODE_KEY,
  GROUP_NAME_KEY,
  HUB_PIN_KEY,
  MANAGED_GROUPS_KEY,
  MODE_KEY,
  OWNERSHIP_KEYS,
  PLACEMENT_KEY,
  PORT_KEY,
  SESSION_GROUPS_KEY,
  TABCREW_WINDOW_KEY,
  TAB_OWNERS_KEY,
  TOKEN_KEY,
  confirmHubPin,
  connectionStatus,
  defaultPort,
  effectiveMode,
  ensureHubPin,
  legacyPopupStatus,
  loadConfig,
  loadFinishMode,
  loadGroupName,
  loadPlacement,
  parseFinishMode,
  parseGroupName,
  parseHubPin,
  parseManagedGroups,
  parseModeSetting,
  parseOwnership,
  parsePlacement,
  parsePort,
  parseSessionGroups,
  parseTabOwners,
  parseTabcrewWindow,
  randomHex,
  resetHubPin,
  saveFinishMode,
  saveGroupName,
  saveModeSetting,
  savePlacement,
  type PopupRequest,
  type PopupState,
} from "./config.js";
import { createFakeChrome, type FakeChrome } from "./test/fakes.js";

const SECRET = "11".repeat(32);

let fake: FakeChrome;
beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
});

describe("connection mode", () => {
  it("reads the mode setting, defaulting to auto", () => {
    expect(parseModeSetting("hub")).toBe("hub");
    expect(parseModeSetting("daemon")).toBe("daemon");
    expect(parseModeSetting("auto")).toBe("auto");
    expect(parseModeSetting(undefined)).toBe("auto");
    expect(parseModeSetting("HUB")).toBe("auto");
    expect(parseModeSetting(3)).toBe("auto");
  });

  it("auto is daemon mode when a daemon token exists, hub mode otherwise; overrides win", () => {
    expect(effectiveMode("auto", "t".repeat(43))).toBe("daemon");
    expect(effectiveMode("auto", null)).toBe("hub");
    expect(effectiveMode("daemon", null)).toBe("daemon");
    expect(effectiveMode("hub", "t".repeat(43))).toBe("hub");
  });

  it("uses a per-mode default port", () => {
    expect(defaultPort("hub")).toBe(8775);
    expect(defaultPort("daemon")).toBe(8771);
    expect(parsePort(undefined, "hub")).toBe(8775);
    expect(parsePort("nope", "hub")).toBe(8775);
    expect(parsePort(9000, "hub")).toBe(9000);
    expect(parsePort("9001", "daemon")).toBe(9001);
    // Without a mode: daemon mode, as before.
    expect(parsePort(undefined)).toBe(8771);
    expect(parsePort(70000)).toBe(8771);
  });

  it("saves only valid mode settings", async () => {
    await saveModeSetting("hub");
    expect(fake.chrome.storage.local._data()[MODE_KEY]).toBe("hub");
    await saveModeSetting("bogus" as never);
    expect(fake.chrome.storage.local._data()[MODE_KEY]).toBe("auto");
  });
});

describe("loadConfig", () => {
  it("defaults to hub mode on port 8775 without a token", async () => {
    expect(await loadConfig()).toEqual({ token: null, port: 8775, mode: "hub", modeSetting: "auto", hubPin: null });
  });

  it("is daemon mode on port 8771 with a stored token", async () => {
    await fake.chrome.storage.local.set({ [TOKEN_KEY]: " tok " });
    expect(await loadConfig()).toEqual({ token: "tok", port: 8771, mode: "daemon", modeSetting: "auto", hubPin: null });
  });

  it("honours the mode override, the stored port and a valid stored pin", async () => {
    await fake.chrome.storage.local.set({
      [TOKEN_KEY]: "tok",
      [MODE_KEY]: "hub",
      [PORT_KEY]: 9100,
      [HUB_PIN_KEY]: { secret: SECRET, confirmed: true },
    });
    expect(await loadConfig()).toEqual({
      token: "tok",
      port: 9100,
      mode: "hub",
      modeSetting: "hub",
      hubPin: { secret: SECRET, confirmed: true },
    });
  });
});

describe("hub pin", () => {
  it("parses only a well-formed pin", () => {
    expect(parseHubPin({ secret: SECRET, confirmed: false })).toEqual({ secret: SECRET, confirmed: false });
    expect(parseHubPin({ secret: SECRET, confirmed: "yes" })).toEqual({ secret: SECRET, confirmed: false });
    expect(parseHubPin({ secret: SECRET.slice(2), confirmed: true })).toBeNull();
    expect(parseHubPin(SECRET)).toBeNull();
    expect(parseHubPin(null)).toBeNull();
  });

  it("generates random lowercase hex", () => {
    const a = randomHex(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(32)).not.toBe(a);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("ensureHubPin creates one unconfirmed secret, even when called concurrently, and keeps it", async () => {
    const [a, b] = await Promise.all([ensureHubPin(), ensureHubPin()]);
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toEqual({ secret: a.secret, confirmed: false });
    expect(b).toEqual(a);
    expect(fake.chrome.storage.local._data()[HUB_PIN_KEY]).toEqual(a);
    expect(await ensureHubPin()).toEqual(a);
  });

  it("confirmHubPin marks the stored secret confirmed only when it matches", async () => {
    const pin = await ensureHubPin();
    expect(await confirmHubPin("22".repeat(32))).toBe(false);
    expect(fake.chrome.storage.local._data()[HUB_PIN_KEY]).toEqual({ secret: pin.secret, confirmed: false });
    expect(await confirmHubPin(pin.secret)).toBe(true);
    expect(fake.chrome.storage.local._data()[HUB_PIN_KEY]).toEqual({ secret: pin.secret, confirmed: true });
    expect(await confirmHubPin(pin.secret)).toBe(false); // already confirmed: no write
  });

  it("resetHubPin replaces the pin with a fresh unconfirmed secret", async () => {
    await fake.chrome.storage.local.set({ [HUB_PIN_KEY]: { secret: SECRET, confirmed: true } });
    const fresh = await resetHubPin();
    expect(fresh.secret).not.toBe(SECRET);
    expect(fresh.confirmed).toBe(false);
    expect(fake.chrome.storage.local._data()[HUB_PIN_KEY]).toEqual(fresh);
  });
});

describe("shared tab groups settings", () => {
  it("placement: shared_window is the default; own_window and user_window still parse", async () => {
    expect(parsePlacement("shared_window")).toBe("shared_window");
    expect(parsePlacement("own_window")).toBe("own_window");
    expect(parsePlacement("user_window")).toBe("user_window");
    expect(parsePlacement(undefined)).toBe("shared_window");
    expect(parsePlacement("bogus")).toBe("shared_window");
    expect(await loadPlacement()).toBe("shared_window");
    await savePlacement("own_window");
    expect(fake.chrome.storage.local._data()[PLACEMENT_KEY]).toBe("own_window");
    expect(await loadPlacement()).toBe("own_window");
    await savePlacement("shared_window");
    expect(await loadPlacement()).toBe("shared_window");
  });

  it("group name: defaults to TabCrew, normalised on load and save; invalid names are not stored", async () => {
    expect(GROUP_NAME_KEY).toBe("v2:group_name");
    expect(parseGroupName(undefined)).toBe("TabCrew");
    expect(parseGroupName("  research   team ")).toBe("research team");
    expect(parseGroupName("✓ done")).toBe("TabCrew");
    expect(parseGroupName("alice · aaaa1111")).toBe("TabCrew");
    expect(parseGroupName("x".repeat(41))).toBe("TabCrew");
    expect(parseGroupName(7)).toBe("TabCrew");
    expect(await loadGroupName()).toBe("TabCrew");

    expect(await saveGroupName("  Research ")).toBe("Research");
    expect(fake.chrome.storage.local._data()[GROUP_NAME_KEY]).toBe("Research");
    expect(await loadGroupName()).toBe("Research");

    expect(await saveGroupName("✓ nope")).toBeNull();
    expect(fake.chrome.storage.local._data()[GROUP_NAME_KEY]).toBe("Research");

    await fake.chrome.storage.local.set({ [GROUP_NAME_KEY]: "bad\u0000" });
    expect(await loadGroupName()).toBe("TabCrew");
  });

  it("finish mode: defaults to keep; only valid modes are stored", async () => {
    expect(FINISH_MODE_KEY).toBe("v2:finish_mode");
    expect(parseFinishMode(undefined)).toBe("keep");
    expect(parseFinishMode("close")).toBe("close");
    expect(parseFinishMode("collect")).toBe("collect");
    expect(parseFinishMode("CLOSE")).toBe("keep");
    expect(await loadFinishMode()).toBe("keep");
    await saveFinishMode("collect");
    expect(fake.chrome.storage.local._data()[FINISH_MODE_KEY]).toBe("collect");
    expect(await loadFinishMode()).toBe("collect");
    await saveFinishMode("bogus" as never);
    expect(fake.chrome.storage.local._data()[FINISH_MODE_KEY]).toBe("keep");
  });

  it("names the ownership keys in chrome.storage.local", () => {
    expect(TAB_OWNERS_KEY).toBe("v2:tabOwners");
    expect(SESSION_GROUPS_KEY).toBe("v2:sessionGroups");
    expect(MANAGED_GROUPS_KEY).toBe("v2:managedGroups");
    expect(TABCREW_WINDOW_KEY).toBe("v2:tabcrewWindow");
    expect([...OWNERSHIP_KEYS].sort()).toEqual(["v2:managedGroups", "v2:sessionGroups", "v2:tabOwners", "v2:tabcrewWindow"]);
  });

  it("parses tab owners (tab id → short_id), dropping malformed entries", () => {
    expect(parseTabOwners({ "12": "aaaa1111", "13": "bbbb2222" })).toEqual({ "12": "aaaa1111", "13": "bbbb2222" });
    expect(parseTabOwners({ "12": "aaaa1111", x: "bbbb2222", "-1": "c", "1.5": "d", "14": "", "15": 3, "16": "y".repeat(65) })).toEqual({
      "12": "aaaa1111",
    });
    expect(parseTabOwners(undefined)).toEqual({});
    expect(parseTabOwners(["aaaa1111"])).toEqual({});
    expect(parseTabOwners("x")).toEqual({});
  });

  it("parses session groups (short_id → group id), dropping malformed entries", () => {
    expect(parseSessionGroups({ aaaa1111: 5, bbbb2222: 6 })).toEqual({ aaaa1111: 5, bbbb2222: 6 });
    expect(parseSessionGroups({ aaaa1111: 5, bbbb2222: -1, cccc3333: "6", dddd4444: 1.5, "": 7 })).toEqual({ aaaa1111: 5 });
    expect(parseSessionGroups(null)).toEqual({});
    expect(parseSessionGroups([5])).toEqual({});
  });

  it("parses managed groups (group id → name, window, kind), dropping malformed entries", () => {
    const good = { name: "TabCrew", windowId: 3, kind: "shared" };
    expect(
      parseManagedGroups({
        "5": good,
        "6": { name: "✓ TabCrew", windowId: 3, kind: "collect" },
        "7": { name: "alice · aaaa1111", windowId: 4, kind: "session" },
        "8": { name: "x", windowId: 3, kind: "other" },
        "9": { name: "", windowId: 3, kind: "shared" },
        "10": { name: "x", windowId: "3", kind: "shared" },
        "11": "TabCrew",
        nope: good,
      }),
    ).toEqual({
      "5": good,
      "6": { name: "✓ TabCrew", windowId: 3, kind: "collect" },
      "7": { name: "alice · aaaa1111", windowId: 4, kind: "session" },
    });
    expect(parseManagedGroups({ "5": { ...good, extra: true } })).toEqual({ "5": good });
    expect(parseManagedGroups(undefined)).toEqual({});
  });

  it("parses the TabCrew window id", () => {
    expect(parseTabcrewWindow(42)).toBe(42);
    expect(parseTabcrewWindow(-1)).toBeNull();
    expect(parseTabcrewWindow(1.5)).toBeNull();
    expect(parseTabcrewWindow("42")).toBeNull();
    expect(parseTabcrewWindow(undefined)).toBeNull();
  });

  it("parses all ownership keys from one storage read", () => {
    expect(parseOwnership({})).toEqual({ tabOwners: {}, sessionGroups: {}, managedGroups: {}, tabcrewWindow: null });
    expect(
      parseOwnership({
        [TAB_OWNERS_KEY]: { "12": "aaaa1111" },
        [SESSION_GROUPS_KEY]: { aaaa1111: 5 },
        [MANAGED_GROUPS_KEY]: { "5": { name: "TabCrew", windowId: 3, kind: "shared" } },
        [TABCREW_WINDOW_KEY]: 3,
      }),
    ).toEqual({
      tabOwners: { "12": "aaaa1111" },
      sessionGroups: { aaaa1111: 5 },
      managedGroups: { "5": { name: "TabCrew", windowId: 3, kind: "shared" } },
      tabcrewWindow: 3,
    });
  });

  it("types: popup requests and state carry the group settings", () => {
    const requests: PopupRequest[] = [
      { type: "v2:rename_group", group_id: 5, name: "Research" },
      { type: "v2:create_group", name: "Research" },
      { type: "v2:set_group_name", name: "Research" },
      { type: "v2:set_finish_mode", mode: "collect" },
    ];
    const state: Pick<PopupState, "groups" | "group_name" | "finish_mode"> = {
      groups: [{ group_id: 5, name: "TabCrew", active_sessions: 2, finished_tabs: 1, is_default: true }],
      group_name: "TabCrew",
      finish_mode: "keep",
    };
    expect(requests.map((r) => r.type)).toEqual(["v2:rename_group", "v2:create_group", "v2:set_group_name", "v2:set_finish_mode"]);
    expect(state.groups?.[0].is_default).toBe(true);
  });
});

describe("popup connection status", () => {
  it("maps hub-mode states to hub statuses", () => {
    expect(connectionStatus("hub", "connected")).toBe("connected");
    expect(connectionStatus("hub", "connecting")).toBe("connecting");
    expect(connectionStatus("hub", "offline")).toBe("hub_not_running");
    expect(connectionStatus("hub", "untrusted_hub")).toBe("untrusted_hub");
  });

  it("keeps daemon-mode states as they are", () => {
    for (const s of ["connected", "connecting", "needs_token", "unauthorized", "offline", "not_paired"] as const) {
      expect(connectionStatus("daemon", s)).toBe(s);
    }
  });

  it("folds hub statuses into the legacy popup status", () => {
    expect(legacyPopupStatus("hub_not_running")).toBe("offline");
    expect(legacyPopupStatus("untrusted_hub")).toBe("unauthorized");
    expect(legacyPopupStatus("connected")).toBe("connected");
    expect(legacyPopupStatus("not_paired")).toBe("not_paired");
  });
});
