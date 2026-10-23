import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  V2_CLOSE_BAD_HELLO,
  V2_CLOSE_PIN_MISMATCH,
  V2_CLOSE_REPLACED,
  V2_PROTOCOL_VERSION,
  v2ExtProofInput,
  v2HubProofInput,
  v2WelcomePin,
  type V2Event,
  type V2SessionRef,
  type V2Welcome,
} from "@tabcrew/shared/v2";
import { ExtensionBridge } from "./bridge.js";
import { MemoryPinStore } from "./pin.js";
import { FakeExtension, hmacHex, until } from "./testing/helpers.js";

const EXT_ID = "aejgcpbbemekfbmmkabpbgdkgmddfamo";
const ORIGIN = `chrome-extension://${EXT_ID}`;
const ALLOWED = [`${ORIGIN}/`];
const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);

/** MemoryPinStore that counts writes and exposes its value. */
class TestPins extends MemoryPinStore {
  sets = 0;
  value: string | null;
  constructor(initial: string | null = null) {
    super(initial);
    this.value = initial;
  }
  override async set(secret: string) {
    this.sets++;
    this.value = secret;
    await super.set(secret);
  }
}

const hmac = hmacHex;

interface HubClient {
  ws: WebSocket;
  welcome: V2Welcome | null;
  frames: Record<string, unknown>[];
  closed: Promise<number>;
  nonce_e: string;
}

async function open(port: number, origin: string | null = ORIGIN): Promise<HubClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { headers: { origin } } : {});
  const frames: Record<string, unknown>[] = [];
  const client: HubClient = {
    ws,
    welcome: null,
    frames,
    closed: new Promise((r) => ws.on("close", (code) => r(code))),
    nonce_e: randomBytes(16).toString("hex"),
  };
  ws.on("message", (d) => {
    const frame = JSON.parse(d.toString());
    if (frame.type === "welcome") client.welcome = frame;
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) => reject(new Error(`http ${res.statusCode}`)));
  });
  return client;
}

async function hello(c: HubClient, pin: unknown, extra: Record<string, unknown> = {}): Promise<"welcome" | number> {
  const result = new Promise<"welcome" | number>((resolve) => {
    const t = setInterval(() => {
      if (c.welcome) {
        clearInterval(t);
        resolve("welcome");
      }
    }, 2);
    void c.closed.then((code) => {
      clearInterval(t);
      resolve(code);
    });
  });
  c.ws.send(
    JSON.stringify({ type: "hello", protocol: V2_PROTOCOL_VERSION, extension_version: "test", mode: "hub", features: ["model_call"], pin, ...extra }),
  );
  return result;
}

const pinned = (c: HubClient) => ({ state: "pinned", nonce_e: c.nonce_e });

function extProof(c: HubClient, secret = SECRET): string {
  const pin = v2WelcomePin(c.welcome);
  if (pin?.state !== "challenge") throw new Error("no challenge");
  return hmac(secret, v2ExtProofInput({ nonce_e: c.nonce_e, nonce_h: pin.nonce_h }));
}

const bridges: ExtensionBridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const b of bridges.splice(0)) await b.close();
});

async function hub(
  pins: TestPins,
  extra: { sessions?: () => readonly V2SessionRef[]; onEvent?: (e: V2Event) => void; helloTimeoutMs?: number; onExtRequest?: () => Promise<unknown> } = {},
) {
  const bridge = new ExtensionBridge({
    auth: { kind: "hub", allowedOrigins: ALLOWED, pinStore: pins },
    port: 0,
    sessions: extra.sessions ?? (() => [{ short_id: "abcdefgh", label: "alpha" }]),
    onEvent: extra.onEvent,
    helloTimeoutMs: extra.helloTimeoutMs,
    onExtRequest: extra.onExtRequest,
    daemonVersion: "9.9.9",
    offlineWaitMs: 2000,
  });
  bridges.push(bridge);
  const port = await bridge.start();
  return { bridge, port };
}

async function client(port: number, origin?: string | null) {
  const c = await open(port, origin);
  sockets.push(c.ws);
  return c;
}

describe("hub bridge: origin allowlist", () => {
  it("refuses a missing Origin, a foreign extension and web origins; accepts an allowed one (slash-normalized)", async () => {
    const { port } = await hub(new TestPins());
    await expect(client(port, null)).rejects.toThrow("http 401");
    await expect(client(port, "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toThrow("http 401");
    await expect(client(port, "https://evil.example")).rejects.toThrow("http 401");
    await expect(client(port, "null")).rejects.toThrow("http 401");
    await expect(client(port, ORIGIN)).resolves.toBeDefined();
    await expect(client(port, `${ORIGIN}/`)).resolves.toBeDefined();
    await expect(client(port, ORIGIN.toUpperCase())).resolves.toBeDefined();
  });

  it("still refuses a non-local Host header", async () => {
    const { port } = await hub(new TestPins());
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: ORIGIN, host: "evil.example:8775" } });
    sockets.push(ws);
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("unexpected-response", (_q, res) => resolve(`http ${res.statusCode}`));
      ws.once("error", () => resolve("error"));
    });
    expect(outcome).toBe("http 401");
  });
});

describe("hub bridge: TOFU pin", () => {
  it("new + no stored pin: stores the secret, welcomes {stored} with sessions and the hub feature, connected at once", async () => {
    const pins = new TestPins();
    const { bridge, port } = await hub(pins);
    const c = await client(port);
    expect(await hello(c, { state: "new", secret: SECRET })).toBe("welcome");
    expect(pins.value).toBe(SECRET);
    expect(c.welcome?.pin).toEqual({ state: "stored" });
    expect(c.welcome?.features).toEqual(["hub"]);
    expect(c.welcome?.sessions).toEqual([{ short_id: "abcdefgh", label: "alpha" }]);
    expect(c.welcome?.daemon_version).toBe("9.9.9");
    await until(() => bridge.connected);
    expect(JSON.stringify(c.welcome)).not.toContain(SECRET);
  });

  it("new + the same stored secret is accepted again ({stored}, no rewrite)", async () => {
    const pins = new TestPins(SECRET);
    const { bridge, port } = await hub(pins);
    const c = await client(port);
    expect(await hello(c, { state: "new", secret: SECRET })).toBe("welcome");
    expect(c.welcome?.pin).toEqual({ state: "stored" });
    expect(pins.sets).toBe(0);
    await until(() => bridge.connected);
  });

  it("new + a different stored secret closes 4403 and keeps the stored pin", async () => {
    const pins = new TestPins(SECRET);
    const { bridge, port } = await hub(pins);
    const c = await client(port);
    expect(await hello(c, { state: "new", secret: OTHER })).toBe(V2_CLOSE_PIN_MISMATCH);
    expect(pins.value).toBe(SECRET);
    expect(bridge.connected).toBe(false);
  });

  it("pinned + no stored pin closes 4403", async () => {
    const { bridge, port } = await hub(new TestPins());
    const c = await client(port);
    expect(await hello(c, pinned(c))).toBe(V2_CLOSE_PIN_MISMATCH);
    expect(bridge.connected).toBe(false);
  });

  it("a hello without a valid pin closes 4403 (missing, malformed, token-only)", async () => {
    const { port } = await hub(new TestPins(SECRET));
    for (const pin of [undefined, { state: "new", secret: "xyz" }, { state: "pinned", nonce_e: "00" }, { state: "other" }]) {
      const c = await client(port);
      expect(await hello(c, pin, { token: "t".repeat(40) })).toBe(V2_CLOSE_PIN_MISMATCH);
    }
  });

  it("wrong protocol or a non-hello first frame still closes 4401", async () => {
    const { port } = await hub(new TestPins(SECRET));
    const c = await client(port);
    expect(await hello(c, { state: "new", secret: SECRET }, { protocol: 1 })).toBe(V2_CLOSE_BAD_HELLO);
    const d = await client(port);
    d.ws.send(JSON.stringify({ type: "pong", t: 1 }));
    expect(await d.closed).toBe(V2_CLOSE_BAD_HELLO);
  });

  it("pinned: challenge welcome carries a valid hub proof and no sessions; connected only after a valid auth", async () => {
    const { bridge, port } = await hub(new TestPins(SECRET));
    const c = await client(port);
    expect(await hello(c, pinned(c))).toBe("welcome");
    const pin = v2WelcomePin(c.welcome);
    expect(pin?.state).toBe("challenge");
    if (pin?.state !== "challenge") return;
    expect(pin.hub_proof).toBe(hmac(SECRET, v2HubProofInput({ nonce_e: c.nonce_e, nonce_h: pin.nonce_h })));
    expect(c.welcome?.sessions).toEqual([]);
    expect(c.welcome?.features).toEqual(["hub"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.connected).toBe(false);
    c.ws.send(JSON.stringify({ type: "auth", ext_proof: extProof(c) }));
    await until(() => bridge.connected);
  });

  it("uses a fresh hub nonce per connection", async () => {
    const { port } = await hub(new TestPins(SECRET));
    const a = await client(port);
    const b = await client(port);
    b.nonce_e = a.nonce_e;
    await hello(a, pinned(a));
    await hello(b, pinned(b));
    expect((a.welcome?.pin as { nonce_h: string }).nonce_h).not.toBe((b.welcome?.pin as { nonce_h: string }).nonce_h);
  });

  it("a bad ext_proof closes 4403 and never connects", async () => {
    const { bridge, port } = await hub(new TestPins(SECRET));
    const flip = (p: string) => (p[0] === "0" ? "1" : "0") + p.slice(1);
    const bads: ((c: HubClient) => unknown)[] = [(c) => flip(extProof(c)), (c) => extProof(c, OTHER), () => "zz", () => undefined];
    for (const bad of bads) {
      const c = await client(port);
      await hello(c, pinned(c));
      c.ws.send(JSON.stringify({ type: "auth", ext_proof: bad(c) }));
      expect(await c.closed).toBe(V2_CLOSE_PIN_MISMATCH);
    }
    expect(bridge.connected).toBe(false);
  });

  it("any other frame before auth closes 4403 and is not processed", async () => {
    const events: V2Event[] = [];
    const { bridge, port } = await hub(new TestPins(SECRET), { onEvent: (e) => events.push(e), onExtRequest: async () => ({}) });
    const c = await client(port);
    await hello(c, pinned(c));
    c.ws.send(JSON.stringify({ type: "event", event: "groups", groups: [] }));
    expect(await c.closed).toBe(V2_CLOSE_PIN_MISMATCH);
    const d = await client(port);
    await hello(d, pinned(d));
    d.ws.send(JSON.stringify({ type: "ext_request", id: "x1", op: "settings_get", args: {} }));
    expect(await d.closed).toBe(V2_CLOSE_PIN_MISMATCH);
    expect(d.frames).toEqual([]);
    expect(events).toEqual([]);
    expect(bridge.connected).toBe(false);
  });

  it("closes 4401 when auth does not arrive in time", async () => {
    const { port } = await hub(new TestPins(SECRET), { helloTimeoutMs: 100 });
    const c = await client(port);
    await hello(c, pinned(c));
    expect(await c.closed).toBe(V2_CLOSE_BAD_HELLO);
  });

  it("sends no request before auth; a waiting request is sent once auth verifies", async () => {
    const { bridge, port } = await hub(new TestPins(SECRET));
    const c = await client(port);
    await hello(c, pinned(c));
    const pending = bridge.request({ short_id: "abcdefgh", label: "alpha" }, "tab_list", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.filter((f) => f.type === "request")).toEqual([]);
    c.ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === "request") c.ws.send(JSON.stringify({ type: "response", id: f.id, ok: true, result: { tabs: [] } }));
    });
    c.ws.send(JSON.stringify({ type: "auth", ext_proof: extProof(c) }));
    await expect(pending).resolves.toEqual({ tabs: [] });
  });

  it("an unauthenticated connection does not replace the active one; an authenticated one does (4409)", async () => {
    const { bridge, port } = await hub(new TestPins(SECRET));
    const a = await client(port);
    await hello(a, pinned(a));
    a.ws.send(JSON.stringify({ type: "auth", ext_proof: extProof(a) }));
    await until(() => bridge.connected);

    const b = await client(port);
    await hello(b, pinned(b));
    b.ws.send(JSON.stringify({ type: "auth", ext_proof: "0".repeat(64) }));
    expect(await b.closed).toBe(V2_CLOSE_PIN_MISMATCH);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    const c = await client(port);
    await hello(c, pinned(c));
    c.ws.send(JSON.stringify({ type: "auth", ext_proof: extProof(c) }));
    expect(await a.closed).toBe(V2_CLOSE_REPLACED);
    expect(bridge.connected).toBe(true);
  });

  it("two racing first pairings with different secrets: exactly one is stored, the other closes 4403", async () => {
    const pins = new TestPins();
    const { port } = await hub(pins);
    const a = await client(port);
    const b = await client(port);
    const [ra, rb] = await Promise.all([hello(a, { state: "new", secret: SECRET }), hello(b, { state: "new", secret: OTHER })]);
    expect([ra, rb].map(String).sort()).toEqual([String(V2_CLOSE_PIN_MISMATCH), "welcome"].sort());
    expect(pins.value).toBe(ra === "welcome" ? SECRET : OTHER);
    expect(pins.sets).toBe(1);
  });

  it("announces settings with the hub feature when it answers ext_request", async () => {
    const { port } = await hub(new TestPins(), { onExtRequest: async () => ({}) });
    const c = await client(port);
    await hello(c, { state: "new", secret: SECRET });
    expect(c.welcome?.features).toEqual(["settings", "hub"]);
  });

  it("FakeExtension.connectHub pairs (new), then reconnects with a verified challenge (pinned)", async () => {
    const pins = new TestPins();
    const { bridge, port } = await hub(pins);
    const first = await FakeExtension.connectHub(port, { secret: SECRET, state: "new" });
    sockets.push(first.ws);
    expect(first.welcome?.pin).toEqual({ state: "stored" });
    await until(() => bridge.connected);
    const second = await FakeExtension.connectHub(port, { secret: SECRET });
    sockets.push(second.ws);
    expect(second.hubProofValid).toBe(true);
    expect((await first.closed).code).toBe(V2_CLOSE_REPLACED);
    await until(() => bridge.connected);
    expect(bridge.features).toEqual(["model_call"]);
  });
});
