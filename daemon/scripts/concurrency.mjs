#!/usr/bin/env node
// Live: three sessions run tab_list, observe, and observe+act(WAIT) concurrently; prints median/max latency. No model calls.
// Over HTTP the sessions share one MCP connection; with TABCREW_TRANSPORT=shim each gets its own shim process.
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/concurrency.mjs
import { connect, describeTransport, transportMode } from "./connect.mjs";
console.log(describeTransport());
const perAgent = transportMode() === "shim";
const shared = perAgent ? null : await connect("phase");
const clients = shared ? [shared] : [];
const caller = (c) => async (n, a) => { const r = await c.callTool({ name: n, arguments: a }); return JSON.parse(r.content.find(x => x.type === "text").text); };
const S = [];
for (const l of ["p1", "p2", "p3"]) {
  const c = shared ?? (await connect(`phase-${l}`));
  if (!shared) clients.push(c);
  const j = caller(c);
  const s = (await j("session_open", { label: l })).session;
  const t = (await j("tab_create", { session: s, url: "https://example.com/?" + l })).tab_id;
  S.push({ j, s, t });
}
console.log(`${S.length} sessions on ${clients.length} MCP connection(s)`);
await new Promise(r => setTimeout(r, 3000));
const phase = async (name, fn) => {
  const t0 = performance.now(); const per = [];
  await Promise.all(S.map(async (x) => { for (let i = 0; i < 8; i++) { const a = performance.now(); await fn(x); per.push(performance.now() - a); } }));
  per.sort((a, b) => a - b);
  console.log(`${name.padEnd(28)} wall ${Math.round(performance.now() - t0)} ms, median ${Math.round(per[per.length >> 1])} ms, max ${Math.round(per.at(-1))} ms`);
  await new Promise(r => setTimeout(r, 500));
};
await phase("tab_list only (no debugger)", (x) => x.j("tab_list", { session: x.s }));
await phase("observe only (snapshot)", (x) => x.j("observe", { session: x.s, tab_id: x.t }));
await phase("observe + act(WAIT)", async (x) => { const o = await x.j("observe", { session: x.s, tab_id: x.t }); await x.j("act", { session: x.s, tab_id: x.t, fingerprint: o.fingerprint, operation: "WAIT" }); });
// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
for (const x of S) {
  for (const t of (await x.j("tab_list", { session: x.s })).tabs ?? []) await x.j("tab_close", { session: x.s, tab_id: t.tab_id });
  await x.j("session_close", { session: x.s });
}
for (const c of clients) await c.close();
