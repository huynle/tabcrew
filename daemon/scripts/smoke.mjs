#!/usr/bin/env node
// Live smoke test against a running daemon (or hub) + the TabCrew extension. No model calls.
// Covers sessions/tabs/isolation/screenshot plus navigate, read_text and debug_logs.
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/smoke.mjs [--keep-open] [--out DIR]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, describeTransport } from "./connect.mjs";

const keepOpen = process.argv.includes("--keep-open");
const outIdx = process.argv.indexOf("--out");
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;

console.log(describeTransport());
const client = await connect("tabcrew-smoke");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { error: r.isError ? json : null, json, raw: r };
}

// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
async function finish(session) {
  const tabs = (await call("tab_list", { session })).json?.tabs ?? [];
  let closed = 0;
  for (const t of tabs) if (!(await call("tab_close", { session, tab_id: t.tab_id })).error) closed++;
  const res = await call("session_close", { session });
  return { closed, kept: res.json?.kept_tabs ?? 0, error: res.error };
}

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

// Two agents share this ONE MCP connection; isolation comes from session handles.
const a = (await call("session_open", { label: "smoke-A" })).json;
const b = (await call("session_open", { label: "smoke-B" })).json;
check("two sessions opened", Boolean(a?.session && b?.session && a.session !== b.session), `${a?.short_id}, ${b?.short_id}`);

const t0 = Date.now();
const [ta, tb] = await Promise.all([
  call("tab_create", { session: a.session, url: "https://example.com/" }),
  call("tab_create", { session: b.session, url: "https://en.wikipedia.org/wiki/Main_Page" }),
]);
check("each session created its own tab in parallel", !ta.error && !tb.error, `${Date.now() - t0} ms; A=${ta.json?.tab_id} B=${tb.json?.tab_id}`);
if (ta.error || tb.error) {
  console.log(`stopping: tab_create failed (${ta.error?.code ?? ""} ${tb.error?.code ?? ""}); is the extension connected?`);
  for (const s of [a, b]) await finish(s.session);
  await client.close();
  process.exit(1);
}
const tabA = ta.json.tab_id, tabB = tb.json.tab_id;

const la = (await call("tab_list", { session: a.session })).json?.tabs?.map((t) => t.tab_id) ?? [];
const lb = (await call("tab_list", { session: b.session })).json?.tabs?.map((t) => t.tab_id) ?? [];
check("tab_list is scoped to each session", la.includes(tabA) && !la.includes(tabB) && lb.includes(tabB) && !lb.includes(tabA), `A sees ${la}, B sees ${lb}`);

const cross = await call("screenshot", { session: b.session, tab_id: tabA });
check("B cannot screenshot A's tab", cross.error?.code === "tab_not_owned", cross.error?.code);
const crossClose = await call("tab_close", { session: a.session, tab_id: tabB });
check("A cannot close B's tab", crossClose.error?.code === "tab_not_owned", crossClose.error?.code);
const bad = await call("tab_list", { session: "s_not-a-real-session-handle" });
check("unknown session handle rejected", bad.error?.code === "bad_session", bad.error?.code);

await new Promise((r) => setTimeout(r, 1500)); // let pages paint
const t1 = Date.now();
const [sa, sb] = await Promise.all([
  call("screenshot", { session: a.session, tab_id: tabA }),
  call("screenshot", { session: b.session, tab_id: tabB }),
]);
const imgA = sa.raw.content.find((c) => c.type === "image");
const imgB = sb.raw.content.find((c) => c.type === "image");
check("both background tabs screenshot in parallel", Boolean(imgA && imgB), `${Date.now() - t1} ms; ${sa.error?.code ?? ""}${sb.error?.code ?? ""}`);
if (out && imgA && imgB) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "A.jpg"), Buffer.from(imgA.data, "base64"));
  writeFileSync(join(out, "B.jpg"), Buffer.from(imgB.data, "base64"));
  console.log(`screenshots saved to ${out}/A.jpg and ${out}/B.jpg`);
}

// navigate / read_text / debug_logs on A's tab (example.com).
const IANA = "https://www.iana.org/help/example-domains";
const stripped = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return u; } };
const t2 = Date.now();
const nav = await call("navigate", { session: a.session, tab_id: tabA, url: IANA });
check("navigate opens the IANA example-domains page", !nav.error && /iana\.org/.test(nav.json?.url ?? ""), `${Date.now() - t2} ms; ${nav.error?.code ?? nav.json?.url}`);
const navCross = await call("navigate", { session: b.session, tab_id: tabA, action: "reload" });
check("B cannot navigate A's tab", navCross.error?.code === "tab_not_owned", navCross.error?.code);
const navBad = await call("navigate", { session: a.session, tab_id: tabA, url: "javascript:alert(1)" });
check("navigate rejects non-http(s) URLs", navBad.error?.code === "invalid_args", navBad.error?.code);

const NETWORK_KEYS = new Set(["method", "url", "status", "type", "failed", "ms", "t"]);
const CONSOLE_KEYS = new Set(["level", "text", "url", "t"]);
const net = await call("debug_logs", { session: a.session, tab_id: tabA, source: "network", limit: 200 });
const netEntries = net.json?.entries ?? [];
const targets = new Set([stripped(IANA), stripped(nav.json?.url ?? IANA)]);
check("debug_logs network has an entry for the navigated URL", !net.error && netEntries.some((e) => targets.has(e.url)), `${netEntries.length} entries, dropped ${net.json?.dropped}`);
check("network entries have no query strings", netEntries.every((e) => typeof e.url === "string" && !e.url.includes("?") && !e.url.includes("#")));
check("network entries carry only whitelisted keys (no headers/cookies/bodies)", netEntries.every((e) => Object.keys(e).every((k) => NETWORK_KEYS.has(k))),
  [...new Set(netEntries.flatMap((e) => Object.keys(e)).filter((k) => !NETWORK_KEYS.has(k)))].join(",") || "ok");
const con = await call("debug_logs", { session: a.session, tab_id: tabA, source: "console" });
check("debug_logs console answers with whitelisted keys", !con.error && (con.json?.entries ?? []).every((e) => Object.keys(e).every((k) => CONSOLE_KEYS.has(k))), con.error?.code ?? `${con.json?.entries?.length} entries`);
const logsCross = await call("debug_logs", { session: b.session, tab_id: tabA, source: "network" });
check("B cannot read A's logs", logsCross.error?.code === "tab_not_owned", logsCross.error?.code);

const back = await call("navigate", { session: a.session, tab_id: tabA, action: "back" });
check("navigate back returns to example.com", !back.error && /example\.com/.test(back.json?.url ?? ""), back.error?.code ?? back.json?.url);
const text = await call("read_text", { session: a.session, tab_id: tabA });
check("read_text contains \"documentation examples\"", !text.error && (text.json?.text ?? "").includes("documentation examples"), text.error?.code ?? `${text.json?.text?.length} chars`);
const short = await call("read_text", { session: a.session, tab_id: tabA, max_length: 7 });
check("read_text honours max_length", short.json?.text?.length === 7 && short.json?.truncated === true, JSON.stringify(short.json?.text));
const textCross = await call("read_text", { session: b.session, tab_id: tabA });
check("B cannot read A's text", textCross.error?.code === "tab_not_owned", textCross.error?.code);

if (!keepOpen) {
  const ca = await finish(a.session);
  const cb = await finish(b.session);
  check("sessions cleaned up: tabs closed, nothing handed over", !ca.error && !cb.error && ca.closed >= 1 && cb.closed >= 1 && ca.kept === 0 && cb.kept === 0,
    `A closed ${ca.closed} kept ${ca.kept}, B closed ${cb.closed} kept ${cb.kept}`);
  const after = await call("tab_list", { session: a.session });
  check("closed session handle no longer works", after.error?.code === "bad_session", after.error?.code);
}

await client.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
