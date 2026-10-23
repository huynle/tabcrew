import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  V2_CLOSE_PIN_MISMATCH,
  V2_EXT_FEATURE_GROUPS,
  V2_EXT_FEATURE_MODEL_CALL,
  V2_FEATURE_HUB,
  V2_MODEL_CALL_MAX_TIMEOUT_MS,
  V2_FEATURE_SETTINGS,
  V2_PIN_NONCE_BYTES,
  V2_PROTOCOL_VERSION,
  v2AuthProof,
  v2ExtProofInput,
  v2HelloFeatures,
  v2HelloPin,
  v2HubProofInput,
  v2IsExtOp,
  v2IsPinSecret,
  v2ParseModelResult,
  v2ProofEquals,
  type V2DaemonFrame,
  type V2Event,
  type V2ExtOp,
  type V2ExtResponse,
  type V2HelloFeatures,
  type V2ModelCall,
  type V2ModelCallBody,
  type V2ModelPurpose,
  type V2Op,
  type V2OpMap,
  type V2SessionRef,
  type V2Welcome,
  type V2WelcomePin,
} from "@tabcrew/shared/v2";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DaemonError, fromWireError, toV2Error } from "./errors.js";
import { ModelUnavailableError } from "./jev/decisions.js";
import { extensionOriginAllowed, hostAllowed, hubOriginAllowed } from "./localhost.js";
import { log } from "./log.js";
import { pinProof, type PinStore } from "./pin.js";
import { safeEqual } from "./token.js";

/** Ops whose effect may have happened even if no response arrives. */
export const MUTATING_OPS: ReadonlySet<V2Op> = new Set<V2Op>([
  "tab_create",
  "tab_close",
  "session_close",
  "session_release",
  "group_rename",
  "act",
  "navigate",
]);

/** Ops only extensions announcing the shared-groups feature understand. */
const GROUP_OPS: ReadonlySet<V2Op> = new Set<V2Op>(["group_rename", "group_list"]);

export const GROUPS_UNSUPPORTED_MESSAGE =
  "the connected TabCrew extension does not support named tab groups; ask the user to update the TabCrew extension and reload it";

/** The session ref as an extension sees it: `group` only for extensions that understand it. */
function refFor(session: V2SessionRef, groups: boolean): V2SessionRef {
  return groups && session.group !== undefined
    ? { short_id: session.short_id, label: session.label, group: session.group }
    : { short_id: session.short_id, label: session.label };
}

export const CLOSE_BAD_HELLO = 4401;
export const CLOSE_PIN_MISMATCH = V2_CLOSE_PIN_MISMATCH;
export const CLOSE_REPLACED = 4409;
/** Close code when the hub cannot read or write its pin store (standard "internal error"). */
export const CLOSE_INTERNAL = 1011;

/**
 * How the extension socket authenticates:
 * - `token`: daemon mode, the shared token in `hello` (Origin optional, any chrome-extension:// id).
 * - `hub`: hub mode, Origin must be one of `allowedOrigins` (normalized), plus the TOFU pin of
 *   `hello.pin` / `auth` against `pinStore` (see shared/v2).
 * - `relay`: Online mode. The relay runs the socket server and authenticates the extension itself,
 *   then hands the socket and its hello to `attach`; the bridge only checks the protocol version.
 */
export type BridgeAuth =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "hub"; readonly allowedOrigins: readonly string[]; readonly pinStore: PinStore }
  | { readonly kind: "relay" };

export type BridgeOptions = BridgeCommonOptions &
  (
    | { readonly token: string; readonly auth?: undefined }
    | { readonly auth: BridgeAuth; readonly token?: undefined }
  );

/** Why a model call got no provider reply. */
export type ModelCallUnavailableReason =
  /** No extension connected within `offlineWaitMs`. */
  | "offline"
  /** The extension connection went away (or the bridge closed) while the call was in flight. */
  | "disconnected"
  /** No `model_result` within the call's timeout (plus `modelCallGraceMs`). */
  | "timeout"
  /** The extension answered `ok:false` `model_error` (network/TLS failure, its own timeout, permission). */
  | "provider";

/**
 * A model call through the extension produced no provider reply. A `ModelUnavailableError` (code
 * `model_error`), so the Jev clients classify it like an unreachable provider.
 */
export class ModelCallUnavailableError extends ModelUnavailableError {
  constructor(
    readonly reason: ModelCallUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "ModelCallUnavailableError";
  }
}

/** The provider's reply to a model call, whatever its HTTP status (the caller maps statuses). */
export interface ModelCallResult {
  readonly status: number;
  /** Parsed reply body, or null when it was not JSON. */
  readonly json: unknown;
  /** The model the extension called (from its settings). */
  readonly model: string;
}

export const MODEL_CALL_UNSUPPORTED_MESSAGE =
  "the connected TabCrew extension cannot make model calls; update the TabCrew extension and reload it";

export interface BridgeCommonOptions {
  /** Port of the bridge's own socket server (`start`); not used by relay bridges. */
  readonly port?: number;
  readonly host?: string;
  /** How long a request waits for an extension to connect. Default 10 s. */
  readonly offlineWaitMs?: number;
  readonly helloTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly defaultRequestTimeoutMs?: number;
  /** Extra time a model call waits for `model_result` beyond the `timeout_ms` the extension enforces. Default 1 s. */
  readonly modelCallGraceMs?: number;
  /** Sessions announced in `welcome`. */
  readonly sessions: () => readonly V2SessionRef[];
  readonly onEvent?: (event: V2Event) => void;
  readonly onConnect?: () => void;
  /** Extension -> daemon requests (`ext_request`, popup settings). Throw a DaemonError to answer ok:false. */
  readonly onExtRequest?: (op: V2ExtOp, args: unknown) => Promise<unknown>;
  /** Announced in `welcome` so the extension can tell an outdated service apart. */
  readonly daemonVersion?: string;
}

interface PendingModelCall {
  readonly socket: WebSocket;
  readonly resolve: (value: ModelCallResult) => void;
  readonly reject: (err: DaemonError) => void;
  readonly timer: NodeJS.Timeout;
}

interface Pending {
  readonly op: V2Op;
  readonly socket: WebSocket;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: DaemonError) => void;
  readonly timer: NodeJS.Timeout;
  readonly sentAt: number;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function lostError(op: V2Op, why: string): DaemonError {
  return MUTATING_OPS.has(op)
    ? new DaemonError("outcome_unknown", `${why} while ${op} was in flight; check state before doing anything else`)
    : new DaemonError("extension_offline", `${why}; retry later`);
}

/**
 * WebSocket server for the TabCrew extension. One extension connection at a time; requests are
 * matched by id and may run concurrently (there is no global queue).
 */
export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private active: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly pendingModel = new Map<string, PendingModelCall>();
  private waiters = new Set<() => void>();
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private extensionVersion: string | null = null;
  private extensionFeatures: readonly string[] = [];
  private readonly auth: BridgeAuth;
  /** Serializes pin store reads/writes so racing first pairings cannot both win. */
  private pinLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BridgeOptions) {
    const auth = options.auth ?? (typeof options.token === "string" ? { kind: "token" as const, token: options.token } : null);
    if (!auth) throw new TypeError("ExtensionBridge needs a token or an auth option");
    this.auth = auth;
  }

  get connected(): boolean {
    return this.active?.readyState === WebSocket.OPEN;
  }

  get version(): string | null {
    return this.connected ? this.extensionVersion : null;
  }

  /** Features the connected extension announced in `hello` (empty when not connected). */
  get features(): readonly string[] {
    return this.connected ? this.extensionFeatures : [];
  }

  /** The connected extension understands shared groups (`group`, finish modes, group ops). */
  get supportsGroups(): boolean {
    return this.features.includes(V2_EXT_FEATURE_GROUPS);
  }

  get inFlight(): number {
    return this.pending.size;
  }

  async start(): Promise<number> {
    const auth = this.auth;
    if (auth.kind === "relay") throw new Error("a relay bridge has no socket server; the relay hands it sockets with attach()");
    if (this.options.port === undefined) throw new TypeError("ExtensionBridge.start() needs a port");
    const wss = new WebSocketServer({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port,
      maxPayload: 64 * 1024 * 1024,
      // Web pages must never reach this socket (the extension's origin is chrome-extension://), and
      // a rebound DNS name must not either. The token (daemon) or pin (hub) in the hello is still
      // required. A hub has no token, so it also requires the Origin of a known TabCrew extension.
      verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
        (auth.kind === "hub" ? hubOriginAllowed(origin, auth.allowedOrigins) : extensionOriginAllowed(origin)) &&
        hostAllowed(req.headers.host),
    });
    this.wss = wss;
    wss.on("connection", (socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("error", (err) => log.error(`extension bridge error: ${err.message}`));
    return (wss.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.stopPing();
    const socket = this.active;
    this.active = null;
    if (socket) this.failPending(socket, "daemon shutting down");
    if (!this.wss) {
      // Relay bridges own no server: close the attached socket here.
      socket?.close(1001, "shutting down");
      return;
    }
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    this.wss = null;
  }

  /**
   * Relay bridges: take over an extension socket the relay has already authenticated, with the
   * hello frame it read (protocol checked here; a bad hello closes it with 4401). A newer socket
   * replaces the current one, as with the bridge's own server.
   */
  attach(socket: WebSocket, hello: Record<string, unknown>): void {
    if (this.auth.kind !== "relay") throw new TypeError("attach() is only for relay bridges");
    if (socket.readyState !== WebSocket.OPEN) return;
    this.handleConnection(socket, hello);
  }

  /**
   * Send an op to the extension and resolve with its typed result. The session's `group` only
   * travels to an extension with the groups feature; group ops to other extensions are refused
   * (`invalid_args`, GROUPS_UNSUPPORTED_MESSAGE) without being sent.
   */
  async request<K extends V2Op>(
    session: V2SessionRef,
    op: K,
    args: V2OpMap[K]["args"],
    timeoutMs = this.options.defaultRequestTimeoutMs ?? 30_000,
  ): Promise<V2OpMap[K]["result"]> {
    const socket = await this.waitForConnection();
    const groups = this.extensionFeatures.includes(V2_EXT_FEATURE_GROUPS);
    if (GROUP_OPS.has(op) && !groups) throw new DaemonError("invalid_args", GROUPS_UNSUPPORTED_MESSAGE);
    const id = randomUUID();
    return new Promise<V2OpMap[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(lostError(op, `extension did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { op, socket, resolve: resolve as (v: unknown) => void, reject, timer, sentAt: performance.now() });
      const frame: V2DaemonFrame = { type: "request", id, op, session: refFor(session, groups), args };
      socket.send(JSON.stringify(frame), (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(lostError(op, "extension connection failed"));
        }
      });
    });
  }

  /**
   * Hub mode: ask the extension to call its configured model (`model_call`) and resolve with the
   * provider's reply, whatever its HTTP status. Rejects with `model_not_configured` (no provider in
   * the extension, or an extension without the model_call feature), `ModelCallUnavailableError`
   * (offline, disconnected, timeout, provider unreachable) or `model_error` (invalid model_result).
   */
  async modelCall(purpose: V2ModelPurpose, body: V2ModelCallBody, timeoutMs: number): Promise<ModelCallResult> {
    let socket: WebSocket;
    try {
      socket = await this.waitForConnection();
    } catch {
      throw new ModelCallUnavailableError("offline", "TabCrew extension is not connected; no model call made.");
    }
    if (!this.extensionFeatures.includes(V2_EXT_FEATURE_MODEL_CALL)) {
      throw new DaemonError("model_not_configured", MODEL_CALL_UNSUPPORTED_MESSAGE);
    }
    const timeout_ms = Math.min(V2_MODEL_CALL_MAX_TIMEOUT_MS, Math.max(1, Math.round(timeoutMs) || 1));
    const id = randomUUID();
    return new Promise<ModelCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingModel.delete(id)) reject(new ModelCallUnavailableError("timeout", "Model request timed out; no action executed."));
      }, timeout_ms + (this.options.modelCallGraceMs ?? 1_000));
      this.pendingModel.set(id, { socket, resolve, reject, timer });
      const frame: V2ModelCall = { type: "model_call", id, purpose, body, timeout_ms };
      socket.send(JSON.stringify(frame), (err) => {
        if (err && this.pendingModel.delete(id)) {
          clearTimeout(timer);
          reject(new ModelCallUnavailableError("disconnected", "TabCrew extension connection failed; no action executed."));
        }
      });
    });
  }

  private waitForConnection(): Promise<WebSocket> {
    if (this.connected) return Promise.resolve(this.active!);
    const waitMs = this.options.offlineWaitMs ?? 10_000;
    return new Promise<WebSocket>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.active!);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new DaemonError("extension_offline", "TabCrew extension is not connected; retry later"));
      }, waitMs);
      this.waiters.add(done);
    });
  }

  /** `first`: a hello the relay already read from this socket (relay bridges only). */
  private handleConnection(socket: WebSocket, first?: Record<string, unknown>): void {
    /** hello: waiting for hello; checking: hub reading its pin; auth: hub waiting for `auth`; open: authenticated. */
    let state: "hello" | "checking" | "auth" | "open" = "hello";
    let expectedProof = "";
    let hello: V2HelloFeatures = { version: null, mode: null, features: [] };
    const helloTimer = setTimeout(() => {
      if (state !== "open") socket.close(CLOSE_BAD_HELLO, state === "auth" ? "auth timeout" : "hello timeout");
    }, this.options.helloTimeoutMs ?? 5_000);
    const reject = (code: number, why: string): void => {
      clearTimeout(helloTimer);
      log.warn(`extension: rejected connection (${why})`);
      socket.close(code, why);
    };
    const open = (welcome: "send" | "sent", pin?: V2WelcomePin): void => {
      clearTimeout(helloTimer);
      state = "open";
      this.accept(socket, hello, welcome, pin);
    };

    const onFrame = (frame: Record<string, unknown>): void => {
      switch (state) {
        case "open":
          if (socket === this.active) this.handleFrame(socket, frame);
          return;
        case "checking":
          reject(CLOSE_BAD_HELLO, "frame before welcome");
          return;
        case "auth": {
          const proof = v2AuthProof(frame);
          if (proof === null || !v2ProofEquals(proof, expectedProof)) {
            reject(CLOSE_PIN_MISMATCH, "pin proof mismatch");
            return;
          }
          open("sent");
          return;
        }
        case "hello":
          break;
      }
      if (frame?.type !== "hello" || frame.protocol !== V2_PROTOCOL_VERSION) {
        reject(CLOSE_BAD_HELLO, "bad hello");
        return;
      }
      hello = v2HelloFeatures(frame);
      const auth = this.auth;
      if (auth.kind === "relay") {
        open("send");
        return;
      }
      if (auth.kind === "token") {
        if (typeof frame.token !== "string" || !safeEqual(frame.token, auth.token)) {
          reject(CLOSE_BAD_HELLO, "bad hello");
          return;
        }
        open("send");
        return;
      }
      const pin = v2HelloPin(frame);
      if (!pin) {
        reject(CLOSE_PIN_MISMATCH, "hub hello without a valid pin");
        return;
      }
      state = "checking";
      this.withPinLock(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const stored = await auth.pinStore.get();
        const secret = v2IsPinSecret(stored) ? stored : null;
        if (pin.state === "new") {
          if (secret === null) await auth.pinStore.set(pin.secret);
          else if (!v2ProofEquals(secret, pin.secret)) {
            reject(CLOSE_PIN_MISMATCH, "pinned to another secret");
            return;
          }
          if (secret === null) log.info("extension: hub pin stored (first pairing)");
          if (socket.readyState !== WebSocket.OPEN) return;
          // Handing over the secret proves possession: the extension is authenticated right away.
          open("send", { state: "stored" });
          return;
        }
        if (secret === null) {
          reject(CLOSE_PIN_MISMATCH, "hub has no pin");
          return;
        }
        const nonces = { nonce_e: pin.nonce_e, nonce_h: randomBytes(V2_PIN_NONCE_BYTES).toString("hex") };
        expectedProof = pinProof(secret, v2ExtProofInput(nonces));
        state = "auth";
        // No real session data until the extension proved it holds the pin.
        const hub_proof = pinProof(secret, v2HubProofInput(nonces));
        socket.send(JSON.stringify(this.welcomeFrame([], { state: "challenge", nonce_h: nonces.nonce_h, hub_proof })));
      }).catch((err) => {
        log.error(`extension: hub pin store failed: ${(err as Error).message}`);
        reject(CLOSE_INTERNAL, "pin store unavailable");
      });
    };

    socket.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(rawToString(data));
      } catch {
        if (state === "auth") reject(CLOSE_PIN_MISMATCH, "invalid auth");
        else if (state !== "open") reject(CLOSE_BAD_HELLO, "invalid hello");
        return;
      }
      onFrame(frame);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (socket === this.active) {
        this.active = null;
        this.stopPing();
        log.info("extension: disconnected");
      }
      this.failPending(socket, "extension disconnected");
    });
    socket.on("error", () => {});
    if (first) onFrame(first);
  }

  private withPinLock(task: () => Promise<void>): Promise<void> {
    const run = this.pinLock.then(task, task);
    this.pinLock = run.catch(() => {});
    return run;
  }

  private welcomeFrame(sessions: readonly V2SessionRef[], pin?: V2WelcomePin, groups = false): V2Welcome {
    const features: string[] = [];
    if (this.options.onExtRequest) features.push(V2_FEATURE_SETTINGS);
    if (this.auth.kind === "hub") features.push(V2_FEATURE_HUB);
    return {
      type: "welcome",
      protocol: V2_PROTOCOL_VERSION,
      sessions: sessions.map((s) => refFor(s, groups)),
      ...(this.options.daemonVersion ? { daemon_version: this.options.daemonVersion } : {}),
      features,
      ...(pin ? { pin } : {}),
    };
  }

  private accept(socket: WebSocket, hello: V2HelloFeatures, welcome: "send" | "sent", pin?: V2WelcomePin): void {
    const previous = this.active;
    this.active = socket;
    this.extensionVersion = hello.version ?? "unknown";
    this.extensionFeatures = hello.features;
    if (previous) {
      this.failPending(previous, "extension connection replaced");
      previous.close(CLOSE_REPLACED, "replaced by a newer connection");
    }
    if (welcome === "send") {
      const groups = hello.features.includes(V2_EXT_FEATURE_GROUPS);
      socket.send(JSON.stringify(this.welcomeFrame(this.options.sessions(), pin, groups)));
    }
    log.info(`extension: connected (version ${this.extensionVersion})`);
    this.startPing(socket);
    this.options.onConnect?.();
    for (const waiter of [...this.waiters]) waiter();
  }

  private handleFrame(socket: WebSocket, frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "ext_request":
        if (typeof frame.id === "string" && frame.id.length <= 100) void this.answerExtRequest(socket, frame.id, frame.op, frame.args);
        return;
      case "response": {
        const id = typeof frame.id === "string" ? frame.id : "";
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        log.debug(`bridge ${entry.op} ${Math.round(performance.now() - entry.sentAt)} ms ${frame.ok === true ? "ok" : "error"}`);
        if (frame.ok === true) entry.resolve(frame.result);
        else entry.reject(fromWireError(frame.error));
        return;
      }
      case "model_result": {
        const id = typeof frame.id === "string" ? frame.id : "";
        const entry = this.pendingModel.get(id);
        if (!entry || entry.socket !== socket) return;
        this.pendingModel.delete(id);
        clearTimeout(entry.timer);
        const result = v2ParseModelResult(frame);
        if (!result) entry.reject(new DaemonError("model_error", "TabCrew extension returned an invalid model result; no action executed."));
        else if (result.ok) entry.resolve(result.result);
        else if (result.error.code === "model_error") entry.reject(new ModelCallUnavailableError("provider", fromWireError(result.error).message));
        else entry.reject(fromWireError(result.error));
        return;
      }
      case "event":
        try {
          this.options.onEvent?.(frame as unknown as V2Event);
        } catch (err) {
          log.error(`extension event handler failed: ${(err as Error).message}`);
        }
        return;
      case "pong":
        this.missedPongs = 0;
        return;
      default:
        return;
    }
  }

  /** Run an extension request (only reachable on the authenticated, active socket) and reply by id. */
  private async answerExtRequest(socket: WebSocket, id: string, op: unknown, args: unknown): Promise<void> {
    let response: V2ExtResponse;
    try {
      if (!v2IsExtOp(op)) throw new DaemonError("invalid_args", `unknown request: ${String(op).slice(0, 40)}`);
      if (!this.options.onExtRequest) throw new DaemonError("internal", "extension requests are not supported");
      const result = await this.options.onExtRequest(op, args ?? {});
      response = { type: "ext_response", id, ok: true, result } as V2ExtResponse;
    } catch (err) {
      response = { type: "ext_response", id, ok: false, error: toV2Error(err) };
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  }

  private failPending(socket: WebSocket, why: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(lostError(entry.op, why));
    }
    for (const [id, entry] of this.pendingModel) {
      if (entry.socket !== socket) continue;
      this.pendingModel.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new ModelCallUnavailableError("disconnected", `${why} during a model call; no action executed.`));
    }
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => {
      if (socket !== this.active) return;
      if (this.missedPongs >= 2) {
        log.warn("extension: missed 2 pongs, dropping connection");
        socket.terminate();
        return;
      }
      this.missedPongs += 1;
      const ping: V2DaemonFrame = { type: "ping", t: Date.now() };
      socket.send(JSON.stringify(ping));
    }, this.options.pingIntervalMs ?? 20_000);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
