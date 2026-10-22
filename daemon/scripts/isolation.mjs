#!/usr/bin/env node
// Live isolation test against a running daemon (or hub) + the TabCrew extension. No model calls.
// Three sessions each drive their own tab concurrently with observe -> act(WAIT) -> observe loops,
// and every cross-session attempt must fail. Over HTTP the three share ONE MCP connection; with
// TABCREW_TRANSPORT=shim every simulated agent gets its own shim process (as separate OpenCode
// instances would), and closing an agent's connection must end the sessions it opened.
// Usage: [TABCREW_TRANSPORT=shim] node daemon/scripts/isolation.mjs [--keep-open]
import { connect, describeTransport, transportMode } from "./connect.mjs";

const keepOpen = process.argv.includes("--keep-open");
const LOOPS = 3;
const perAgent = transportMode() === "shim";

console.log(describeTransport());
const shared = perAgent ? null : await connect("tabcrew-isolation");
const clients = shared ? [shared] : [];

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};
const caller = (client) => async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { error: r.isError ? json ?? { code: "unparsable" } : null, json, raw: r };
};
/** A new MCP connection per agent in shim mode, else the shared one. */
async function agentClient(label) {
  if (shared) return shared;
  const client = await connect(`tabcrew-isolation-${label}`);
  clients.push(client);
  return client;
}

// session_close hands remaining tabs to the user; close ours first so nothing is left behind.
async function finish(call, session) {
  const tabs = (await call("tab_list", { session })).json?.tabs ?? [];
  let closed = 0;
  for (const t of tabs) if (!(await call("tab_close", { session, tab_id: t.tab_id })).error) closed++;
  const res = await call("session_close", { session });
  return { closed, kept: res.json?.kept_tabs ?? 0, error: res.error };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const firstClient = await agentClient("iso-A");
const tools = (await firstClient.listTools()).tools.map((t) => t.name);
check("observe and act are exposed", tools.includes("observe") && tools.includes("act"), tools.sort().join(", "));

const pages = [
  { label: "iso-A", url: "https://example.com/" },
  { label: "iso-B", url: "https://en.wikipedia.org/wiki/Main_Page" },
  { label: "iso-C", url: "https://www.iana.org/help/example-domains" },
];
const sessions = [];
let exitCode = 0;

try {
  for (const p of pages) {
    const call = caller(p === pages[0] ? firstClient : await agentClient(p.label));
    const s = (await call("session_open", { label: p.label })).json;
    if (!s?.session) throw new Error(`session_open failed for ${p.label}`);
    sessions.push({ ...p, call, handle: s.session, short_id: s.short_id });
  }
  check(
    `three sessions opened on ${perAgent ? "three MCP connections (one shim each)" : "one MCP connection"}`,
    new Set(sessions.map((s) => s.handle)).size === 3,
    sessions.map((s) => s.short_id).join(", "),
  );

  const tc = Date.now();
  const created = await Promise.all(sessions.map((s) => s.call("tab_create", { session: s.handle, url: s.url })));
  const createdOk = created.every((r) => !r.error && Number.isInteger(r.json?.tab_id));
  check("each session created its own tab", createdOk, `${Date.now() - tc} ms; ${created.map((r) => r.json?.tab_id ?? r.error?.code).join(", ")}`);
  if (!createdOk) throw new Error("tab_create failed; is the TabCrew extension connected?");
  sessions.forEach((s, i) => (s.tab = created[i].json.tab_id));

  await sleep(2000); // let pages load

  for (const s of sessions) {
    const list = await s.call("tab_list", { session: s.handle });
    const ids = list.json?.tabs?.map((t) => t.tab_id) ?? [];
    check(`${s.label}: tab_list shows exactly its own tab`, !list.error && ids.length === 1 && ids[0] === s.tab, `sees [${ids}]${list.error ? ` ${list.error.code}` : ""}`);
  }

  async function ownLoop(s) {
    const steps = [];
    const timed = async (name, args) => {
      const t = Date.now();
      const r = await s.call(name, args);
      steps.push({ name, ms: Date.now() - t, error: r.error?.code });
      return r;
    };
    let ok = true;
    let staleOk = true;
    const start = Date.now();
    for (let i = 0; i < LOOPS; i++) {
      const before = await timed("observe", { session: s.handle, tab_id: s.tab });
      const fp = before.json?.fingerprint;
      if (before.error || !fp || !Array.isArray(before.json?.elements)) { ok = false; break; }
      const act = await timed("act", { session: s.handle, tab_id: s.tab, fingerprint: fp, operation: "WAIT" });
      if (act.error || act.json?.executed?.operation !== "WAIT") { ok = false; break; }
      if (i === 0) {
        const reuse = await s.call("act", { session: s.handle, tab_id: s.tab, fingerprint: fp, operation: "WAIT" });
        staleOk = reuse.error?.code === "stale_page";
      }
      const after = await timed("observe", { session: s.handle, tab_id: s.tab });
      if (after.error || !after.json?.fingerprint) { ok = false; break; }
    }
    return { ok, staleOk, steps, start, end: Date.now() };
  }

  async function crossAttempts(s, victim) {
    const args = { session: s.handle, tab_id: victim.tab };
    const attempts = await Promise.all([
      s.call("observe", args),
      s.call("act", { ...args, fingerprint: "0".repeat(64), operation: "WAIT" }),
      s.call("screenshot", args),
      s.call("tab_close", args),
    ]);
    return ["observe", "act", "screenshot", "tab_close"].map((name, i) => ({ name, code: attempts[i].error?.code ?? "ok" }));
  }

  const t0 = Date.now();
  const runs = await Promise.all(
    sessions.map(async (s, i) => {
      const victim = sessions[(i + 1) % sessions.length];
      const [own, cross] = await Promise.all([ownLoop(s), crossAttempts(s, victim)]);
      return { s, victim, own, cross };
    }),
  );
  const wall = Date.now() - t0;

  for (const { s, victim, own, cross } of runs) {
    const failed = own.steps.filter((st) => st.error).map((st) => `${st.name}:${st.error}`);
    const avg = (name) => {
      const xs = own.steps.filter((st) => st.name === name).map((st) => st.ms);
      return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
    };
    check(
      `${s.label}: ${LOOPS}x observe -> act(WAIT) -> observe on its own tab`,
      own.ok && failed.length === 0,
      `${own.end - own.start} ms; avg observe ${avg("observe")} ms, act ${avg("act")} ms${failed.length ? `; errors ${failed.join(" ")}` : ""}`,
    );
    check(`${s.label}: reusing a fingerprint after act is stale_page`, own.staleOk);
    check(
      `${s.label}: cannot touch ${victim.label}'s tab`,
      cross.every((c) => c.code === "tab_not_owned"),
      cross.map((c) => `${c.name}=${c.code}`).join(" "),
    );
  }

  const sum = runs.reduce((n, r) => n + (r.own.end - r.own.start), 0);
  const longest = Math.max(...runs.map((r) => r.own.end - r.own.start));
  const overlap = runs.every((a) => runs.every((b) => a.own.start < b.own.end && b.own.start < a.own.end));
  console.log(`timing: wall ${wall} ms, sum of per-session times ${sum} ms, longest session ${longest} ms`);
  check("sessions progressed concurrently", overlap && wall < sum * 0.75, `wall/sum = ${(wall / sum).toFixed(2)}; overlapping=${overlap}`);

  for (const s of sessions) {
    const list = await s.call("tab_list", { session: s.handle });
    const ids = list.json?.tabs?.map((t) => t.tab_id) ?? [];
    check(`${s.label}: its tab survived the other sessions' attempts`, ids.length === 1 && ids[0] === s.tab, `sees [${ids}]`);
  }

  if (perAgent) {
    // Per-connection ownership: a session ends (handed to the user) when the shim that opened it exits.
    const extra = await connect("tabcrew-isolation-ephemeral");
    const opened = (await caller(extra)("session_open", { label: "iso-ephemeral" })).json;
    await extra.close();
    let code = "ok";
    for (let i = 0; i < 20 && code !== "bad_session"; i++) {
      await sleep(250);
      code = (await sessions[0].call("tab_list", { session: opened?.session ?? "s_missing" })).error?.code ?? "ok";
    }
    check("a session ends when the MCP connection that opened it closes", Boolean(opened?.session) && code === "bad_session", code);
  }
} catch (err) {
  check("run completed", false, err.message);
} finally {
  if (!keepOpen) {
    for (const s of sessions) {
      const c = await finish(s.call, s.handle);
      check(`${s.label}: tab closed and session ended, nothing handed over`, !c.error && c.closed >= (s.tab ? 1 : 0) && c.kept === 0, c.error?.code ?? `closed ${c.closed}, kept ${c.kept}`);
    }
  }
  for (const client of clients) await client.close();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
  exitCode = failed ? 1 : 0;
}
process.exit(exitCode);
