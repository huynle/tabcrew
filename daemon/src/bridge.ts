import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  V2_PROTOCOL_VERSION,
  v2IsExtOp,
  type V2DaemonFrame,
  type V2Event,
  type V2ExtOp,
  type V2ExtResponse,
  type V2Op,
  type V2OpMap,
  type V2SessionRef,
} from "@tabcrew/shared/v2";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DaemonError, fromWireError, toV2Error } from "./errors.js";
import { extensionOriginAllowed, hostAllowed } from "./localhost.js";
import { log } from "./log.js";
import { safeEqual } from "./token.js";

/** Ops whose effect may have happened even if no response arrives. */
export const MUTATING_OPS: ReadonlySet<V2Op> = new Set<V2Op>([
  "tab_create",
  "tab_close",
  "session_close",
  "session_release",
  "act",
  "navigate",
]);

export const CLOSE_BAD_HELLO = 4401;
export const CLOSE_REPLACED = 4409;

export interface BridgeOptions {
  readonly token: string;
  readonly port: number;
  readonly host?: string;
  /** How long a request waits for an extension to connect. Default 10 s. */
  readonly offlineWaitMs?: number;
  readonly helloTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly defaultRequestTimeoutMs?: number;
  /** Sessions announced in `welcome`. */
  readonly sessions: () => readonly V2SessionRef[];
  readonly onEvent?: (event: V2Event) => void;
  readonly onConnect?: () => void;
  /** Extension -> daemon requests (`ext_request`, popup settings). Throw a DaemonError to answer ok:false. */
  readonly onExtRequest?: (op: V2ExtOp, args: unknown) => Promise<unknown>;
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
  private waiters = new Set<() => void>();
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private extensionVersion: string | null = null;

  constructor(private readonly options: BridgeOptions) {}

  get connected(): boolean {
    return this.active?.readyState === WebSocket.OPEN;
  }

  get version(): string | null {
    return this.connected ? this.extensionVersion : null;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port,
      maxPayload: 64 * 1024 * 1024,
      // Web pages must never reach this socket (the extension's origin is chrome-extension://), and
      // a rebound DNS name must not either. The token in the hello frame is still required.
      verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
        extensionOriginAllowed(origin) && hostAllowed(req.headers.host),
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
    if (!this.wss) return;
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    this.wss = null;
  }

  /** Send an op to the extension and resolve with its typed result. */
  async request<K extends V2Op>(
    session: V2SessionRef,
    op: K,
    args: V2OpMap[K]["args"],
    timeoutMs = this.options.defaultRequestTimeoutMs ?? 30_000,
  ): Promise<V2OpMap[K]["result"]> {
    const socket = await this.waitForConnection();
    const id = randomUUID();
    return new Promise<V2OpMap[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(lostError(op, `extension did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { op, socket, resolve: resolve as (v: unknown) => void, reject, timer, sentAt: performance.now() });
      const frame: V2DaemonFrame = { type: "request", id, op, session, args };
      socket.send(JSON.stringify(frame), (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(lostError(op, "extension connection failed"));
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

  private handleConnection(socket: WebSocket): void {
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_BAD_HELLO, "hello timeout");
    }, this.options.helloTimeoutMs ?? 5_000);

    socket.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(rawToString(data));
      } catch {
        if (!authenticated) {
          clearTimeout(helloTimer);
          socket.close(CLOSE_BAD_HELLO, "invalid hello");
        }
        return;
      }
      if (!authenticated) {
        clearTimeout(helloTimer);
        if (
          frame?.type !== "hello" ||
          frame.protocol !== V2_PROTOCOL_VERSION ||
          typeof frame.token !== "string" ||
          !safeEqual(frame.token, this.options.token)
        ) {
          log.warn("extension: rejected connection (bad hello)");
          socket.close(CLOSE_BAD_HELLO, "invalid hello");
          return;
        }
        authenticated = true;
        this.accept(socket, typeof frame.extension_version === "string" ? frame.extension_version.slice(0, 40) : "unknown");
        return;
      }
      if (socket !== this.active) return;
      this.handleFrame(socket, frame);
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
  }

  private accept(socket: WebSocket, version: string): void {
    const previous = this.active;
    this.active = socket;
    this.extensionVersion = version;
    if (previous) {
      this.failPending(previous, "extension connection replaced");
      previous.close(CLOSE_REPLACED, "replaced by a newer connection");
    }
    const welcome: V2DaemonFrame = {
      type: "welcome",
      protocol: V2_PROTOCOL_VERSION,
      sessions: this.options.sessions().map((s) => ({ short_id: s.short_id, label: s.label })),
    };
    socket.send(JSON.stringify(welcome));
    log.info(`extension: connected (version ${version})`);
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
