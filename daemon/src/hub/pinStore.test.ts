import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubPaths, type HubPaths } from "./paths.js";
import { FilePinStore, resetHubPin } from "./pinStore.js";

const SECRET = "ab".repeat(32);
const OTHER = "cd".repeat(32);

describe("FilePinStore", () => {
  let base: string;
  let paths: HubPaths;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tabcrew-pin-"));
    paths = hubPaths({ env: { TABCREW_HUB_RUNTIME_DIR: join(base, "rt"), TABCREW_HUB_STATE_DIR: join(base, "state", "TabCrew") } });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("is unpaired (null) when nothing is stored, without creating the state dir", async () => {
    expect(await new FilePinStore(paths).get()).toBeNull();
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it("persists the secret across instances in a 0600 file inside a 0700 state dir", async () => {
    await new FilePinStore(paths).set(SECRET);
    expect(await new FilePinStore(paths).get()).toBe(SECRET);
    expect(statSync(paths.pin).mode & 0o777).toBe(0o600);
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(paths.pin, "utf8").trim()).toBe(SECRET);
  });

  it("replaces atomically and leaves no temp files behind", async () => {
    const store = new FilePinStore(paths);
    await store.set(SECRET);
    await store.set(OTHER);
    expect(await store.get()).toBe(OTHER);
    expect(readdirSync(paths.stateDir)).toEqual(["hub-pin"]);
  });

  it("rejects a secret that is not 64 lowercase hex chars", async () => {
    await expect(new FilePinStore(paths).set("nothex")).rejects.toThrow(/64/);
    expect(existsSync(paths.pin)).toBe(false);
  });

  it("clear() forgets the pin and is a no-op when unpaired", async () => {
    const store = new FilePinStore(paths);
    await store.clear();
    await store.set(SECRET);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it("treats a corrupt pin file as unpaired", async () => {
    const store = new FilePinStore(paths);
    await store.set(SECRET);
    writeFileSync(paths.pin, "garbage\n");
    expect(await store.get()).toBeNull();
  });

  it("fails closed when the pin file is readable by others or is a symlink", async () => {
    const store = new FilePinStore(paths);
    await store.set(SECRET);
    chmodSync(paths.pin, 0o644);
    await expect(store.get()).rejects.toThrow(/permissions/);
    rmSync(paths.pin);
    const target = join(base, "elsewhere");
    writeFileSync(target, SECRET, { mode: 0o600 });
    symlinkSync(target, paths.pin);
    await expect(store.get()).rejects.toThrow(/symlink/);
  });

  it("resetHubPin deletes the pin and reports whether one existed", async () => {
    expect(resetHubPin(paths)).toBe(false);
    await new FilePinStore(paths).set(SECRET);
    expect(resetHubPin(paths)).toBe(true);
    expect(existsSync(paths.pin)).toBe(false);
    expect(await new FilePinStore(paths).get()).toBeNull();
  });
});
