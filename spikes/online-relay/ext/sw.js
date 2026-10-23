// Spike service worker: WebSocket and launchWebAuthFlow probes, driven over CDP by run.mjs.

function wsProbe(url, hello) {
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 10_000);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      return resolve({ ok: false, error: `construct: ${err}` });
    }
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, reply: String(ev.data) });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "socket error" });
    };
  });
}

globalThis.wsProbe = wsProbe;

globalThis.ensureOffscreen = async () => {
  if (await chrome.offscreen.hasDocument()) return true;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "spike" });
  return true;
};

globalThis.redirectUrl = () => chrome.identity.getRedirectURL("cb");

globalThis.authProbe = async (url, interactive) => {
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive });
    return { ok: true, redirect };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
};

globalThis.startAuth = (url, interactive) => {
  globalThis.authResult = undefined;
  globalThis.authProbe(url, interactive).then((r) => (globalThis.authResult = r));
  return true;
};
