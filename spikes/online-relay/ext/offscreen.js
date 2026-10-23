// Spike offscreen document: the same WebSocket probe, from the context TabCrew really uses.
globalThis.wsProbe = (url, hello) =>
  new Promise((resolve) => {
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
