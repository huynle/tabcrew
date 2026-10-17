import { describe, expect, it } from "vitest";
import { v2GroupTitle, v2ParseGroupTitle, v2ReleasedGroupTitle } from "./v2.js";

describe("v2 group titles", () => {
  it("round-trips a session group title", () => {
    const ref = { short_id: "aaaa1111", label: "alice" };
    expect(v2ParseGroupTitle(v2GroupTitle(ref))).toEqual(ref);
  });

  it("a released title is ✓ <label> and never parses as a session group", () => {
    expect(v2ReleasedGroupTitle("alice")).toBe("✓ alice");
    expect(v2ParseGroupTitle(v2ReleasedGroupTitle("alice"))).toBeNull();
    // Even a label that looks like a full session title cannot be re-adopted.
    const tricky = v2ReleasedGroupTitle("bob · bbbb2222");
    expect(tricky.startsWith("✓ ")).toBe(true);
    expect(v2ParseGroupTitle(tricky)).toBeNull();
  });
});

describe("extension -> daemon requests", () => {
  it("v2IsExtOp accepts only the known ops", async () => {
    const { v2IsExtOp, V2_EXT_OPS } = await import("./v2.js");
    expect([...V2_EXT_OPS].sort()).toEqual(["settings_get", "settings_set"]);
    expect(v2IsExtOp("settings_get")).toBe(true);
    expect(v2IsExtOp("settings_set")).toBe(true);
    expect(v2IsExtOp("tab_list")).toBe(false);
    expect(v2IsExtOp("__proto__")).toBe(false);
    expect(v2IsExtOp(42)).toBe(false);
  });
});
