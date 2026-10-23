import { describe, expect, it } from "vitest";
import type { PopupActionResult, PopupGroupInfo } from "../config.js";
import { actionNote, checkGroupName, collectLabel, groupRows, groupsSectionVisible, renameTarget } from "./view.js";

const group = (group_id: number, name: string, extra: Partial<PopupGroupInfo> = {}): PopupGroupInfo => ({
  group_id,
  name,
  active_sessions: 0,
  finished_tabs: 0,
  is_default: false,
  ...extra,
});

describe("checkGroupName", () => {
  it("accepts a valid name, trimmed and with whitespace runs collapsed", () => {
    expect(checkGroupName("  Research \t notes ")).toEqual({ ok: true, name: "Research notes" });
  });

  it("explains why a name is refused", () => {
    expect(checkGroupName("   ")).toEqual({ ok: false, error: "Enter a group name." });
    expect(checkGroupName("x".repeat(41))).toEqual({ ok: false, error: "Use at most 40 characters." });
    expect(checkGroupName("x".repeat(40))).toEqual({ ok: true, name: "x".repeat(40) });
    expect(checkGroupName("✓ Done")).toEqual({ ok: false, error: 'Names can\'t start with "✓ " (used for finished tabs).' });
    expect(checkGroupName("alice · abcd1234")).toEqual({
      ok: false,
      error: 'Names like "<label> · <8 characters>" are used for per-session groups.',
    });
    expect(checkGroupName("bad\u0007name")).toEqual({ ok: false, error: "Remove control characters from the name." });
  });

  it("refuses a name another TabCrew group already has (but not the group's own name)", () => {
    const groups = [group(5, "TabCrew", { is_default: true }), group(-1, "Research")];
    expect(checkGroupName("Research", groups)).toEqual({ ok: false, error: 'A TabCrew group named "Research" already exists.' });
    expect(checkGroupName(" Research ", groups, -1)).toEqual({ ok: true, name: "Research" });
    expect(checkGroupName("research", groups)).toEqual({ ok: true, name: "research" });
  });
});

describe("groupRows", () => {
  it("is empty for an extension without shared groups", () => {
    expect(groupRows(undefined)).toEqual([]);
  });

  it("lists live groups with agents and finished tabs, and names not in Chrome yet", () => {
    const rows = groupRows([
      group(5, "TabCrew", { active_sessions: 2, finished_tabs: 3, is_default: true }),
      group(9, "Research", { active_sessions: 1, finished_tabs: 1 }),
      group(12, "Idle"),
      group(-1, "Later"),
    ]);
    expect(rows).toEqual([
      { group_id: 5, name: "TabCrew", is_default: true, pending: false, meta: "2 agents · 3 finished tabs" },
      { group_id: 9, name: "Research", is_default: false, pending: false, meta: "1 agent · 1 finished tab" },
      { group_id: 12, name: "Idle", is_default: false, pending: false, meta: "no agents · no finished tabs" },
      { group_id: -1, name: "Later", is_default: false, pending: true, meta: "appears in Chrome when an agent uses it" },
    ]);
  });
});

describe("groupsSectionVisible", () => {
  const live = [group(5, "TabCrew", { is_default: true })];
  const pending = [group(-1, "TabCrew", { is_default: true })];

  it("shows the Tab groups section for the shared window placement", () => {
    expect(groupsSectionVisible("shared_window", pending)).toBe(true);
    expect(groupsSectionVisible("shared_window", [])).toBe(true);
  });

  it("hides it for the other placements unless TabCrew groups are still open", () => {
    expect(groupsSectionVisible("own_window", pending)).toBe(false);
    expect(groupsSectionVisible("user_window", [])).toBe(false);
    expect(groupsSectionVisible("own_window", live)).toBe(true);
  });

  it("hides it for an extension without shared groups", () => {
    expect(groupsSectionVisible("shared_window", undefined)).toBe(false);
  });
});

describe("collectLabel", () => {
  it("names the collect group after the default group name", () => {
    expect(collectLabel("Research")).toBe('Collect in "✓ Research"');
    expect(collectLabel(undefined)).toBe('Collect in "✓ TabCrew"');
    expect(collectLabel("✓ bad")).toBe('Collect in "✓ TabCrew"');
  });
});

describe("renameTarget", () => {
  it("keeps a live group's id while it is still listed", () => {
    expect(renameTarget([group(5, "Renamed in Chrome")], { group_id: 5, name: "TabCrew" })).toBe(5);
  });

  it("finds a name-only entry by name (its negative id shifts)", () => {
    const groups = [group(-1, "TabCrew"), group(-2, "Later")];
    expect(renameTarget(groups, { group_id: -3, name: "Later" })).toBe(-2);
  });

  it("follows a name-only entry that became a live Chrome group", () => {
    expect(renameTarget([group(7, "Later", { active_sessions: 1 })], { group_id: -2, name: "Later" })).toBe(7);
  });

  it("is null when the group is gone", () => {
    expect(renameTarget([group(-1, "TabCrew")], { group_id: 5, name: "Research" })).toBeNull();
    expect(renameTarget(undefined, { group_id: 5, name: "Research" })).toBeNull();
  });
});

describe("actionNote", () => {
  it("shows the done text on success and the error (capitalised, with a full stop) on failure", () => {
    const ok: PopupActionResult = { ok: true };
    expect(actionNote(ok, "Saved.")).toEqual({ text: "Saved.", tone: "ok" });
    expect(actionNote({ ok: false, error: "not a valid group name" }, "Saved.")).toEqual({ text: "Not a valid group name.", tone: "error" });
    expect(actionNote({ ok: false, error: 'a TabCrew group named "x" already exists' }, "")).toEqual({
      text: 'A TabCrew group named "x" already exists.',
      tone: "error",
    });
    expect(actionNote({ ok: false, error: "extension not responding." }, "")).toEqual({ text: "Extension not responding.", tone: "error" });
  });
});
