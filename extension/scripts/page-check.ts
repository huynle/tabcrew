/**
 * Headless check of the page scripts (snapshot, act) against extension/test-fixtures/modal.html:
 * scroll areas inside an open modal, clip-aware element inclusion, scroll-into-view before input.
 *
 * It runs the real PageController / runAct over CDP in a throwaway headless Chrome (fresh
 * temporary --user-data-dir, deleted afterwards). It never touches your browser or the daemon.
 *
 * Usage: npx tsx extension/scripts/page-check.ts   (CHROME_BIN=/path/to/chrome to override)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { V2Snapshot } from "@tabcrew/shared/v2";
import { PageController } from "../src/snapshot/controller.js";

const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const CHROME = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p): p is string => !!p && existsSync(p));
if (!CHROME) {
  console.error("No Chrome/Chromium found; set CHROME_BIN.");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- fixture server ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const name = basename(new URL(req.url ?? "/", "http://x").pathname) || "modal.html";
  if (extname(name) !== ".html") return void res.writeHead(404).end();
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(FIXTURES, name)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// --- headless Chrome + CDP ----------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "tabcrew-page-check-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1000,800", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
chrome.stderr!.on("data", (d) => (stderr += d));
let wsUrl = "";
for (let i = 0; i < 200 && !wsUrl; i++) {
  wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] ?? "";
  if (!wsUrl) await sleep(50);
}
if (!wsUrl) throw new Error(`Chrome did not start:\n${stderr.slice(-1000)}`);

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
};
function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
await cdp("Page.enable", {}, sessionId);
await cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
const TAB = 1;
/** Results of the act-side scripts, by tag (to tell a wheel scroll from the script fallback, a reveal). */
const seen: Record<string, unknown[]> = {};
const page = new PageController({
  send: async (_tab, method, params) => {
    const result = await cdp(method, params ?? {}, sessionId);
    const tag = /^\/\*cu:(\w+)\*\//.exec(String(params?.expression ?? ""))?.[1];
    if (tag === "scrolled" || tag === "target") (seen[tag] ??= []).push(result?.result?.value);
    return result;
  },
  isMac: async () => process.platform === "darwin",
});
const lastSeen = (tag: string) => seen[tag]?.at(-1) as Record<string, unknown> | undefined;
const evalJs = async (expression: string) => (await cdp("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;

async function load(path: string): Promise<void> {
  await cdp("Page.navigate", { url: `${base}/${path}` }, sessionId);
  for (let i = 0; i < 100; i++) {
    if ((await evalJs("document.readyState")) === "complete") break;
    await sleep(30);
  }
  page.forget(TAB);
}

// --- checks -------------------------------------------------------------------------------------
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const labels = (s: V2Snapshot) => s.actions.map((a) => a.label);
const find = (s: V2Snapshot, label: string) => s.actions.find((a) => a.label === label);

try {
  // 1. Open modal, page locked.
  await load("modal.html");
  let snap = await page.snapshot(TAB);
  const scrolls = snap.actions.filter((a) => a.kind === "scroll");
  check("modal: offers 'Scroll down in \"Provider settings\" dialog' as the first scroll control", scrolls[0]?.label === 'Scroll down in "Provider settings" dialog' && scrolls[0]?.id === "scroll_down_1", scrolls);
  check("modal: no page scroll while the page is locked behind the dialog", !scrolls.some((a) => a.id === "scroll_down" || a.id === "scroll_up"), scrolls);
  check("modal: background controls behind the backdrop are not offered", !labels(snap).some((l) => l.startsWith("Background") || l === "Open provider settings" || l.startsWith("Activity")), labels(snap));
  check("modal: Preview sync (below the dialog's fold) is not offered yet", !find(snap, "Preview sync"), labels(snap));
  check("modal: dialog text comes first", snap.text.startsWith("Provider settings"), snap.text.slice(0, 80));
  check("modal: the clipped Notes field is not offered", !snap.actions.some((a) => a.label === "Notes"), labels(snap));

  // 2. Scroll the dialog until Preview sync is offered, then click it.
  let steps = 0;
  while (!find(snap, "Preview sync") && steps < 6) {
    const before = snap.fingerprint;
    const down = snap.actions.find((a) => a.id === "scroll_down_1");
    if (!down) break;
    const r = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: down.id });
    snap = await page.snapshot(TAB);
    check(`scroll ${++steps}: page_changed and a new fingerprint`, r.page_changed === true && snap.fingerprint !== before, r);
  }
  check("the dialog scrolled by the mouse wheel (not the script fallback)", lastSeen("scrolled")?.by === "wheel", seen.scrolled);
  check("scrolling the dialog moved the dialog body, not the page", (await evalJs("[scrollY, document.querySelector('#dialog .body').scrollTop > 0]")).join() === "0,true");
  check("after scrolling, 'Scroll up in \"Provider settings\" dialog' is offered", !!snap.actions.find((a) => a.id === "scroll_up_1"), labels(snap));
  const preview = find(snap, "Preview sync");
  check("Preview sync becomes clickable", !!preview, labels(snap));
  if (preview) {
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: preview.id });
    check("clicking Preview sync works", (await evalJs("document.querySelector('#result').textContent")) === "Preview ready: 3 models");
  }

  // 3. Stale detection: the dialog scrolled by someone else → stale_page.
  snap = await page.snapshot(TAB);
  await evalJs("document.querySelector('#dialog .body').scrollTop -= 30");
  const up = snap.actions.find((a) => a.id === "scroll_up_1")!;
  const stale = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: up.id }).catch((e) => e);
  check("an outside dialog scroll makes the old observation stale (scroll)", stale?.code === "stale_page", stale);
  snap = await page.snapshot(TAB);
  const field = snap.actions.find((a) => a.kind === "fill")!;
  await evalJs("document.querySelector('#dialog .body').scrollTop -= 30");
  const staleClick = await page.act(TAB, { fingerprint: snap.fingerprint, action_id: snap.actions.find((a) => a.kind === "click" && a.node === field.node)!.id }).catch((e) => e);
  check("an outside dialog scroll makes the old observation stale (click)", staleClick?.code === "stale_page", staleClick);

  // 4. Scroll into view: a field under the sticky note is offered but covered; act reveals it.
  await load("modal.html");
  snap = await page.snapshot(TAB);
  const covered = await evalJs(`(() => { const out=[]; for (const i of document.querySelectorAll('#dialog input')) {
    const r=i.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2; if (y < 800 && !i.contains(document.elementFromPoint(x,y))) out.push(i.name); } return out; })()`);
  const coveredName = (covered as string[]).find((n) => snap.actions.some((a) => a.kind === "fill" && a.label.toLowerCase().startsWith(n)));
  const target = snap.actions.find((a) => a.kind === "fill" && coveredName && a.label.toLowerCase().startsWith(coveredName));
  check("a field covered by the dialog's sticky note is offered", !!target, { covered, labels: labels(snap) });
  if (target) {
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: target.id, text: "eu-west" });
    check("the target check revealed it", lastSeen("target")?.revealed === true, seen.target);
    check("filling it scrolled it into view first and typed into it", (await evalJs(`document.querySelector('#dialog input[name=${coveredName}]').value`)) === "eu-west");
  }

  // 5. Closed dialog: the page behaves as before, plus a panel scroll area.
  await load("modal.html?closed=1");
  snap = await page.snapshot(TAB);
  const pageScrolls = snap.actions.filter((a) => a.kind === "scroll");
  check("closed: page 'Scroll down' first, unchanged", pageScrolls[0]?.id === "scroll_down" && pageScrolls[0]?.label === "Scroll down", pageScrolls);
  check("closed: background controls are offered", !!find(snap, "Background action one") && !!find(snap, "Open provider settings"), labels(snap));
  const panel = pageScrolls.find((a) => a.label === 'Scroll down in "Activity" panel');
  check("closed: the Activity side panel is a scroll area", !!panel, pageScrolls);
  if (panel) {
    await page.act(TAB, { fingerprint: snap.fingerprint, action_id: panel.id });
    check("the panel scrolled by the mouse wheel", lastSeen("scrolled")?.by === "wheel", seen.scrolled);
    check("scrolling the panel moved the panel, not the page", (await evalJs("[scrollY, document.querySelector('#activity').scrollTop > 0]")).join() === "0,true");
    snap = await page.snapshot(TAB);
  }
  const pageDown = snap.actions.find((a) => a.id === "scroll_down")!;
  await page.act(TAB, { fingerprint: snap.fingerprint, action_id: pageDown.id });
  check("page Scroll down still scrolls the page", (await evalJs("scrollY")) > 0);

  // 6. No point where a wheel reaches the area (an invisible overlay over it): scroll by script.
  await load("modal.html?closed=1");
  await evalJs(`(() => { const o=document.createElement('div'); o.style.cssText='position:fixed;right:0;top:0;width:300px;height:400px;z-index:5'; document.body.append(o); })()`);
  snap = await page.snapshot(TAB);
  const covers = snap.actions.find((a) => a.label === 'Scroll down in "Activity" panel');
  if (covers) await page.act(TAB, { fingerprint: snap.fingerprint, action_id: covers.id });
  check("an area the wheel cannot reach scrolls by script", lastSeen("scrolled")?.by === "script" && (await evalJs("document.querySelector('#activity').scrollTop")) > 0, seen.scrolled);
} finally {
  ws.close();
  chrome.kill("SIGTERM");
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
