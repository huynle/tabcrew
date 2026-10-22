import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HUB_SOCKET_MAX_BYTES,
  HubPathError,
  ensurePrivateDir,
  hubPaths,
  hubRuntimeDir,
  hubStateDir,
  verifyPrivateFile,
} from "./paths.js";

const uid = process.getuid!();

const noExec = (): string => {
  throw new Error("exec must not be called");
};

describe("hubRuntimeDir", () => {
  it("macOS: uses getconf DARWIN_USER_TEMP_DIR (not TMPDIR) plus tabcrew-<uid>", () => {
    const calls: string[][] = [];
    const dir = hubRuntimeDir({
      platform: "darwin",
      uid: 501,
      env: { TMPDIR: "/ignored/" },
      exec: (file, args) => {
        calls.push([file, ...args]);
        return "/var/folders/ab/xyz/T/\n";
      },
    });
    expect(dir).toBe("/var/folders/ab/xyz/T/tabcrew-501");
    expect(calls).toEqual([["getconf", "DARWIN_USER_TEMP_DIR"]]);
  });

  it("macOS: falls back to /tmp/tabcrew-<uid> when getconf fails or prints nothing", () => {
    const failing = () => {
      throw new Error("no getconf");
    };
    expect(hubRuntimeDir({ platform: "darwin", uid: 501, env: {}, exec: failing })).toBe("/tmp/tabcrew-501");
    expect(hubRuntimeDir({ platform: "darwin", uid: 501, env: {}, exec: () => "  \n" })).toBe("/tmp/tabcrew-501");
  });

  it("Linux: $XDG_RUNTIME_DIR/tabcrew, else /run/user/<uid>/tabcrew if present, else /tmp/tabcrew-<uid>", () => {
    expect(hubRuntimeDir({ platform: "linux", uid: 1000, env: { XDG_RUNTIME_DIR: "/run/user/1000" }, exec: noExec })).toBe(
      "/run/user/1000/tabcrew",
    );
    expect(hubRuntimeDir({ platform: "linux", uid: 1000, env: {}, exec: noExec, isDir: (p) => p === "/run/user/1000" })).toBe(
      "/run/user/1000/tabcrew",
    );
    expect(hubRuntimeDir({ platform: "linux", uid: 1000, env: {}, exec: noExec, isDir: () => false })).toBe("/tmp/tabcrew-1000");
  });

  it("TABCREW_HUB_RUNTIME_DIR overrides the platform default", () => {
    expect(hubRuntimeDir({ platform: "darwin", uid: 1, env: { TABCREW_HUB_RUNTIME_DIR: "/x/rt" }, exec: noExec })).toBe("/x/rt");
  });
});

describe("hubStateDir", () => {
  it("macOS: ~/Library/Application Support/TabCrew", () => {
    expect(hubStateDir({ platform: "darwin", home: "/Users/me", env: {} })).toBe("/Users/me/Library/Application Support/TabCrew");
  });

  it("Linux: $XDG_STATE_HOME/tabcrew, else ~/.local/state/tabcrew", () => {
    expect(hubStateDir({ platform: "linux", home: "/home/me", env: { XDG_STATE_HOME: "/st" } })).toBe("/st/tabcrew");
    expect(hubStateDir({ platform: "linux", home: "/home/me", env: {} })).toBe("/home/me/.local/state/tabcrew");
  });

  it("TABCREW_HUB_STATE_DIR overrides the platform default", () => {
    expect(hubStateDir({ platform: "darwin", home: "/Users/me", env: { TABCREW_HUB_STATE_DIR: "/s" } })).toBe("/s");
  });
});

describe("hubPaths", () => {
  it("names every hub file inside the runtime and state dirs", () => {
    const paths = hubPaths({ env: { TABCREW_HUB_RUNTIME_DIR: "/rt", TABCREW_HUB_STATE_DIR: "/st" } });
    expect(paths).toEqual({
      runtimeDir: "/rt",
      socket: "/rt/hub.sock",
      info: "/rt/hub.json",
      log: "/rt/hub.log",
      error: "/rt/hub.error",
      spawnLock: "/rt/spawn.lock",
      stateDir: "/st",
      pin: "/st/hub-pin",
    });
  });

  it("rejects a socket path that does not fit in sun_path", () => {
    const long = `/${"d".repeat(HUB_SOCKET_MAX_BYTES - "/hub.sock".length - 1)}`;
    expect(() => hubPaths({ env: { TABCREW_HUB_RUNTIME_DIR: long, TABCREW_HUB_STATE_DIR: "/st" } })).not.toThrow();
    expect(() => hubPaths({ env: { TABCREW_HUB_RUNTIME_DIR: `${long}x`, TABCREW_HUB_STATE_DIR: "/st" } })).toThrow(HubPathError);
  });
});

describe("ensurePrivateDir / verifyPrivateFile", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tabcrew-paths-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("creates a missing directory (and parents) with mode 0700", () => {
    const dir = join(base, "a", "b");
    ensurePrivateDir(dir, uid);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("accepts an existing private directory", () => {
    const dir = join(base, "ok");
    mkdirSync(dir, { mode: 0o700 });
    expect(() => ensurePrivateDir(dir, uid)).not.toThrow();
  });

  it("rejects a directory readable by group/other", () => {
    const dir = join(base, "open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(() => ensurePrivateDir(dir, uid)).toThrow(/permissions|0755/);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("rejects a symlink even when it points at a private directory", () => {
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(() => ensurePrivateDir(link, uid)).toThrow(/symlink/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("rejects a directory owned by another user", () => {
    const dir = join(base, "foreign");
    mkdirSync(dir, { mode: 0o700 });
    expect(() => ensurePrivateDir(dir, uid + 1)).toThrow(/owned by uid/);
  });

  it("rejects a regular file in place of the directory", () => {
    const file = join(base, "file");
    writeFileSync(file, "");
    expect(() => ensurePrivateDir(file, uid)).toThrow(HubPathError);
  });

  it("verifyPrivateFile accepts 0600 files and rejects open modes, symlinks and foreign owners", () => {
    const file = join(base, "f");
    writeFileSync(file, "x", { mode: 0o600 });
    expect(verifyPrivateFile(file, uid)).toBe(true);
    expect(verifyPrivateFile(join(base, "missing"), uid)).toBe(false);
    expect(() => verifyPrivateFile(file, uid + 1)).toThrow(/owned by uid/);
    const link = join(base, "fl");
    symlinkSync(file, link);
    expect(() => verifyPrivateFile(link, uid)).toThrow(/symlink/);
    chmodSync(file, 0o644);
    expect(() => verifyPrivateFile(file, uid)).toThrow(/permissions/);
  });
});
