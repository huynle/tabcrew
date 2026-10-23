#!/usr/bin/env node
// Live isolation test against a running daemon (or hub) + the TabCrew extension. No model calls.
// Assumes the popup's default placement, "One TabCrew window, shared group".
// Shared group: three sessions open their tabs in the SAME default TabCrew group (one window) and
// each drives its own tab concurrently with observe -> act(WAIT) -> observe loops; tab_list must
// show only the session's own tab, and every cross-session attempt must fail with tab_not_owned.
// Named group: three more sessions do the same in one group passed to session_open, then finish
// with session_close {tabs: "close"}.
// Over HTTP all sessions share ONE MCP connection; with TABCREW_TRANSPORT=shim every simulated agent
// gets its own shim process (as separate OpenCode instances would), and closing an agent's
// connection must end the sessions it opened.
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

// session_close leaves remaining tabs for the user (default: keep); close ours first so nothing is left behind.
async function finish(call, session) {
  const tabs = (await call("tab_list", { session })).json?.tabs ?? [];
  let closed = 0;
  for (const t of tabs) if (!(await call("tab_close", { session, tab_id: t.tab_id })).error) closed++;
  const res = await call("session_close", { session });
  return { closed, kept: res.json?.kept_tabs ?? 0, error: res.error };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabIds = (list) => list.json?.tabs?.map((t) => t.tab_id) ?? [];

/** group_list for every session: each must see exactly one group marked mine, and all the same one. */
async function sameGroup(group, expected) {
  const lists = await Promise.all(group.map((s) => s.call("group_list", { session: s.handle })));
  const errors = lists.filter((l) => l.error).map((l) => l.error.code);
  const mine = lists.map((l) => (l.json?.groups ?? []).filter((g) => g.mine).map((g) => g.name));
  const names = new Set(mine.map((m) => m.join("|")));
  const listed = expected === undefined || lists.every((l) => (l.json?.groups ?? []).filter((g) => g.name === expected).length === 1);
  const ok = errors.length === 0 && mine.every((m) => m.length === 1) && names.size === 1 && listed && (expected === undefined || names.has(expected));
  const detail = errors.length ? `group_list errors: ${errors.join(", ")} (extension without named groups?)` : `mine: ${mine.map((m) => m.join("|") || "-").join(", ")}`;
  return { ok, detail, name: mine[0]?.[0] };
}

/** Each session's tab_list shows exactly its own tab: none of the others in the same group. */
async function ownTabsOnly(group, tag) {
  for (const s of group) {
    const list = await s.call("tab_list", { session: s.handle });
    const ids = tabIds(list);
    check(`${tag}${s.label}: tab_list shows exactly its own tab, none of the others in its group`, !list.error && ids.length === 1 && ids[0] === s.tab, `sees [${ids}]${list.error ? ` ${list.error.code}` : ""}`);
  }
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

const firstClient = await agentClient("iso-A");
const tools = (await firstClient.listTools()).tools.map((t) => t.name);
check("observe, act and the group tools are exposed", ["observe", "act", "group_list", "group_rename"].every((t) => tools.includes(t)), tools.sort().join(", "));

const pages = [
  { label: "iso-A", url: "https://example.com/" },
  { label: "iso-B", url: "https://en.wikipedia.org/wiki/Main_Page" },
  { label: "iso-C", url: "https://www.iana.org/help/example-domains" },
];
const sessions = [];
const named = [];
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

  const grouped = await sameGroup(sessions);
  check("all three sessions share one TabCrew group (the default group)", grouped.ok, grouped.detail);

  await sleep(2000); // let pages load

  await ownTabsOnly(sessions, "");

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
      `${s.label}: cannot touch ${victim.label}'s tab in the same group`,
      cross.every((c) => c.code === "tab_not_owned"),
      cross.map((c) => `${c.name}=${c.code}`).join(" "),
    );
  }

  const sum = runs.reduce((n, r) => n + (r.own.end - r.own.start), 0);
  const longest = Math.max(...runs.map((r) => r.own.end - r.own.start));
  const overlap = runs.every((a) => runs.every((b) => a.own.start < b.own.end && b.own.start < a.own.end));
  console.log(`timing: wall ${wall} ms, sum of per-session times ${sum} ms, longest session ${longest} ms`);
  // One shared window: page ops take turns on the active tab, so only overlap is required here
  // (the speed-up comes from model and network time, which these WAIT loops barely have).
  check("sessions progressed concurrently in one window", overlap, `wall/sum = ${(wall / sum).toFixed(2)}; overlapping=${overlap}`);

  for (const s of sessions) {
    const list = await s.call("tab_list", { session: s.handle });
    const ids = tabIds(list);
    check(`${s.label}: its tab survived the other sessions' attempts`, ids.length === 1 && ids[0] === s.tab, `sees [${ids}]`);
  }

  // Named group: three sessions join one group given to session_open, isolated the same way.
  const groupName = `iso ${Date.now().toString(36).slice(-6)}`;
  for (const [i, s] of sessions.entries()) {
    const label = `iso-N${i + 1}`;
    const opened = (await s.call("session_open", { label, group: groupName })).json;
    if (!opened?.session) throw new Error(`session_open with group failed for ${label}`);
    named.push({ label, call: s.call, handle: opened.session, group: opened.group, note: opened.note, url: `https://example.com/?${label}` });
  }
  check(`named group: session_open echoes group "${groupName}"`, named.every((n) => n.group === groupName && !n.note), named.map((n) => n.note ?? n.group ?? "-").join(" | "));
  const namedCreated = await Promise.all(named.map((n) => n.call("tab_create", { session: n.handle, url: n.url })));
  check("named group: each session created its own tab", namedCreated.every((r) => !r.error && Number.isInteger(r.json?.tab_id)), namedCreated.map((r) => r.json?.tab_id ?? r.error?.code).join(", "));
  named.forEach((n, i) => (n.tab = namedCreated[i].json?.tab_id));
  const inNamed = await sameGroup(named, groupName);
  check(`named group: all three sessions are in "${groupName}"`, inNamed.ok, inNamed.detail);
  await sleep(1500);
  await ownTabsOnly(named, "named group: ");
  const namedRuns = await Promise.all(
    named.map(async (n, i) => {
      const victim = named[(i + 1) % named.length];
      const own = await n.call("observe", { session: n.handle, tab_id: n.tab });
      const act = own.json?.fingerprint
        ? await n.call("act", { session: n.handle, tab_id: n.tab, fingerprint: own.json.fingerprint, operation: "WAIT" })
        : own;
      return { n, victim, act, cross: await crossAttempts(n, victim) };
    }),
  );
  for (const { n, victim, act, cross } of namedRuns) {
    check(`named group: ${n.label} observe -> act(WAIT) on its own tab`, !act.error && act.json?.executed?.operation === "WAIT", act.error?.code ?? "");
    check(`named group: ${n.label} cannot touch ${victim.label}'s tab`, cross.every((c) => c.code === "tab_not_owned"), cross.map((c) => `${c.name}=${c.code}`).join(" "));
  }
  if (!keepOpen) {
    for (const n of named.splice(0)) {
      const res = await n.call("session_close", { session: n.handle, tabs: "close" });
      const after = await n.call("tab_list", { session: n.handle });
      check(
        `named group: ${n.label} session_close {tabs: "close"} closed its tab and ended the session`,
        !res.error && res.json?.closed_tabs === 1 && res.json?.kept_tabs === 0 && after.error?.code === "bad_session",
        res.error?.code ?? `closed_tabs ${res.json?.closed_tabs}, kept ${res.json?.kept_tabs}, mode ${res.json?.mode}, then ${after.error?.code ?? "ok"}`,
      );
    }
  }

  if (perAgent) {
    // Per-connection ownership: a session ends when the shim that opened it exits.
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
    for (const n of named) await n.call("session_close", { session: n.handle, tabs: "close" }).catch(() => undefined);
    for (const s of sessions) {
      const c = await finish(s.call, s.handle);
      check(`${s.label}: tab closed and session ended, nothing left behind`, !c.error && c.closed >= (s.tab ? 1 : 0) && c.kept === 0, c.error?.code ?? `closed ${c.closed}, kept ${c.kept}`);
    }
  }
  for (const client of clients) await client.close();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} check(s) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
  exitCode = failed ? 1 : 0;
}
process.exit(exitCode);
