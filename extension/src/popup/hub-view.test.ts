import { describe, expect, it } from "vitest";
import type { PopupState } from "../config.js";
import type { ProbeResult } from "../model/probe.js";
import type { ProviderSettings } from "../model/settings.js";
import {
  buildProvider,
  connectionBadge,
  connectionHint,
  modeNote,
  popupMode,
  portField,
  portSetting,
  probeInput,
  probeSummary,
  providerFormFrom,
  providerKeyStatus,
  settingsAccess,
  type ProviderForm,
} from "./view.js";

const hubState = (connection: PopupState["connection"], extra: Partial<PopupState> = {}): PopupState => ({
  status: "offline",
  connection,
  mode: "hub",
  mode_setting: "auto",
  hub_pinned: false,
  port: 8775,
  token_set: false,
  sessions: [],
  finished: [],
  ...extra,
});

const daemonState = (status: PopupState["status"], extra: Partial<PopupState> = {}): PopupState => ({
  status,
  port: 8771,
  token_set: true,
  sessions: [],
  finished: [],
  ...extra,
});

const SAVED: ProviderSettings = {
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  api_key: "sk-provider-secret-1234",
  headers: { "OpenAI-Organization": "org-1" },
  decision_model: "gemini-3.6-flash",
  text_model: "gemini-3.1-flash-lite",
};

describe("popupMode", () => {
  it("is the effective mode, daemon for older service workers that do not report one", () => {
    expect(popupMode(hubState("connected"))).toBe("hub");
    expect(popupMode(daemonState("connected"))).toBe("daemon");
    expect(popupMode(daemonState("connected", { mode: "daemon" }))).toBe("daemon");
  });
});

describe("connectionBadge", () => {
  it("uses the full connection status, including the hub ones", () => {
    expect(connectionBadge(hubState("connected"))).toEqual({ text: "connected", className: "status connected" });
    expect(connectionBadge(hubState("hub_not_running"))).toEqual({ text: "hub not running", className: "status hub_not_running" });
    expect(connectionBadge(hubState("untrusted_hub"))).toEqual({ text: "untrusted hub", className: "status untrusted_hub" });
  });

  it("keeps the daemon texts, falling back to the legacy status", () => {
    expect(connectionBadge(daemonState("unauthorized"))).toEqual({ text: "unauthorized: check token", className: "status unauthorized" });
    expect(connectionBadge(daemonState("needs_token")).text).toBe("pairing…");
    expect(connectionBadge(daemonState("offline", { connection: "offline" })).text).toBe("offline");
  });
});

describe("connectionHint", () => {
  it("shows nothing while the hub is connected or connecting", () => {
    expect(connectionHint(hubState("connected"))).toBeNull();
    expect(connectionHint(hubState("connecting"))).toBeNull();
  });

  it("says to start OpenCode when the hub is not running (no setup command)", () => {
    expect(connectionHint(hubState("hub_not_running"))).toEqual({
      text: "Start OpenCode — TabCrew starts with it.",
      command: null,
      detail: "The TabCrew hub listens on port 8775; this popup connects as soon as it runs.",
      trust: false,
    });
  });

  it("offers Trust this hub when a pinned hub fails the check", () => {
    expect(connectionHint(hubState("untrusted_hub", { hub_pinned: true }))).toEqual({
      text: "This TabCrew hub failed the trust check (it doesn't know this browser's pin). If you restarted or reset TabCrew yourself, trust it.",
      command: "tabcrew mcp reset-pin",
      detail: "If trusting fails, the hub trusts another browser profile: run the command above in a terminal, then click Trust this hub again.",
      trust: true,
    });
  });

  it("explains the reset-pin command when the hub refuses a new pin", () => {
    expect(connectionHint(hubState("untrusted_hub", { hub_pinned: false }))).toEqual({
      text: "The TabCrew hub already trusts another browser profile. To use it from this one, run in a terminal:",
      command: "tabcrew mcp reset-pin",
      detail: "Then click Trust this hub.",
      trust: true,
    });
  });

  it("is the setup hint in daemon mode", () => {
    expect(connectionHint(daemonState("offline"))).toEqual({
      text: "Can't reach the TabCrew service. If it isn't installed, run:",
      command: "npx tabcrew setup",
      detail: null,
      trust: false,
    });
    expect(connectionHint(daemonState("connected"))).toBeNull();
  });

  it("never shows the outdated-service box for a hub (it has no daemon settings)", () => {
    expect(connectionHint(hubState("connected", { status: "connected", service: { version: "0.5.0", settings: false } }))).toBeNull();
  });
});

describe("settingsAccess in hub mode", () => {
  it("is offline: the hub has no daemon settings, so the popup never asks", () => {
    expect(settingsAccess(hubState("connected", { status: "connected", service: { version: "0.5.0", settings: true } }))).toBe("offline");
  });
});

describe("modeNote", () => {
  it("explains what auto resolved to", () => {
    expect(modeNote(hubState("connected"))).toBe("Auto: hub mode (no daemon token saved).");
    expect(modeNote(daemonState("connected", { mode: "daemon", mode_setting: "auto" }))).toBe("Auto: daemon mode (a daemon token is saved).");
    expect(modeNote(hubState("connected", { mode_setting: "hub" }))).toBe("Hub: OpenCode starts TabCrew; model calls use the provider above.");
    expect(modeNote(daemonState("connected", { mode: "daemon", mode_setting: "daemon" }))).toBe("Daemon: the TabCrew service from npx tabcrew setup.");
  });
});

describe("portField / portSetting", () => {
  it("labels the port by mode with the mode's default as placeholder", () => {
    expect(portField(hubState("connected"))).toEqual({ label: "Hub port", placeholder: "8775", value: "8775" });
    expect(portField(daemonState("connected"))).toEqual({ label: "Daemon port", placeholder: "8771", value: "8771" });
    expect(portField(hubState("connected", { port: 9000 })).value).toBe("9000");
  });

  it("stores a custom port, null (back to the default) for empty, invalid or default input", () => {
    expect(portSetting("9000", "hub")).toBe(9000);
    expect(portSetting(" 8771 ", "hub")).toBe(8771);
    expect(portSetting("8775", "hub")).toBeNull();
    expect(portSetting("8771", "daemon")).toBeNull();
    expect(portSetting("", "daemon")).toBeNull();
    expect(portSetting("70000", "daemon")).toBeNull();
    expect(portSetting("abc", "hub")).toBeNull();
  });
});

describe("providerFormFrom", () => {
  it("defaults to the Provider A preset with no key", () => {
    expect(providerFormFrom(null)).toEqual({
      preset: "provider-a",
      base_url: "https://llm.example.com/v1",
      api_key: "",
      headers: [],
      decision_model: "",
      text_model: "",
      fallback_text_model: "",
    });
  });

  it("fills saved settings but never the key", () => {
    expect(providerFormFrom({ ...SAVED, base_url: "https://llm.example/v1", fallback_text_model: "claude-haiku-4-5" })).toEqual({
      preset: "custom",
      base_url: "https://llm.example/v1",
      api_key: "",
      headers: [{ name: "OpenAI-Organization", value: "org-1" }],
      decision_model: "gemini-3.6-flash",
      text_model: "gemini-3.1-flash-lite",
      fallback_text_model: "claude-haiku-4-5",
    });
  });
});

describe("providerKeyStatus", () => {
  it("shows only the last 4 characters", () => {
    expect(providerKeyStatus(SAVED)).toEqual({ text: "Set …1234 (leave empty to keep it)", warn: false });
    expect(providerKeyStatus({ ...SAVED, api_key: "short" })).toEqual({ text: "Set (leave empty to keep it)", warn: false });
    expect(providerKeyStatus(null)).toEqual({ text: "Not set — browse disabled", warn: true });
  });
});

describe("buildProvider", () => {
  const form = (extra: Partial<ProviderForm> = {}): ProviderForm => ({ ...providerFormFrom(SAVED), ...extra });

  it("builds settings, keeping the saved key when the field is empty", () => {
    expect(buildProvider(form(), SAVED)).toEqual({ ok: true, settings: SAVED, origin: "https://llm.example.com" });
  });

  it("uses a newly typed key and trims everything", () => {
    const result = buildProvider(
      form({ api_key: "  sk-new-key-5678 ", base_url: "https://openrouter.ai/api/v1/", decision_model: " a/b ", fallback_text_model: " c/d " }),
      SAVED,
    );
    expect(result).toEqual({
      ok: true,
      origin: "https://openrouter.ai",
      settings: { ...SAVED, base_url: "https://openrouter.ai/api/v1", api_key: "sk-new-key-5678", decision_model: "a/b", fallback_text_model: "c/d" },
    });
  });

  it("never reuses the saved key for another origin", () => {
    expect(buildProvider(form({ base_url: "https://openrouter.ai/api/v1" }), SAVED)).toEqual({
      ok: false,
      field: "api_key",
      error: "Paste the API key for https://openrouter.ai (the saved key belongs to https://llm.example.com).",
    });
    expect(buildProvider(form(), null)).toEqual({ ok: false, field: "api_key", error: "Paste an API key." });
  });

  it("validates the URL, the headers and the required models", () => {
    expect(buildProvider(form({ base_url: "http://example.com" }), SAVED)).toEqual({
      ok: false,
      field: "base_url",
      error: "Use an https:// URL (http:// only for localhost).",
    });
    expect(buildProvider(form({ headers: [{ name: "Authorization", value: "x" }] }), SAVED)).toMatchObject({ ok: false, field: "headers" });
    expect(buildProvider(form({ headers: [{ name: "", value: "x" }] }), SAVED)).toEqual({ ok: false, field: "headers", error: "Give every header a name." });
    expect(buildProvider(form({ headers: [{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }] }), SAVED)).toEqual({
      ok: false,
      field: "headers",
      error: 'Header "x-a" is listed twice.',
    });
    expect(buildProvider(form({ decision_model: " " }), SAVED)).toEqual({ ok: false, field: "decision_model", error: "Enter a decision model." });
    expect(buildProvider(form({ text_model: "" }), SAVED)).toEqual({ ok: false, field: "text_model", error: "Enter a text model." });
  });

  it("skips empty header rows and drops a blank fallback", () => {
    const result = buildProvider(form({ headers: [{ name: " ", value: "" }, { name: " X-Title ", value: " TabCrew " }], fallback_text_model: " " }), SAVED);
    expect(result).toMatchObject({ ok: true, settings: { headers: { "X-Title": "TabCrew" } } });
    expect(result.ok && "fallback_text_model" in result.settings).toBe(false);
  });
});

describe("probeInput", () => {
  it("needs only a URL and a key (models optional), with the same key rule", () => {
    expect(probeInput(providerFormFrom({ ...SAVED, decision_model: "" }), SAVED)).toEqual({
      ok: true,
      origin: "https://llm.example.com",
      input: { base_url: "https://llm.example.com/v1", api_key: SAVED.api_key, headers: SAVED.headers, decision_model: "" },
    });
    expect(probeInput({ ...providerFormFrom(SAVED), base_url: "https://other.example/v1" }, SAVED)).toMatchObject({ ok: false, field: "api_key" });
  });
});

describe("probeSummary", () => {
  const result = (extra: Partial<ProbeResult>): ProbeResult => ({ models: ["a", "b"], models_error: null, chat: null, ...extra });

  it("shows ✓ with the latency", () => {
    expect(probeSummary(result({ chat: { ok: true, model: "a", ms: 640 } }))).toEqual({ ok: true, text: "✓ 2 models · a answered in 640 ms" });
    expect(probeSummary(result({ models: [], models_error: "HTTP 404: nope", chat: { ok: true, model: "a", ms: 640 } }))).toEqual({
      ok: true,
      text: "✓ a answered in 640 ms (model list unavailable: HTTP 404: nope)",
    });
    expect(probeSummary(result({}))).toEqual({ ok: true, text: "✓ 2 models. Set a decision model to test a chat call." });
  });

  it("shows ✗ with the error", () => {
    expect(probeSummary(result({ chat: { ok: false, error: "HTTP 401: bad key (check the API key and headers)" } }))).toEqual({
      ok: false,
      text: "✗ Chat call failed: HTTP 401: bad key (check the API key and headers)",
    });
    expect(probeSummary(result({ models: [], models_error: "model request to https://x failed: boom" }))).toEqual({
      ok: false,
      text: "✗ model request to https://x failed: boom",
    });
  });
});
