import { describe, expect, it } from "vitest";
import type { PopupState } from "../config.js";
import { keyStatus, modelField, removeKeyPrompt, settingPatch, settingsAccess, setupHint } from "./view.js";

describe("keyStatus", () => {
  it("describes a required key that is not set", () => {
    expect(keyStatus({ source: "unset", hint: null, check: null }, true)).toEqual({
      text: "Not set — browse disabled",
      locked: false,
      removable: false,
      warn: true,
    });
  });

  it("describes an optional key that is not set", () => {
    expect(keyStatus({ source: "unset", hint: null }, false)).toEqual({
      text: "Not set (uses the OpenRouter key)",
      locked: false,
      removable: false,
      warn: false,
    });
  });

  it("shows only the last 4 characters of a saved key, and an unverified note", () => {
    expect(keyStatus({ source: "file", hint: "abcd", check: "valid" }, true)).toEqual({
      text: "Set …abcd",
      locked: false,
      removable: true,
      warn: false,
    });
    expect(keyStatus({ source: "file", hint: "abcd", check: "unreachable" }, true).text).toBe(
      "Set …abcd (not verified: OpenRouter was unreachable)",
    );
  });

  it("marks a key from the daemon's environment read-only", () => {
    expect(keyStatus({ source: "env", hint: "wxyz", check: null }, true)).toEqual({
      text: "Set by environment …wxyz (read-only)",
      locked: true,
      removable: false,
      warn: false,
    });
  });
});

describe("modelField", () => {
  it("leaves the input empty with the default as placeholder for defaults", () => {
    expect(modelField({ value: "typesafe/jev-1.13", source: "default", default: "typesafe/jev-1.13" })).toEqual({
      value: "",
      placeholder: "typesafe/jev-1.13",
      locked: false,
      note: "",
    });
  });

  it("shows a saved value and an env-locked value", () => {
    expect(modelField({ value: "a/b", source: "file", default: "typesafe/jev-1.13" })).toMatchObject({ value: "a/b", locked: false });
    expect(modelField({ value: "c/d", source: "env", default: "typesafe/jev-1.13" })).toEqual({
      value: "c/d",
      placeholder: "typesafe/jev-1.13",
      locked: true,
      note: "Set by environment (read-only)",
    });
    expect(modelField({ value: null, source: "default", default: null }, "OpenRouter")).toMatchObject({ value: "", placeholder: "OpenRouter" });
  });
});

describe("settingPatch", () => {
  const def = { value: "x/default", source: "default" as const, default: "x/default" };
  const file = { value: "a/b", source: "file" as const, default: "x/default" };
  const env = { value: "e/v", source: "env" as const, default: "x/default" };

  it("returns undefined when nothing changed", () => {
    expect(settingPatch("  ", def)).toBeUndefined();
    expect(settingPatch(" a/b ", file)).toBeUndefined();
    expect(settingPatch("anything", env)).toBeUndefined();
  });

  it("returns the trimmed new value, or null to reset a saved value", () => {
    expect(settingPatch(" n/m ", def)).toBe("n/m");
    expect(settingPatch("n/m", file)).toBe("n/m");
    expect(settingPatch("", file)).toBeNull();
  });
});

describe("setupHint", () => {
  const state = (status: PopupState["status"], extra: Partial<PopupState> = {}): PopupState => ({
    status,
    port: 8771,
    token_set: true,
    sessions: [],
    finished: [],
    ...extra,
  });

  it("is hidden when connected to a current (or not yet known) service", () => {
    expect(setupHint(state("connected"))).toBeNull();
    expect(setupHint(state("connected", { service: null }))).toBeNull();
    expect(setupHint(state("connected", { service: { version: "0.5.0", settings: true } }))).toBeNull();
  });

  it("asks to update an outdated service", () => {
    expect(setupHint(state("connected", { service: { version: null, settings: false } }))).toEqual({
      text: "Your TabCrew service is out of date. Update it to manage keys and models here:",
      command: "npx tabcrew@latest setup",
      detail: null,
    });
  });

  it("asks to run setup when the service is missing, with the pairing error as detail", () => {
    expect(setupHint(state("not_paired", { token_set: false, pairing_error: "host not found" }))).toEqual({
      text: "TabCrew needs its local service. In a terminal run:",
      command: "npx tabcrew setup",
      detail: "host not found",
    });
    expect(setupHint(state("offline"))).toEqual({
      text: "Can't reach the TabCrew service. If it isn't installed, run:",
      command: "npx tabcrew setup",
      detail: null,
    });
    expect(setupHint(state("needs_token", { token_set: false }))?.text).toBe("TabCrew needs its local service. In a terminal run:");
    expect(setupHint(state("unauthorized"))?.command).toBe("npx tabcrew setup");
  });
});

describe("removeKeyPrompt", () => {
  it("warns that removing the OpenRouter key disables browse", () => {
    expect(removeKeyPrompt("openrouter_api_key")).toEqual({
      confirmLabel: "Confirm remove",
      warning: "Remove your OpenRouter key? browse will stop working. Click Confirm remove to continue.",
    });
  });

  it("explains that removing the override falls back to the OpenRouter key", () => {
    expect(removeKeyPrompt("text_model_api_key")).toEqual({
      confirmLabel: "Confirm remove",
      warning: "Remove the override key? The text model will use the OpenRouter key. Click Confirm remove to continue.",
    });
  });
});

describe("settingsAccess", () => {
  const state = (status: PopupState["status"], service?: PopupState["service"]): PopupState => ({
    status,
    port: 8771,
    token_set: true,
    sessions: [],
    finished: [],
    service,
  });

  it("is ready only for a connected service with the settings feature", () => {
    expect(settingsAccess(state("connected", { version: "0.5.0", settings: true }))).toBe("ready");
  });

  it("is outdated for a connected service without it", () => {
    expect(settingsAccess(state("connected", { version: null, settings: false }))).toBe("outdated");
  });

  it("waits while connected but the service is not known yet", () => {
    expect(settingsAccess(state("connected", null))).toBe("waiting");
    expect(settingsAccess(state("connected"))).toBe("waiting");
  });

  it("is offline when not connected, whatever the last service was", () => {
    expect(settingsAccess(state("offline", { version: null, settings: false }))).toBe("offline");
    expect(settingsAccess(state("unauthorized"))).toBe("offline");
  });
});
