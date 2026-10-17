/**
 * The service-worker side of the bridge. The daemon socket lives in the offscreen document; this
 * relay receives its requests over the `v2-bridge` port, runs them concurrently (no queue), and
 * posts responses and events back. It also mirrors the socket status for the popup.
 */

import type { V2Event, V2ExtOp, V2ExtOpMap, V2ExtResponse, V2Request, V2Response, V2Welcome } from "@tabcrew/shared/v2";
import type { BridgeConfig, BridgeStatus } from "./config.js";
import { toWireError } from "./errors.js";
import type { PortLike, ToOffscreen, ToServiceWorker } from "./relay-protocol.js";

export const RECHECK_OFFSCREEN_MS = 1_000;
/** How long a popup request to the daemon (settings) may take; the OpenRouter key check takes up to 10 s. */
export const DAEMON_REQUEST_TIMEOUT_MS = 15_000;

interface PendingDaemonRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RelayDeps {
  loadConfig(): Promise<BridgeConfig>;
  handleRequest(req: V2Request): Promise<unknown>;
  /** Called after each daemon `welcome`. Use it to reconcile and send `groups`. */
  onWelcome(welcome: V2Welcome): Promise<void> | void;
  /** Create the offscreen document if it is missing. */
  ensureOffscreen(): Promise<void>;
  /** The offscreen socket status changed (e.g. to "unauthorized"). */
  onStatus?(status: BridgeStatus): void;
}

export class BridgeRelay {
  private port: PortLike | null = null;
  private _status: BridgeStatus = "offline";
  private readonly daemonPending = new Map<string, PendingDaemonRequest>();

  constructor(private readonly deps: RelayDeps) {}

  get status(): BridgeStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this.port !== null && this._status === "connected";
  }

  /** A `v2-bridge` port opened by the offscreen document. Replaces any previous one. */
  attach(port: PortLike): void {
    const previous = this.port;
    this.port = port;
    if (previous) {
      try {
        previous.disconnect();
      } catch {
        // ignore
      }
    }
    port.onMessage.addListener((message) => {
      if (this.port === port) this.handle(message as ToServiceWorker);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this._status = "offline";
      this.failDaemonRequests("connection to the TabCrew daemon was lost");
      // The document may be closing or gone: recreate it (once now, once after it has settled).
      void this.ensure();
      setTimeout(() => void this.ensure(), RECHECK_OFFSCREEN_MS);
    });
    void this.pushConfig(false);
  }

  /** Startup / alarm hook: make sure the offscreen document exists and its socket is trying. */
  async ensure(): Promise<void> {
    try {
      await this.deps.ensureOffscreen();
    } catch (err) {
      console.warn("[v2 relay] offscreen document unavailable:", err);
      return;
    }
    this.post({ type: "ensure" });
  }

  /** Send the current token/port to the offscreen document. `reconfigure` forces a reconnect. */
  async pushConfig(reconfigure: boolean): Promise<void> {
    const config = await this.deps.loadConfig();
    this.post({ type: "config", token: config.token, port: config.port, reconfigure });
  }

  /** Send an unsolicited event. Dropped (returns false) if not connected; the daemon resyncs via `groups`. */
  sendEvent(event: V2Event): boolean {
    if (!this.isReady) return false;
    return this.post({ type: "frame", frame: event });
  }

  /**
   * Ask the daemon something on the popup's behalf (relayed through the offscreen socket).
   * Nothing about the request is stored or logged here: settings_set may carry an API key.
   */
  daemonRequest<K extends V2ExtOp>(
    op: K,
    args: V2ExtOpMap[K]["args"],
    timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
  ): Promise<V2ExtOpMap[K]["result"]> {
    if (!this.isReady) return Promise.reject(new Error("not connected to the TabCrew daemon"));
    const id = crypto.randomUUID();
    return new Promise<V2ExtOpMap[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.daemonPending.delete(id)) reject(new Error(`the TabCrew daemon did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.daemonPending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      if (!this.post({ type: "ext_request", request: { type: "ext_request", id, op, args } })) {
        this.settleDaemonRequest({
          type: "ext_response",
          id,
          ok: false,
          error: { code: "extension_offline", message: "not connected to the TabCrew daemon" },
        });
      }
    });
  }

  private settleDaemonRequest(response: V2ExtResponse): void {
    const entry = typeof response?.id === "string" ? this.daemonPending.get(response.id) : undefined;
    if (!entry) return;
    this.daemonPending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error?.message || "the TabCrew daemon refused the request"));
  }

  private failDaemonRequests(message: string): void {
    for (const [id, entry] of this.daemonPending) {
      this.daemonPending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
  }

  private handle(message: ToServiceWorker): void {
    switch (message?.type) {
      case "status":
        if (this._status !== message.status) {
          this._status = message.status;
          if (message.status !== "connected") this.failDaemonRequests("connection to the TabCrew daemon was lost");
          this.deps.onStatus?.(message.status);
        }
        break;
      case "welcome":
        void Promise.resolve()
          .then(() => this.deps.onWelcome(message.welcome))
          .catch((err) => console.warn("[v2 relay] welcome handling failed:", err));
        break;
      case "request":
        void this.dispatch(message.request);
        break;
      case "ext_response":
        this.settleDaemonRequest(message.response);
        break;
      case "keepalive":
        break;
      default:
        console.warn("[v2 relay] unknown port message:", (message as { type?: unknown })?.type);
    }
  }

  private async dispatch(req: V2Request): Promise<void> {
    if (typeof req?.id !== "string") return;
    let response: V2Response;
    if (!req.session || typeof req.session.short_id !== "string" || typeof req.op !== "string") {
      response = {
        type: "response",
        id: req.id,
        ok: false,
        error: { code: "invalid_args", message: "request needs op and session.short_id" },
      };
    } else {
      try {
        const result = await this.deps.handleRequest(req);
        response = { type: "response", id: req.id, ok: true, result } as V2Response;
      } catch (err) {
        response = { type: "response", id: req.id, ok: false, error: toWireError(err) };
      }
    }
    this.post({ type: "frame", frame: response });
  }

  private post(message: ToOffscreen): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch (err) {
      console.warn("[v2 relay] post failed:", err);
      return false;
    }
  }
}
