import { beforeEach, describe, expect, it } from "vitest";
import {
  HUB_PIN_KEY,
  MODE_KEY,
  PORT_KEY,
  TOKEN_KEY,
  confirmHubPin,
  connectionStatus,
  defaultPort,
  effectiveMode,
  ensureHubPin,
  legacyPopupStatus,
  loadConfig,
  parseHubPin,
  parseModeSetting,
  parsePort,
  randomHex,
  resetHubPin,
  saveModeSetting,
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
