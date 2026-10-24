#!/usr/bin/env node
// Live browser guard tests (port of jev-ultrafast scripts/check_guards.py) against a running
// daemon + the TabCrew extension. No model calls, no external sites: the fixture is served from
// extension/test-fixtures/ on an ephemeral 127.0.0.1 port.
//
// The page can only be driven through MCP tools, so each mutation is "armed" by clicking a
// fixture button; it lands ~400 ms later. The test observes right after arming, waits, then
// acts on that outdated observation and checks the guard's verdict.
//
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/guards.mjs [--keep-open] [--only <substring>]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, describeTransport } from "./connect.mjs";

const keepOpen = process.argv.includes("--keep-open");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
const FIXTURES = fileURLToPath(new URL("../../extension/test-fixtures/", import.meta.url));
const ARM_WAIT_MS = 900; // fixture applies armed mutations after 400 ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture server ---------------------------------------------------------------------
const server = createServer((req, res) => {
  const name = basename(new URL(req.url, "http://x").pathname) || "guards.html";
  if (extname(name) !== ".html") return void res.writeHead(404).end();
  try {
    const body = readFileSync(join(FIXTURES, name));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- MCP --------------------------------------------------------------------------------
console.log(describeTransport());
const client = await connect("tabcrew-guards");

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const error = r.isError ? { code: json?.code ?? json?.error?.code ?? "unparsed", message: json?.message ?? text } : null;
  return { error, json, text };
}

// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
async function finish(session) {
  const tabs = (await call("tab_list", { session })).json?.tabs ?? [];
  let closed = 0;
  for (const t of tabs) if (!(await call("tab_close", { session, tab_id: t.tab_id })).error) closed++;
  const res = await call("session_close", { session });
  return { closed, kept: res.json?.kept_tabs ?? 0, error: res.error };
}

const tools = new Set((await client.listTools()).tools.map((t) => t.name));
for (const t of ["session_open", "tab_create", "observe", "act", "session_close"]) {
  if (!tools.has(t)) {
    console.log(`daemon does not expose the "${t}" tool yet; tools: ${[...tools].join(", ")}`);
    await client.close();
    server.close();
    process.exit(2);
  }
}

// --- observe table helpers -----------------------------------------------------------------
const ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"]);

/** Normalise the observe `elements` (array of objects, or a text table) to [{index,label,role,operations,options}]. */
function normaliseElements(elements) {
  if (Array.isArray(elements)) {
    return elements.map((e) => ({
      index: String(e.index ?? e.id ?? e.target),
      label: String(e.label ?? e.name ?? ""),
      role: e.role,
      operations: e.operations,
      raw: e,
      options: (e.options ?? []).map((o) => ({ index: String(o.index ?? o.target), label: String(o.label ?? ""), value: o.value })),
    }));
  }
  const out = [];
  for (const line of String(elements ?? "").split("\n")) {
    const m = /^\s*\[(\d+)(?::(\d+))?\]\s*(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[3];
    const first = rest.split(/\s+/)[0];
    const role = ROLES.has(first) ? first : undefined;
    if (role) rest = rest.slice(first.length).trim();
    const label = rest.split(" · ")[0].trim();
    if (m[2]) {
      const parent = out.find((e) => e.index === m[1]);
      parent?.options.push({ index: `${m[1]}:${m[2]}`, label });
    } else {
      out.push({ index: m[1], label, role, raw: line, options: [] });
    }
  }
  return out;
}

async function observe() {
  let last;
  for (let i = 0; i < 20; i++) {
    const r = await call("observe", { session, tab_id: tabId });
    if (!r.error) {
      const j = r.json ?? {};
      const fingerprint = j.fingerprint ?? /fingerprint\W+([0-9a-f]{64})/.exec(r.text)?.[1];
      return { ...j, text: j.text ?? r.text, fingerprint, list: normaliseElements(j.elements), dump: r.text };
    }
    last = r.error;
    await sleep(150);
  }
  throw new Error(`observe failed: ${last?.code} ${last?.message}`);
}

function el(obs, label) {
  const e = obs.list.find((x) => x.label === label) ?? obs.list.find((x) => x.label.startsWith(label));
  if (!e) throw new Error(`no element labelled "${label}" in: ${obs.list.map((x) => x.label).join(" | ")}`);
  return e;
}

/** Target for a <select> option: "<element>:<option>" from the element's option list. */
function optionTarget(obs, selectLabel, optionLabel) {
  const sel = obs.list.find((x) => x.label === selectLabel && x.options.length);
  const opt = sel?.options.find((o) => o.label === optionLabel || o.label.endsWith(`→ ${optionLabel}`) || o.value === optionLabel);
  if (opt) return opt.index;
  const flat = obs.list.find((x) => x.label === `${selectLabel} → ${optionLabel}`);
  if (flat) return flat.index;
  throw new Error(`no option "${optionLabel}" for "${selectLabel}"`);
}

async function act(obs, operation, target, text) {
  const args = { session, tab_id: tabId, fingerprint: obs.fingerprint, operation };
  if (target !== undefined) args.target = target;
  if (text !== undefined) args.text = text;
  return call("act", args);
}

function expectOk(r, what) {
  if (r.error) throw new Error(`${what}: expected success, got ${r.error.code} (${r.error.message})`);
  return r.json ?? {};
}
function expectError(r, codes, what) {
  const list = [codes].flat();
  if (!r.error) throw new Error(`${what}: expected ${list.join("/")}, but the action executed (${r.text.slice(0, 120)})`);
  if (!list.includes(r.error.code)) throw new Error(`${what}: expected ${list.join("/")}, got ${r.error.code} (${r.error.message})`);
  return r.error.code;
}
function expectText(obs, needle, what) {
  if (!String(obs.text).includes(needle)) throw new Error(`${what}: page text lacks "${needle}"`);
}

/**
 * Click a fixture control as test setup (not a guard under test). If the page is still settling the
 * click is refused with stale_page and nothing runs, so observe again and retry like an agent would.
 */
async function clickSetup(label, what) {
  for (let attempt = 1; ; attempt++) {
    const obs = await observe();
    const r = await act(obs, "CLICK", el(obs, label).index);
    if (!r.error || r.error.code !== "stale_page" || attempt >= 5) return expectOk(r, what);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function reset() {
  await clickSetup("Reset fixture", "reset");
  const fresh = await observe();
  expectText(fresh, "Continue clicks: 0 · Purchases: 0 · City: Zurich", "reset");
  return fresh;
}

/** Click "Arm <name>", observe immediately (before the mutation lands), then wait for it. */
async function armed(name) {
  await clickSetup(`Arm ${name}`, `arm ${name}`);
  const before = await observe();
  await sleep(ARM_WAIT_MS);
  return before;
}

// --- run --------------------------------------------------------------------------------
const opened = await call("session_open", { label: "guards" });
if (opened.error) throw new Error(`session_open failed: ${opened.error.code}`);
const session = opened.json.session;
const created = await call("tab_create", { session, url: `${base}/guards.html` });
if (created.error) {
  console.log(`tab_create failed: ${created.error.code} ${created.error.message}; is the extension connected?`);
  await finish(session);
  await client.close();
  server.close();
  process.exit(1);
}
const tabId = created.json.tab_id;

const results = [];
async function guard(name, fn, { fresh = true } = {}) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try {
    if (fresh) await reset();
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}  (${Date.now() - t0} ms${detail ? `; ${detail}` : ""})`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  (${err instanceof Error ? err.message : String(err)})`);
  }
}

try {
  // Wait for the fixture to render.
  for (let i = 0; ; i++) {
    const obs = await observe().catch(() => null);
    if (obs && String(obs.text).includes("Continue clicks")) break;
    if (i >= 40) throw new Error("fixture did not load");
    await sleep(250);
  }

  // Click-guard checks on "Continue" (page key + that node's guard; geometry re-resolved).
  await guard("moving target is clicked at its current location", async () => {
    const obs = await armed("move");
    const r = expectOk(await act(obs, "CLICK", el(obs, "Continue").index), "click");
    expectText(await observe(), "Continue clicks: 1", "after click");
    return `page_changed=${r.page_changed}`;
  });
  await guard("unrelated offscreen text does not invalidate a click", async () => {
    const obs = await armed("offscreen text");
    expectOk(await act(obs, "CLICK", el(obs, "Continue").index), "click");
    expectText(await observe(), "Continue clicks: 1", "after click");
  });
  await guard("textless overlay blocks the click before input (target_covered)", async () => {
    const obs = await armed("cover");
    expectError(await act(obs, "CLICK", el(obs, "Continue").index), "target_covered", "covered click");
    expectText(await observe(), "Continue clicks: 0", "nothing clicked");
  });
  for (const [arm, label] of [
    ["disable", "disabled target"],
    ["hide", "hidden target"],
    ["replace", "replaced node"],
    ["relabel", "accessible label change"],
  ]) {
    await guard(`${label} invalidates the click (stale_page)`, async () => {
      const obs = await armed(arm);
      expectError(await act(obs, "CLICK", el(obs, "Continue").index), "stale_page", label);
      expectText(await observe(), "Continue clicks: 0", "nothing clicked");
    });
  }
  await guard("aria-disabled ancestor rejects the click (target_invalid)", async () => {
    const obs = await armed("ancestor disabled");
    expectError(await act(obs, "CLICK", el(obs, "Continue").index), "target_invalid", "ancestor disabled");
    expectText(await observe(), "Continue clicks: 0", "nothing clicked");
  });
  await guard("target pushed out of the viewport is scrolled back into view and clicked", async () => {
    const obs = await armed("push offscreen");
    try {
      expectOk(await act(obs, "CLICK", el(obs, "Continue").index), "offscreen target");
      // observe only sees the viewport, now scrolled to the moved target; read_text sees the counter.
      const text = await call("read_text", { session, tab_id: tabId });
      if (!String(text.json?.text ?? "").includes("Continue clicks: 1")) throw new Error(`clicked once: page text lacks "Continue clicks: 1"`);
    } finally {
      // Start the next checks from the top of a fresh page (a new URL, so Chrome restores no scroll).
      expectOk(await call("navigate", { session, tab_id: tabId, url: `${base}/guards.html?fresh=offscreen` }), "reload fixture");
    }
  });

  // Action-specific guard on "Buy" (inside the form) vs. the full marker for typing.
  await guard("nearby price in the same form invalidates the click (stale_page)", async () => {
    const obs = await armed("price");
    expectError(await act(obs, "CLICK", el(obs, "Buy").index), "stale_page", "price change");
    expectText(await observe(), "Purchases: 0", "nothing bought");
  });
  await guard("form value change invalidates the click (stale_page)", async () => {
    const obs = await armed("city value");
    expectError(await act(obs, "CLICK", el(obs, "Buy").index), "stale_page", "field value");
  });
  await guard("checkbox property change invalidates the click (stale_page)", async () => {
    const obs = await armed("toggle");
    expectError(await act(obs, "CLICK", el(obs, "Buy").index), "stale_page", "checkbox property");
  });
  await guard("unrelated visible update: click guard accepts it", async () => {
    const obs = await armed("news");
    expectOk(await act(obs, "CLICK", el(obs, "Buy").index), "click Buy");
    expectText(await observe(), "Purchases: 1", "bought");
  });
  await guard("unrelated visible update: typing (full marker) rejects it (stale_page)", async () => {
    const obs = await armed("news");
    expectError(await act(obs, "TYPE_TEXT", el(obs, "City").index, "London"), "stale_page", "marker");
    expectText(await observe(), "City: Zurich", "nothing typed");
  });
  await guard("field turned read-only invalidates typing (stale_page)", async () => {
    const obs = await armed("readonly");
    expectError(await act(obs, "TYPE_TEXT", el(obs, "City").index, "London"), "stale_page", "read-only");
  });
  await guard("dropdown option disabled after observe is rejected (target_invalid)", async () => {
    const obs = await armed("option");
    expectError(await act(obs, "SELECT", optionTarget(obs, "Category", "Coastal")), "target_invalid", "disabled option");
    expectText(await observe(), "Category: all", "nothing selected");
  });

  // Exposure and plain execution.
  await guard("only safe controls and values are exposed", async () => {
    const obs = await observe();
    if (obs.dump.includes("never expose this")) throw new Error("password value leaked");
    if (obs.list.some((x) => x.label === "Disabled action")) throw new Error("disabled button listed");
    if (obs.list.some((x) => x.label === "Secret")) throw new Error("password field listed");
    const ro = el(obs, "Read only");
    if (Array.isArray(ro.operations) && ro.operations.includes("TYPE_TEXT")) throw new Error("read-only field is typeable");
    const box = el(obs, "Refundable");
    if (Array.isArray(box.operations) && box.operations.join() !== "CLICK") throw new Error(`checkbox ops ${box.operations}`);
    const cat = obs.list.find((x) => x.label === "Category" && x.options.length);
    if (cat) {
      const labels = cat.options.map((o) => o.label).join(" | ");
      if (/Unavailable|→ All$/.test(labels)) throw new Error(`unexpected options: ${labels}`);
    }
  });
  await guard("native dropdown selects an observed option", async () => {
    const obs = await observe();
    expectOk(await act(obs, "SELECT", optionTarget(obs, "Category", "Design")), "select");
    expectText(await observe(), "Category: Design", "selected");
  });
  await guard("checkbox click toggles it", async () => {
    const obs = await observe();
    expectOk(await act(obs, "CLICK", el(obs, "Refundable").index), "click checkbox");
    expectText(await observe(), "Refundable: yes", "checked");
  });
  await guard("typing replaces the field value", async () => {
    const obs = await observe();
    const r = expectOk(await act(obs, "TYPE_TEXT", el(obs, "City").index, "London"), "type");
    expectText(await observe(), "City: London ·", "typed");
    return `page_changed=${r.page_changed}`;
  });
  await guard("typing into a combobox waits for async suggestions", async () => {
    const obs = await observe();
    const r = expectOk(await act(obs, "TYPE_TEXT", el(obs, "Search").index, "Gen"), "type");
    if (r.page_changed !== true) throw new Error(`page_changed=${r.page_changed}`);
    const after = await observe();
    el(after, "Gen City");
    el(after, "Gen Airport");
  });
  await guard("scroll down and up", async () => {
    let obs = await observe();
    const down = expectOk(await act(obs, "SCROLL_DOWN"), "scroll down");
    if (down.page_changed !== true) throw new Error(`scroll down page_changed=${down.page_changed}`);
    obs = await observe();
    expectOk(await act(obs, "SCROLL_UP"), "scroll up");
  });
  await guard("wait executes without changing the page", async () => {
    const obs = await observe();
    const r = expectOk(await act(obs, "WAIT"), "wait");
    if (r.page_changed !== false) throw new Error(`page_changed=${r.page_changed}`);
  });

  // Argument errors.
  await guard("unknown fingerprint → stale_page", async () => {
    const obs = await observe();
    expectError(await act({ ...obs, fingerprint: "0".repeat(64) }, "CLICK", el(obs, "Continue").index), "stale_page", "bad fingerprint");
    expectText(await observe(), "Continue clicks: 0", "nothing clicked");
  });
  await guard("typing without text is rejected", async () => {
    const obs = await observe();
    expectError(await act(obs, "TYPE_TEXT", el(obs, "City").index), ["target_invalid", "invalid_args"], "no text");
  });
  await guard("unknown element index is rejected", async () => {
    const obs = await observe();
    expectError(await act(obs, "CLICK", "999"), ["target_invalid", "invalid_args"], "index 999");
  });

  // Navigation last: the old document's observation must not be usable afterwards.
  await guard("navigation invalidates the old document", async () => {
    const obs = await observe();
    // page_changed may be true, or false/null if the post-input snapshot raced the commit.
    const r = expectOk(await act(obs, "CLICK", el(obs, "Next page").index), "click link");
    let after = await observe();
    for (let i = 0; i < 30 && !String(after.text).includes("You arrived at the next page."); i++) {
      await sleep(100);
      after = await observe();
    }
    expectText(after, "You arrived at the next page.", "next page");
    expectError(await act(obs, "CLICK", el(obs, "Continue").index), "stale_page", "old document's fingerprint");
    return `page_changed=${r.page_changed}`;
  }, { fresh: true });
} finally {
  if (!keepOpen) await finish(session).catch(() => undefined);
  await client.close();
  server.close();
}

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} guard check(s) FAILED` : `\nALL ${results.length} GUARD CHECKS PASSED (no model calls)`);
process.exit(failed ? 1 : 0);
