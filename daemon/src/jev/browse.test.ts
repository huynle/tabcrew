import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { V2Request, V2Snapshot } from "@tabcrew/shared/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningDaemon } from "../daemon.js";
import { setLogSink } from "../log.js";
import { flightsSnapshot } from "../testing/fixtures.js";
import { call, FakeExtension, mcpClient, simpleSnapshot, startTestDaemon, tempHome, until, WireError } from "../testing/helpers.js";
import { CHAT_DECISION } from "./chat.js";
import { NEXT_ACTION, TEXT_VALUE } from "./questions.js";

// ---------------------------------------------------------------------------
// Mocked OpenRouter: every request to openrouter.ai is answered here; MCP traffic passes through.
// ---------------------------------------------------------------------------

interface ModelCall {
  readonly url: string;
  readonly body: any;
  readonly auth: string | null;
}

type Reply = Response | Promise<Response>;
const realFetch = globalThis.fetch;
let modelCalls: ModelCall[];
let onDecision: (body: any, n: number) => Reply;
let onText: (body: any, n: number) => Reply;
let onChat: (body: any, n: number) => Reply;

const decisionCalls = () => modelCalls.filter((c) => c.url.endsWith("/api/alpha/decisions"));
const isChatDecision = (body: any) => body?.messages?.[0]?.content === CHAT_DECISION;
const textCalls = () => modelCalls.filter((c) => c.url.endsWith("/chat/completions") && !isChatDecision(c.body));
const chatCalls = () => modelCalls.filter((c) => c.url.endsWith("/chat/completions") && isChatDecision(c.body));

function chatReply(content: unknown) {
  return Response.json({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 1500, completion_tokens: 30, cost: 0.0005 },
  });
}

function pick(criteria: Record<string, unknown>, choice: string, p = 0.9) {
  const ids = Object.keys(criteria);
  const rest = ids.length > 1 ? (1 - p) / (ids.length - 1) : 0;
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === choice ? (ids.length > 1 ? p : 1) : rest]));
  return { choice, probabilities, confidence: 0.8 };
}

/** A valid Jev answer for this request: `operation` plus a valid choice for every target head. */
function jev(body: any, operation: string, target?: string, patch: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries<any>(body.questions)) {
    const keys = Object.keys(q.criteria);
    if (name === "operation") answers[name] = pick(q.criteria, operation);
    else answers[name] = pick(q.criteria, name === `${operation.toLowerCase()}_target` && target ? target : keys[0]);
  }
  return Response.json({
    model: "typesafe/jev-1.13",
    answers: { ...answers, ...patch },
    usage: { input_tokens: 1000, output_tokens: 10, cost: 0.001 },
  });
}

/** Decisions answered in order from a script of [operation, target?]. */
function script(...moves: [string, string?][]) {
  onDecision = (body, n) => {
    const [op, target] = moves[Math.min(n, moves.length - 1)];
    return jev(body, op, target);
  };
}

function textReply(content: string) {
  return Response.json({ choices: [{ message: { content } }], usage: { cost: 0.0001 } });
}

// ---------------------------------------------------------------------------
// Daemon + fake extension
// ---------------------------------------------------------------------------

let home: string;
let cleanupHome: () => void;
let daemon: RunningDaemon | null;
const clients: Client[] = [];
const extensions: FakeExtension[] = [];

beforeEach(() => {
  ({ home, cleanup: cleanupHome } = tempHome());
  daemon = null;
  modelCalls = [];
  onDecision = (body) => jev(body, "DONE");
  onText = () => textReply('{"text": "Zurich"}');
  onChat = () => chatReply({ operation: "DONE", target: null, confidence: 0.9, reason: "done" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://openrouter.ai/") && !url.startsWith("https://llm.example/")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    modelCalls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/alpha/decisions")) return onDecision(body, decisionCalls().length - 1);
    return isChatDecision(body) ? onChat(body, chatCalls().length - 1) : onText(body, textCalls().length - 1);
  });
});

afterEach(async () => {
  for (const ext of extensions.splice(0)) ext.ws.terminate();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await daemon?.close();
  cleanupHome();
  vi.unstubAllGlobals();
  setLogSink(() => {});
});

async function setup(env: Record<string, string> = { OPENROUTER_API_KEY: "test-key" }) {
  daemon = await startTestDaemon(home, { modelRetryBaseMs: 1 }, env);
  const client = await mcpClient(daemon.mcpPort, daemon.token);
  clients.push(client);
  const ext = await FakeExtension.connect(daemon.extensionPort, daemon.token);
  extensions.push(ext);
  return { d: daemon, client, ext };
}

async function openWithTab(client: Client, ext: FakeExtension, snapshot?: (tab: number) => V2Snapshot) {
  const s = await call(client, "session_open", { label: "jev" });
  if (!s.ok) throw new Error("open failed");
  const t = await call(client, "tab_create", { session: s.value.session, url: "https://example.com/" });
  if (!t.ok) throw new Error("tab_create failed");
  const tab = t.value.tab_id as number;
  if (snapshot) ext.snapshots.set(tab, snapshot(tab));
  return { S: s.value.session as string, short_id: s.value.short_id as string, tab };
}

const acts = (ext: FakeExtension) => ext.requests.filter((r) => r.op === "act");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every act changes the page (new fingerprint), unless `fail` throws for it. */
function progressing(ext: FakeExtension, tab: number, fail?: (req: V2Request, n: number) => void) {
  let n = 0;
  ext.handler = (req) => {
    if (req.op === "act") {
      fail?.(req, n++);
      const snap = ext.snapshots.get(tab) ?? simpleSnapshot(tab);
      ext.snapshots.set(tab, { ...snap, fingerprint: `${snap.fingerprint}+` });
    }
    return ext.simulate(req);
  };
}

async function browse(client: Client, args: Record<string, unknown>) {
  const r = await call(client, "browse", args);
  if (!r.ok) throw new Error(`browse failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("browse request and result", () => {
  it("sends one Decisions call per step with the operation and per-operation target heads", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    progressing(ext, a.tab);
    script(["CLICK", "1"], ["DONE"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Open the origin picker" });

    expect(decisionCalls()).toHaveLength(2);
    expect(textCalls()).toHaveLength(0);
    const [first, second] = decisionCalls();
    expect(first.auth).toBe("Bearer test-key");
    expect(first.body.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(first.body.questions)).toEqual(["operation", "type_text_target", "click_target", "select_target"]);
    expect(Object.keys(first.body.questions.operation.criteria)).toEqual(["TYPE_TEXT", "CLICK", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    expect(first.body.questions.operation.instructions).toEqual({ goal: "Open the origin picker", rules: NEXT_ACTION });
    expect(first.body.state.recent_actions).toEqual([]);
    expect(second.body.state.recent_actions).toEqual([{ action: "Open Where from?", kind: "click", text: null, page_changed: true }]);

    expect(acts(ext).map((q) => q.args)).toEqual([{ tab_id: a.tab, fingerprint: "fp-flights-1", action_id: "e2" }]);
    expect(r.status).toBe("done");
    expect(r.note).toBe("DONE is Jev's claim; verify the page yourself with observe/read the result");
    expect(r.next).toMatch(/session_close/);
    expect(r.next).toMatch(/review/);
    expect(r.steps).toEqual([
      { step: 1, operation: "CLICK", target: "1", label: "Open Where from?", probability: 0.9, confidence: 0.8, page_changed: true, decision_ms: expect.any(Number) },
      { step: 2, operation: "DONE", target: null, label: "DONE", probability: 0.9, confidence: 0.8, page_changed: false, decision_ms: expect.any(Number) },
    ]);
    expect(r.final.url).toBe("https://flights.example/search");
    expect(r.final.title).toBe("Flights");
    expect(r.final.elements).toEqual([
      "[1] combobox Where from? · Zürich",
      "[2] button Search",
      "[3] combobox Sort by · Best",
      "[4] checkbox Nonstop only · on · checked",
      "[5] checkbox Refundable · on",
      "[6] button Passengers",
    ]);
    expect(r.usage).toEqual({ decisions: 2, decision_input_tokens: 2000, decision_cost_usd: 0.002, text_calls: 0, text_cost_usd: 0 });
    expect(r.elapsed_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(r)).not.toContain("Search flights"); // no page text dump
  });

  it("offers only operations the page supports", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    await browse(client, { session: a.S, tab_id: a.tab, goal: "anything" });
    const body = decisionCalls()[0].body;
    expect(Object.keys(body.questions)).toEqual(["operation", "click_target"]);
    expect(Object.keys(body.questions.operation.criteria)).toEqual(["CLICK", "WAIT", "DONE", "BLOCKED"]);
  });

  it("validates its arguments", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    for (const args of [
      { session: a.S, tab_id: a.tab, goal: "x".repeat(2001) },
      { session: a.S, tab_id: a.tab, goal: "   " },
      { session: a.S, tab_id: a.tab, goal: "g", max_steps: 51 },
      { session: a.S, tab_id: a.tab, goal: "g", max_steps: 0 },
    ]) {
      const r = await call(client, "browse", args);
      expect(!r.ok && r.error.code).toBe("invalid_args");
    }
    const other = await call(client, "browse", { session: a.S, tab_id: 9999, goal: "g" });
    expect(!other.ok && other.error.code).toBe("tab_not_owned");
    expect(modelCalls).toHaveLength(0);
  });
});

describe("answer validation", () => {
  it.each([
    ["unknown operation", (b: any) => jev(b, "CLICK", "1", { operation: { choice: "EVAL", probabilities: { EVAL: 1 }, confidence: 1 } })],
    ["probabilities not summing to 1", (b: any) => {
      const ids = Object.keys(b.questions.operation.criteria);
      return jev(b, "CLICK", "1", { operation: { choice: "CLICK", probabilities: Object.fromEntries(ids.map((id) => [id, id === "CLICK" ? 0.5 : 0])), confidence: 0.5 } });
    }],
    ["choice not argmax", (b: any) => {
      const ids = Object.keys(b.questions.operation.criteria);
      return jev(b, "CLICK", "1", { operation: { choice: "CLICK", probabilities: Object.fromEntries(ids.map((id) => [id, id === "WAIT" ? 0.8 : id === "CLICK" ? 0.2 : 0])), confidence: 0.5 } });
    }],
    ["NaN in the body", () => new Response('{"answers": {"operation": {"choice": "WAIT", "probabilities": {"WAIT": NaN}}}}', { status: 200 })],
    ["unknown target", (b: any) => jev(b, "CLICK", "1", { click_target: { choice: "99", probabilities: { "99": 1 }, confidence: 1 } })],
    ["missing answers", () => Response.json({ model: "m" })],
    ["HTTP 500", () => new Response("oops", { status: 500 })],
  ])("stops on %s with model_error and sends no act", async (_name, reply) => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    onDecision = reply;
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "click it" });
    expect(r.status).toBe("model_error");
    expect(r.message).toMatch(/no action executed/);
    expect(r.steps).toEqual([]);
    expect(r.final.url).toBe(`https://example.test/${a.tab}`);
    expect(acts(ext)).toHaveLength(0);
    expect(decisionCalls()).toHaveLength(1);
  });

  it("consumes only the chosen operation's target head", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    progressing(ext, a.tab);
    let n = 0;
    onDecision = (b) => (n++ === 0 ? jev(b, "CLICK", "4", { type_text_target: { choice: "garbage", probabilities: { x: Number.NaN } } }) : jev(b, "DONE"));
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "turn on nonstop" });
    expect(r.status).toBe("done");
    expect(acts(ext).map((q) => (q.args as { action_id: string }).action_id)).toEqual(["e7"]);
    expect(textCalls()).toHaveLength(0);
  });
});

describe("TYPE_TEXT", () => {
  it("calls the text helper once and types its value", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    progressing(ext, a.tab);
    script(["TYPE_TEXT", "1"], ["DONE"]);
    onText = () => textReply('```json\n{"text": "Zurich"}\n```');
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Fly from Zurich" });
    expect(r.status).toBe("done");
    expect(textCalls()).toHaveLength(1);
    const req = textCalls()[0].body;
    expect(req.model).toBe("inception/mercury-2.5");
    expect(req.reasoning).toEqual({ enabled: false });
    expect(req.messages[0]).toEqual({ role: "system", content: TEXT_VALUE });
    expect(JSON.parse(req.messages[1].content)).toMatchObject({
      goal: "Fly from Zurich",
      field: { label: "Where from?", role: "combobox", value: "Zürich" },
      recent_actions: [],
    });
    expect(acts(ext).map((q) => q.args)).toEqual([{ tab_id: a.tab, fingerprint: "fp-flights-1", action_id: "e1", text: "Zurich" }]);
    expect(r.steps[0]).toMatchObject({ operation: "TYPE_TEXT", target: "1", label: "Where from?", text: "Zurich", text_ms: expect.any(Number) });
    expect(r.usage).toMatchObject({ text_calls: 1, text_cost_usd: 0.0001 });
    expect(decisionCalls()[1].body.state.recent_actions[0]).toEqual({ action: "Where from?", kind: "fill", text: "Zurich", page_changed: true });
  });

  it.each([
    ["extra keys", '{"text": "Zurich", "note": "x"}'],
    ["empty", '{"text": ""}'],
    ["too long", JSON.stringify({ text: "x".repeat(2001) })],
  ])("rejects %s from the helper and types nothing", async (_name, content) => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    script(["TYPE_TEXT", "1"]);
    onText = () => textReply(content);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Fly from Zurich" });
    expect(r.status).toBe("model_error");
    expect(r.message).toMatch(/nothing typed/);
    expect(acts(ext)).toHaveLength(0);
  });

  it("reuses the value across a stale retry only while the helper input is identical", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    // First act: stale, page unchanged -> same helper input -> cached value reused.
    progressing(ext, a.tab, (_req, n) => {
      if (n === 0) throw new WireError({ code: "stale_page", message: "changed" });
    });
    script(["TYPE_TEXT", "1"], ["TYPE_TEXT", "1"], ["DONE"]);
    let r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Fly from Zurich" });
    expect(r.status).toBe("done");
    expect(textCalls()).toHaveLength(1);
    expect(acts(ext).map((q) => (q.args as { text?: string }).text)).toEqual(["Zurich", "Zurich"]);
    expect(r.steps.map((s: { operation: string }) => s.operation)).toEqual(["TYPE_TEXT", "DONE"]);

    // Second run: the stale page's text changed -> the helper is asked again.
    modelCalls.length = 0;
    ext.requests.length = 0;
    ext.snapshots.set(a.tab, flightsSnapshot());
    let texts = 0;
    onText = () => textReply(JSON.stringify({ text: `Zurich ${++texts}` }));
    progressing(ext, a.tab, (_req, n) => {
      if (n === 0) {
        ext.snapshots.set(a.tab, { ...flightsSnapshot("fp-other"), text: "Different page text" });
        throw new WireError({ code: "stale_page", message: "changed" });
      }
    });
    script(["TYPE_TEXT", "1"], ["TYPE_TEXT", "1"], ["DONE"]);
    r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Fly from Zurich" });
    expect(r.status).toBe("done");
    expect(textCalls()).toHaveLength(2);
    expect(acts(ext).map((q) => (q.args as { text?: string }).text)).toEqual(["Zurich 1", "Zurich 2"]);
  });
});

describe("loop control", () => {
  it("retries a 429 from Decisions and continues", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    let n = 0;
    onDecision = (b) => (n++ === 0 ? new Response("slow down", { status: 429 }) : jev(b, "DONE"));
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("done");
    expect(decisionCalls()).toHaveLength(2);
    expect(r.usage.decisions).toBe(1);
  });

  it("stops as blocked after 3 non-WAIT actions that do not change the page", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    script(["CLICK", "1"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("blocked");
    expect(r.message).toMatch(/did not change the page/);
    expect(r.steps.map((s: { page_changed: boolean }) => s.page_changed)).toEqual([false, false, false]);
    expect(acts(ext)).toHaveLength(3);
  });

  it("does not count WAIT toward the no-change rule; stops at max_steps", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    script(["WAIT"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g", max_steps: 4 });
    expect(r.status).toBe("max_steps");
    expect(r.steps).toHaveLength(4);
    expect(acts(ext)).toHaveLength(4);
    expect(decisionCalls()).toHaveLength(4);
  });

  it("stops at max_steps on a changing page", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    progressing(ext, a.tab);
    script(["CLICK", "1"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g", max_steps: 2 });
    expect(r.status).toBe("max_steps");
    expect(r.note).toBeUndefined();
    expect(r.next).toMatch(/session_close/);
    expect(r.next).toMatch(/review/);
    expect(acts(ext)).toHaveLength(2);
    expect(decisionCalls()).toHaveLength(2);
  });

  it("stops as blocked when Jev chooses BLOCKED", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    script(["BLOCKED"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("blocked");
    expect(acts(ext)).toHaveLength(0);
  });

  it("decides again when DONE was chosen on a page that has since changed", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    let snaps = 0;
    ext.handler = (req) => {
      if (req.op === "snapshot" && ++snaps === 2) ext.snapshots.set(a.tab, simpleSnapshot(a.tab, "fp-later"));
      return ext.simulate(req);
    };
    script(["DONE"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("done");
    expect(decisionCalls()).toHaveLength(2);
    expect(decisionCalls()[1].body.state.page.url).toBe(`https://example.test/${a.tab}`);
    expect(r.steps).toHaveLength(1);
  });

  it("never retries act: stale_page re-decides outside the step budget, up to 10 times", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    progressing(ext, a.tab, () => {
      throw new WireError({ code: "stale_page", message: "changed" });
    });
    script(["CLICK", "1"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g", max_steps: 3 });
    expect(r.status).toBe("blocked");
    expect(r.message).toMatch(/stale/);
    expect(r.steps).toEqual([]);
    expect(acts(ext)).toHaveLength(11);
    expect(decisionCalls()).toHaveLength(11);
  });

  it("records target_covered and re-observes", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    progressing(ext, a.tab, (_req, n) => {
      if (n === 0) throw new WireError({ code: "target_covered", message: "covered" });
    });
    script(["CLICK", "1"], ["CLICK", "1"], ["DONE"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("done");
    expect(r.steps.map((s: { error?: string; page_changed: boolean }) => [s.error, s.page_changed])).toEqual([
      ["target_covered", false],
      [undefined, true],
      [undefined, false],
    ]);
    expect(acts(ext)).toHaveLength(2);
  });

  it("stops with outcome_unknown when an act's result is unknown", async () => {
    const { client, ext } = await setup();
    const a = await openWithTab(client, ext);
    progressing(ext, a.tab, () => {
      throw new WireError({ code: "outcome_unknown", message: "input sent, result unknown" });
    });
    script(["CLICK", "1"]);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("outcome_unknown");
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].error).toBe("outcome_unknown");
    expect(acts(ext)).toHaveLength(1);
    expect(decisionCalls()).toHaveLength(1);
  });

  it("returns stopped_by_user when Stop arrives mid-run, without acting", async () => {
    const { d, client, ext } = await setup();
    const a = await openWithTab(client, ext);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onDecision = async (b) => {
      await gate;
      return jev(b, "CLICK", "1");
    };
    const running = browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    await until(() => decisionCalls().length === 1);
    ext.send({ type: "event", event: "stop", short_id: a.short_id });
    await until(() => d.registry.getByShortId(a.short_id)?.stopped === true);
    release();
    const r = await running;
    expect(r.status).toBe("stopped_by_user");
    expect(acts(ext)).toHaveLength(0);
    expect(decisionCalls()).toHaveLength(1);
  });

  it("ends at the next step boundary when Stop arrives during an act; later calls get stopped_by_user", async () => {
    const { d, client, ext } = await setup();
    const a = await openWithTab(client, ext);
    let releaseAct!: () => void;
    const actGate = new Promise<void>((r) => (releaseAct = r));
    ext.handler = async (req) => {
      if (req.op === "act") {
        await actGate;
        const snap = ext.snapshots.get(a.tab) ?? simpleSnapshot(a.tab);
        ext.snapshots.set(a.tab, { ...snap, fingerprint: `${snap.fingerprint}+` });
      }
      return ext.simulate(req);
    };
    script(["CLICK", "1"], ["CLICK", "1"], ["DONE"]);
    const running = browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    await until(() => acts(ext).length === 1);
    ext.send({ type: "event", event: "stop", short_id: a.short_id });
    await until(() => d.registry.getByShortId(a.short_id)?.stopped === true);
    const snapshotsBefore = ext.requests.filter((r) => r.op === "snapshot").length;
    releaseAct();
    const r = await running;
    expect(r.status).toBe("stopped_by_user");
    // The in-flight action is recorded; nothing further is observed, decided or executed.
    expect(r.steps.map((s: { operation: string }) => s.operation)).toEqual(["CLICK"]);
    expect(acts(ext)).toHaveLength(1);
    expect(decisionCalls()).toHaveLength(1);
    expect(ext.requests.filter((q) => q.op === "snapshot")).toHaveLength(snapshotsBefore);

    for (const [name, args] of [
      ["browse", { goal: "again" }],
      ["observe", {}],
      ["navigate", { action: "reload" }],
      ["read_text", {}],
    ] as const) {
      const later = await call(client, name, { session: a.S, tab_id: a.tab, ...args });
      expect(later.ok ? "ok" : later.error.code).toBe("stopped_by_user");
    }
    expect(decisionCalls()).toHaveLength(1);
  });

  it("returns model_error before any request when OPENROUTER_API_KEY is missing", async () => {
    const { client, ext } = await setup({});
    const a = await openWithTab(client, ext);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("model_error");
    expect(r.message).toContain("set OPENROUTER_API_KEY in ~/.tabcrew/env");
    expect(modelCalls).toHaveLength(0);
    expect(acts(ext)).toHaveLength(0);
  });

  it("caps concurrent loops at browse_concurrency; excess calls wait in order", async () => {
    const { client, ext } = await setup({ OPENROUTER_API_KEY: "k", TABCREW_BROWSE_CONCURRENCY: "1" });
    const a = await openWithTab(client, ext);
    const b = await openWithTab(client, ext);
    const c = await openWithTab(client, ext);
    const gates: (() => void)[] = [];
    onDecision = (body) => new Promise((resolve) => gates.push(() => resolve(jev(body, "DONE"))));
    const snapshotsFor = (tab: number) => ext.requests.filter((r) => r.op === "snapshot" && (r.args as { tab_id: number }).tab_id === tab);

    const ra = browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    await until(() => gates.length === 1);
    const rb = browse(client, { session: b.S, tab_id: b.tab, goal: "g" });
    await sleep(20);
    const rc = browse(client, { session: c.S, tab_id: c.tab, goal: "g" });
    await sleep(50);
    expect(gates).toHaveLength(1);
    expect(snapshotsFor(b.tab)).toHaveLength(0);
    expect(snapshotsFor(c.tab)).toHaveLength(0);
    // Other tools are not blocked by the cap.
    expect((await call(client, "observe", { session: b.S, tab_id: b.tab })).ok).toBe(true);

    gates[0]();
    expect((await ra).status).toBe("done");
    await until(() => gates.length === 2);
    expect(snapshotsFor(c.tab)).toHaveLength(0);
    gates[1]();
    expect((await rb).status).toBe("done");
    await until(() => gates.length === 3);
    gates[2]();
    expect((await rc).status).toBe("done");
  });

  it("logs start and end without the goal, page text or typed values", async () => {
    const lines: string[] = [];
    const { client, ext } = await setup();
    setLogSink((_level, message) => lines.push(message));
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    progressing(ext, a.tab);
    script(["TYPE_TEXT", "1"], ["DONE"]);
    onText = () => textReply('{"text": "SecretCity"}');
    await browse(client, { session: a.S, tab_id: a.tab, goal: "GoalWords about Zurich" });
    const browseLines = lines.filter((l) => l.startsWith("browse "));
    expect(browseLines).toHaveLength(2);
    expect(browseLines[1]).toMatch(new RegExp(`^browse ${a.short_id} tab ${a.tab}: done after 2 step\\(s\\) in \\d+ ms$`));
    const all = lines.join("\n");
    for (const secret of ["GoalWords", "SecretCity", "Search flights", "Zürich"]) expect(all).not.toContain(secret);
  });
});

describe("chat decisions (decision_model)", () => {
  const CHAT_ENV = { OPENROUTER_API_KEY: "test-key", DECISION_MODEL: "anthropic/claude-haiku" };

  it("asks the chat model instead of Jev, with the same state and offered options", async () => {
    const { client, ext } = await setup(CHAT_ENV);
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    progressing(ext, a.tab);
    const moves = [
      { operation: "click", target: 1, confidence: 0.7, reason: "open the origin picker" },
      { operation: "DONE", target: null, confidence: 0.95, reason: "picker open" },
    ];
    onChat = (_b, n) => chatReply("```json\n" + JSON.stringify(moves[n]) + "\n```");
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "Open the origin picker" });

    expect(decisionCalls()).toHaveLength(0);
    expect(chatCalls()).toHaveLength(2);
    const first = chatCalls()[0];
    expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(first.auth).toBe("Bearer test-key");
    expect(first.body).toMatchObject({ model: "anthropic/claude-haiku", reasoning: { enabled: false } });
    const user = JSON.parse(first.body.messages[1].content);
    expect(user.goal).toBe("Open the origin picker");
    expect(Object.keys(user.operations)).toEqual(["TYPE_TEXT", "CLICK", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    expect(Object.keys(user.targets.CLICK)).toEqual(["1", "2", "4", "5", "6"]);
    expect(user.page.url).toBe("https://flights.example/search");
    expect(user.elements[0]).toMatchObject({ index: "1", label: "Where from?" });

    expect(acts(ext).map((q) => q.args)).toEqual([{ tab_id: a.tab, fingerprint: "fp-flights-1", action_id: "e2" }]);
    expect(r.status).toBe("done");
    expect(r.steps).toEqual([
      { step: 1, operation: "CLICK", target: "1", label: "Open Where from?", probability: 0.7, confidence: 0.7, page_changed: true, decision_ms: expect.any(Number), decider: "anthropic/claude-haiku", reason: "open the origin picker" },
      { step: 2, operation: "DONE", target: null, label: "DONE", probability: 0.95, confidence: 0.95, page_changed: false, decision_ms: expect.any(Number), decider: "anthropic/claude-haiku", reason: "picker open" },
    ]);
    expect(r.usage).toEqual({ decisions: 2, decision_input_tokens: 3000, decision_cost_usd: 0.001, text_calls: 0, text_cost_usd: 0 });
  });

  it("uses DECISION_MODEL_BASE_URL and DECISION_MODEL_API_KEY without an OpenRouter key", async () => {
    const { client, ext } = await setup({ DECISION_MODEL: "claude-haiku", DECISION_MODEL_BASE_URL: "https://llm.example/v1/", DECISION_MODEL_API_KEY: "local-key" });
    const a = await openWithTab(client, ext);
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("done");
    expect(chatCalls().map((c) => [c.url, c.auth])).toEqual([["https://llm.example/v1/chat/completions", "Bearer local-key"]]);
  });

  it("stops with model_error and acts on nothing when the reply targets an element it was not offered", async () => {
    const { client, ext } = await setup(CHAT_ENV);
    const a = await openWithTab(client, ext, () => flightsSnapshot());
    onChat = () => chatReply({ operation: "CLICK", target: "3", confidence: 0.9 });
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("model_error");
    expect(r.message).toMatch(/target not offered for CLICK/);
    expect(acts(ext)).toHaveLength(0);
  });

  it("auto: falls back to the chat model for the rest of the run when Decisions is unavailable", async () => {
    const { client, ext } = await setup({ ...CHAT_ENV, DECISION_PROVIDER: "auto" });
    const a = await openWithTab(client, ext);
    progressing(ext, a.tab);
    onDecision = () => new Response("gone", { status: 404 });
    onChat = (_b, n) => chatReply(n === 0 ? { operation: "CLICK", target: "1", confidence: 0.6 } : { operation: "DONE", confidence: 0.9 });
    const r = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(r.status).toBe("done");
    expect(decisionCalls()).toHaveLength(1);
    expect(chatCalls()).toHaveLength(2);
    expect(r.steps.map((s: { decider?: string }) => s.decider)).toEqual(["anthropic/claude-haiku", "anthropic/claude-haiku"]);
  });

  it("auto: uses Jev while it answers, and does not fall back on a rejected key", async () => {
    const { client, ext } = await setup({ ...CHAT_ENV, DECISION_PROVIDER: "auto" });
    const a = await openWithTab(client, ext);
    const ok = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(ok.status).toBe("done");
    expect(ok.steps[0].decider).toBeUndefined();
    onDecision = () => new Response("no", { status: 401 });
    const bad = await browse(client, { session: a.S, tab_id: a.tab, goal: "g" });
    expect(bad.status).toBe("model_error");
    expect(bad.message).toMatch(/HTTP 401/);
    expect(chatCalls()).toHaveLength(0);
  });
});
