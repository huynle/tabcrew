import { existsSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningDaemon } from "./daemon.js";
import { McpSocketServer } from "./mcp/socketServer.js";
import { call, FakeExtension, mcpSocketClient, startTestDaemon, tempHome, until } from "./testing/helpers.js";

let home: string;
let cleanupHome: () => void;
let daemon: RunningDaemon;
let ext: FakeExtension;
const servers: McpSocketServer[] = [];
const sockets: Socket[] = [];

beforeEach(async () => {
  ({ home, cleanup: cleanupHome } = tempHome());
  daemon = await startTestDaemon(home);
  ext = await FakeExtension.connect(daemon.extensionPort, daemon.token);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.close();
  ext.ws.terminate();
  await daemon.close();
  cleanupHome();
});

function server(extra: { onIdle?: () => void; onConnectionCountChange?: (n: number) => void } = {}): McpSocketServer {
  const s = new McpSocketServer({
    registry: daemon.registry,
    bridge: daemon.bridge,
    scheduler: daemon.scheduler,
    observations: daemon.observations,
    jev: daemon.jev,
    socketPath: join(home, "s.sock"),
    version: "9.9.9",
    ...extra,
  });
  servers.push(s);
  return s;
}

async function client(path = join(home, "s.sock")) {
  const c = await mcpSocketClient(path);
  sockets.push(c.socket);
  return c;
}

describe("McpSocketServer", () => {
  it("listens on a 0600 Unix socket and serves the TabCrew tools with instructions", async () => {
    await server().start();
    const path = join(home, "s.sock");
    expect(statSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { client: c } = await client();
    expect(c.getServerVersion()).toMatchObject({ name: "tabcrew", version: "9.9.9" });
    expect(c.getInstructions()).toMatch(/session_open/);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "act",
        "browse",
        "debug_logs",
        "group_list",
        "group_rename",
        "navigate",
        "observe",
        "read_text",
        "screenshot",
        "session_close",
        "session_open",
        "tab_close",
        "tab_create",
        "tab_list",
      ].sort(),
    );
  });

  it("serves two concurrent clients, each owning its sessions; closing one hands only its sessions over", async () => {
    const s = server();
    await s.start();
    const a = await client();
    const b = await client();
    await until(() => s.connectionCount === 2);
    const sa = await call(a.client, "session_open", { label: "A" });
    const sb = await call(b.client, "session_open", { label: "B" });
    if (!sa.ok || !sb.ok) throw new Error("open failed");
    await call(a.client, "tab_create", { session: sa.value.session });
    expect(daemon.registry.size).toBe(2);

    a.socket.destroy();
    await until(() => ext.requests.some((r) => r.op === "session_release"));
    await until(() => daemon.registry.size === 1);
    const released = ext.requests.filter((r) => r.op === "session_release").map((r) => r.session.short_id);
    expect(released).toEqual([sa.value.short_id]);
    await until(() => s.connectionCount === 1);

    const stillB = await call(b.client, "tab_create", { session: sb.value.session });
    expect(stillB.ok).toBe(true);
  });

  it("reports connection counts and calls onIdle when the last connection closes", async () => {
    const counts: number[] = [];
    let idle = 0;
    const s = server({ onConnectionCountChange: (n) => counts.push(n), onIdle: () => idle++ });
    await s.start();
    const a = await client();
    const b = await client();
    await until(() => counts.length === 2);
    a.socket.destroy();
    await until(() => counts.length === 3);
    expect(idle).toBe(0);
    b.socket.destroy();
    await until(() => idle === 1);
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(s.connectionCount).toBe(0);
  });

  it("close() drops connections without handing sessions over and removes the socket file", async () => {
    const s = server();
    await s.start();
    const a = await client();
    const opened = await call(a.client, "session_open", { label: "keep" });
    expect(opened.ok).toBe(true);
    const closed = new Promise<void>((r) => a.socket.once("close", () => r()));
    await s.close();
    await closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.registry.size).toBe(1);
    expect(ext.requests.some((r) => r.op === "session_release")).toBe(false);
    expect(existsSync(join(home, "s.sock"))).toBe(false);
  });

  it("refuses to start when another server already listens on the path", async () => {
    await server().start();
    await expect(server().start()).rejects.toThrow(/EADDRINUSE/);
    // The live server's socket is untouched.
    const { client: c } = await client();
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);
  });
});
