#!/usr/bin/env node
// Live: three sessions in ONE TabCrew window (the popup's default placement, "One TabCrew window,
// shared group") run tab_list, observe, and observe -> act(WAIT) concurrently; then the same
// observe -> act(WAIT) one session at a time for comparison. Prints median/max latency, checks that
// every call succeeded (page ops take turns on the window's active tab, so none may fail with
// stale_page or tab_not_owned), and exits 1 on any failure. No model calls.
// Over HTTP the sessions share one MCP connection; with TABCREW_TRANSPORT=shim each gets its own shim process.
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/concurrency.mjs
import { connect, describeTransport, transportMode } from "./connect.mjs";
console.log(describeTransport());
const perAgent = transportMode() === "shim";
const shared = perAgent ? null : await connect("phase");
const clients = shared ? [shared] : [];
const caller = (c) => async (n, a) => {
  const r = await c.callTool({ name: n, arguments: a });
  let json = null;
  try { json = JSON.parse(r.content.find((x) => x.type === "text")?.text ?? ""); } catch {}
  if (r.isError) throw new Error(`${n}: ${json?.code ?? "unparsable"}${json?.message ? ` (${json.message})` : ""}`);
  return json;
};
let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = [];
try {
  for (const l of ["p1", "p2", "p3"]) {
    const c = shared ?? (await connect(`phase-${l}`));
    if (!shared) clients.push(c);
    const j = caller(c);
    const s = (await j("session_open", { label: l })).session;
    S.push({ j, s, l });
  }
  const t0 = performance.now();
  await Promise.all(S.map(async (x) => (x.t = (await x.j("tab_create", { session: x.s, url: "https://example.com/?" + x.l })).tab_id)));
  console.log(`${S.length} sessions on ${clients.length} MCP connection(s); first tabs created in parallel in ${Math.round(performance.now() - t0)} ms`);

  // One shared group (and so one window): every session's group_list marks the same group as mine.
  const mine = await Promise.all(S.map(async (x) => ((await x.j("group_list", { session: x.s })).groups ?? []).filter((g) => g.mine).map((g) => g.name)));
  if (mine.every((m) => m.length === 1) && new Set(mine.map((m) => m[0])).size === 1) console.log(`shared group: "${mine[0][0]}"`);
  else fail(`sessions are not in one shared TabCrew group (mine: ${mine.map((m) => m.join("|") || "-").join(", ")})`);

  await sleep(3000);
  const report = (name, wall, per, errors) => {
    per.sort((a, b) => a - b);
    console.log(`${name.padEnd(36)} wall ${Math.round(wall)} ms, median ${Math.round(per[per.length >> 1] ?? 0)} ms, max ${Math.round(per.at(-1) ?? 0)} ms${errors.length ? `, ${errors.length} error(s)` : ""}`);
    for (const e of [...new Set(errors)]) fail(`${name}: ${e}`);
    return wall;
  };
  const ROUNDS = 8;
  const timedRounds = async (x, fn, per, errors) => {
    for (let i = 0; i < ROUNDS; i++) {
      const a = performance.now();
      try { await fn(x); } catch (err) { errors.push(`${x.l}: ${err.message}`); }
      per.push(performance.now() - a);
    }
  };
  const parallel = async (name, fn) => {
    const per = []; const errors = []; const t = performance.now();
    await Promise.all(S.map((x) => timedRounds(x, fn, per, errors)));
    const wall = report(name, performance.now() - t, per, errors);
    await sleep(500);
    return wall;
  };
  const serial = async (name, fn) => {
    const per = []; const errors = []; const t = performance.now();
    for (const x of S) await timedRounds(x, fn, per, errors);
    const wall = report(name, performance.now() - t, per, errors);
    await sleep(500);
    return wall;
  };
  const observeAct = async (x) => {
    const o = await x.j("observe", { session: x.s, tab_id: x.t });
    const a = await x.j("act", { session: x.s, tab_id: x.t, fingerprint: o.fingerprint, operation: "WAIT" });
    if (a?.executed?.operation !== "WAIT") throw new Error(`act did not execute WAIT (${JSON.stringify(a?.executed ?? null)})`);
  };
  await parallel("tab_list only (no debugger)", async (x) => {
    const tabs = (await x.j("tab_list", { session: x.s })).tabs ?? [];
    if (tabs.length !== 1 || tabs[0].tab_id !== x.t) throw new Error(`tab_list shows [${tabs.map((t) => t.tab_id)}], expected [${x.t}]`);
  });
  await parallel("observe only (snapshot)", async (x) => {
    if (!(await x.j("observe", { session: x.s, tab_id: x.t })).fingerprint) throw new Error("observe returned no fingerprint");
  });
  const together = await parallel("observe -> act(WAIT), in parallel", observeAct);
  const alone = await serial("observe -> act(WAIT), one at a time", observeAct);
  console.log(`parallel / one-at-a-time wall: ${(together / alone).toFixed(2)} (1.00 = page ops fully took turns)`);
} catch (err) {
  fail(`run aborted: ${err.message}`);
} finally {
  // Close the tabs with the session, so nothing is left behind for the user.
  for (const x of S) {
    try {
      const r = await x.j("session_close", { session: x.s, tabs: "close" });
      if (x.t !== undefined && r.kept_tabs !== 0) fail(`${x.l}: session_close kept ${r.kept_tabs} tab(s)`);
    } catch (err) {
      fail(`${x.l}: ${err.message}`);
    }
  }
  for (const c of clients) await c.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall calls succeeded");
process.exit(failures ? 1 : 0);
