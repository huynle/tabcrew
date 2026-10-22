import { spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { V2_HUB_EXTENSION_PORT } from "@tabcrew/shared/v2";
import { HUB_DEFAULT_IDLE_MINUTES } from "../hub/config.js";
import { clearHubError, openHubLog, readHubError, readHubInfo, type HubInfo } from "../hub/info.js";
import { ensureHubRuntimeDir, hubPaths, type HubPathOptions, type HubPaths } from "../hub/paths.js";
import { resetHubPin } from "../hub/pinStore.js";

/**
 * `tabcrew mcp`: the stdio MCP server an MCP client (OpenCode, Claude Code, ...) launches in hub
 * mode. It is only a relay: it connects to the shared hub's Unix socket (starting the hub as a
 * detached `daemon.mjs hub` when none answers) and copies bytes stdin -> socket -> stdout.
 * stdout is the MCP channel: nothing but the hub's bytes is ever written to it; every diagnostic
 * goes to stderr.
 */

export const MCP_USAGE = `usage: tabcrew mcp [--port N] [--idle-minutes N]
       tabcrew mcp reset-pin

MCP stdio server for hub mode (locked-down Chrome: no launchd, no native messaging, no ~/.tabcrew).
Relays MCP between stdin/stdout and the shared TabCrew hub, starting the hub in the background when
none is running. Add it to your MCP client as a local (stdio) server, e.g. in opencode.jsonc:
  "tabcrew": { "type": "local", "command": ["node", "/abs/path/to/cli/dist/cli.mjs", "mcp"] }

  --port N          extension WebSocket port for a newly started hub (default ${V2_HUB_EXTENSION_PORT})
  --idle-minutes N  a newly started hub exits N minutes after its last MCP client
                    (default ${HUB_DEFAULT_IDLE_MINUTES}; 0 = never)
  reset-pin         forget the hub's trust-on-first-use pin, then pair again from the
                    TabCrew popup (Trust this hub)
  -h, --help        show this help

The flags only apply when this command starts the hub; a running hub keeps its settings.
Exit codes: 0 MCP client closed stdin; 1 hub failed to start or connection lost; 2 usage;
3 the hub's extension port is in use. Hub files and logs: see \`daemon.mjs hub --help\`.`;

/** Exit codes of `tabcrew mcp`. */
export const MCP_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** The spawned hub reported its extension port as taken (hub exit code 3). */
  portInUse: 3,
} as const;

/** A spawn.lock older than this is abandoned (its owner crashed or hung). */
export const SPAWN_LOCK_STALE_MS = 30_000;
/** A lock file without readable content gets this long to be written before it counts as stale. */
const LOCK_WRITE_GRACE_MS = 2_000;
const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** After stdin ends, how long to wait for the hub to close its side before dropping the socket. */
const CLOSE_GRACE_MS = 1_000;
const LOG_TAIL_BYTES = 4_096;
/** How long to wait for a just-started hub's hub.json (version check only). */
const HUB_INFO_WAIT_MS = 1_000;

export type McpArgs =
  | { readonly kind: "run"; readonly hubArgs: readonly string[]; readonly port?: number }
  | { readonly kind: "reset-pin" }
  | { readonly kind: "help" };

export type ParsedMcpArgs = { readonly ok: true; readonly args: McpArgs } | { readonly ok: false; readonly error: string };

/** The detached hub process, as far as the shim cares. */
export interface HubChild {
  readonly pid?: number;
  unref(): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
}

export interface SpawnHubOptions {
  /** hub.log fd: the hub's stdout and stderr (never the shim's stdout, which is the MCP channel). */
  readonly logFd: number;
  readonly cwd: string;
}

export interface McpDeps {
  /** Hub path resolution (env/home/uid/platform); see hub/paths.ts. */
  readonly pathOptions?: HubPathOptions;
  /** Directory holding the bundled daemon.mjs (cli/dist). */
  readonly runtimeDir: string | null;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: (s: string) => void;
  /** Help and reset-pin output (never used while relaying). */
  readonly out?: (line: string) => void;
  /** This shim's version (default: the bundled/package version). */
  readonly version?: string;
  /** Node binary for the hub (default process.execPath). */
  readonly execPath?: string;
  readonly connect?: (path: string) => Promise<Socket>;
  readonly spawn?: (command: string, args: readonly string[], opts: SpawnHubOptions) => HubChild;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pid?: number;
  readonly pollMs?: number;
  readonly spawnTimeoutMs?: number;
}

declare const __TABCREW_VERSION__: string | undefined;

/** The shim's version: inlined in the bundle, else daemon/package.json (development). */
export function shimVersion(): string {
  if (typeof __TABCREW_VERSION__ === "string") return __TABCREW_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

/** Parse `tabcrew mcp` arguments (after "mcp"). */
export function parseMcpArgs(argv: readonly string[]): ParsedMcpArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: true, args: { kind: "help" } };
  if (argv[0] === "reset-pin") {
    if (argv.length > 1) return { ok: false, error: `reset-pin takes no options: ${argv.slice(1).join(" ")}` };
    return { ok: true, args: { kind: "reset-pin" } };
  }
  const hubArgs: string[] = [];
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^(--port|--idle-minutes)(?:=(.*))?$/.exec(arg);
    if (!m) return { ok: false, error: `unknown option for mcp: ${arg}` };
    const [, flag, inline] = m;
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") return { ok: false, error: `${flag} needs a value` };
    if (flag === "--port") {
      const parsed = parsePort(value);
      if (parsed === null) return { ok: false, error: `invalid --port: ${value} (0-65535)` };
      port = parsed;
    } else if (!/^\d+(\.\d+)?$/.test(value)) {
      return { ok: false, error: `invalid --idle-minutes: ${value} (a number >= 0)` };
    }
    hubArgs.push(flag, value);
  }
  return { ok: true, args: port === undefined ? { kind: "run", hubArgs } : { kind: "run", hubArgs, port } };
}

const defaultConnect = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(path);
    const onError = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    sock.once("error", onError);
    sock.once("connect", () => {
      sock.off("error", onError);
      resolve(sock);
    });
  });

/** Spawn the hub detached from the shim: own process group, stdout+stderr to hub.log, unref'd by the caller. */
export function spawnDetachedHub(command: string, args: readonly string[], opts: SpawnHubOptions) {
  return spawnChild(command, [...args], { detached: true, stdio: ["ignore", opts.logFd, opts.logFd], cwd: opts.cwd });
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Ctx {
  readonly paths: HubPaths;
  readonly stderr: (s: string) => void;
  readonly connect: (path: string) => Promise<Socket>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isPidAlive: (pid: number) => boolean;
  readonly pid: number;
  readonly pollMs: number;
  readonly spawnTimeoutMs: number;
}

type Connected = { readonly sock: Socket };
type Failed = { readonly code: number; readonly message: string };

const NO_HUB = new Set(["ENOENT", "ECONNREFUSED"]);

async function tryConnect(ctx: Ctx): Promise<Socket | NodeJS.ErrnoException> {
  try {
    return await ctx.connect(ctx.paths.socket);
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}

function isSocket(v: Socket | NodeJS.ErrnoException): v is Socket {
  return !(v instanceof Error);
}

// --- spawn.lock: "<pid> <epoch ms> <nonce>", created with O_EXCL ---

function createLock(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(path: string): { content: string; mtimeMs: number } | null {
  try {
    return { content: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Remove the lock only if it still holds `content` (never another shim's fresh lock). */
function removeLockIf(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function lockHolder(lock: { content: string; mtimeMs: number }, ctx: Ctx): { pid: number | null; stale: boolean } {
  const m = /^(\d+) (\d+) /.exec(lock.content);
  if (!m) return { pid: null, stale: ctx.now() - lock.mtimeMs > LOCK_WRITE_GRACE_MS };
  const pid = Number(m[1]);
  const age = ctx.now() - Number(m[2]);
  return { pid, stale: !ctx.isPidAlive(pid) || age > SPAWN_LOCK_STALE_MS };
}

/** Bytes appended to hub.log since `offset` (at most LOG_TAIL_BYTES, from the end). */
function logTail(path: string, offset: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(offset, size - LOG_TAIL_BYTES);
      if (size <= start) return "";
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Spawn the hub (lock held) and wait until its socket answers. */
async function spawnAndWait(ctx: Ctx, command: string, args: readonly string[], spawn: NonNullable<McpDeps["spawn"]>): Promise<Connected | Failed> {
  const { paths } = ctx;
  // A hub.error from an earlier failed start must not be blamed on this one.
  clearHubError(paths);
  const logFd = openHubLog(paths);
  let logStart = 0;
  let child: HubChild;
  try {
    logStart = fstatSync(logFd).size;
    child = spawn(command, args, { logFd, cwd: paths.runtimeDir });
  } catch (err) {
    closeSync(logFd);
    return { code: MCP_EXIT.failed, message: `could not start the TabCrew hub: ${(err as Error).message}` };
  }
  closeSync(logFd);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.once("error", (err) => {
    spawnError = err;
  });
  child.unref();

  const deadline = ctx.now() + ctx.spawnTimeoutMs;
  for (;;) {
    const res = await tryConnect(ctx);
    if (isSocket(res)) return { sock: res };
    if (spawnError) return { code: MCP_EXIT.failed, message: `could not start the TabCrew hub: ${(spawnError as Error).message}` };
    const ended = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
    // Exit 0 = another hub already answered on the socket: keep trying to connect to it.
    if (ended && ended.code !== 0) {
      const code = ended.code === MCP_EXIT.portInUse ? MCP_EXIT.portInUse : MCP_EXIT.failed;
      const reason = readHubError(paths) ?? logTail(paths.log, logStart);
      const how = ended.code === null ? `signal ${ended.signal}` : `exit ${ended.code}`;
      let message = `the TabCrew hub failed to start (${how})${reason ? `:\n${indent(reason)}` : ""}\n  log: ${paths.log}`;
      if (code === MCP_EXIT.portInUse) message += "\n  free that port, or pass --port N here and set the same port in the TabCrew popup";
      return { code, message };
    }
    if (ctx.now() > deadline) {
      const tail = logTail(paths.log, logStart);
      return {
        code: MCP_EXIT.failed,
        message: `the TabCrew hub did not start within ${Math.round(ctx.spawnTimeoutMs / 1000)} s${tail ? `:\n${indent(tail)}` : ""}\n  log: ${paths.log}`,
      };
    }
    await ctx.sleep(ctx.pollMs);
  }
}

/** Connect to the hub, spawning it (under spawn.lock) when nothing answers on hub.sock. */
async function connectOrSpawn(ctx: Ctx, deps: McpDeps, hubArgs: readonly string[]): Promise<Connected | Failed> {
  const { paths } = ctx;
  const first = await tryConnect(ctx);
  if (isSocket(first)) return { sock: first };
  if (!NO_HUB.has(first.code ?? "")) return { code: MCP_EXIT.failed, message: `cannot connect to ${paths.socket}: ${first.message}` };

  const daemonScript = deps.runtimeDir ? join(deps.runtimeDir, "daemon.mjs") : null;
  if (!daemonScript || !existsSync(daemonScript)) {
    return {
      code: MCP_EXIT.failed,
      message: `cannot find the TabCrew hub runtime (${daemonScript ?? "daemon.mjs"}); build it with npm run build, or run tabcrew from its npm package`,
    };
  }

  const mine = `${ctx.pid} ${ctx.now()} ${randomBytes(8).toString("hex")}\n`;
  const waitDeadline = ctx.now() + SPAWN_LOCK_STALE_MS + ctx.spawnTimeoutMs;
  for (;;) {
    if (createLock(paths.spawnLock, mine)) break;
    const held = readLock(paths.spawnLock);
    if (!held) continue;
    const holder = lockHolder(held, ctx);
    if (holder.stale) {
      removeLockIf(paths.spawnLock, held.content);
      continue;
    }
    // Another shim is starting the hub: wait for its socket.
    await ctx.sleep(ctx.pollMs);
    const res = await tryConnect(ctx);
    if (isSocket(res)) return { sock: res };
    if (ctx.now() > waitDeadline) {
      return {
        code: MCP_EXIT.failed,
        message: `timed out waiting for another tabcrew mcp (pid ${holder.pid ?? "?"}) to start the hub; if it is stuck, remove ${paths.spawnLock}`,
      };
    }
  }
  try {
    // Someone may have started the hub between our first attempt and taking the lock.
    const again = await tryConnect(ctx);
    if (isSocket(again)) return { sock: again };
    return await spawnAndWait(ctx, deps.execPath ?? process.execPath, [daemonScript, "hub", ...hubArgs], deps.spawn ?? spawnDetachedHub);
  } finally {
    removeLockIf(paths.spawnLock, mine);
  }
}

/**
 * hub.json of the hub we are connected to. A freshly started hub writes it just after it starts
 * listening, and a crashed hub may have left an old one behind (dead pid): retry briefly.
 */
async function currentHubInfo(ctx: Ctx): Promise<HubInfo | null> {
  const deadline = ctx.now() + HUB_INFO_WAIT_MS;
  for (;;) {
    let info: HubInfo | null = null;
    try {
      info = readHubInfo(ctx.paths);
    } catch {
      info = null;
    }
    if (info && ctx.isPidAlive(info.pid)) return info;
    if (ctx.now() > deadline) return null;
    await ctx.sleep(Math.min(ctx.pollMs, 50));
  }
}

function warnAboutHub(info: HubInfo | null, version: string, port: number | undefined, stderr: (s: string) => void): void {
  if (!info) return;
  if (info.version !== version) {
    stderr(
      `tabcrew mcp: warning: the running TabCrew hub (pid ${info.pid}) is version ${info.version}, this tabcrew mcp is ${version}; ` +
        `the hub is replaced after it idle-exits (all MCP clients closed), or stop it now with: kill ${info.pid}\n`,
    );
  }
  if (port !== undefined && info.wsPort !== port) {
    stderr(
      `tabcrew mcp: warning: the running TabCrew hub (pid ${info.pid}) uses extension port ${info.wsPort}; --port ${port} only applies when tabcrew mcp starts a new hub\n`,
    );
  }
}

/** Copy stdin -> socket and socket -> stdout until either side closes. */
function relay(sock: Socket, stdin: Readable, stdout: Writable, stderr: (s: string) => void, info: HubInfo | null): Promise<number> {
  return new Promise((resolve) => {
    let clientGone = false;
    let lastError: Error | null = null;
    const clientClosed = () => {
      if (clientGone) return;
      clientGone = true;
      sock.end();
      setTimeout(() => sock.destroy(), CLOSE_GRACE_MS).unref();
    };
    stdin.once("end", clientClosed);
    stdin.once("error", clientClosed);
    // EPIPE on stdout: the MCP client is gone.
    stdout.once("error", () => {
      clientGone = true;
      sock.destroy();
    });
    sock.on("error", (err) => {
      lastError = err;
    });
    sock.once("close", () => {
      stdin.unpipe(sock);
      sock.unpipe(stdout);
      if (clientGone) {
        resolve(MCP_EXIT.ok);
        return;
      }
      const who = info ? ` (pid ${info.pid})` : "";
      const why = lastError ? `: ${(lastError as Error).message}` : "";
      stderr(
        `tabcrew mcp: lost connection to the TabCrew hub${who}${why}. ` +
          `Restart this MCP server (reconnect it in your MCP client) to start a new hub.\n`,
      );
      // Release stdin so the process can exit.
      stdin.destroy();
      resolve(MCP_EXIT.failed);
    });
    sock.pipe(stdout, { end: false });
    stdin.pipe(sock, { end: false });
  });
}

function resetPin(paths: HubPaths, out: (line: string) => void): number {
  const removed = resetHubPin(paths);
  out(removed ? `Removed the TabCrew hub pin (${paths.pin}).` : `No hub pin at ${paths.pin}; nothing to reset.`);
  out('Next: open the TabCrew popup in Chrome and click "Trust this hub" to pair the extension with the hub.');
  return MCP_EXIT.ok;
}

/**
 * `tabcrew mcp [--port N] [--idle-minutes N] | reset-pin | --help`. For a relay, resolves when the
 * MCP client closes stdin (0) or the hub connection is lost / the hub cannot start (non-zero).
 */
export async function runMcp(argv: readonly string[], deps: McpDeps): Promise<number> {
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const out = deps.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const parsed = parseMcpArgs(argv);
  if (!parsed.ok) {
    stderr(`tabcrew mcp: ${parsed.error}\n\n${MCP_USAGE}\n`);
    return MCP_EXIT.usage;
  }
  const { args } = parsed;
  if (args.kind === "help") {
    out(MCP_USAGE);
    return MCP_EXIT.ok;
  }

  let paths: HubPaths;
  try {
    paths = hubPaths(deps.pathOptions);
    if (args.kind === "reset-pin") return resetPin(paths, out);
    ensureHubRuntimeDir(paths, deps.pathOptions?.uid);
  } catch (err) {
    stderr(`tabcrew mcp: ${(err as Error).message}\n`);
    return MCP_EXIT.failed;
  }

  const ctx: Ctx = {
    paths,
    stderr,
    connect: deps.connect ?? defaultConnect,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    isPidAlive: deps.isPidAlive ?? defaultIsPidAlive,
    pid: deps.pid ?? process.pid,
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    spawnTimeoutMs: deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
  };
  let result: Connected | Failed;
  try {
    result = await connectOrSpawn(ctx, deps, args.hubArgs);
  } catch (err) {
    result = { code: MCP_EXIT.failed, message: (err as Error).message };
  }
  if ("message" in result) {
    stderr(`tabcrew mcp: ${result.message}\n`);
    return result.code;
  }

  const info = await currentHubInfo(ctx);
  warnAboutHub(info, deps.version ?? shimVersion(), args.port, stderr);
  return relay(result.sock, deps.stdin ?? process.stdin, deps.stdout ?? process.stdout, stderr, info);
}
