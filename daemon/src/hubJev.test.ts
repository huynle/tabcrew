import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { V2ModelCall } from "@tabcrew/shared/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningHub } from "./daemon.js";
import { CHAT_DECISION } from "./jev/chat.js";
import { flightsSnapshot } from "./testing/fixtures.js";
import { call, FakeExtension, mcpSocketClient, startTestHub, tempHome, until, WireError } from "./testing/helpers.js";

// Hub mode end to end: browse decisions and text go through the extension's model_call; nothing
// leaves the hub over HTTP.

const SECRET = "e".repeat(64);

let home: string;
let cleanupHome: () => void;
let hub: RunningHub | null;
const extensions: FakeExtension[] = [];
const clients: Client[] = [];
let fetchCalls: string[];

beforeEach(() => {
  ({ home, cleanup: cleanupHome } = tempHome());
  hub = null;
  fetchCalls = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  });
});

afterEach(async () => {
  for (const e of extensions.splice(0)) e.ws.terminate();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await hub?.close();
  cleanupHome();
  vi.unstubAllGlobals();
});

/** A chat completion whose usage.cost is an object, the model comes back in the reply. */
function completion(content: unknown, model: string) {
  return {
    status: 200,
    model,
    json: {
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, cost: { input_cost: 0.0001, output_cost: 0.0001, total_cost: 0.0002 } },
    },
  };
}

async function setup() {
  hub = await startTestHub(home, {}, { modelRetryBaseMs: 1 });
  const ext = await FakeExtension.connectHub(hub.extensionPort, { secret: SECRET, state: "new" });
  extensions.push(ext);
  await until(() => hub!.bridge.connected);
  const { client } = await mcpSocketClient(hub.socketPath);
  clients.push(client);
  const s = await call(client, "session_open", { label: "hub-jev" });
  if (!s.ok) throw new Error("open failed");
  const t = await call(client, "tab_create", { session: s.value.session, url: "https://flights.example/" });
  if (!t.ok) throw new Error("tab_create failed");
  const tab = t.value.tab_id as number;
  ext.snapshots.set(tab, flightsSnapshot());
  // Every act changes the page.
  ext.handler = (req) => {
    if (req.op === "act") {
      const snap = ext.snapshots.get(tab)!;
      ext.snapshots.set(tab, { ...snap, fingerprint: `${snap.fingerprint}+` });
    }
    return ext.simulate(req);
  };
  return { ext, client, session: s.value.session as string, tab };
}

async function browse(client: Client, args: Record<string, unknown>) {
  const r = await call(client, "browse", args);
  if (!r.ok) throw new Error(`browse failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("hub-mode browse via model_call", () => {
  it("decides by chat and fills text through the extension; reports model and object-shaped cost", async () => {
    const { ext, client, session, tab } = await setup();
    const moves = [
      { operation: "TYPE_TEXT", target: "1", confidence: 0.8, reason: "fill origin" },
      { operation: "DONE", target: null, confidence: 0.9, reason: "filled" },
    ];
    let decisions = 0;
    ext.modelHandler = (c: V2ModelCall) =>
      c.purpose === "chat_decision" ? completion("```json\n" + JSON.stringify(moves[decisions++]) + "\n```", "gemini-3.6-flash") : completion({ text: "Zurich" }, "claude-haiku-4-5");

    const r = await browse(client, { session, tab_id: tab, goal: "Fly from Zurich" });
    expect(r.status).toBe("done");
    expect(r.steps).toEqual([
      expect.objectContaining({ operation: "TYPE_TEXT", target: "1", text: "Zurich", decider: "gemini-3.6-flash", reason: "fill origin" }),
      expect.objectContaining({ operation: "DONE", decider: "gemini-3.6-flash" }),
    ]);
    expect(r.usage).toEqual({ decisions: 2, decision_input_tokens: 2000, decision_cost_usd: 0.0004, text_calls: 1, text_cost_usd: 0.0002 });

    expect(ext.modelCalls.map((c) => c.purpose)).toEqual(["chat_decision", "text", "chat_decision"]);
    for (const c of ext.modelCalls) {
      expect(Object.keys(c.body).sort()).toEqual(["max_tokens", "messages", "response_format"]);
    }
    expect(ext.modelCalls[0].body.messages[0].content).toBe(CHAT_DECISION);
    expect(ext.modelCalls[1].timeout_ms).toBe(8_000);
    expect(fetchCalls.filter((u) => !u.startsWith("http://127.0.0.1"))).toEqual([]);
  });

  it("no model provider in the extension: browse stops with a model_error pointing at the popup", async () => {
    const { ext, client, session, tab } = await setup();
    ext.modelHandler = () => {
      throw new WireError({ code: "model_not_configured", message: "set a model provider in the TabCrew popup" });
    };
    const r = await browse(client, { session, tab_id: tab, goal: "anything" });
    expect(r.status).toBe("model_error");
    expect(r.message).toContain("TabCrew popup (Model provider)");
    expect(r.message).not.toMatch(/OpenRouter|\.tabcrew/);
    expect(r.steps).toEqual([]);
    expect(ext.requests.filter((q) => q.op === "act")).toHaveLength(0);
  });
});
