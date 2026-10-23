import { describe, expect, it } from "vitest";
import { DaemonError } from "./errors.js";
import { actionSpace, ObservationCache, resolveAct, scrollChoices, toObservation, type Operation } from "./observe.js";
import { flightsSnapshot, modalSnapshot, panelsSnapshot } from "./testing/fixtures.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as DaemonError).code;
  }
  return undefined;
}

describe("actionSpace", () => {
  it("builds one numbered element per node with per-operation targets", () => {
    const snap = flightsSnapshot();
    const space = actionSpace(snap.actions);
    expect(space.elements).toEqual([
      { index: 1, role: "combobox", label: "Where from?", value: "Zürich", operations: ["TYPE_TEXT", "CLICK"] },
      { index: 2, role: "button", label: "Search", operations: ["CLICK"] },
      {
        index: 3,
        role: "combobox",
        label: "Sort by",
        value: "Best",
        operations: ["SELECT"],
        options: [
          { index: "3:1", label: "Price", value: "price" },
          { index: "3:2", label: "Duration", value: "duration" },
          { index: "3:3", label: "Departure time", value: "departure" },
        ],
      },
      { index: 4, role: "checkbox", label: "Nonstop only", value: "on", checked: "true", operations: ["CLICK"] },
      { index: 5, role: "checkbox", label: "Refundable", value: "on", checked: "false", operations: ["CLICK"] },
      { index: 6, role: "button", label: "Passengers", expanded: "false", operations: ["CLICK"] },
    ]);
    expect(space.controls).toEqual([
      { operation: "SCROLL_DOWN", label: "Scroll down" },
      { operation: "WAIT", label: "Wait for the page to update" },
    ]);
    expect(toObservation(snap, space)).toEqual({
      url: snap.url,
      title: snap.title,
      text: snap.text,
      elements: space.elements,
      controls: space.controls,
      fingerprint: "fp-flights-1",
      omitted_actions: 3,
    });
  });

  it("maps (operation, target) to exactly one snapshot action", () => {
    const space = actionSpace(flightsSnapshot().actions);
    const id = (op: Operation, target?: string | number) => resolveAct(space, op, target).action.id;
    expect(id("CLICK", 1)).toBe("e2");
    expect(id("TYPE_TEXT", "1")).toBe("e1");
    expect(id("CLICK", "2")).toBe("e3");
    expect(id("SELECT", "3:1")).toBe("e4");
    expect(id("SELECT", "3:2")).toBe("e5");
    expect(id("SELECT", "3:3")).toBe("e6");
    expect(id("CLICK", 4)).toBe("e7");
    expect(id("SCROLL_DOWN")).toBe("scroll_down");
    expect(id("WAIT", "ignored")).toBe("wait");
    expect(resolveAct(space, "SELECT", "3:2").target).toBe("3:2");
    expect(resolveAct(space, "WAIT", undefined).target).toBeNull();
  });

  it("rejects anything outside the table with target_invalid and a short hint", () => {
    const space = actionSpace(flightsSnapshot().actions);
    expect(codeOf(() => resolveAct(space, "TYPE_TEXT", 2))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "CLICK", 3))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "CLICK", 99))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "CLICK", "#submit"))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "SELECT", "3:4"))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "SCROLL_UP", undefined))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "CLICK", undefined))).toBe("invalid_args");
    try {
      resolveAct(space, "SELECT", "3");
    } catch (err) {
      expect((err as DaemonError).message).toContain("3:1, 3:2, 3:3");
      expect((err as DaemonError).message).toContain('"3:1"');
    }
    try {
      resolveAct(space, "TYPE_TEXT", 5);
    } catch (err) {
      expect((err as DaemonError).message).toMatch(/valid TYPE_TEXT targets: 1$/);
    }
  });

  it("caps the hint for large tables", () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({ id: `e${i + 1}`, kind: "click" as const, label: `L${i}`, node: i }));
    const space = actionSpace(actions);
    try {
      resolveAct(space, "CLICK", 41);
      expect.unreachable();
    } catch (err) {
      expect((err as DaemonError).message).toContain("(40 total)");
      expect((err as DaemonError).message.length).toBeLessThan(200);
    }
  });
});

describe("scroll areas", () => {
  const ids = (space: ReturnType<typeof actionSpace>, op: Operation, target?: string | number) => resolveAct(space, op, target).action.id;

  it("lists each area's scroll controls with an s<n> target; no target scrolls the first listed one", () => {
    const space = actionSpace(modalSnapshot().actions);
    expect(space.controls).toEqual([
      { operation: "SCROLL_DOWN", label: 'Scroll down in "Provider settings" dialog', target: "s1" },
      { operation: "WAIT", label: "Wait for the page to update" },
    ]);
    expect(ids(space, "SCROLL_DOWN")).toBe("scroll_down_1");
    expect(ids(space, "SCROLL_DOWN", "s1")).toBe("scroll_down_1");
    expect(ids(space, "SCROLL_DOWN", " S1 ")).toBe("scroll_down_1");
    expect(resolveAct(space, "SCROLL_DOWN", "s1").target).toBe("s1");
    expect(resolveAct(space, "SCROLL_DOWN", undefined).target).toBeNull();
    expect(codeOf(() => resolveAct(space, "SCROLL_UP", undefined))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "SCROLL_DOWN", "page"))).toBe("target_invalid");
    expect(codeOf(() => resolveAct(space, "SCROLL_DOWN", 1))).toBe("target_invalid");
    try {
      resolveAct(space, "SCROLL_DOWN", 2);
    } catch (err) {
      expect((err as DaemonError).message).toContain("valid SCROLL_DOWN targets: s1");
    }
    const scrolled = actionSpace(modalSnapshot(true).actions);
    expect(ids(scrolled, "SCROLL_UP", "s1")).toBe("scroll_up_1");
    expect(scrolled.controls.map((c) => [c.operation, c.target])).toEqual([
      ["SCROLL_DOWN", "s1"],
      ["SCROLL_UP", "s1"],
      ["WAIT", undefined],
    ]);
  });

  it("without a modal the page stays first and untargeted; areas follow with their targets", () => {
    const space = actionSpace(panelsSnapshot().actions);
    expect(space.controls).toEqual([
      { operation: "SCROLL_DOWN", label: "Scroll down" },
      { operation: "SCROLL_DOWN", label: 'Scroll down in "Messages" panel', target: "s1" },
      { operation: "SCROLL_DOWN", label: 'Scroll down in "Activity" panel', target: "s2" },
      { operation: "SCROLL_UP", label: 'Scroll up in "Activity" panel', target: "s2" },
      { operation: "WAIT", label: "Wait for the page to update" },
    ]);
    expect(ids(space, "SCROLL_DOWN")).toBe("scroll_down");
    expect(ids(space, "SCROLL_DOWN", "page")).toBe("scroll_down");
    expect(ids(space, "SCROLL_DOWN", "s2")).toBe("scroll_down_2");
    expect(ids(space, "SCROLL_UP")).toBe("scroll_up_2");
    expect(space.controlActions.get("SCROLL_DOWN")?.id).toBe("scroll_down");
  });

  it("a page listed after a modal's area gets the explicit target \"page\"", () => {
    const actions = [
      { id: "scroll_down_1", kind: "scroll" as const, node: 40, label: 'Scroll down in "Provider settings" dialog' },
      { id: "scroll_down", kind: "scroll" as const, label: "Scroll down the page" },
    ];
    const space = actionSpace(actions);
    expect(space.controls).toEqual([
      { operation: "SCROLL_DOWN", label: 'Scroll down in "Provider settings" dialog', target: "s1" },
      { operation: "SCROLL_DOWN", label: "Scroll down the page", target: "page" },
    ]);
    expect(ids(space, "SCROLL_DOWN")).toBe("scroll_down_1");
    expect(ids(space, "SCROLL_DOWN", "page")).toBe("scroll_down");
  });

  it("scrollChoices lists only operations with more than one scroll target, in order", () => {
    expect([...scrollChoices(actionSpace(flightsSnapshot().actions)).keys()]).toEqual([]);
    expect([...scrollChoices(actionSpace(modalSnapshot().actions)).keys()]).toEqual([]);
    const choices = scrollChoices(actionSpace(panelsSnapshot().actions));
    expect([...choices.keys()]).toEqual(["SCROLL_DOWN"]);
    expect([...choices.get("SCROLL_DOWN")!.keys()]).toEqual(["page", "s1", "s2"]);
  });
});

describe("ObservationCache", () => {
  it("keeps only the latest fingerprint per (session, tab)", () => {
    const cache = new ObservationCache();
    const space = actionSpace(flightsSnapshot().actions);
    cache.set("AAAAAAAA", 1, "fp1", space);
    expect(cache.require("AAAAAAAA", 1, "fp1")).toBe(space);
    cache.set("AAAAAAAA", 1, "fp2", space);
    expect(codeOf(() => cache.require("AAAAAAAA", 1, "fp1"))).toBe("stale_page");
    expect(codeOf(() => cache.require("BBBBBBBB", 1, "fp2"))).toBe("stale_page");
    cache.set("AAAAAAAA", 2, "fp3", space);
    cache.forgetTab(1);
    expect(codeOf(() => cache.require("AAAAAAAA", 1, "fp2"))).toBe("stale_page");
    cache.forgetSession("AAAAAAAA");
    expect(cache.size).toBe(0);
  });
});
