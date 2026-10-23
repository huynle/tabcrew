import { beforeEach, describe, expect, it } from "vitest";
import type { V2Request } from "@tabcrew/shared/v2";
import { CdpManager } from "./cdp.js";
import { handleRequest } from "./ops.js";
import { PageController, SNAPSHOT_ATTEMPTS, type RawAction, type RawSnapshot } from "./snapshot/controller.js";
import { canonicalJson, fingerprint } from "./snapshot/fingerprint.js";
import { MARKER_SOURCE, SNAPSHOT_SOURCE, guardSource, scrolledSource, scrollPointSource, settleSource, targetSource } from "./snapshot/scripts.js";
import { TabManager } from "./tabs.js";
import { createFakeChrome } from "./test/fakes.js";

const TAB = 7;

function rawPage(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  const actions: RawAction[] = [
    { id: "e1", kind: "click", label: "Continue", node: 1, role: "button", value: "", rect: { x: 10, y: 10, w: 100, h: 40 } },
    { id: "e2", kind: "fill", label: "City", node: 2, role: "textbox", value: "Zurich", rect: { x: 10, y: 60, w: 200, h: 30 } },
    { id: "e3", kind: "click", label: "Open City", node: 2, role: "textbox", value: "Zurich", rect: { x: 10, y: 60, w: 200, h: 30 } },
    { id: "e4", kind: "select", label: "Category → Design", node: 3, role: "combobox", value: "Design", current_value: "All", rect: { x: 10, y: 100, w: 120, h: 30 } },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    { id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ];
  return {
    url: "https://fixture.test/",
    title: "Fixture",
    w: 1000,
    h: 800,
    text: "Cart total: $10",
    scroll: { y: 0, height: 3000 },
    actions,
    marker: ["t0", "https://fixture.test/", "Cart total: $10"],
    page_key: ["t0", "https://fixture.test/", 0, 0, [[2, "Zurich"]]],
    guards: { "1": [1, "button", "Continue"], "2": [2, "textbox", "City"], "3": [3, "combobox", "Category"] },
    omitted_actions: 0,
    ...overrides,
  };
}

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

/** Scripted page behind a fake CDP `send`. */
class FakePage {
  calls: Call[] = [];
  /** What the next snapshot/marker/guard evaluations see. */
  current: RawSnapshot | null = rawPage();
  snapshotQueue: (RawSnapshot | null | "throw")[] = [];
  target: unknown = { x: 60, y: 30 };
  targetThrows = false;
  failInput: string | null = null;
  scrollPoint: unknown = { x: 500, y: 300, top: 0 };
  scrolledThrows = false;

  send = async (_tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ method, params });
    if (method.startsWith("Input.")) {
      if (this.failInput === (params?.type ?? method)) throw new Error("Inspected target navigated or closed");
      return {};
    }
    if (method !== "Runtime.evaluate") return {};
    const expr = String(params?.expression);
    const value = (v: unknown) => ({ result: { type: "object", value: structuredClone(v) } });
    if (expr.startsWith("/*cu:snapshot*/")) {
      const next = this.snapshotQueue.length ? this.snapshotQueue.shift()! : this.current;
      if (next === "throw") return { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x\n at y" } } };
      return value(next);
    }
    if (expr.startsWith("/*cu:marker*/")) return value(this.current?.marker ?? null);
    if (expr.startsWith("/*cu:guard*/")) {
      const node = /nodes\.get\((\d+)\)/.exec(expr)![1]!;
      return value(this.current ? [this.current.page_key, this.current.guards[node] ?? null] : null);
    }
    if (expr.startsWith("/*cu:target*/")) {
      if (this.targetThrows) return { exceptionDetails: { text: "Execution context was destroyed." } };
      return value(this.target);
    }
    if (expr.startsWith("/*cu:settle*/")) return value(true);
    if (expr.startsWith("/*cu:scrollpoint*/")) return value(this.scrollPoint);
    if (expr.startsWith("/*cu:scrolled*/")) {
      if (this.scrolledThrows) return { exceptionDetails: { text: "Execution context was destroyed." } };
      return value({ top: 240, by: "wheel" });
    }
    throw new Error(`unexpected expression ${expr.slice(0, 40)}`);
  };

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  inputs(): Call[] {
    return this.calls.filter((c) => c.method.startsWith("Input."));
  }
  evaluations(tag: string): Call[] {
    return this.calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).startsWith(`/*cu:${tag}*/`));
  }
}

let fake: FakePage;
let page: PageController;
let mac: boolean;
let slept: number[];

beforeEach(() => {
  fake = new FakePage();
  mac = true;
  slept = [];
  page = new PageController({
    send: fake.send,
    isMac: async () => mac,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
});

async function observe() {
  const snap = await page.snapshot(TAB);
  fake.calls = [];
  return snap;
}

describe("fingerprint", () => {
  const base = { url: "https://a/", text: "hello", actions: [{ id: "e1", kind: "click", label: "Go", node: 1 }], scroll: { y: 0, height: 100 } };

  it("is stable for equal content regardless of key order", async () => {
    const reordered = { scroll: { height: 100, y: 0 }, actions: [{ node: 1, label: "Go", kind: "click", id: "e1" }], text: "hello", url: "https://a/" };
    const a = await fingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(reordered)).toBe(a);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it.each([
    ["url", { url: "https://b/" }],
    ["text", { text: "hello!" }],
    ["actions", { actions: [{ id: "e1", kind: "click", label: "Stop", node: 1 }] }],
    ["scroll", { scroll: { y: 560, height: 100 } }],
  ])("changes with %s", async (_name, change) => {
    expect(await fingerprint({ ...base, ...change })).not.toBe(await fingerprint(base));
  });

  it("snapshots of identical pages share a fingerprint; a text change alters it", async () => {
    const a = await page.snapshot(TAB);
    const b = await page.snapshot(TAB);
    expect(b.fingerprint).toBe(a.fingerprint);
    fake.current = rawPage({ text: "Cart total: $100" });
    expect((await page.snapshot(TAB)).fingerprint).not.toBe(a.fingerprint);
  });
});

describe("snapshot", () => {
  it("returns the wire shape without geometry or private freshness data", async () => {
    const snap = await page.snapshot(TAB);
    expect(snap).toMatchObject({ url: "https://fixture.test/", title: "Fixture", viewport: { w: 1000, h: 800 }, scroll: { y: 0, height: 3000 } });
    const json = JSON.stringify(snap);
    for (const secret of ["rect", "page_key", "guards", "marker", "delta"]) expect(json).not.toContain(secret);
    expect(snap.actions.map((a) => a.id)).toEqual(["e1", "e2", "e3", "e4", "scroll_down", "scroll_up", "wait"]);
    expect(snap.actions[3]).toEqual({ id: "e4", kind: "select", label: "Category → Design", node: 3, role: "combobox", value: "Design", current_value: "All" });
    expect(fake.evaluations("snapshot")[0]!.params).toEqual({ expression: SNAPSHOT_SOURCE, returnByValue: true });
  });

  it("retries a navigating document and evaluation exceptions", async () => {
    fake.snapshotQueue = [null, "throw", null];
    const snap = await page.snapshot(TAB);
    expect(snap.url).toBe("https://fixture.test/");
    expect(fake.evaluations("snapshot")).toHaveLength(4);
    expect(slept).toEqual([20, 20, 20]);
  });

  it("fails with stale_page after 10 attempts", async () => {
    fake.current = null;
    await expect(page.snapshot(TAB)).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.evaluations("snapshot")).toHaveLength(SNAPSHOT_ATTEMPTS);
  });
});

describe("act: checks before input", () => {
  it("stale fingerprint → stale_page without any input", async () => {
    await observe();
    await expect(page.act(TAB, { fingerprint: "0".repeat(64), action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.calls).toEqual([]);
  });

  it("no snapshot yet (or forgotten after navigation) → stale_page", async () => {
    const snap = await observe();
    page.forget(TAB);
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.calls).toEqual([]);
  });

  it("unknown action id → target_invalid", async () => {
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e99" })).rejects.toMatchObject({ code: "target_invalid" });
    expect(fake.inputs()).toEqual([]);
  });

  it("click: changed node guard → stale_page without input", async () => {
    const snap = await observe();
    fake.current = rawPage({ guards: { ...rawPage().guards, "1": [1, "button", "Delete account"] } });
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.evaluations("guard")).toHaveLength(1);
    expect(fake.evaluations("target")).toHaveLength(0);
    expect(fake.inputs()).toEqual([]);
  });

  it("click: changed page key (e.g. a form value) → stale_page without input", async () => {
    const snap = await observe();
    fake.current = rawPage({ page_key: ["t0", "https://fixture.test/", 0, 0, [[2, "London"]]] });
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.inputs()).toEqual([]);
  });

  it("click ignores unrelated changes that only the full marker sees", async () => {
    const snap = await observe();
    fake.current = rawPage({ marker: ["t0", "https://fixture.test/", "News updated"] });
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).resolves.toMatchObject({ executed: "e1" });
  });

  it("fill: changed marker → stale_page without input", async () => {
    const snap = await observe();
    fake.current = rawPage({ marker: ["t0", "https://fixture.test/", "Cart total: $100"] });
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2", text: "London" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.evaluations("marker")).toHaveLength(1);
    expect(fake.evaluations("guard")).toHaveLength(0);
    expect(fake.inputs()).toEqual([]);
  });

  it("freshness evaluation exception → stale_page", async () => {
    const snap = await observe();
    const send = fake.send;
    fake.send = async (t, m, p) => (String(p?.expression).startsWith("/*cu:guard*/") ? { exceptionDetails: { text: "boom" } } : send(t, m, p));
    page = new PageController({ send: (t, m, p) => fake.send(t, m, p), isMac: async () => true, sleep: async () => undefined });
    // The new controller has no snapshot; take one then make the guard throw.
    const fresh = await page.snapshot(TAB);
    expect(fresh.fingerprint).toBe(snap.fingerprint);
    await expect(page.act(TAB, { fingerprint: fresh.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.inputs()).toEqual([]);
  });

  it("covered target → target_covered without input", async () => {
    const snap = await observe();
    fake.target = { error: "target_covered", message: "Another element covers the target." };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "target_covered" });
    expect(fake.inputs()).toEqual([]);
  });

  it.each(["disabled", "hidden", "read-only", "outside the viewport"])("%s target → target_invalid without input", async (why) => {
    const snap = await observe();
    fake.target = { error: "target_invalid", message: `The target is ${why}.` };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2", text: "x" })).rejects.toMatchObject({ code: "target_invalid" });
    expect(fake.inputs()).toEqual([]);
  });

  it("select with a missing option → target_invalid (nothing executed, not outcome_unknown)", async () => {
    const snap = await observe();
    fake.target = { error: "target_invalid", message: "The observed option is no longer available." };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e4" })).rejects.toMatchObject({ code: "target_invalid" });
  });

  it("fill without text is rejected before touching the page", async () => {
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2" })).rejects.toMatchObject({
      code: "target_invalid",
      message: expect.stringContaining("text"),
    });
    expect(fake.calls).toEqual([]);
  });
});

describe("act: input", () => {
  it("click presses and releases at the re-resolved centre", async () => {
    const snap = await observe();
    fake.target = { x: 260, y: 30 }; // moved since the snapshot
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" });
    expect(fake.inputs().map((c) => c.params)).toEqual([
      { type: "mousePressed", x: 260, y: 30, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 260, y: 30, button: "left", clickCount: 1 },
    ]);
    expect(String(fake.evaluations("target")[0]!.params!.expression)).toBe(targetSource({ node: 1, kind: "click", value: "" }));
  });

  it.each([
    [true, 4],
    [false, 2],
  ])("fill (mac=%s) clicks, selects all with modifier %i, then inserts text", async (isMac, modifiers) => {
    mac = isMac;
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2", text: "London" });
    expect(fake.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 60, y: 30, button: "left", clickCount: 1 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 60, y: 30, button: "left", clickCount: 1 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"] } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA", modifiers } },
      { method: "Input.insertText", params: { text: "London" } },
    ]);
  });

  it("select sets the value through the target evaluation and sends no mouse events", async () => {
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e4" });
    expect(fake.inputs()).toEqual([]);
    const expr = String(fake.evaluations("target")[0]!.params!.expression);
    expect(expr).toBe(targetSource({ node: 3, kind: "select", value: "Design" }));
    expect(expr).toContain('"value":"Design"');
  });

  it.each([
    ["scroll_down", 560],
    ["scroll_up", -560],
  ])("%s sends one mouseWheel of %i at the viewport centre", async (id, delta) => {
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: id });
    expect(fake.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: delta } },
    ]);
    expect(fake.evaluations("marker")).toHaveLength(1);
  });

  it("wait sleeps 100 ms, sends no input and skips the settle wait", async () => {
    const snap = await observe();
    const result = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "wait" });
    expect(result).toEqual({ executed: "wait", page_changed: false });
    expect(slept).toContain(100);
    expect(fake.inputs()).toEqual([]);
    expect(fake.evaluations("settle")).toHaveLength(0);
  });

  it("settles after input, then snapshots once", async () => {
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2", text: "Lon" });
    const order = fake.calls.map((c) => (c.method === "Runtime.evaluate" ? String(c.params!.expression).slice(0, 14) : c.method));
    expect(order.at(-2)).toBe("/*cu:settle*/(");
    expect(order.at(-1)).toBe("/*cu:snapshot*");
    const settle = fake.evaluations("settle")[0]!.params!;
    expect(settle).toMatchObject({ awaitPromise: true, returnByValue: true, expression: settleSource({ node: 2, kind: "fill" }) });
  });
});

describe("act: outcome", () => {
  it("page_changed reflects the post-input snapshot, which becomes the latest", async () => {
    const snap = await observe();
    fake.snapshotQueue = [rawPage({ text: "Clicked" })];
    const result = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" });
    expect(result).toEqual({ executed: "e1", page_changed: true });
    expect(page.latest(TAB)!.fingerprint).not.toBe(snap.fingerprint);
    // The old fingerprint is no longer accepted.
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
  });

  it("page_changed is false when nothing visible changed", async () => {
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).resolves.toEqual({ executed: "e1", page_changed: false });
    expect(page.latest(TAB)!.fingerprint).toBe(snap.fingerprint);
  });

  it("page_changed is null when the post-input snapshot fails (navigation)", async () => {
    const snap = await observe();
    fake.snapshotQueue = Array(SNAPSHOT_ATTEMPTS).fill(null);
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).resolves.toEqual({ executed: "e1", page_changed: null });
    expect(page.latest(TAB)).toBeUndefined();
  });

  it("an error after input dispatch began → outcome_unknown, never retried", async () => {
    const snap = await observe();
    fake.failInput = "Input.insertText";
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e2", text: "London" })).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fake.calls.filter((c) => c.method === "Input.insertText")).toHaveLength(1);
    expect(page.latest(TAB)).toBeUndefined();
  });

  it("a click interrupted between press and release → outcome_unknown", async () => {
    const snap = await observe();
    fake.failInput = "mouseReleased";
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("a select whose evaluation is destroyed mid-way → outcome_unknown", async () => {
    const snap = await observe();
    fake.targetThrows = true;
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e4" })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("a click whose target evaluation throws executed nothing → stale_page", async () => {
    const snap = await observe();
    fake.targetThrows = true;
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.inputs()).toEqual([]);
  });
});

describe("act: scrollable containers", () => {
  const AREA: RawAction = { id: "scroll_down_1", kind: "scroll", label: 'Scroll down in "Provider settings" dialog', node: 9, delta: 240 };
  const withArea = () => rawPage({ actions: [...rawPage().actions.slice(0, 4), AREA, ...rawPage().actions.slice(4)] });

  it("wheels at the area's own point, then confirms (or falls back to) the area scroll", async () => {
    fake.current = withArea();
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down_1" })).resolves.toMatchObject({ executed: "scroll_down_1" });
    expect(fake.evaluations("marker")).toHaveLength(1);
    expect(String(fake.evaluations("scrollpoint")[0]!.params!.expression)).toBe(scrollPointSource({ node: 9, delta: 240 }));
    expect(fake.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 500, y: 300, deltaX: 0, deltaY: 240 } },
    ]);
    const scrolled = fake.evaluations("scrolled")[0]!.params!;
    expect(scrolled).toMatchObject({ awaitPromise: true, expression: scrolledSource({ node: 9, top: 0, delta: 240, wheel: true }) });
  });

  it("without a point that reaches the area, scrolls it by script and sends no input", async () => {
    fake.current = withArea();
    fake.scrollPoint = { x: null, top: 12 };
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down_1" });
    expect(fake.inputs()).toEqual([]);
    expect(String(fake.evaluations("scrolled")[0]!.params!.expression)).toBe(scrolledSource({ node: 9, top: 12, delta: 240, wheel: false }));
  });

  it("a vanished area → its error, nothing executed", async () => {
    fake.current = withArea();
    fake.scrollPoint = { error: "stale_page", message: "The scroll area is no longer in the page. Observe again." };
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down_1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.inputs()).toEqual([]);
    expect(fake.evaluations("scrolled")).toHaveLength(0);
  });

  it("a changed marker (e.g. the area scrolled meanwhile) → stale_page before anything", async () => {
    fake.current = withArea();
    const snap = await observe();
    fake.current = { ...withArea(), marker: ["t0", "https://fixture.test/", "Cart total: $10", [[9, 80]]] };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down_1" })).rejects.toMatchObject({ code: "stale_page" });
    expect(fake.evaluations("scrollpoint")).toHaveLength(0);
    expect(fake.inputs()).toEqual([]);
  });

  it("a failure after the wheel → outcome_unknown", async () => {
    fake.current = withArea();
    fake.scrolledThrows = true;
    const snap = await observe();
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down_1" })).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(page.latest(TAB)).toBeUndefined();
  });

  it("page scroll is unchanged: one wheel at the viewport centre, no area scripts", async () => {
    fake.current = withArea();
    const snap = await observe();
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "scroll_down" });
    expect(fake.evaluations("scrollpoint")).toHaveLength(0);
    expect(fake.evaluations("scrolled")).toHaveLength(0);
    expect(fake.inputs()).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 560 } },
    ]);
  });
});

describe("act: scroll into view before input", () => {
  it("the target check may reveal the target (awaited); the click lands at the revealed centre", async () => {
    const snap = await observe();
    fake.target = { x: 300, y: 420, revealed: true };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).resolves.toMatchObject({ executed: "e1" });
    expect(fake.evaluations("target")[0]!.params).toMatchObject({ awaitPromise: true });
    expect(fake.inputs().map((c) => c.params)).toEqual([
      { type: "mousePressed", x: 300, y: 420, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 300, y: 420, button: "left", clickCount: 1 },
    ]);
  });

  it("still covered after revealing → target_covered, no input, and the scrolled page must be observed again", async () => {
    const snap = await observe();
    fake.target = { error: "target_covered", message: "Another element covers the target.", revealed: true };
    const err = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" }).catch((e) => e);
    expect(err).toMatchObject({ code: "target_covered", message: expect.stringContaining("scrolled") });
    expect(fake.inputs()).toEqual([]);
    expect(page.latest(TAB)).toBeUndefined();
  });

  it("an error without revealing keeps the observation (nothing changed)", async () => {
    const snap = await observe();
    fake.target = { error: "target_covered", message: "Another element covers the target." };
    await expect(page.act(TAB, { fingerprint: snap.fingerprint, action_id: "e1" })).rejects.toMatchObject({ code: "target_covered" });
    expect(page.latest(TAB)?.fingerprint).toBe(snap.fingerprint);
  });
});

describe("page scripts", () => {
  const sources = {
    snapshot: SNAPSHOT_SOURCE,
    marker: MARKER_SOURCE,
    guard: guardSource(12),
    target: targetSource({ node: 3, kind: "select", value: 'a"b' }),
    settle: settleSource({ node: 2, kind: "fill" }),
    scrollpoint: scrollPointSource({ node: 9, delta: -240 }),
    scrolled: scrolledSource({ node: 9, top: 40, delta: -240, wheel: true }),
  };

  it.each(Object.entries(sources))("%s is a valid JS expression", (_name, source) => {
    expect(() => new Function(`return ${source};`)).not.toThrow();
  });

  it("never reads password, file or hidden input values", () => {
    expect(SNAPSHOT_SOURCE).toContain("const safe = e => !['password','file','hidden'].includes(e.type);");
    // Every place that reads control values filters through `safe` first.
    expect(SNAPSHOT_SOURCE).toContain("[...document.querySelectorAll('input,textarea,select')].filter(safe)");
    expect(SNAPSHOT_SOURCE).toContain("if (!safe(e) || !visible(e)");
    expect(SNAPSHOT_SOURCE).not.toMatch(/type\s*===?\s*['"]password['"]/);
  });
});

describe("ownership", () => {
  const alice = { short_id: "aaaa1111", label: "alice" };
  const bob = { short_id: "bbbb2222", label: "bob" };

  it("snapshot and act reject tabs outside the caller's session", async () => {
    const chromeFake = createFakeChrome();
    chromeFake.install();
    const tabs = new TabManager(() => undefined);
    const cdp = new CdpManager();
    const deps = { tabs, cdp, page };
    const call = (session: typeof alice, op: V2Request["op"], args: object) =>
      handleRequest({ type: "request", id: "x", op, session, args } as V2Request, deps);

    const bobTab = (await call(bob, "tab_create", {})) as { tab_id: number };
    await expect(call(alice, "snapshot", { tab_id: bobTab.tab_id })).rejects.toMatchObject({ code: "tab_not_owned" });
    await expect(call(alice, "act", { tab_id: bobTab.tab_id, fingerprint: "f", action_id: "e1" })).rejects.toMatchObject({ code: "tab_not_owned" });
    expect(fake.calls).toEqual([]);

    const own = (await call(bob, "snapshot", { tab_id: bobTab.tab_id })) as { fingerprint: string };
    expect(own.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(call(bob, "act", { tab_id: bobTab.tab_id, fingerprint: own.fingerprint, action_id: "e1" })).resolves.toMatchObject({ executed: "e1" });
    await expect(call(bob, "snapshot", { tab_id: 999 })).rejects.toMatchObject({ code: "tab_gone" });
  });
});
