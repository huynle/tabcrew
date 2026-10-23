import { chmodSync, closeSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearHubError,
  openHubLog,
  readHubError,
  readHubInfo,
  removeHubInfo,
  writeHubError,
  writeHubInfo,
  writePrivateFileAtomic,
} from "./info.js";
import { ensureHubRuntimeDir, hubPaths, type HubPaths } from "./paths.js";

describe("hub runtime files", () => {
  let base: string;
  let paths: HubPaths;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tabcrew-info-"));
    paths = hubPaths({ env: { TABCREW_HUB_RUNTIME_DIR: join(base, "rt"), TABCREW_HUB_STATE_DIR: join(base, "st") } });
    ensureHubRuntimeDir(paths);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("writePrivateFileAtomic writes 0600 and leaves no temp file", () => {
    const file = join(paths.runtimeDir, "x");
    writePrivateFileAtomic(file, "one");
    writePrivateFileAtomic(file, "two");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.runtimeDir)).toEqual(["x"]);
  });

  it("hub.json round-trips {pid, version, wsPort, startedAt}", () => {
    const info = { pid: 123, version: "0.5.0", wsPort: 8775, startedAt: "2026-10-22T00:00:00.000Z" };
    expect(readHubInfo(paths)).toBeNull();
    writeHubInfo(paths, info);
    expect(readHubInfo(paths)).toEqual(info);
    expect(statSync(paths.info).mode & 0o777).toBe(0o600);
  });

  it("readHubInfo returns null for corrupt or incomplete files", () => {
    writeFileSync(paths.info, "{not json", { mode: 0o600 });
    expect(readHubInfo(paths)).toBeNull();
    writeFileSync(paths.info, JSON.stringify({ pid: "x", version: "1", wsPort: 1 }), { mode: 0o600 });
    expect(readHubInfo(paths)).toBeNull();
  });

  it("removeHubInfo only removes the file of the given pid", () => {
    writeHubInfo(paths, { pid: 1, version: "v", wsPort: 1, startedAt: "t" });
    removeHubInfo(paths, 2);
    expect(existsSync(paths.info)).toBe(true);
    removeHubInfo(paths, 1);
    expect(existsSync(paths.info)).toBe(false);
    expect(() => removeHubInfo(paths, 1)).not.toThrow();
  });

  it("hub.error is written 0600, read back trimmed, and cleared", () => {
    expect(readHubError(paths)).toBeNull();
    writeHubError(paths, "port 8775 in use by pid 7 (node)");
    expect(readHubError(paths)).toBe("port 8775 in use by pid 7 (node)");
    expect(statSync(paths.error).mode & 0o777).toBe(0o600);
    clearHubError(paths);
    expect(readHubError(paths)).toBeNull();
    expect(() => clearHubError(paths)).not.toThrow();
  });

  it("openHubLog appends to a 0600 hub.log (tightening an existing open mode)", () => {
    writeFileSync(paths.log, "old\n");
    chmodSync(paths.log, 0o644);
    const fd = openHubLog(paths);
    writeSync(fd, "new\n");
    closeSync(fd);
    expect(statSync(paths.log).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.runtimeDir)).toContain("hub.log");
  });
});
