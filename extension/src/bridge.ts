/**
 * Connect-out WebSocket bridge to the TabCrew daemon. Runs in the offscreen document so a
 * blocked socket can never freeze the service worker.
 *
 * - Sends `hello` (protocol 2 + token) as the first frame; the daemon answers `welcome`
 *   or closes with 4401 if the token is wrong.
 * - Answers `ping` itself. `request` frames are handed to `onRequest` (the service-worker relay)
 *   without waiting: there is no queue here. Per-tab ordering is the daemon's job.
 * - A response is written only to the socket its request arrived on.
 * - Reconnects with exponential backoff (capped at 30 s). The keepalive alarm also calls
 *   `ensureConnected()` in case timers were throttled.
 * - No token → status `needs_token`, no connection. 4401 → status `unauthorized` and no
 *   retries until the token changes.
 */

import {
  V2_PROTOCOL_VERSION,
  type V2DaemonFrame,
  type V2Event,
  type V2ExtRequest,
  type V2ExtResponse,
  type V2ExtensionFrame,
  type V2Request,
  type V2Response,
  type V2Welcome,
} from "@tabcrew/shared/v2";
import type { BridgeConfig, BridgeStatus } from "./config.js";
import type { BridgeStats } from "./relay-protocol.js";

export const UNAUTHORIZED_CLOSE_CODE = 4401;
export const MAX_BACKOFF_MS = 30_000;
export const SLOW_SEND_MS = 200;
const BASE_BACKOFF_MS = 1_000;
const OPEN = 1;

/** The subset of the browser WebSocket used here (lets tests inject a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BridgeDeps {
  loadConfig(): Promise<BridgeConfig>;
  createSocket(url: string): SocketLike;
  extensionVersion: string;
  /** A daemon request; answer later with `sendResponse`. Must not block. */
  onRequest(req: V2Request): void;
  /** Called once per connection after `welcome` (status is already `connected`). */
  onWelcome(welcome: V2Welcome): void;
  /** The daemon's answer to an `ext_request`, or a local failure when the connection dropped. */
  onExtResponse?(response: V2ExtResponse): void;
  /** Called after each ping has been answered. */
  onPing?(): void;
  onStatus?(status: BridgeStatus): void;
  /** Monotonic milliseconds, for send timing. */
  now?(): number;
}

export class Bridge {
  private socket: SocketLike | null = null;
  private welcomed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private generation = 0;
  private unauthorizedToken: string | null = null;
  private _status: BridgeStatus = "offline";
  /** Request ids received on the current socket and not answered yet. */
  private pending = new Set<string>();
  /** ext_request ids sent on the current socket and not answered yet. */
  private extPending = new Set<string>();
  private sendStats = { sends: 0, slow_sends_over_200ms: 0, max_send_ms: 0 };

  constructor(private readonly deps: BridgeDeps) {}

  get status(): BridgeStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this.welcomed && this.socket !== null && this.socket.readyState === OPEN;
  }

  stats(): BridgeStats {
    return { ...this.sendStats };
  }

  /** Read config and connect if possible. Supersedes any start in progress. */
  async start(): Promise<void> {
    const gen = ++this.generation;
    const config = await this.deps.loadConfig();
    if (gen !== this.generation) return;
    if (this.socket) return;
    if (!config.token) {
      this.setStatus("needs_token");
      return;
    }
    if (this.unauthorizedToken !== null && config.token === this.unauthorizedToken) {
      this.setStatus("unauthorized");
      return;
    }
    this.unauthorizedToken = null;
    this.open(config.token, config.port);
  }

  /** Alarm/wake hook: reconnect if nothing is connected or pending. */
  ensureConnected(): Promise<void> {
    if (this.socket || this.reconnectTimer !== null) return Promise.resolve();
    return this.start();
  }

  /** Token or port changed: drop the current connection and start over. */
  reconfigure(): Promise<void> {
    this.clearTimer();
    this.attempts = 0;
    this.unauthorizedToken = null;
    this.dropSocket();
    return this.start();
  }

  /** Send an unsolicited event. Dropped (returns false) if not connected; the daemon resyncs via `groups`. */
  sendEvent(event: V2Event): boolean {
    if (!this.isReady || !this.socket) return false;
    return this.sendOn(this.socket, event);
  }

  /** Send an extension -> daemon request. Returns false (nothing sent) if not connected. */
  sendExtRequest(request: V2ExtRequest): boolean {
    if (!this.isReady || !this.socket) return false;
    if (!this.sendOn(this.socket, request)) return false;
    this.extPending.add(request.id);
    return true;
  }

  /** Answer a request. Dropped (returns false) if it did not arrive on the current socket. */
  sendResponse(response: V2Response): boolean {
    if (!this.socket || !this.pending.delete(response.id)) return false;
    return this.sendOn(this.socket, response);
  }

  private open(token: string, port: number): void {
    this.setStatus("connecting");
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(`ws://127.0.0.1:${port}`);
    } catch (err) {
      console.warn("[v2 bridge] connect failed:", err);
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    this.pending.clear();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.sendOn(socket, {
        type: "hello",
        protocol: V2_PROTOCOL_VERSION,
        token,
        extension_version: this.deps.extensionVersion,
      });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleRaw(socket, ev.data);
    };
    socket.onerror = () => {
      // onclose follows and handles reconnects.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.welcomed = false;
      this.pending.clear();
      this.failExtPending();
      if (ev.code === UNAUTHORIZED_CLOSE_CODE) {
        this.unauthorizedToken = token;
        this.setStatus("unauthorized");
        return;
      }
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private handleRaw(socket: SocketLike, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: V2DaemonFrame;
    try {
      frame = JSON.parse(data) as V2DaemonFrame;
    } catch {
      console.warn("[v2 bridge] ignoring malformed frame");
      return;
    }
    switch (frame?.type) {
      case "welcome":
        this.welcomed = true;
        this.attempts = 0;
        this.setStatus("connected");
        this.notify(() => this.deps.onWelcome(frame));
        break;
      case "ping":
        this.sendOn(socket, { type: "pong", t: frame.t });
        this.notify(() => this.deps.onPing?.());
        break;
      case "ext_response":
        if (typeof frame.id !== "string" || !this.extPending.delete(frame.id)) return;
        this.notify(() => this.deps.onExtResponse?.(frame));
        break;
      case "request":
        if (typeof frame.id !== "string") return;
        this.pending.add(frame.id);
        this.notify(() => this.deps.onRequest(frame));
        break;
      default:
        console.warn("[v2 bridge] unknown frame type:", (frame as { type?: unknown })?.type);
    }
  }

  private failExtPending(): void {
    const ids = [...this.extPending];
    this.extPending.clear();
    for (const id of ids) {
      this.notify(() =>
        this.deps.onExtResponse?.({
          type: "ext_response",
          id,
          ok: false,
          error: { code: "extension_offline", message: "connection to the TabCrew daemon was lost" },
        }),
      );
    }
  }

  private notify(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn("[v2 bridge] handler failed:", err);
    }
  }

  private sendOn(socket: SocketLike, frame: V2ExtensionFrame): boolean {
    if (socket !== this.socket || socket.readyState !== OPEN) return false;
    const now = this.deps.now ?? (() => performance.now());
    const started = now();
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      console.warn("[v2 bridge] send failed:", err);
      return false;
    } finally {
      this.recordSend(now() - started);
    }
  }

  private recordSend(ms: number): void {
    this.sendStats.sends++;
    if (ms > SLOW_SEND_MS) this.sendStats.slow_sends_over_200ms++;
    if (ms > this.sendStats.max_send_ms) this.sendStats.max_send_ms = Math.round(ms);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.pending.clear();
    this.failExtPending();
    if (socket) {
      try {
        socket.close(1000, "reconfigure");
      } catch {
        // ignore
      }
    }
  }

  private setStatus(status: BridgeStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.deps.onStatus?.(status);
  }
}
