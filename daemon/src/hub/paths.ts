import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Env } from "../home.js";

/**
 * Where a hub keeps its files. Hub mode never uses ~/.tabcrew:
 * - runtime dir (private 0700): MCP socket, hub.json, hub.log, hub.error, spawn.lock, sessions.json.
 *   macOS: `$(getconf DARWIN_USER_TEMP_DIR)/tabcrew-<uid>` (the per-user temp dir; TMPDIR is not used
 *   because the MCP SDK strips it from the environment of stdio servers). Linux:
 *   `$XDG_RUNTIME_DIR/tabcrew`, else `/run/user/<uid>/tabcrew` when that dir exists, else
 *   `/tmp/tabcrew-<uid>`. Override: `$TABCREW_HUB_RUNTIME_DIR`.
 * - state dir (private 0700): the TOFU pin `hub-pin` (0600). macOS:
 *   `~/Library/Application Support/TabCrew`; Linux: `$XDG_STATE_HOME/tabcrew`, else
 *   `~/.local/state/tabcrew`. Override: `$TABCREW_HUB_STATE_DIR`.
 * Shared by the hub (`daemon.mjs hub`) and the `tabcrew mcp` shim, so both must resolve the same paths.
 */

export const HUB_RUNTIME_DIR_ENV = "TABCREW_HUB_RUNTIME_DIR";
export const HUB_STATE_DIR_ENV = "TABCREW_HUB_STATE_DIR";

/** sun_path is 104 bytes on macOS (108 on Linux), including the trailing NUL. */
export const HUB_SOCKET_MAX_BYTES = 103;

export interface HubPathOptions {
  readonly env?: Env;
  readonly home?: string;
  readonly uid?: number;
  readonly platform?: NodeJS.Platform;
  /** Runs a command and returns its stdout (throws on failure). Default: execFileSync. */
  readonly exec?: (file: string, args: readonly string[]) => string;
  /** Whether a path is an existing directory (Linux /run/user probe). */
  readonly isDir?: (path: string) => boolean;
}

export interface HubPaths {
  readonly runtimeDir: string;
  /** MCP Unix socket. */
  readonly socket: string;
  /** hub.json: {pid, version, wsPort, startedAt} of the running hub. */
  readonly info: string;
  /** hub.log: the shim redirects the hub's stderr here. */
  readonly log: string;
  /** hub.error: why the last start failed (e.g. port in use). */
  readonly error: string;
  /** spawn.lock: held by the shim while it spawns a hub. */
  readonly spawnLock: string;
  readonly stateDir: string;
  /** hub-pin: the TOFU secret (0600). */
  readonly pin: string;
}

export class HubPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubPathError";
  }
}

export function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

const defaultExec = (file: string, args: readonly string[]): string =>
  execFileSync(file, [...args], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });

const defaultIsDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function override(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? resolve(raw) : undefined;
}

/** The hub's private runtime dir (resolution only; see ensurePrivateDir). */
export function hubRuntimeDir(opts: HubPathOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = override(env, HUB_RUNTIME_DIR_ENV);
  if (fromEnv) return fromEnv;
  const uid = opts.uid ?? currentUid();
  const platform = opts.platform ?? process.platform;
  const fallback = `/tmp/tabcrew-${uid}`;
  if (platform === "darwin") {
    let temp = "";
    try {
      temp = (opts.exec ?? defaultExec)("getconf", ["DARWIN_USER_TEMP_DIR"]).trim();
    } catch {
      temp = "";
    }
    return temp ? join(temp, `tabcrew-${uid}`) : fallback;
  }
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return join(xdg, "tabcrew");
  const runUser = `/run/user/${uid}`;
  if ((opts.isDir ?? defaultIsDir)(runUser)) return join(runUser, "tabcrew");
  return fallback;
}

/** Where the hub keeps state that survives restarts (the TOFU pin). */
export function hubStateDir(opts: HubPathOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = override(env, HUB_STATE_DIR_ENV);
  if (fromEnv) return fromEnv;
  const home = opts.home ?? homedir();
  if ((opts.platform ?? process.platform) === "darwin") return join(home, "Library", "Application Support", "TabCrew");
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "tabcrew");
}

/** Every hub path (no filesystem access). Throws HubPathError if the socket path is too long. */
export function hubPaths(opts: HubPathOptions = {}): HubPaths {
  const runtimeDir = hubRuntimeDir(opts);
  const stateDir = hubStateDir(opts);
  const socket = join(runtimeDir, "hub.sock");
  if (Buffer.byteLength(socket) > HUB_SOCKET_MAX_BYTES) {
    throw new HubPathError(`hub socket path is too long (${Buffer.byteLength(socket)} > ${HUB_SOCKET_MAX_BYTES} bytes): ${socket}`);
  }
  return {
    runtimeDir,
    socket,
    info: join(runtimeDir, "hub.json"),
    log: join(runtimeDir, "hub.log"),
    error: join(runtimeDir, "hub.error"),
    spawnLock: join(runtimeDir, "spawn.lock"),
    stateDir,
    pin: join(stateDir, "hub-pin"),
  };
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function checkPrivate(path: string, st: Stats, uid: number, what: string): void {
  if (st.isSymbolicLink()) throw new HubPathError(`${what} ${path} is a symlink; refusing to use it`);
  if (st.uid !== uid) throw new HubPathError(`${what} ${path} is owned by uid ${st.uid}, not ${uid}; refusing to use it`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new HubPathError(
      `${what} ${path} has permissions 0${mode.toString(8)} (group/other access); fix with: chmod ${what === "directory" ? 700 : 600} '${path}'`,
    );
  }
}

/**
 * Create `dir` (and missing parents) with mode 0700, or verify an existing one: a real directory
 * (not a symlink), owned by `uid`, no group/other permission bits. Throws HubPathError otherwise.
 */
export function ensurePrivateDir(dir: string, uid: number = currentUid()): void {
  let st = lstatOrNull(dir);
  if (!st) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
    // A fresh directory is ours: pin its mode regardless of the umask.
    if (!st.isSymbolicLink() && st.isDirectory() && st.uid === uid) chmodSync(dir, 0o700);
    st = lstatSync(dir);
  }
  if (!st.isSymbolicLink() && !st.isDirectory()) throw new HubPathError(`${dir} is not a directory`);
  checkPrivate(dir, st, uid, "directory");
}

/**
 * Verify a private file: false if missing; throws HubPathError if it is a symlink, not a regular
 * file, owned by someone else, or has group/other permission bits.
 */
export function verifyPrivateFile(path: string, uid: number = currentUid()): boolean {
  const st = lstatOrNull(path);
  if (!st) return false;
  if (!st.isSymbolicLink() && !st.isFile()) throw new HubPathError(`${path} is not a regular file`);
  checkPrivate(path, st, uid, "file");
  return true;
}

/** Create/verify the runtime dir. */
export function ensureHubRuntimeDir(paths: HubPaths, uid: number = currentUid()): void {
  ensurePrivateDir(paths.runtimeDir, uid);
}

/** Create/verify the state dir (pin). */
export function ensureHubStateDir(paths: HubPaths, uid: number = currentUid()): void {
  ensurePrivateDir(paths.stateDir, uid);
}
