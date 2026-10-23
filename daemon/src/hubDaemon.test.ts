import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { V2_HUB_EXTENSION_PORT } from "@tabcrew/shared/v2";
import { HUB_OFFLINE_WAIT_MS, type RunningHub } from "./daemon.js";
import { MemoryPinStore } from "./pin.js";
import { call, FakeExtension, mcpSocketClient, startTestHub, tempHome, until } from "./testing/helpers.js";

const SECRET = "d".repeat(64);

let home: string;
let cleanupHome: () => void;
let runtimeDir: string;
let hub: RunningHub | null;
const extensions: FakeExtension[] = [];
const clients: Client[] = [];

beforeEach(() => {
  ({ home, cleanup: cleanupHome } = tempHome());
  runtimeDir = join(home, "rt");
  mkdirSync(runtimeDir, { mode: 0o700 });
  hub = null;
});

afterEach(async () => {
  for (const e of extensions.splice(0)) e.ws.terminate();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await hub?.close();
  cleanupHome();
});

async function startHub(extra: { onIdle?: () => void; pins?: MemoryPinStore } = {}): Promise<RunningHub> {
  hub = await startTestHub(home, { runtimeDir, pinStore: extra.pins, onIdle: extra.onIdle });
  return hub;
}

async function socketClient(h: RunningHub): Promise<Client> {
  const { client } = await mcpSocketClient(h.socketPath);
  clients.push(client);
  return client;
}

describe("startDaemon hub mode", () => {
  it("runs without token, settings or HTTP: nothing is written to the daemon home", async () => {
    const h = await startHub();
    expect(h.mode).toBe("hub");
    expect("mcpPort" in h).toBe(false);
    expect("token" in h).toBe(false);
    expect(existsSync(join(home, "home"))).toBe(false);
    expect(h.extensionPort).toBeGreaterThan(0);
    expect(existsSync(h.socketPath)).toBe(true);
  });

  it("pairs an extension (TOFU) and serves tools end to end over the socket", async () => {
    const pins = new MemoryPinStore();
    const h = await startHub({ pins });
    const ext = await FakeExtension.connectHub(h.extensionPort, { secret: SECRET, state: "new" });
    extensions.push(ext);
    expect(ext.welcome?.features).toEqual(["hub"]);
    expect(await pins.get()).toBe(SECRET);
    await until(() => h.bridge.connected);

    const client = await socketClient(h);
    const opened = await call(client, "session_open", { label: "hub" });
    if (!opened.ok) throw new Error("open failed");
    const tab = await call(client, "tab_create", { session: opened.value.session, url: "https://example.com/" });
    expect(tab).toMatchObject({ ok: true, value: { url: "https://example.com/" } });
    expect(h.connectionCount).toBe(1);
  });

  it("keeps sessions.json in the runtime dir", async () => {
    const h = await startHub();
    const client = await socketClient(h);
    const opened = await call(client, "session_open", { label: "persist" });
    expect(opened.ok).toBe(true);
    await h.close();
    hub = null;
    const saved = readFileSync(join(runtimeDir, "sessions.json"), "utf8");
    expect(saved).toContain("persist");
  });

  it("forwards onIdle when the last MCP connection closes, and close() removes the socket", async () => {
    let idle = 0;
    const h = await startHub({ onIdle: () => idle++ });
    const client = await socketClient(h);
    await client.close();
    await until(() => idle === 1);
    await h.close();
    hub = null;
    expect(existsSync(join(runtimeDir, "hub.sock"))).toBe(false);
    expect(readdirSync(runtimeDir)).toEqual(["sessions.json"]);
  });

  it("defaults: hub port 8775 and a 45 s offline wait", () => {
    expect(V2_HUB_EXTENSION_PORT).toBe(8775);
    expect(HUB_OFFLINE_WAIT_MS).toBe(45_000);
  });
});
