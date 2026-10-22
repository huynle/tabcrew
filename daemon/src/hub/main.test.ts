import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpSocketClient } from "../testing/helpers.js";
import { readHubError, readHubInfo } from "./info.js";
import { HUB_EXIT, IdleExit, describePortOwner, runHub, type RunHubDeps } from "./main.js";
import { ensureHubRuntimeDir, hubPaths, type HubPaths } from "./paths.js";

describe("IdleExit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires N ms after start when no client ever connects", () => {
    const onIdle = vi.fn();
    const idle = new IdleExit(60_000, onIdle);
    idle.start();
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not run while clients are connected and restarts the countdown when the last one leaves", () => {
    const onIdle = vi.fn();
    const idle = new IdleExit(60_000, onIdle);
    idle.start();
    vi.advanceTimersByTime(30_000);
    idle.update(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    idle.update(2);
    idle.update(1);
    idle.update(0);
    vi.advanceTimersByTime(59_000);
    expect(onIdle).not.toHaveBeenCalled();
    idle.update(1); // a client reconnects: cancelled
    idle.update(0);
    vi.advanceTimersByTime(59_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a client that connects before start() keeps the hub alive", () => {
    const onIdle = vi.fn();
    const idle = new IdleExit(1_000, onIdle);
    idle.update(1);
    idle.start();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("0 disables idle exit; stop() cancels a pending countdown", () => {
    const onIdle = vi.fn();
    const off = new IdleExit(0, onIdle);
    off.start();
    off.update(0);
    const on = new IdleExit(1_000, onIdle);
    on.start();
    on.stop();
    on.update(0);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("describePortOwner", () => {
  it("names the listening pid and command from lsof -Fpc", () => {
    const calls: string[][] = [];
    const message = describePortOwner(8775, (file, args) => {
      calls.push([file, ...args]);
      return "p4242\ncnode\nf12\n";
    });
    expect(message).toBe("port 8775 in use by pid 4242 (node)");
    expect(calls[0]).toEqual(["lsof", "-nP", "-iTCP:8775", "-sTCP:LISTEN", "-Fpc"]);
  });

  it("falls back to a generic message when lsof fails or finds nothing", () => {
    const failing = () => {
      throw new Error("lsof: not found");
    };
    expect(describePortOwner(8775, failing)).toBe("port 8775 in use by another process");
    expect(describePortOwner(8775, () => "")).toBe("port 8775 in use by another process");
  });

  it.skipIf(!existsSync("/usr/sbin/lsof") && !existsSync("/usr/bin/lsof"))("finds this process with the real lsof", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(describePortOwner(port)).toMatch(new RegExp(`^port ${port} in use by pid ${process.pid} \\(.+\\)$`));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("runHub", () => {
  let base: string;
  let paths: HubPaths;
  let signals: Map<string, () => void>;
  let deps: RunHubDeps;
  let out: string[];

  beforeEach(() => {
    // Short base dir: the socket path must fit in sun_path.
    base = mkdtempSync(join(tmpdir(), "tch-"));
    const env = { TABCREW_HUB_RUNTIME_DIR: join(base, "rt"), TABCREW_HUB_STATE_DIR: join(base, "st") };
    paths = hubPaths({ env });
    signals = new Map();
    out = [];
    deps = {
      pathOptions: { env },
      onSignal: (signal, handler) => {
        signals.set(signal, handler);
        return () => signals.delete(signal);
      },
      exec: () => "p999\ncsomething\n",
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("--help prints usage and exits 0; bad arguments exit with the usage code", async () => {
    expect(await runHub(["--help"], deps)).toBe(HUB_EXIT.ok);
    expect(out.join("")).toMatch(/usage: daemon\.mjs hub/);
    expect(await runHub(["--port", "nope"], deps)).toBe(HUB_EXIT.usage);
    expect(existsSync(paths.runtimeDir)).toBe(false);
  });

  it("serves MCP on hub.sock, publishes hub.json, and cleans both up on SIGTERM", async () => {
    const done = runHub(["--port", "0", "--idle-minutes", "0"], deps);
    await waitFor(() => readHubInfo(paths) !== null);
    const info = readHubInfo(paths)!;
    expect(info.pid).toBe(process.pid);
    expect(info.wsPort).toBeGreaterThan(0);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(existsSync(paths.socket)).toBe(true);
    const { client, socket } = await mcpSocketClient(paths.socket);
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    socket.destroy();
    signals.get("SIGTERM")!();
    expect(await done).toBe(HUB_EXIT.ok);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.info)).toBe(false);
    expect(signals.size).toBe(0);
  });

  it("exits 0 without disturbing an already running hub", async () => {
    const first = runHub(["--port", "0", "--idle-minutes", "0"], deps);
    await waitFor(() => readHubInfo(paths) !== null);
    const firstSignals = new Map(signals);
    signals.clear();
    expect(await runHub(["--port", "0"], deps)).toBe(HUB_EXIT.ok);
    expect(readHubInfo(paths)?.pid).toBe(process.pid);
    const { socket } = await mcpSocketClient(paths.socket);
    socket.destroy();
    firstSignals.get("SIGINT")!();
    expect(await first).toBe(HUB_EXIT.ok);
  });

  it("removes a stale socket (nobody listening) and starts", async () => {
    ensureHubRuntimeDir(paths);
    // A process that died without cleaning up leaves its socket file behind.
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(paths.socket)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(paths.socket)).toBe(true);

    const done = runHub(["--port", "0", "--idle-minutes", "0"], deps);
    await waitFor(() => readHubInfo(paths) !== null);
    const { socket } = await mcpSocketClient(paths.socket);
    socket.destroy();
    signals.get("SIGTERM")!();
    expect(await done).toBe(HUB_EXIT.ok);
  });

  it("refuses a non-socket file at the socket path", async () => {
    ensureHubRuntimeDir(paths);
    writeFileSync(paths.socket, "not a socket");
    expect(await runHub(["--port", "0"], deps)).toBe(HUB_EXIT.failed);
    expect(readFileSync(paths.socket, "utf8")).toBe("not a socket");
    expect(readHubError(paths)).toMatch(/not a socket/);
  });

  it("refuses an insecure runtime dir", async () => {
    ensureHubRuntimeDir(paths);
    const { chmodSync } = await import("node:fs");
    chmodSync(paths.runtimeDir, 0o755);
    expect(await runHub(["--port", "0"], deps)).toBe(HUB_EXIT.failed);
    expect(out.join("")).toMatch(/permissions/);
    expect(existsSync(paths.socket)).toBe(false);
  });

  it("port in use: writes hub.error naming the owner, exits non-zero, leaves no socket", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      expect(await runHub(["--port", String(port)], deps)).toBe(HUB_EXIT.portInUse);
      expect(readHubError(paths)).toBe(`port ${port} in use by pid 999 (something)`);
      expect(existsSync(paths.socket)).toBe(false);
      expect(existsSync(paths.info)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("clears a previous hub.error once it starts", async () => {
    ensureHubRuntimeDir(paths);
    writeFileSync(paths.error, "old failure\n", { mode: 0o600 });
    const done = runHub(["--port", "0", "--idle-minutes", "0"], deps);
    await waitFor(() => readHubInfo(paths) !== null);
    expect(readHubError(paths)).toBeNull();
    signals.get("SIGTERM")!();
    await done;
  });

  it("idle-exits when no client connects, and after the last client disconnects", async () => {
    // 0.005 min = 300 ms
    const started = Date.now();
    expect(await runHub(["--port", "0", "--idle-minutes", "0.005"], deps)).toBe(HUB_EXIT.ok);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.info)).toBe(false);

    signals.clear();
    let exited = false;
    const done = runHub(["--port", "0", "--idle-minutes", "0.005"], deps).then((code) => {
      exited = true;
      return code;
    });
    await waitFor(() => readHubInfo(paths) !== null);
    const { socket } = await mcpSocketClient(paths.socket);
    await new Promise((r) => setTimeout(r, 600));
    expect(exited).toBe(false);
    socket.destroy();
    expect(await done).toBe(HUB_EXIT.ok);
  });
});
