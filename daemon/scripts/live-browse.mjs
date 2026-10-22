#!/usr/bin/env node
// PAID live check of the Jev `browse` loop against a running daemon (or hub) + the TabCrew extension.
// Daemon mode: real OpenRouter calls (Jev Decisions + text helper) billed to OPENROUTER_API_KEY.
// Hub mode (TABCREW_TRANSPORT=shim): the extension calls the provider set in its popup (Model provider).
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/live-browse.mjs [--only wikipedia|flights] [--parallel] [--keep-open] [--max-steps N]
import { connect, describeTransport, transportMode } from "./connect.mjs";

const argv = process.argv.slice(2);
const keepOpen = argv.includes("--keep-open");
const parallel = argv.includes("--parallel");
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = flag("--only");
if (only && !["wikipedia", "flights"].includes(only)) {
  console.error("--only must be wikipedia or flights");
  process.exit(2);
}
const maxStepsArg = flag("--max-steps") ? Number(flag("--max-steps")) : undefined;

console.log(describeTransport());
const client = await connect("tabcrew-live-browse");

const BROWSE_TIMEOUT_MS = 10 * 60_000;
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: name === "browse" ? BROWSE_TIMEOUT_MS : 60_000 });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { error: r.isError ? json : null, json };
}

// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
async function finish(session) {
  const tabs = (await call("tab_list", { session })).json?.tabs ?? [];
  let closed = 0;
  for (const t of tabs) if (!(await call("tab_close", { session, tab_id: t.tab_id })).error) closed++;
  const res = await call("session_close", { session });
  return { closed, kept: res.json?.kept_tabs ?? 0, error: res.error };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printBrowse(out, r) {
  for (const s of r.steps ?? []) {
    const target = s.target ? `[${s.target}] ` : "";
    const typed = s.text !== undefined ? `  typed ${JSON.stringify(s.text)}` : "";
    const err = s.error ? `  (${s.error})` : "";
    out(`  ${String(s.step).padStart(2)}. ${s.operation.padEnd(11)} ${target}${s.label}  p=${s.probability.toFixed(3)}${typed}  changed=${s.page_changed}${err}`);
  }
  const u = r.usage ?? {};
  out(`  status ${r.status}${r.message ? ` (${r.message})` : ""}; ${r.elapsed_ms} ms; ${u.decisions} decision(s) $${(u.decision_cost_usd ?? 0).toFixed(4)} + ${u.text_calls} text call(s) $${(u.text_cost_usd ?? 0).toFixed(4)}`);
  out(`  final ${r.final?.url}`);
}

async function scenario(name, url, goal, maxSteps, verify) {
  const lines = [];
  const out = (line) => (parallel ? lines.push(line) : console.log(line));
  const checks = [];
  const check = (label, ok, detail = "") => {
    checks.push(ok);
    out(`${ok ? "PASS" : "FAIL"}  ${name}: ${label}${detail ? `  (${detail})` : ""}`);
  };
  out(`\n== ${name} ==\n  goal: ${goal}`);
  const opened = await call("session_open", { label: `live-${name}` });
  const session = opened.json?.session;
  if (!session) {
    check("session_open", false, JSON.stringify(opened.error));
    return { lines, checks };
  }
  try {
    const tab = await call("tab_create", { session, url });
    if (tab.error) {
      check("tab_create", false, `${tab.error.code}; is the extension connected?`);
      return { lines, checks };
    }
    const tabId = tab.json.tab_id;
    await sleep(2000); // let the page load
    const started = Date.now();
    const browsed = await call("browse", { session, tab_id: tabId, goal, max_steps: maxSteps });
    if (browsed.error) {
      check("browse returned", false, `${browsed.error.code}: ${browsed.error.message}`);
      return { lines, checks };
    }
    printBrowse(out, browsed.json);
    out(`  wall ${Date.now() - started} ms`);
    check("browse status is done", browsed.json.status === "done", browsed.json.status);
    await verify({ session, tabId, check });
  } catch (err) {
    check("no exception", false, String(err?.message ?? err));
  } finally {
    if (!keepOpen) await finish(session);
    else out(`  kept open: session ${opened.json.short_id}`);
  }
  return { lines, checks };
}

function wikipedia() {
  return scenario(
    "wikipedia",
    "https://en.wikipedia.org/wiki/Main_Page",
    "Find and open the Wikipedia article about Gödel's incompleteness theorems.",
    maxStepsArg ?? 25,
    async ({ session, tabId, check }) => {
      const listed = await call("tab_list", { session });
      const tab = listed.json?.tabs?.find((t) => t.tab_id === tabId);
      let path = "";
      try {
        path = new URL(tab?.url ?? "").pathname;
      } catch {}
      const expected = "/wiki/G%C3%B6del%27s_incompleteness_theorems";
      // Chrome may report the apostrophe unescaped; compare the decoded paths.
      const same = path === expected || decodeURIComponent(path) === decodeURIComponent(expected);
      check("tab_list shows the article URL", same, path || "no url");
    },
  );
}

function flights() {
  const date = new Date();
  date.setDate(date.getDate() + 40);
  const long = date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); // November 20, 2026
  const short = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); // Fri, Nov 20
  return scenario(
    "flights",
    "https://www.google.com/travel/flights?hl=en",
    `Find one-way flights from Zurich to London on ${long}, for one adult in economy. Stop when matching flight options are visible.`,
    maxStepsArg ?? 40,
    async ({ session, tabId, check }) => {
      const observed = await call("observe", { session, tab_id: tabId });
      if (observed.error) {
        check("observe", false, observed.error.code);
        return;
      }
      const els = observed.json.elements ?? [];
      const byLabel = (label) => els.find((e) => (e.label ?? "").trim() === label);
      const departure = els.find((e) => /^Departure\b/.test(e.label ?? ""));
      check(`Departure = ${short}`, (departure?.value ?? "").includes(short), departure?.value ?? "missing");
      const from = byLabel("Where from?");
      check("Where from? = Zürich", from?.value?.trim() === "Zürich", from?.value ?? "missing");
      const to = byLabel("Where to?");
      check("Where to? = London", to?.value?.trim() === "London", to?.value ?? "missing");
      const oneWay = els.find(
        (e) => /^one[ -]way$/i.test((e.value ?? "").trim()) || (/ticket type/i.test(e.label ?? "") && /one[ -]way/i.test(`${e.label} ${e.value ?? ""}`)),
      );
      check("ticket type is one way", Boolean(oneWay), oneWay ? `${oneWay.label} · ${oneWay.value ?? ""}` : "not found");
      // Results are listed as "Select flight" buttons whose labels carry the full weekday and date.
      const fullDate = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      const flights = els.filter((e) => /select flight/i.test(e.label ?? ""));
      check(`flight results listed for ${fullDate}`, flights.length > 0 && flights.every((e) => e.label.includes(fullDate)), `${flights.length} result(s)`);
    },
  );
}

const runs = [];
if (!only || only === "wikipedia") runs.push(wikipedia);
if (!only || only === "flights") runs.push(flights);

console.log(transportMode() === "shim" ? "PAID: this makes real calls to the model provider set in the TabCrew popup." : "PAID: this makes real OpenRouter calls.");
const results = [];
if (parallel) {
  for (const r of await Promise.all(runs.map((run) => run()))) {
    for (const line of r.lines) console.log(line);
    results.push(...r.checks);
  }
} else {
  for (const run of runs) results.push(...(await run()).checks);
}

await client.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed || results.length === 0 ? 1 : 0);
