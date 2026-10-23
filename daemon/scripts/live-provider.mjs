#!/usr/bin/env node
// PAID (cents) live check of hub mode with a Provider (or any OpenAI-compatible) model provider:
// one `browse` on Wikipedia over the `tabcrew mcp` shim, exactly the path OpenCode uses.
// The model calls go from the extension to the provider set in its popup; nothing is read from ~/.tabcrew.
// Usage: node daemon/scripts/live-provider.mjs [--keep-open] [--max-steps N]
// Exit codes: 0 browse reached DONE on the expected article, 1 any failure, 2 usage.
import { connect, describeTransport } from "./connect.mjs";

const argv = process.argv.slice(2);
const keepOpen = argv.includes("--keep-open");
const stepsIdx = argv.indexOf("--max-steps");
const maxSteps = stepsIdx >= 0 ? Number(argv[stepsIdx + 1]) : 15;
if (!Number.isInteger(maxSteps) || maxSteps < 1) {
  console.error("--max-steps must be a positive integer");
  process.exit(2);
}
const START_URL = "https://en.wikipedia.org/wiki/Main_Page";
const GOAL = "Search Wikipedia for 'Lockheed Martin' and open the Wikipedia article about Lockheed Martin.";
const EXPECTED_PATH = "/wiki/Lockheed_Martin";
const BROWSE_TIMEOUT_MS = 10 * 60_000;

console.log(`Prerequisites:
  - the TabCrew extension is loaded (chrome://extensions -> Load unpacked -> extension/dist) and its
    popup shows "connected" (Advanced -> Connection: Auto or Hub; click "Trust this hub" if asked)
  - popup Advanced -> Model provider: Provider A or Provider B, your API key, a decision model and
    a text model, then Save (and Allow the site access Chrome asks for)
  - OpenCode is NOT required: this script runs its own \`tabcrew mcp\` shim (npm run build first)
PAID: one browse, a few cents on the configured provider.
`);
console.log(describeTransport("shim"));
const client = await connect("tabcrew-live-provider", "shim");

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: name === "browse" ? BROWSE_TIMEOUT_MS : 60_000 });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { error: r.isError ? json ?? { code: "unparsable", message: text } : null, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  return ok;
};
function hint(code) {
  if (code === "extension_offline") return "the extension did not connect to the hub: is it loaded, in Auto/Hub mode, trusted, on the same port?";
  if (code === "model_error") return "check popup Advanced -> Model provider (key, headers, model names, site access), then Test";
  return "";
}

const opened = await call("session_open", { label: "live-provider" });
const session = opened.json?.session;
try {
  if (!check("session_open", Boolean(session), opened.error?.code)) throw new Error("no session");
  const tab = await call("tab_create", { session, url: START_URL });
  if (!check("tab_create", !tab.error, tab.error ? `${tab.error.code}: ${hint(tab.error.code) || tab.error.message}` : `tab ${tab.json.tab_id}`)) throw new Error("no tab");
  const tabId = tab.json.tab_id;
  await sleep(2000); // let the page load

  console.log(`\ngoal: ${GOAL}`);
  const started = Date.now();
  const browsed = await call("browse", { session, tab_id: tabId, goal: GOAL, max_steps: maxSteps });
  if (browsed.error) {
    check("browse returned", false, `${browsed.error.code}: ${browsed.error.message} ${hint(browsed.error.code)}`);
    throw new Error("browse failed");
  }
  const r = browsed.json;
  for (const s of r.steps ?? []) {
    const target = s.target ? `[${s.target}] ` : "";
    const typed = s.text !== undefined ? `  typed ${JSON.stringify(s.text)}` : "";
    const err = s.error ? `  (${s.error})` : "";
    console.log(`  ${String(s.step).padStart(2)}. ${s.operation.padEnd(11)} ${target}${s.label}${typed}  changed=${s.page_changed}${err}`);
  }
  const u = r.usage ?? {};
  const deciders = [...new Set((r.steps ?? []).map((s) => s.decider).filter(Boolean))];
  const total = (u.decision_cost_usd ?? 0) + (u.text_cost_usd ?? 0);
  console.log(`
status:         ${r.status}${r.message ? ` (${r.message})` : ""}
steps:          ${r.steps?.length ?? 0} (max ${maxSteps}); ${r.elapsed_ms} ms in browse, ${Date.now() - started} ms wall
decision model: ${deciders.join(", ") || "none reported"}
text model:     ${u.text_calls ? "the popup's Text model (browse reports calls and cost, not the name)" : "not used"}; ${u.text_calls ?? 0} call(s)
cost:           $${total.toFixed(4)} = ${u.decisions ?? 0} decision(s) $${(u.decision_cost_usd ?? 0).toFixed(4)} + ${u.text_calls ?? 0} text call(s) $${(u.text_cost_usd ?? 0).toFixed(4)}
final:          ${r.final?.url}
`);
  check("browse status is done", r.status === "done", r.status === "model_error" ? `${r.message}; ${hint("model_error")}` : r.status);
  check("a chat decision model decided the steps (hub mode)", deciders.length > 0, deciders.join(", ") || "no decider on any step");
  const listed = await call("tab_list", { session });
  let path = "";
  try {
    path = new URL(listed.json?.tabs?.find((t) => t.tab_id === tabId)?.url ?? "").pathname;
  } catch {}
  check(`tab is on ${EXPECTED_PATH}`, path === EXPECTED_PATH, path || "no url");
} catch (err) {
  if (results.every(Boolean)) check("no exception", false, String(err?.message ?? err));
} finally {
  if (session && !keepOpen) {
    for (const t of (await call("tab_list", { session })).json?.tabs ?? []) await call("tab_close", { session, tab_id: t.tab_id });
    await call("session_close", { session });
  } else if (session) console.log(`kept open: session ${opened.json.short_id}`);
  await client.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed || results.length === 0 ? 1 : 0);
