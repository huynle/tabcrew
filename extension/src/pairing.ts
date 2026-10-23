/**
 * Automatic pairing: the extension asks the `com.tabcrew.pair` native messaging host (installed by
 * `npx tabcrew setup`) for the daemon token and stores it like a manually entered one. Storing it
 * fires chrome.storage.onChanged, which pushes the new config to the offscreen bridge.
 *
 * - No token stored → ask the host (retried from the keepalive alarm while unpaired).
 * - The daemon rejected the stored token (4401) → ask the host once per rejected token; a different
 *   token means the daemon's token changed (e.g. reinstall), so it replaces the stored one.
 *
 * Connection mode (`v2:mode`): "daemon" pairs as above; "hub" and "online" never ask the host (hub mode has no
 * token, and locked-down Chrome blocks native messaging); "auto" without a token is hub mode, so the
 * host is asked once per service-worker life (a successful pairing stores a token, which switches
 * auto to daemon mode) and not from the keepalive loop.
 */

import { NATIVE_HOST_NAME, type PairRequest } from "@tabcrew/shared/product";
import type { ModeSetting } from "./config.js";

export const NOT_PAIRED_TEXT = "not paired: run npx tabcrew setup";

export interface PairingDeps {
  sendNativeMessage(host: string, message: PairRequest): Promise<unknown>;
  loadToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  /** The stored mode setting; absent means "daemon" (always pair while no token is stored). */
  loadModeSetting?(): Promise<ModeSetting>;
}

/** "same": the host returned the token that is already stored. "skipped": not asked (hub mode). */
export type PairOutcome = "already_paired" | "paired" | "same" | "failed" | "skipped";

export class Pairing {
  private inFlight: Promise<PairOutcome> | null = null;
  private repairedFor: string | null = null;
  private _lastError: string | null = null;
  private autoAttempted = false;

  constructor(private readonly deps: PairingDeps) {}

  /** Why the last attempt failed (null after a success). Never contains the token. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Pair if no token is stored. */
  async ensurePaired(): Promise<PairOutcome> {
    if (await this.deps.loadToken()) return "already_paired";
    const mode = (await this.deps.loadModeSetting?.()) ?? "daemon";
    if (mode === "hub" || mode === "online") return "skipped";
    if (mode === "auto") {
      if (this.autoAttempted) return "skipped";
      this.autoAttempted = true;
    }
    return this.pair(null);
  }

  /**
   * The daemon rejected `rejectedToken` (close code 4401). Ask the host once for this token; true if
   * a different token was stored.
   */
  async repair(rejectedToken: string | null): Promise<boolean> {
    if (rejectedToken === null || this.repairedFor === rejectedToken) return false;
    const mode = await this.deps.loadModeSetting?.();
    if (mode === "hub" || mode === "online") return false;
    this.repairedFor = rejectedToken;
    return (await this.pair(rejectedToken)) === "paired";
  }

  private pair(current: string | null): Promise<PairOutcome> {
    if (!this.inFlight) {
      this.inFlight = this.request(current).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async request(current: string | null): Promise<PairOutcome> {
    let response: unknown;
    try {
      response = await this.deps.sendNativeMessage(NATIVE_HOST_NAME, { type: "get_token" });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return "failed";
    }
    const token = (response as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.trim().length < 32) {
      const error = (response as { error?: unknown } | null)?.error;
      this._lastError = typeof error === "string" ? error : "unexpected reply from the pairing host";
      return "failed";
    }
    this._lastError = null;
    if (token.trim() === current) return "same";
    await this.deps.saveToken(token.trim());
    return "paired";
  }
}
