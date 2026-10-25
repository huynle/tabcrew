/**
 * Connect-out WebSocket bridge to the TabCrew daemon or hub. Runs in the offscreen document so a
 * blocked socket can never freeze the service worker.
 *
 * Daemon mode (a launchd daemon with a token):
 * - Sends `hello` (protocol 2 + token, `features: ["groups"]`) as the first frame; the daemon answers `welcome`
 *   or closes with 4401 if the token is wrong.
 * - No token → status `needs_token`, no connection. 4401 → status `unauthorized` and no
 *   retries until the config changes.
 *
 * Hub mode (no token; trust-on-first-use pin, see shared/src/v2.ts):
 * - `hello` carries `mode: "hub"`, `features: ["model_call", "groups"]` and the pin: `{state:"new", secret}`
 *   until a hub stored the secret, `{state:"pinned", nonce_e}` afterwards.
 * - `new` must be answered by `welcome.pin = {state:"stored"}`; `pinned` by a challenge whose
 *   `hub_proof` (HMAC-SHA256, WebCrypto) is checked before anything else happens, then `auth` is
 *   sent. Until then every other frame is dropped (no request, model_call or ping is handled).
 * - A wrong or missing answer, or close code 4403 → status `untrusted_hub` and no retries until the
 *   config (pin, mode, port) changes. Reconnect backoff is capped at 3 s (hubs restart on demand).
 * - A later `welcome` on a verified socket is treated as a session refresh (`onWelcome` again).
 *
 * Online mode (TabCrew Online relay, see online.ts):
 * - Dials `config.online.url` (wss://<relay>/ext) and sends `hello` with the short-lived access token
 *   and `features: ["model_call", "groups"]`; the relay checks the token and answers `welcome`.
 * - No account → status `signed_out`, no connection. 4401 → `unauthorized` until a new token
 *   arrives (the service worker refreshes it and reconfigures).
 * - `model_call`s are handled as in hub mode (the user's own provider settings).
 *
 * All modes:
 * - Answers `ping` itself. `request` frames are handed to `onRequest` (the service-worker relay)
 *   without waiting: there is no queue here. Per-tab ordering is the daemon's job.
 * - A response (or model_result) is written only to the socket its request arrived on.
 * - Reconnects with exponential backoff (capped at 30 s in daemon mode). The keepalive alarm also
 *   calls `ensureConnected()` in case timers were throttled.
 */

import {
  V2_CLOSE_BAD_HELLO,
  V2_EXT_FEATURE_ACCOUNT_MODEL,
  V2_EXT_FEATURE_OWN_MODEL,
  V2_CLOSE_PIN_MISMATCH,
  V2_EXT_FEATURE_GROUPS,
  V2_EXT_FEATURE_MODEL_CALL,
  V2_PIN_NONCE_BYTES,
  V2_PROTOCOL_VERSION,
  v2ExtProofInput,
  v2HubProofInput,
  v2ParseModelCall,
  v2ProofEquals,
  v2WelcomePin,
  type V2DaemonFrame,
  type V2Event,
  type V2ExtRequest,
  type V2ExtResponse,
  type V2ExtensionFrame,
  type V2HelloPin,
  type V2ModelCall,
  type V2ModelResult,
  type V2Request,
  type V2Response,
  type V2Welcome,
} from "@tabcrew/shared/v2";
import { randomHex, type BridgeConfig, type BridgeStatus, type ConnectionMode } from "./config.js";
import type { BridgeStats } from "./relay-protocol.js";

export const UNAUTHORIZED_CLOSE_CODE = V2_CLOSE_BAD_HELLO;
export const PIN_MISMATCH_CLOSE_CODE = V2_CLOSE_PIN_MISMATCH;
export const MAX_BACKOFF_MS = 30_000;
/** Hub mode reconnects faster: a hub is spawned on demand and the agent is waiting for the browser. */
export const HUB_MAX_BACKOFF_MS = 3_000;
export const SLOW_SEND_MS = 200;
const BASE_BACKOFF_MS = 1_000;
/**
 * The daemon, hub and relay ping every 20 s. A connection that delivers nothing for this long is
 * dead even if it never closed (a broken path can leave the socket "open" for ~10 minutes, until
 * the OS gives up on TCP): drop it and reconnect.
 */
export const SILENCE_MS = 60_000;
export const SILENT_CLOSE_CODE = 4000;
const OPEN = 1;

/** HMAC-SHA256 (WebCrypto) with the hex-decoded `secretHex` as key over the UTF-8 `message`; lowercase hex. */
export async function hmacSha256Hex(secretHex: string, message: string): Promise<string> {
  const keyBytes = new Uint8Array(secretHex.length / 2);
  for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  /** Called once per connection after `welcome` (status is already `connected`); hub mode: after the pin check. */
  onWelcome(welcome: V2Welcome): void;
  /** The daemon's answer to an `ext_request`, or a local failure when the connection dropped. */
  onExtResponse?(response: V2ExtResponse): void;
  /** Hub mode: a verified, sanitized `model_call`; answer later with `sendModelResult`. Must not block. */
  onModelCall?(call: V2ModelCall): void;
  /** Hub mode: the hub stored this pin secret (`welcome.pin = {state:"stored"}`); persist it as confirmed. */
  onHubPinStored?(secret: string): void;
  /** Called after each ping has been answered. */
  onPing?(): void;
  onStatus?(status: BridgeStatus): void;
  /** Monotonic milliseconds, for send timing. */
  now?(): number;
}

/** What the current socket is: its mode, the config it was opened with, and (hub) the pin handshake state. */
interface Connection {
  readonly mode: ConnectionMode;
  /** Identifies the credentials (token or pin secret) the socket was opened with. */
  readonly key: string;
  readonly token: string | null;
  readonly secret: string | null;
  /** Where the socket dials. */
  readonly url: string;
  /** Hub mode: the pin sent in `hello` (set when the socket opens). */
  pin: V2HelloPin | null;
  /** Hub mode: "pending" until welcome, "verifying" while the proof is checked, "ok" once trusted. */
  auth: "pending" | "verifying" | "ok";
  /** Online mode: the user chose this browser's own model provider (announces own_model). */
  readonly ownModel?: boolean;
}

/** A refusal that stops retries until the config changes. */
interface Blocked {
  readonly key: string;
  readonly status: "unauthorized" | "untrusted_hub";
}

export class Bridge {
  private socket: SocketLike | null = null;
  private welcomed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket was opened or last delivered a frame (`now()`). */
  private lastFrameAt = 0;
  private attempts = 0;
  private generation = 0;
  private blocked: Blocked | null = null;
  /** A pin secret a hub stored during this document's life (the service worker may not have confirmed it yet). */
  private storedSecret: string | null = null;
  private _status: BridgeStatus = "offline";
  /** Request ids received on the current socket and not answered yet. */
  private pending = new Set<string>();
  /** model_call ids received on the current socket and not answered yet. */
  private modelPending = new Set<string>();
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
    let conn: Connection;
    if (config.mode === "online") {
      if (!config.online) {
        this.setStatus("signed_out");
        return;
      }
      const { url, accessToken } = config.online;
      const ownModel = config.online.ownModel === true;
      conn = { mode: "online", key: `online|${url}|${accessToken}|${ownModel}`, token: accessToken, secret: null, url, pin: null, auth: "ok", ownModel };
    } else if (config.mode === "hub") {
      // The service worker creates the pin before pushing a hub config; without one there is nothing to send.
      if (!config.hubPin) {
        this.setStatus("offline");
        return;
      }
      const { secret } = config.hubPin;
      conn = { mode: "hub", key: `hub|${secret}`, token: null, secret, url: `ws://127.0.0.1:${config.port}`, pin: null, auth: "pending" };
    } else {
      if (!config.token) {
        this.setStatus("needs_token");
        return;
      }
      conn = {
        mode: "daemon",
        key: `daemon|${config.token}`,
        token: config.token,
        secret: null,
        url: `ws://127.0.0.1:${config.port}`,
        pin: null,
        auth: "ok",
      };
    }
    if (this.blocked !== null && this.blocked.key === conn.key) {
      this.setStatus(this.blocked.status);
      return;
    }
    this.blocked = null;
    this.open(conn, config.hubPin?.confirmed === true);
  }

  /** Alarm/wake hook: reconnect if nothing is connected or pending. */
  ensureConnected(): Promise<void> {
    if (this.socket && this.now() - this.lastFrameAt >= SILENCE_MS) {
      // The silence timer should have fired; offscreen timers can be throttled, the alarm is not.
      this.dropSilent(this.socket, null);
      this.clearTimer();
      return this.start();
    }
    if (this.socket || this.reconnectTimer !== null) return Promise.resolve();
    return this.start();
  }

  /** Token, port, mode or pin changed: drop the current connection and start over. */
  reconfigure(): Promise<void> {
    this.clearTimer();
    this.attempts = 0;
    this.blocked = null;
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

  /** Answer a hub `model_call`. Dropped (returns false) if it did not arrive on the current socket. */
  sendModelResult(result: V2ModelResult): boolean {
    if (!this.socket || !this.modelPending.delete(result.id)) return false;
    return this.sendOn(this.socket, result);
  }

  private open(conn: Connection, pinConfirmed: boolean): void {
    // Hub mode: stay "offline" while retrying, so the popup shows a steady "hub not running".
    if (conn.mode !== "hub" || this.attempts === 0) this.setStatus("connecting");
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(conn.url);
    } catch (err) {
      console.warn("[v2 bridge] connect failed:", err);
      this.setStatus("offline");
      this.scheduleReconnect(conn.mode);
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    this.pending.clear();
    this.modelPending.clear();
    this.heard(socket, conn.mode);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.sendOn(socket, this.hello(conn, pinConfirmed));
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.heard(socket, conn.mode);
      this.handleRaw(socket, conn, ev.data);
    };
    socket.onerror = () => {
      // onclose follows and handles reconnects.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.clearSilence();
      this.socket = null;
      this.welcomed = false;
      this.pending.clear();
      this.modelPending.clear();
      this.failExtPending();
      if (ev.code === UNAUTHORIZED_CLOSE_CODE) {
        this.block(conn, "unauthorized");
        return;
      }
      if (conn.mode === "hub" && ev.code === PIN_MISMATCH_CLOSE_CODE) {
        this.block(conn, "untrusted_hub");
        return;
      }
      this.setStatus("offline");
      this.scheduleReconnect(conn.mode);
    };
  }

  private hello(conn: Connection, pinConfirmed: boolean): V2ExtensionFrame {
    if (conn.mode === "online") {
      return {
        type: "hello",
        protocol: V2_PROTOCOL_VERSION,
        token: conn.token ?? "",
        extension_version: this.deps.extensionVersion,
        features: [V2_EXT_FEATURE_MODEL_CALL, V2_EXT_FEATURE_GROUPS, V2_EXT_FEATURE_ACCOUNT_MODEL, ...(conn.ownModel ? [V2_EXT_FEATURE_OWN_MODEL] : [])],
      };
    }
    if (conn.mode === "daemon") {
      return {
        type: "hello",
        protocol: V2_PROTOCOL_VERSION,
        token: conn.token ?? "",
        extension_version: this.deps.extensionVersion,
        features: [V2_EXT_FEATURE_GROUPS],
      };
    }
    const secret = conn.secret!;
    const pinned = pinConfirmed || this.storedSecret === secret;
    conn.pin = pinned ? { state: "pinned", nonce_e: randomHex(V2_PIN_NONCE_BYTES) } : { state: "new", secret };
    return {
      type: "hello",
      protocol: V2_PROTOCOL_VERSION,
      extension_version: this.deps.extensionVersion,
      mode: "hub",
      features: [V2_EXT_FEATURE_MODEL_CALL, V2_EXT_FEATURE_GROUPS],
      pin: conn.pin,
    };
  }

  private handleRaw(socket: SocketLike, conn: Connection, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: V2DaemonFrame;
    try {
      frame = JSON.parse(data) as V2DaemonFrame;
    } catch {
      console.warn("[v2 bridge] ignoring malformed frame");
      return;
    }
    if (conn.auth !== "ok") {
      // Hub mode before the pin check passed: only the first welcome is looked at.
      if (frame?.type === "welcome" && conn.auth === "pending") {
        conn.auth = "verifying";
        void this.acceptHubWelcome(socket, conn, frame);
      } else {
        console.warn("[v2 bridge] dropping frame before the hub is verified:", (frame as { type?: unknown })?.type);
      }
      return;
    }
    switch (frame?.type) {
      case "welcome":
        if (conn.mode === "hub" && this.welcomed) {
          // A verified hub re-sent its sessions: reconcile again.
          this.notify(() => this.deps.onWelcome(frame));
          break;
        }
        this.completeWelcome(frame);
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
      case "model_call":
        if (conn.mode === "daemon") {
          console.warn("[v2 bridge] ignoring model_call in daemon mode");
          return;
        }
        this.handleModelCall(socket, frame);
        break;
      default:
        console.warn("[v2 bridge] unknown frame type:", (frame as { type?: unknown })?.type);
    }
  }

  private handleModelCall(socket: SocketLike, frame: unknown): void {
    const call = v2ParseModelCall(frame);
    if (!call) {
      const id = (frame as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0 && id.length <= 100) {
        this.sendOn(socket, { type: "model_result", id, ok: false, error: { code: "model_error", message: "malformed model_call" } });
      }
      return;
    }
    this.modelPending.add(call.id);
    this.notify(() => this.deps.onModelCall?.(call));
  }

  /** Hub mode: check the welcome's pin answer; only then is the connection usable. */
  private async acceptHubWelcome(socket: SocketLike, conn: Connection, welcome: V2Welcome): Promise<void> {
    const sent = conn.pin;
    const secret = conn.secret;
    const answer = v2WelcomePin(welcome);
    try {
      if (!sent || !secret) throw new Error("no pin was sent");
      if (sent.state === "new") {
        if (answer?.state !== "stored") throw new Error("the hub did not store the pin");
        this.storedSecret = secret;
        this.notify(() => this.deps.onHubPinStored?.(secret));
      } else {
        if (answer?.state !== "challenge") throw new Error("the hub did not answer the pin challenge");
        const nonces = { nonce_e: sent.nonce_e, nonce_h: answer.nonce_h };
        const expected = await hmacSha256Hex(secret, v2HubProofInput(nonces));
        if (this.socket !== socket) return;
        if (!v2ProofEquals(expected, answer.hub_proof)) throw new Error("wrong hub proof");
        const ext_proof = await hmacSha256Hex(secret, v2ExtProofInput(nonces));
        if (this.socket !== socket) return;
        if (!this.sendOn(socket, { type: "auth", ext_proof })) return;
      }
    } catch (err) {
      if (this.socket !== socket) return;
      console.warn("[v2 bridge] untrusted hub:", err instanceof Error ? err.message : err);
      this.dropSocket(PIN_MISMATCH_CLOSE_CODE, "untrusted hub");
      this.block(conn, "untrusted_hub");
      return;
    }
    if (this.socket !== socket) return;
    conn.auth = "ok";
    this.completeWelcome(welcome);
  }

  private completeWelcome(welcome: V2Welcome): void {
    this.welcomed = true;
    this.attempts = 0;
    this.setStatus("connected");
    this.notify(() => this.deps.onWelcome(welcome));
  }

  private block(conn: Connection, status: Blocked["status"]): void {
    this.blocked = { key: conn.key, status };
    this.setStatus(status);
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
    const started = this.now();
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      console.warn("[v2 bridge] send failed:", err);
      return false;
    } finally {
      this.recordSend(this.now() - started);
    }
  }

  private recordSend(ms: number): void {
    this.sendStats.sends++;
    if (ms > SLOW_SEND_MS) this.sendStats.slow_sends_over_200ms++;
    if (ms > this.sendStats.max_send_ms) this.sendStats.max_send_ms = Math.round(ms);
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }

  /** The socket is alive (opened or delivered a frame): restart its silence timer. */
  private heard(socket: SocketLike, mode: ConnectionMode): void {
    this.lastFrameAt = this.now();
    this.clearSilence();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.socket === socket) this.dropSilent(socket, mode);
    }, SILENCE_MS);
  }

  /** Drop a socket that went silent; `mode` schedules the usual backoff reconnect (null: the caller reconnects). */
  private dropSilent(socket: SocketLike, mode: ConnectionMode | null): void {
    console.warn(`[v2 bridge] nothing received for ${SILENCE_MS / 1000} s; reconnecting`);
    if (this.socket !== socket) return;
    this.dropSocket(SILENT_CLOSE_CODE, "silent");
    this.setStatus("offline");
    if (mode) this.scheduleReconnect(mode);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private scheduleReconnect(mode: ConnectionMode): void {
    if (this.reconnectTimer !== null) return;
    const cap = mode === "hub" ? HUB_MAX_BACKOFF_MS : MAX_BACKOFF_MS;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempts, cap);
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

  private dropSocket(code = 1000, reason = "reconfigure"): void {
    const socket = this.socket;
    this.clearSilence();
    this.socket = null;
    this.welcomed = false;
    this.pending.clear();
    this.modelPending.clear();
    this.failExtPending();
    if (socket) {
      try {
        socket.close(code, reason);
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
