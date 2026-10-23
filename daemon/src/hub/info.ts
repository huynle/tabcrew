import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { verifyPrivateFile, type HubPaths } from "./paths.js";

/** What a running hub publishes in hub.json (the shim reads it to find and check the hub). */
export interface HubInfo {
  readonly pid: number;
  readonly version: string;
  /** The extension WebSocket port the hub is bound to. */
  readonly wsPort: number;
  /** ISO time the hub started listening. */
  readonly startedAt: string;
}

/** Write `data` to `path` with mode 0600 via a temp file + rename (never a partial file). */
export function writePrivateFileAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    unlinkQuiet(tmp);
    throw err;
  }
}

/** Unlink `path`; false if it did not exist. */
export function unlinkQuiet(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function readQuiet(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function writeHubInfo(paths: Pick<HubPaths, "info">, info: HubInfo): void {
  writePrivateFileAtomic(paths.info, `${JSON.stringify(info)}\n`);
}

/** The published hub info, or null when missing or not a valid hub.json. */
export function readHubInfo(paths: Pick<HubPaths, "info">): HubInfo | null {
  const raw = readQuiet(paths.info);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<HubInfo>;
    if (
      Number.isInteger(v.pid) &&
      typeof v.version === "string" &&
      Number.isInteger(v.wsPort) &&
      typeof v.startedAt === "string"
    ) {
      return { pid: v.pid!, version: v.version, wsPort: v.wsPort!, startedAt: v.startedAt };
    }
  } catch {
    // corrupt
  }
  return null;
}

/** Remove hub.json if it belongs to `pid` (a newer hub's file is left alone). */
export function removeHubInfo(paths: Pick<HubPaths, "info">, pid: number): void {
  const info = readHubInfo(paths);
  if (info && info.pid !== pid) return;
  unlinkQuiet(paths.info);
}

export function writeHubError(paths: Pick<HubPaths, "error">, message: string): void {
  writePrivateFileAtomic(paths.error, `${message.trim()}\n`);
}

export function readHubError(paths: Pick<HubPaths, "error">): string | null {
  const raw = readQuiet(paths.error);
  const text = raw?.trim();
  return text ? text : null;
}

export function clearHubError(paths: Pick<HubPaths, "error">): void {
  unlinkQuiet(paths.error);
}

/**
 * Open hub.log for appending (mode 0600, tightened if it already existed) and return the fd, for
 * the shim to pass as the spawned hub's stdout/stderr. Refuses a symlinked or foreign-owned log.
 */
export function openHubLog(paths: Pick<HubPaths, "log">): number {
  try {
    verifyPrivateFile(paths.log);
  } catch (err) {
    if (!/permissions/.test((err as Error).message)) throw err;
    chmodSync(paths.log, 0o600);
  }
  // O_NOFOLLOW: a symlink swapped in after the check is refused, not followed.
  return openSync(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
}
