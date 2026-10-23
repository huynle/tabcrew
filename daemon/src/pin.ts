import { createHmac } from "node:crypto";

/**
 * Where a hub keeps its trust-on-first-use pin (the 64-hex secret the extension handed over on
 * first pairing). Hub mode only; the file-backed store lives with the hub launcher. Implementations
 * must never log the secret.
 */
export interface PinStore {
  /** The stored secret, or null when the hub is not paired yet. */
  get(): Promise<string | null>;
  /** Store (or replace) the secret. */
  set(secret: string): Promise<void>;
  /** Forget the secret (user-approved re-trust). */
  clear(): Promise<void>;
}

/** In-memory pin store (tests, or a hub that should forget its pin on exit). */
export class MemoryPinStore implements PinStore {
  constructor(private secret: string | null = null) {}

  async get(): Promise<string | null> {
    return this.secret;
  }

  async set(secret: string): Promise<void> {
    this.secret = secret;
  }

  async clear(): Promise<void> {
    this.secret = null;
  }
}

/** HMAC-SHA256 keyed with the hex-decoded pin secret over the UTF-8 input, as lowercase hex (shared/v2 TOFU spec). */
export function pinProof(secret: string, input: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(input, "utf8").digest("hex");
}
