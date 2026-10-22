import { execFileSync } from "node:child_process";
import { lstatSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { daemonVersion, startDaemon, type RunningHub } from "../daemon.js";
import { log } from "../log.js";
import type { PinStore } from "../pin.js";
import { HUB_DEFAULT_IDLE_MINUTES, hubConfig, parseHubArgs } from "./config.js";
import { clearHubError, readHubInfo, removeHubInfo, writeHubError, writeHubInfo } from "./info.js";
import { ensureHubRuntimeDir, hubPaths, type HubPathOptions, type HubPaths } from "./paths.js";
import { FilePinStore } from "./pinStore.js";

export const HUB_USAGE = `usage: daemon.mjs hub [--port N] [--idle-minutes N]

Run a TabCrew hub: the shared server behind \`tabcrew mcp\` (no launchd, no ~/.tabcrew).
MCP is served on a Unix socket in a private runtime dir; the extension connects to
ws://127.0.0.1:<port> and authenticates with its Origin and a trust-on-first-use pin.

  --port N          extension WebSocket port (default 8775)
  --idle-minutes N  exit N minutes after the last MCP client disconnects, or when none
                    connects within N minutes of start (default ${HUB_DEFAULT_IDLE_MINUTES}; 0 = never)
  -h, --help        show this help

Files: <runtime dir>/hub.sock, hub.json, hub.log, hub.error, spawn.lock; pin: <state dir>/hub-pin
  runtime dir: macOS $(getconf DARWIN_USER_TEMP_DIR)/tabcrew-<uid>, Linux $XDG_RUNTIME_DIR/tabcrew
  state dir:   macOS ~/Library/Application Support/TabCrew, Linux $XDG_STATE_HOME/tabcrew
Exit codes: 0 stopped, idle or already running; 1 failed (see hub.error); 2 usage; 3 port in use`;

/** Exit codes of `daemon.mjs hub`. */
export const HUB_EXIT = {
  /** Stopped by signal, idle exit, help, or another hub already answers on the socket. */
  ok: 0,
  /** Could not start (reason in hub.error when the runtime dir is usable). */
  failed: 1,
  usage: 2,
  /** The extension port is taken by another process (owner in hub.error). */
  portInUse: 3,
} as const;

type Exec = (file: string, args: readonly string[]) => string;

export interface RunHubDeps {
  /** Path resolution (env/home/uid/platform/exec); see hub/paths.ts. */
  readonly pathOptions?: HubPathOptions;
  /** Runs lsof for port diagnostics (default execFileSync). */
  readonly exec?: Exec;
  /** Register a signal handler; returns an unsubscribe function (default process.on/off). */
  readonly onSignal?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => () => void;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  /** Default: FilePinStore on the state dir. */
  readonly pinStore?: PinStore;
  /** Extension origins allowed on the WebSocket (default: the known TabCrew extension IDs). */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Idle exit: fires `ms` after start() while no MCP client is connected, re-arming whenever the
 * connection count drops back to 0 and cancelling when a client connects. ms <= 0 disables it.
 */
export class IdleExit {
  private count = 0;
  private started = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}

  start(): void {
    this.started = true;
    this.arm();
  }

  update(count: number): void {
    this.count = count;
    if (count > 0) this.cancel();
    else this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private arm(): void {
    if (!this.started || this.stopped || this.ms <= 0 || this.count > 0) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped && this.count === 0) this.onIdle();
    }, this.ms);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const LSOF_CANDIDATES = ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"];

const defaultExec: Exec = (file, args) =>
  execFileSync(file, [...args], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });

/** Default exec for lsof: try PATH, then the usual locations (PATH may be minimal under an MCP client). */
function execLsof(args: readonly string[]): string {
  let last: unknown;
  for (const file of LSOF_CANDIDATES) {
    try {
      return defaultExec(file, args);
    } catch (err) {
      last = err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw last;
}

/** "port N in use by pid P (cmd)", using a read-only `lsof -nP -iTCP:N -sTCP:LISTEN -Fpc`. */
export function describePortOwner(port: number, exec?: Exec): string {
  const args = ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"];
  let out = "";
  try {
    out = exec ? exec("lsof", args) : execLsof(args);
  } catch {
    out = "";
  }
  let pid: string | undefined;
  let cmd: string | undefined;
  for (const line of out.split("\n")) {
    if (!pid && line.startsWith("p")) pid = line.slice(1).trim();
    else if (pid && !cmd && line.startsWith("c")) cmd = line.slice(1).trim();
  }
  if (!pid) return `port ${port} in use by another process`;
  return `port ${port} in use by pid ${pid}${cmd ? ` (${cmd})` : ""}`;
}

class HubStartError extends Error {}

type SocketState = "absent" | "live" | "stale";

/** Is a hub answering on `path`? A socket nobody listens on (ECONNREFUSED) is stale. */
async function probeSocket(path: string, timeoutMs = 1_000): Promise<SocketState> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
  if (!isSocket) throw new HubStartError(`${path} exists and is not a socket; remove it and retry`);
  return new Promise<SocketState>((resolve, reject) => {
    const sock = connect(path);
    // Busy but present: treat as live rather than deleting another hub's socket.
    const timer = setTimeout(() => {
      sock.destroy();
      resolve("live");
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      sock.destroy();
      resolve("live");
    });
    sock.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      sock.destroy();
      if (err.code === "ECONNREFUSED") resolve("stale");
      else if (err.code === "ENOENT") resolve("absent");
      else reject(err);
    });
  });
}

function socketInode(path: string): number | null {
  try {
    return lstatSync(path).ino;
  } catch {
    return null;
  }
}

/**
 * `daemon.mjs hub`: run a hub until SIGTERM/SIGINT or idle exit; resolves with the exit code.
 *
 * Startup: verify/create the runtime dir; if hub.sock exists, probe it (a live hub => exit 0;
 * ECONNREFUSED => stale, unlink); start the hub (extension WebSocket first, then the socket);
 * on a taken port write hub.error "port N in use by pid P (cmd)" and exit 3; then write
 * hub.json {pid, version, wsPort, startedAt} and remove any old hub.error. Logs go to stderr.
 */
export async function runHub(argv: readonly string[], deps: RunHubDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const parsed = parseHubArgs(argv);
  if (!parsed.ok) {
    stderr(`${parsed.error}\n${HUB_USAGE}\n`);
    return HUB_EXIT.usage;
  }
  const { args } = parsed;
  if (args.help) {
    stdout(`${HUB_USAGE}\n`);
    return HUB_EXIT.ok;
  }

  let paths: HubPaths;
  try {
    paths = hubPaths(deps.pathOptions);
    ensureHubRuntimeDir(paths, deps.pathOptions?.uid);
  } catch (err) {
    stderr(`tabcrew-hub: ${(err as Error).message}\n`);
    return HUB_EXIT.failed;
  }
  const fail = (code: number, message: string): number => {
    stderr(`tabcrew-hub: ${message}\n`);
    try {
      writeHubError(paths, message);
    } catch {
      // the message is on stderr (hub.log) anyway
    }
    return code;
  };
  const alreadyRunning = (): number => {
    const other = readHubInfo(paths);
    log.info(`hub: another hub is already running${other ? ` (pid ${other.pid}, version ${other.version})` : ""}; exiting`);
    return HUB_EXIT.ok;
  };

  try {
    const state = await probeSocket(paths.socket);
    if (state === "live") return alreadyRunning();
    if (state === "stale") {
      log.info(`hub: removing stale socket ${paths.socket}`);
      unlinkSync(paths.socket);
    }
  } catch (err) {
    return fail(HUB_EXIT.failed, (err as Error).message);
  }

  const pid = process.pid;
  let stop: (reason: string) => void = () => {};
  const idle = new IdleExit(args.idleMinutes * 60_000, () => stop(`no MCP client for ${args.idleMinutes} minute(s)`));

  let hub: RunningHub;
  try {
    hub = await startDaemon(
      hubConfig(args, paths.runtimeDir),
      {},
      {
        mode: "hub",
        runtimeDir: paths.runtimeDir,
        socketPath: paths.socket,
        pinStore: deps.pinStore ?? new FilePinStore(paths, deps.pathOptions?.uid),
        allowedOrigins: deps.allowedOrigins,
        extensionPort: args.port,
        onConnectionCountChange: (count) => idle.update(count),
      },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { address?: string };
    if (e.code === "EADDRINUSE" && (e.address === paths.socket || e.message.includes(paths.socket))) {
      // Another hub bound the socket between our probe and listen.
      if ((await probeSocket(paths.socket).catch(() => "absent")) === "live") return alreadyRunning();
      return fail(HUB_EXIT.failed, `socket ${paths.socket} is in use`);
    }
    if (e.code === "EADDRINUSE") return fail(HUB_EXIT.portInUse, describePortOwner(args.port, deps.exec));
    return fail(HUB_EXIT.failed, `hub failed to start: ${e.message}`);
  }

  const inode = socketInode(paths.socket);
  try {
    writeHubInfo(paths, { pid, version: daemonVersion(), wsPort: hub.extensionPort, startedAt: new Date().toISOString() });
    clearHubError(paths);
  } catch (err) {
    await hub.close().catch(() => {});
    return fail(HUB_EXIT.failed, `cannot write ${paths.info}: ${(err as Error).message}`);
  }

  const onSignal =
    deps.onSignal ??
    ((signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    });

  return new Promise<number>((resolve) => {
    let stopping = false;
    const unsubscribe: Array<() => void> = [];
    stop = (reason) => {
      if (stopping) return;
      stopping = true;
      idle.stop();
      for (const off of unsubscribe) off();
      log.info(`hub: ${reason}, shutting down`);
      hub.close().then(
        () => finish(HUB_EXIT.ok),
        (err) => {
          log.error(`hub: close failed: ${(err as Error).message}`);
          finish(HUB_EXIT.failed);
        },
      );
    };
    const finish = (code: number): void => {
      // Only remove the socket we created (a newer hub may have replaced a socket we lost).
      if (inode !== null && socketInode(paths.socket) === inode) {
        try {
          unlinkSync(paths.socket);
        } catch {
          // already gone
        }
      }
      try {
        removeHubInfo(paths, pid);
      } catch {
        // best effort
      }
      resolve(code);
    };
    unsubscribe.push(onSignal("SIGTERM", () => stop("received SIGTERM")));
    unsubscribe.push(onSignal("SIGINT", () => stop("received SIGINT")));
    idle.update(hub.connectionCount);
    idle.start();
  });
}
