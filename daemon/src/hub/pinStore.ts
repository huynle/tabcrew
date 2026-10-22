import { closeSync, constants, openSync, readFileSync } from "node:fs";
import type { PinStore } from "../pin.js";
import { unlinkQuiet, writePrivateFileAtomic } from "./info.js";
import { currentUid, ensurePrivateDir, verifyPrivateFile, type HubPaths } from "./paths.js";

const PIN_SECRET = /^[0-9a-f]{64}$/;

/**
 * The hub's TOFU pin in `<stateDir>/hub-pin` (0600, state dir 0700; see hub/paths.ts). Every get()
 * re-reads the file, so `tabcrew mcp reset-pin` takes effect on a running hub. A symlinked,
 * foreign-owned or group/other-readable pin file makes get() throw (the hub then refuses the
 * extension) instead of silently re-pairing. Never logs the secret.
 */
export class FilePinStore implements PinStore {
  constructor(
    private readonly paths: Pick<HubPaths, "pin" | "stateDir">,
    private readonly uid: number = currentUid(),
  ) {}

  async get(): Promise<string | null> {
    if (!verifyPrivateFile(this.paths.pin, this.uid)) return null;
    const fd = openSync(this.paths.pin, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: string;
    try {
      value = readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
    return PIN_SECRET.test(value) ? value : null;
  }

  async set(secret: string): Promise<void> {
    if (!PIN_SECRET.test(secret)) throw new Error("hub pin must be 64 lowercase hex characters");
    ensurePrivateDir(this.paths.stateDir, this.uid);
    writePrivateFileAtomic(this.paths.pin, `${secret}\n`);
  }

  async clear(): Promise<void> {
    unlinkQuiet(this.paths.pin);
  }
}

/** Forget the hub's pin (`tabcrew mcp reset-pin`). Returns whether a pin file existed. */
export function resetHubPin(paths: Pick<HubPaths, "pin">): boolean {
  return unlinkQuiet(paths.pin);
}
