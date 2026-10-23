import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHubLog } from "../hub/info.js";
import { hubPaths, type HubPaths } from "../hub/paths.js";
import { fakeSystem } from "../testing/fakeSystem.js";
import { cliMain } from "./main.js";
import { MCP_USAGE, parseMcpArgs, runMcp, spawnDetachedHub, type HubChild, type McpDeps } from "./mcp.js";

const RESPONSE = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';
const REQUEST = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';

let base: string;
let runtimeDir: string;
let bundleDir: string;
let paths: HubPaths;
let env: Record<string, string>;
const servers: Server[] = [];

beforeEach(() => {
  // Short base path: the socket path must stay under 104 bytes.
  base = mkdtempSync(join(tmpdir(), "tc-shim-"));
  runtimeDir = join(base, "rt");
  bundleDir = join(base, "dist");
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, "daemon.mjs"), "// fake\n");
  env = { TABCREW_HUB_RUNTIME_DIR: runtimeDir, TABCREW_HUB_STATE_DIR: join(base, "state") };
  paths = hubPaths({ env });
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

/** A fake hub on hub.sock: answers every line with RESPONSE; `onSocket` can misbehave instead. */
function startFakeHub(onSocket?: (sock: Socket) => void): Promise<Server> {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const server = createServer((sock) => {
    sock.on("error", () => {});
    if (onSocket) return onSocket(sock);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      while (buf.includes("\n")) {
        buf = buf.slice(buf.indexOf("\n") + 1);
        sock.write(RESPONSE);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(paths.socket, () => resolve(server)));
}

function writeInfo(version: string, wsPort = 18775): void {
  writeFileSync(paths.info, JSON.stringify({ pid: process.pid, version, wsPort, startedAt: new Date().toISOString() }), { mode: 0o600 });
}

class FakeChild extends EventEmitter implements HubChild {
  pid = 4242;
  unrefed = false;
  unref(): void {
    this.unrefed = true;
  }
}

interface Harness {
  deps: McpDeps;
  stdin: PassThrough;
  stdout: string[];
  stderr: string[];
  out: string[];
  spawns: Array<{ command: string; args: readonly string[]; logFd: number; child: FakeChild }>;
}

function harness(spawnImpl?: (child: FakeChild) => void, extra: Partial<McpDeps> = {}): Harness {
  const stdin = new PassThrough();
  const stdoutStream = new PassThrough();
  const stdout: string[] = [];
  stdoutStream.on("data", (c: Buffer) => stdout.push(c.toString("utf8")));
  const stderr: string[] = [];
  const out: string[] = [];
  const spawns: Harness["spawns"] = [];
  const deps: McpDeps = {
    pathOptions: { env },
    runtimeDir: bundleDir,
    stdin,
    stdout: stdoutStream,
    stderr: (s) => stderr.push(s),
    out: (s) => out.push(s),
    version: "0.5.0",
    execPath: "/usr/bin/node-fake",
    pollMs: 10,
    spawnTimeoutMs: 2_000,
    spawn: (command, args, opts) => {
      const child = new FakeChild();
      spawns.push({ command, args, logFd: opts.logFd, child });
      setTimeout(() => spawnImpl?.(child), 0);
      return child;
    },
    ...extra,
  };
  return { deps, stdin, stdout, stderr, out, spawns };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Send one request, wait for its response, close stdin; returns the exit code. */
async function roundTrip(h: Harness, run: Promise<number>): Promise<number> {
  h.stdin.write(REQUEST);
  await Promise.race([until(() => h.stdout.join("").includes(RESPONSE)), run.then((code) => {
    throw new Error(`shim exited early with ${code}: ${h.stderr.join("")}`);
  })]);
  h.stdin.end();
  return run;
}

function expectPureJsonRpc(chunks: string[]): void {
  const text = chunks.join("");
  expect(text.length).toBeGreaterThan(0);
  for (const line of text.split("\n").filter(Boolean)) expect(JSON.parse(line).jsonrpc).toBe("2.0");
}

describe("parseMcpArgs", () => {
  it("parses run flags, reset-pin and help", () => {
    expect(parseMcpArgs([])).toEqual({ ok: true, args: { kind: "run", hubArgs: [] } });
    expect(parseMcpArgs(["--port", "18775", "--idle-minutes=0.5"])).toEqual({
      ok: true,
      args: { kind: "run", hubArgs: ["--port", "18775", "--idle-minutes", "0.5"], port: 18775 },
    });
    expect(parseMcpArgs(["reset-pin"])).toEqual({ ok: true, args: { kind: "reset-pin" } });
    expect(parseMcpArgs(["--help"])).toEqual({ ok: true, args: { kind: "help" } });
    expect(parseMcpArgs(["-h"])).toEqual({ ok: true, args: { kind: "help" } });
    expect(parseMcpArgs(["reset-pin", "--help"])).toEqual({ ok: true, args: { kind: "help" } });
  });

  it("rejects bad input", () => {
    expect(parseMcpArgs(["--port"]).ok).toBe(false);
    expect(parseMcpArgs(["--port", "99999"]).ok).toBe(false);
    expect(parseMcpArgs(["--idle-minutes", "-1"]).ok).toBe(false);
    expect(parseMcpArgs(["--bogus"]).ok).toBe(false);
    expect(parseMcpArgs(["reset-pin", "--port", "1"]).ok).toBe(false);
  });
});

describe("runMcp: help, usage, reset-pin", () => {
  it("prints help to out and exits 0", async () => {
    const h = harness();
    expect(await runMcp(["--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(MCP_USAGE);
    expect(MCP_USAGE).toContain("usage: tabcrew mcp");
    expect(MCP_USAGE).toContain("reset-pin");
  });

  it("reports usage errors on stderr (never stdout) with exit 2", async () => {
    const h = harness();
    expect(await runMcp(["--nope"], h.deps)).toBe(2);
    expect(h.stderr.join("")).toContain("unknown option");
    expect(h.stdout).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it("reset-pin deletes the pin and explains the next step", async () => {
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.pin, `${"a".repeat(64)}\n`, { mode: 0o600 });
    const h = harness();
    expect(await runMcp(["reset-pin"], h.deps)).toBe(0);
    expect(existsSync(paths.pin)).toBe(false);
    const text = h.out.join("\n");
    expect(text).toContain("Removed");
    expect(text).toContain("Trust this hub");
  });

  it("reset-pin without a pin says so and still exits 0", async () => {
    const h = harness();
    expect(await runMcp(["reset-pin"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/No hub pin/);
    expect(h.out.join("\n")).toContain("Trust this hub");
  });
});

describe("runMcp: hub already running", () => {
  it("relays stdin -> socket and socket -> stdout, exits 0 on stdin end, never spawns", async () => {
    await startFakeHub();
    writeInfo("0.5.0");
    const h = harness();
    const code = await roundTrip(h, runMcp([], h.deps));
    expect(code).toBe(0);
    expect(h.spawns).toEqual([]);
    expect(h.stdout.join("")).toBe(RESPONSE);
    expect(h.stderr.join("")).not.toMatch(/version/);
  });

  it("warns on stderr (stdout stays pure) when the hub version differs", async () => {
    await startFakeHub();
    writeInfo("0.4.9");
    const h = harness();
    expect(await roundTrip(h, runMcp([], h.deps))).toBe(0);
    expect(h.stderr.join("")).toMatch(/0\.4\.9/);
    expect(h.stderr.join("")).toMatch(/0\.5\.0/);
    expect(h.stdout.join("")).toBe(RESPONSE);
  });

  it("warns when --port differs from the running hub's port", async () => {
    await startFakeHub();
    writeInfo("0.5.0", 8775);
    const h = harness();
    expect(await roundTrip(h, runMcp(["--port", "18775"], h.deps))).toBe(0);
    expect(h.stderr.join("")).toMatch(/8775/);
    expect(h.spawns).toEqual([]);
  });

  it("exits non-zero with a clear stderr message when the hub goes away", async () => {
    await startFakeHub((sock) => {
      sock.once("data", () => {
        sock.write(RESPONSE);
        setTimeout(() => sock.destroy(), 20);
      });
    });
    writeInfo("0.5.0");
    const h = harness();
    const run = runMcp([], h.deps);
    h.stdin.write(REQUEST);
    const code = await run;
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/lost connection to the TabCrew hub/);
    expect(h.stdout.join("")).toBe(RESPONSE);
  });
});

describe("runMcp: spawning the hub", () => {
  const hubStarts = (delayMs = 100) =>
    setTimeout(() => {
      void startFakeHub().then(() => writeInfo("0.5.0"));
    }, delayMs);

  it("spawns exactly one detached hub with the shim's flags and relays to it", async () => {
    const h = harness(() => hubStarts());
    const code = await roundTrip(h, runMcp(["--port", "18775", "--idle-minutes", "1"], h.deps));
    expect(code).toBe(0);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].command).toBe("/usr/bin/node-fake");
    expect(h.spawns[0].args).toEqual([join(bundleDir, "daemon.mjs"), "hub", "--port", "18775", "--idle-minutes", "1"]);
    expect(h.spawns[0].logFd).toBeGreaterThan(2);
    expect(h.spawns[0].child.unrefed).toBe(true);
    expect(existsSync(paths.spawnLock)).toBe(false);
    expectPureJsonRpc(h.stdout);
  });

  it("two concurrent shims spawn only one hub (spawn.lock)", async () => {
    const a = harness(() => hubStarts(200));
    const b = harness(() => hubStarts(200));
    const runA = runMcp([], a.deps);
    const runB = runMcp([], b.deps);
    const [codeA, codeB] = await Promise.all([roundTrip(a, runA), roundTrip(b, runB)]);
    expect([codeA, codeB]).toEqual([0, 0]);
    expect(a.spawns.length + b.spawns.length).toBe(1);
    expect(existsSync(paths.spawnLock)).toBe(false);
    expectPureJsonRpc(a.stdout);
    expectPureJsonRpc(b.stdout);
  });

  it("takes over a stale lock whose pid is dead", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.spawnLock, `999999 ${Date.now()} deadbeef\n`);
    const h = harness(() => hubStarts(), { isPidAlive: (pid) => pid !== 999999 });
    expect(await roundTrip(h, runMcp([], h.deps))).toBe(0);
    expect(h.spawns).toHaveLength(1);
    expect(existsSync(paths.spawnLock)).toBe(false);
  });

  it("takes over a lock older than 30 s even if its pid is alive", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.spawnLock, `${process.pid} 1000 cafe\n`);
    const h = harness(() => hubStarts(), { now: () => 1000 + 31_000 });
    expect(await roundTrip(h, runMcp([], h.deps))).toBe(0);
    expect(h.spawns).toHaveLength(1);
  });

  it("spawns a hub when hub.sock is stale (nobody listening)", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    // A listener killed with SIGKILL leaves its socket file behind.
    spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(paths.socket)}, () => process.kill(process.pid, "SIGKILL"))`]);
    expect(existsSync(paths.socket)).toBe(true);
    const h = harness(() =>
      setTimeout(() => {
        rmSync(paths.socket, { force: true }); // what the real hub does with a stale socket
        void startFakeHub().then(() => writeInfo("0.5.0"));
      }, 50),
    );
    expect(await roundTrip(h, runMcp([], h.deps))).toBe(0);
    expect(h.spawns).toHaveLength(1);
  });

  it("connects when the spawned hub exits 0 because another hub answered", async () => {
    const h = harness((child) => {
      void startFakeHub().then(() => {
        writeInfo("0.5.0");
        child.emit("exit", 0, null);
      });
    });
    expect(await roundTrip(h, runMcp([], h.deps))).toBe(0);
    expect(h.spawns).toHaveLength(1);
  });

  it("surfaces hub.error and the hub's exit code when the port is in use", async () => {
    const h = harness((child) => {
      writeFileSync(paths.error, "port 18775 in use by pid 4242 (ewp-mcp)\n", { mode: 0o600 });
      child.emit("exit", 3, null);
    });
    const code = await runMcp(["--port", "18775"], h.deps);
    expect(code).toBe(3);
    expect(h.stderr.join("")).toContain("port 18775 in use by pid 4242 (ewp-mcp)");
    expect(h.stdout).toEqual([]);
    expect(existsSync(paths.spawnLock)).toBe(false);
  });

  it("does not report an old hub.error from a previous run", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.error, "port 1 in use by pid 1 (old)\n", { mode: 0o600 });
    const h = harness((child) => {
      writeFileSync(paths.log, "boom: something broke\n", { flag: "a" });
      child.emit("exit", 1, null);
    });
    expect(await runMcp([], h.deps)).toBe(1);
    const err = h.stderr.join("");
    expect(err).not.toContain("(old)");
    expect(err).toContain("boom: something broke");
  });

  it("fails with a clear message when the hub never comes up", async () => {
    const h = harness(() => {}, { spawnTimeoutMs: 200 });
    expect(await runMcp([], h.deps)).toBe(1);
    expect(h.stderr.join("")).toMatch(/did not start/);
    expect(h.stderr.join("")).toContain(paths.log);
    expect(existsSync(paths.spawnLock)).toBe(false);
  });

  it("fails when the spawn itself errors", async () => {
    const h = harness((child) => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    expect(await runMcp([], h.deps)).toBe(1);
    expect(h.stderr.join("")).toMatch(/spawn ENOENT/);
    expect(existsSync(paths.spawnLock)).toBe(false);
  });

  it("fails clearly when daemon.mjs is missing", async () => {
    const h = harness(() => {}, { runtimeDir: join(base, "nowhere") });
    expect(await runMcp([], h.deps)).toBe(1);
    expect(h.stderr.join("")).toMatch(/daemon\.mjs/);
    expect(h.spawns).toEqual([]);
  });
});

describe("spawnDetachedHub", () => {
  it("sends the child's stdout and stderr to the log fd, not the shim's stdout", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const fd = openHubLog(paths);
    const child = spawnDetachedHub(process.execPath, ["-e", "console.log('to-stdout'); console.error('to-stderr')"], { logFd: fd, cwd: runtimeDir });
    closeSync(fd);
    await new Promise((r) => child.once("exit", r));
    const log = readFileSync(paths.log, "utf8");
    expect(log).toContain("to-stdout");
    expect(log).toContain("to-stderr");
  });
});

describe("cliMain mcp", () => {
  it("dispatches `mcp --help` and `mcp reset-pin`", async () => {
    const sys = fakeSystem(base, { env, runtimeDir: bundleDir });
    expect(await cliMain(["mcp", "--help"], sys)).toBe(0);
    expect(sys.output()).toContain("usage: tabcrew mcp");
    expect(await cliMain(["mcp", "reset-pin"], sys)).toBe(0);
    expect(sys.output()).toContain("Trust this hub");
  });

  it("lists mcp in the CLI usage", async () => {
    const sys = fakeSystem(base);
    expect(await cliMain(["help"], sys)).toBe(0);
    expect(sys.output()).toMatch(/\n {2}mcp /);
  });
});
