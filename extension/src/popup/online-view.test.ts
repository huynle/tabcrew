import { describe, expect, it } from "vitest";
import type { PopupState } from "../config.js";
import { connectionBadge, connectionHint, modeNote, onlineView, pauseView, settingsAccess } from "./view.js";

function state(extra: Partial<PopupState> = {}): PopupState {
  return {
    status: "offline",
    connection: "relay_offline",
    mode: "online",
    mode_setting: "online",
    port: 0,
    token_set: false,
    sessions: [],
    finished: [],
    online: { relay_url: "https://tabcrew.huynle.com", browser_name: "Home Mac", signed_in: true },
    ...extra,
  };
}

describe("online mode in the popup", () => {
  it("status pill", () => {
    expect(connectionBadge(state()).text).toBe("relay offline");
    expect(connectionBadge(state({ connection: "signed_out" })).text).toBe("signed out");
    expect(connectionBadge(state({ connection: "connected", status: "connected" })).className).toBe("status connected");
  });

  it("hints: sign in when signed out, the relay host when offline, nothing when connected", () => {
    expect(connectionHint(state({ connection: "signed_out" }))?.text).toMatch(/Sign in/);
    expect(connectionHint(state())?.text).toContain("tabcrew.huynle.com");
    expect(connectionHint(state({ connection: "connected", status: "connected" }))).toBeNull();
    expect(connectionHint(state())?.trust).toBe(false);
  });

  it("mode notes say what Online and Auto mean", () => {
    expect(modeNote(state())).toMatch(/^Online:/);
    expect(modeNote(state({ mode_setting: "auto" }))).toMatch(/^Auto: online mode/);
  });

  it("daemon settings are never requested in online mode", () => {
    expect(settingsAccess(state({ status: "connected", connection: "connected", service: { version: "0.6.0", settings: true } }))).toBe("offline");
  });

  it("account box: signed in shows the browser and Sign out; signed out shows Sign in", () => {
    expect(onlineView(state())).toEqual({
      signedIn: true,
      relayUrl: "https://tabcrew.huynle.com",
      browserName: "Home Mac",
      button: "Sign out",
      note: 'Signed in as browser "Home Mac" at tabcrew.huynle.com. Agents you sign in there can use this browser.',
    });
    const out = onlineView(state({ online: { relay_url: "https://tabcrew.huynle.com", browser_name: "", signed_in: false } }));
    expect(out.button).toBe("Sign in");
    expect(out.signedIn).toBe(false);
    expect(out.note).toMatch(/relay sees the pages/);
  });

  it("shows the last sign-in error after the popup reopens", () => {
    const view = onlineView(state({ online: { relay_url: "http://127.0.0.1:8790", browser_name: "home-mac", signed_in: false, error: "Authorization page could not be loaded." } }));
    expect(view.note).toBe(
      "Sign-in failed: Authorization page could not be loaded. Check the relay URL: is a TabCrew relay running at 127.0.0.1:8790?",
    );
    expect(view.relayUrl).toBe("http://127.0.0.1:8790");
    expect(view.browserName).toBe("home-mac");
  });

  it("pause switch", () => {
    expect(pauseView(state({ paused: true }))).toEqual({ checked: true, note: "Paused: agents are refused in this browser until you resume." });
    expect(pauseView(state()).checked).toBe(false);
  });
});
