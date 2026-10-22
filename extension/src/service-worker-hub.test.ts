import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopupActionResult, PopupState } from "./config.js";
import { createFakeChrome, flush, type FakeChrome, type FakePort } from "./test/fakes.js";

const PIN_RE = /^[0-9a-f]{64}$/;
const CALL = {
  type: "model_call",
  id: "m1",
  purpose: "text",
  body: { messages: [{ role: "user", content: "hi" }], max_tokens: 50 },
  timeout_ms: 10_000,
};

let fake: FakeChrome;

async function boot(): Promise<void> {
  vi.resetModules();
  await import("./service-worker.js");
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function offscreenConnects(): FakePort {
  return fake.chrome.runtime.connect({ name: "v2-bridge" });
}

function popup<T>(msg: unknown): Promise<T> {
  return new Promise((resolve) => fake.chrome.runtime.onMessage.fire(msg, {}, (r) => resolve(r as T)));
}

const popupState = () => popup<PopupState>({ type: "v2:get_state" });
const storedPin = () => fake.chrome.storage.local._data()["v2:hub_pin"] as { secret: string; confirmed: boolean } | undefined;
type ConfigMessage = { type: "config"; token: string | null; port: number; reconfigure: boolean; mode?: string; hub_pin?: { secret: string; confirmed: boolean } };
const configs = (port: FakePort) => port.messages<ConfigMessage>().filter((m) => m.type === "config");

beforeEach(() => {
  fake = createFakeChrome();
  fake.install();
});

describe("service worker hub mode (auto, no daemon token)", () => {
  it("creates a pin and pushes a hub config to the offscreen document", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    const pin = storedPin()!;
    expect(pin.secret).toMatch(PIN_RE);
    expect(pin.confirmed).toBe(false);
    expect(configs(port).at(-1)).toEqual({ type: "config", token: null, port: 8775, reconfigure: false, mode: "hub", hub_pin: pin });
    // Creating the pin must not force a reconnect.
    expect(configs(port).every((m) => m.reconfigure === false && m.hub_pin?.secret === pin.secret)).toBe(true);
  });

  it("reports hub statuses to the popup, never not_paired", async () => {
    await boot();
    expect(await popupState()).toMatchObject({
      status: "offline",
      connection: "hub_not_running",
      mode: "hub",
      mode_setting: "auto",
      port: 8775,
      token_set: false,
      pairing_error: null,
    });
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "untrusted_hub" });
    await settle();
    expect(await popupState()).toMatchObject({ status: "unauthorized", connection: "untrusted_hub" });
    port.postMessage({ type: "status", status: "connected" });
    await settle();
    expect(await popupState()).toMatchObject({ status: "connected", connection: "connected", hub_pinned: false });
    expect(JSON.stringify(await popupState())).not.toContain(storedPin()!.secret);
  });

  it("confirms the pin when the hub stored it, without forcing a reconnect", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    const { secret } = storedPin()!;
    port.postMessage({ type: "hub_pin_stored", secret });
    await settle();
    expect(storedPin()).toEqual({ secret, confirmed: true });
    expect(configs(port).at(-1)).toMatchObject({ reconfigure: false, hub_pin: { secret, confirmed: true } });
    expect((await popupState()).hub_pinned).toBe(true);
  });

  it("v2:trust_hub replaces the pin with a fresh secret and pushes it", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    const old = storedPin()!.secret;
    port.postMessage({ type: "hub_pin_stored", secret: old });
    await settle();
    expect(await popup<PopupActionResult>({ type: "v2:trust_hub" })).toEqual({ ok: true });
    await settle();
    const fresh = storedPin()!;
    expect(fresh.secret).toMatch(PIN_RE);
    expect(fresh.secret).not.toBe(old);
    expect(fresh.confirmed).toBe(false);
    expect(configs(port).at(-1)).toMatchObject({ mode: "hub", hub_pin: fresh });
  });

  it("answers model_call with model_not_configured", async () => {
    await boot();
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "connected" });
    port.postMessage({ type: "model_call", call: CALL });
    await settle();
    expect(port.messages().filter((m) => m.type === "model_result")).toEqual([{
      type: "model_result",
      result: { type: "model_result", id: "m1", ok: false, error: { code: "model_not_configured", message: "set a model provider in the TabCrew popup" } },
    }]);
  });

  it("asks the pairing host at most once, not from the keepalive alarm", async () => {
    await boot();
    fake.chrome.alarms.onAlarm.fire({ name: "v2-bridge-keepalive" });
    fake.chrome.alarms.onAlarm.fire({ name: "v2-bridge-keepalive" });
    await settle();
    expect(fake.chrome.runtime.sendNativeMessage.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("re-pushes the config (forcing a reconnect) when the mode changes", async () => {
    await fake.chrome.storage.local.set({ "v2:token": "tok" });
    await boot();
    const port = offscreenConnects();
    await settle();
    expect(configs(port).at(-1)).toEqual({ type: "config", token: "tok", port: 8771, reconfigure: false });
    await fake.chrome.storage.local.set({ "v2:mode": "hub" });
    await settle();
    expect(configs(port).at(-1)).toMatchObject({ type: "config", token: null, port: 8775, reconfigure: true, mode: "hub" });
  });
});

describe("service worker explicit hub mode", () => {
  beforeEach(async () => {
    await fake.chrome.storage.local.set({ "v2:mode": "hub", "v2:token": "tok" });
  });

  it("never pairs and never sends the daemon token", async () => {
    await boot();
    const port = offscreenConnects();
    await settle();
    fake.chrome.alarms.onAlarm.fire({ name: "v2-bridge-keepalive" });
    port.postMessage({ type: "status", status: "unauthorized" }); // would trigger a re-pair in daemon mode
    await settle();
    expect(fake.chrome.runtime.sendNativeMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(port.messages())).not.toContain('"tok"');
    expect(await popupState()).toMatchObject({ mode: "hub", mode_setting: "hub", token_set: true });
  });
});

describe("service worker daemon mode popup state", () => {
  it("reports the daemon mode and the plain status", async () => {
    await fake.chrome.storage.local.set({ "v2:token": "tok" });
    await boot();
    const port = offscreenConnects();
    port.postMessage({ type: "status", status: "connected" });
    await settle();
    expect(await popupState()).toMatchObject({ status: "connected", connection: "connected", mode: "daemon", mode_setting: "auto", port: 8771 });
    expect(storedPin()).toBeUndefined();
  });
});
