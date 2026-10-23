#!/usr/bin/env node
// Phase 0 spike for Online mode (docs/plans/2026-10-23-online-relay-design.md).
//
// Questions:
//   1. Can an MV3 extension with no host_permissions open wss:// to an outside host, from the
//      offscreen document (where TabCrew keeps its socket) and from the service worker?
//      What Origin does the relay see?
//   2. Does chrome.identity.launchWebAuthFlow work with the fixed dev extension ID, both when the
//      relay redirects at once (interactive: false) and after a user click (interactive: true)?
//
// The relay is simulated: a local TLS server answers as tabcrew.huynle.com (host-resolver rule,
// self-signed cert). Probe 3 also dials a real public wss echo server. Uses Chromium (branded
// Chrome ignores --load-extension) in a throwaway headless profile.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const CHROMIUM = process.env.CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";
const RELAY_HOST = "tabcrew.huynle.com";
const PUBLIC_ECHO = process.env.PUBLIC_WSS ?? "wss://ws.postman-echo.com/raw";
const DEV_ID = "aejgcpbbemekfbmmkabpbgdkgmddfamo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), "tabcrew-spike-"));

// --- spike extension: same key as the dev build, so the same ID and chromiumapp.org URL ---------
const key = readFileSync(join(repo, "extension", "dev-key.pub"), "utf8")
  .split("\n")
  .filter((l) => l && !l.startsWith("-----"))
  .join("");
const extDir = join(work, "ext");
cpSync(join(here, "ext"), extDir, { recursive: true });
const manifest = {
  manifest_version: 3,
  name: "TabCrew online spike",
  version: "0.0.1",
  key,
  permissions: ["offscreen", "identity"],
  background: { service_worker: "sw.js" },
};
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// --- simulated relay: https + wss on 127.0.0.1, answering as tabcrew.huynle.com ------------------
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${RELAY_HOST}`,
  "-addext", `subjectAltName=DNS:${RELAY_HOST}`,
  "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"),
], { stdio: "ignore" });
const seen = { origins: [], hellos: [] };
const https = createServer({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (req, res) => {
  const url = new URL(req.url, `https://${RELAY_HOST}`);
  if (url.pathname !== "/authorize") return void res.writeHead(404).end();
  const redirect = url.searchParams.get("redirect_uri") ?? "";
  const target = `${redirect}?code=spike-code&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
  if (url.searchParams.get("mode") === "auto") return void res.writeHead(302, { location: target }).end();
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><title>Sign in</title><button id="go">Continue with GitHub</button><script>go.onclick = () => (location.href = ${JSON.stringify(target)});</script>`,
  );
});
const wss = new WebSocketServer({ noServer: true });
https.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "https://x").pathname !== "/ext") return socket.destroy();
  seen.origins.push(req.headers.origin ?? "(none)");
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.once("message", (data) => {
      seen.hellos.push(String(data));
      ws.send(JSON.stringify({ type: "welcome", origin: req.headers.origin ?? null, hello: JSON.parse(String(data)) }));
    });
  });
});
await new Promise((r) => https.listen(0, "127.0.0.1", r));
const port = https.address().port;
const relay = `${RELAY_HOST}:${port}`;

// --- Chromium + CDP --------------------------------------------------------------------------------
const profile = join(work, "profile");
const chrome = spawn(CHROMIUM, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  `--host-resolver-rules=MAP ${RELAY_HOST} 127.0.0.1`, "--ignore-certificate-errors",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => (stderr += d));
let wsUrl = "";
for (let i = 0; i < 200 && !wsUrl; i++) {
  wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] ?? "";
  if (!wsUrl) await sleep(50);
}
if (!wsUrl) throw new Error(`Chromium did not start:\n${stderr}`);

const cdp = new WebSocket(wsUrl);
await new Promise((r, j) => ((cdp.onopen = r), (cdp.onerror = j)));
let nextId = 1;
const pending = new Map();
cdp.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function findTarget(pred, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { targetInfos } = await send("Target.getTargets");
    const t = targetInfos.find(pred);
    if (t) return t;
    await sleep(100);
  }
  return null;
}
async function attach(target) {
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

try {
  const sw = await findTarget((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${DEV_ID}/`));
  check("spike extension loaded with the dev ID", !!sw, sw ? sw.url : "no service worker for the dev ID");
  if (!sw) throw new Error("stop");
  const swS = await attach(sw);
  for (let i = 0; i < 100 && (await evaluate(swS, "typeof ensureOffscreen")) !== "function"; i++) await sleep(100);
  check("manifest declares no host_permissions", !("host_permissions" in manifest) && !("optional_host_permissions" in manifest));

  // 1. WebSocket to the relay
  const hello = { type: "hello", token: "access-token-placeholder" };
  await evaluate(swS, "ensureOffscreen()");
  const off = await findTarget((t) => t.url === `chrome-extension://${DEV_ID}/offscreen.html`);
  const offS = off && (await attach(off));
  check("offscreen document created", !!offS);

  const r1 = offS && (await evaluate(offS, `wsProbe(${JSON.stringify(`wss://${relay}/ext`)}, ${JSON.stringify(hello)})`));
  const w1 = r1?.ok ? JSON.parse(r1.reply) : null;
  check("offscreen: wss to tabcrew.huynle.com connects and round-trips", !!w1, r1?.ok ? "" : r1?.error);
  check("relay sees Origin chrome-extension://<dev id>", w1?.origin === `chrome-extension://${DEV_ID}`, w1?.origin ?? "");
  check("relay receives the hello token in the first frame", w1?.hello?.token === hello.token);

  const r2 = await evaluate(swS, `wsProbe(${JSON.stringify(`wss://${relay}/ext`)}, ${JSON.stringify(hello)})`);
  check("service worker: wss to tabcrew.huynle.com connects and round-trips", r2.ok, r2.ok ? "" : r2.error);

  const r3 = offS && (await evaluate(offS, `wsProbe(${JSON.stringify(PUBLIC_ECHO)}, {"ping":1})`));
  check(`offscreen: wss to a real public host (${PUBLIC_ECHO})`, !!r3?.ok && r3.reply.includes("ping"), r3?.ok ? "" : r3?.error);

  // 2. launchWebAuthFlow
  const redirectUrl = await evaluate(swS, `redirectUrl()`);
  check("identity redirect URL is the dev ID's chromiumapp.org URL", redirectUrl === `https://${DEV_ID}.chromiumapp.org/cb`, redirectUrl);
  const authUrl = (mode, state) =>
    `https://${relay}/authorize?mode=${mode}&state=${state}&redirect_uri=${encodeURIComponent(redirectUrl)}`;

  const a1 = await evaluate(swS, `authProbe(${JSON.stringify(authUrl("auto", "s1"))}, false)`);
  const u1 = a1.ok ? new URL(a1.redirect) : null;
  check(
    "launchWebAuthFlow (interactive: false): relay 302 returns code + state",
    u1?.searchParams.get("code") === "spike-code" && u1?.searchParams.get("state") === "s1",
    a1.ok ? a1.redirect : a1.error,
  );

  await evaluate(swS, `startAuth(${JSON.stringify(authUrl("click", "s2"))}, true)`);
  const page = await findTarget((t) => t.type === "page" && t.url.includes("/authorize?mode=click"));
  check("launchWebAuthFlow (interactive: true) opens the sign-in window", !!page, page?.url ?? "no window");
  if (page) {
    const pS = await attach(page);
    await evaluate(pS, `document.querySelector("button").click(), true`);
  }
  let a2;
  for (let i = 0; i < 100 && !a2; i++) {
    a2 = await evaluate(swS, `globalThis.authResult`);
    if (!a2) await sleep(100);
  }
  const u2 = a2?.ok ? new URL(a2.redirect) : null;
  check(
    "launchWebAuthFlow (interactive: true): after the click, returns code + state",
    u2?.searchParams.get("code") === "spike-code" && u2?.searchParams.get("state") === "s2",
    a2 ? (a2.ok ? a2.redirect : a2.error) : "no result",
  );
} catch (err) {
  if (String(err.message) !== "stop") check("spike ran without errors", false, String(err.message ?? err));
} finally {
  cdp.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  https.close();
  await Promise.race([exited, sleep(5_000)]);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
