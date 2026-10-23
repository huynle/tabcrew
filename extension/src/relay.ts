/**
 * The service-worker side of the bridge. The daemon socket lives in the offscreen document; this
 * relay receives its requests over the `v2-bridge` port, runs them concurrently (no queue), and
 * posts responses and events back. It also mirrors the socket status for the popup.
 *
 * Hub mode: the pushed config carries the TOFU pin (never the daemon token); `model_call`s from the
 * hub run through `RelayDeps.handleModelCall` here (the service worker holds the provider settings)
 * and are answered with `model_result`.
 */

import {
  V2_FEATURE_SETTINGS,
  v2IsPinSecret,
  v2ParseModelCall,
  v2ParseModelResult,
  v2ServiceInfo,
  type V2Error,
  type V2Event,
  type V2ExtOp,
  type V2ExtOpMap,
  type V2ExtResponse,
  type V2ModelCall,
  type V2ModelResult,
  type V2Request,
  type V2Response,
  type V2Welcome,
} from "@tabcrew/shared/v2";
import type { BridgeConfig, BridgeStatus, ServiceInfo } from "./config.js";
import { toWireError } from "./errors.js";
import type { PortLike, ToOffscreen, ToServiceWorker } from "./relay-protocol.js";

export const RECHECK_OFFSCREEN_MS = 1_000;
/** How long a popup request to the daemon (settings) may take; the OpenRouter key check takes up to 10 s. */
export const DAEMON_REQUEST_TIMEOUT_MS = 15_000;
/** A daemon older than popup settings ignores ext_request; answer at once instead of timing out. */
export const SERVICE_TOO_OLD_ERROR = "Your TabCrew service is too old for settings here. Update it: npx tabcrew@latest setup";

function serviceFrom(source: unknown): ServiceInfo {
  const info = v2ServiceInfo(source);
  return { version: info.version, settings: info.features.includes(V2_FEATURE_SETTINGS) };
}

/** The answer to a hub `model_call` (the relay adds type and id). */
export type ModelCallOutcome =
  | { readonly ok: true; readonly result: { readonly status: number; readonly json: unknown; readonly model: string } }
  | { readonly ok: false; readonly error: V2Error };

export const MODEL_NOT_CONFIGURED_MESSAGE = "set a model provider in the TabCrew popup";

/** The model_call handler until a provider proxy exists: every call is `model_not_configured`. */
export async function modelNotConfigured(_call: V2ModelCall): Promise<ModelCallOutcome> {
  return { ok: false, error: { code: "model_not_configured", message: MODEL_NOT_CONFIGURED_MESSAGE } };
}

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
  /**
   * Hub mode: run a (sanitized) model call with the extension's provider settings. Default:
   * `modelNotConfigured`. A throw becomes `model_error` with the error's message, so it must not
   * contain the API key.
   */
  handleModelCall?(call: V2ModelCall): Promise<ModelCallOutcome>;
  /** Hub mode: the hub stored this pin secret; mark the stored pin confirmed. */
  onHubPinStored?(secret: string): Promise<void> | void;
  /** "Pause agents": while true every request and model call is refused without touching any tab. */
  isPaused?(): Promise<boolean> | boolean;
}

export const PAUSED_MESSAGE = "the user paused agents in this browser (TabCrew popup); ask the user before continuing";

export class BridgeRelay {
  private port: PortLike | null = null;
  private _status: BridgeStatus = "offline";
  private _service: ServiceInfo | null = null;
  private readonly daemonPending = new Map<string, PendingDaemonRequest>();

  constructor(private readonly deps: RelayDeps) {}

  get status(): BridgeStatus {
    return this._status;
  }

  /** The connected service's version and features; null when not connected or not yet welcomed. */
  get service(): ServiceInfo | null {
    return this._service;
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
      this._service = null;
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

  /**
   * Send the current config to the offscreen document. `reconfigure` forces a reconnect. Hub mode
   * sends the pin and never the daemon token; daemon mode keeps the pre-hub message shape.
   */
  async pushConfig(reconfigure: boolean): Promise<void> {
    const config = await this.deps.loadConfig();
    if (config.mode === "hub") {
      this.post({ type: "config", token: null, port: config.port, reconfigure, mode: "hub", hub_pin: config.hubPin ?? null });
    } else if (config.mode === "online") {
      // Never the daemon token: only the relay URL and a short-lived access token.
      const online = config.online ? { url: config.online.url, access_token: config.online.accessToken } : null;
      this.post({ type: "config", token: null, port: 0, reconfigure, mode: "online", online });
    } else {
      this.post({ type: "config", token: config.token, port: config.port, reconfigure });
    }
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
    // Unknown (welcome not seen yet) is let through; only a service known to lack settings is refused.
    if (this._service && !this._service.settings) return Promise.reject(new Error(SERVICE_TOO_OLD_ERROR));
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
          if (message.status !== "connected") {
            this._service = null;
            this.failDaemonRequests("connection to the TabCrew daemon was lost");
          }
          this.deps.onStatus?.(message.status);
        }
        break;
      case "welcome":
        this._service = serviceFrom(message.welcome);
        void Promise.resolve()
          .then(() => this.deps.onWelcome(message.welcome))
          .catch((err) => console.warn("[v2 relay] welcome handling failed:", err));
        break;
      case "service":
        // Same shape check as a welcome: the replayed fields are the welcome's.
        if (this._status === "connected") this._service = serviceFrom({ daemon_version: message.service?.version, features: message.service?.features });
        break;
      case "request":
        void this.dispatch(message.request);
        break;
      case "ext_response":
        this.settleDaemonRequest(message.response);
        break;
      case "keepalive":
        break;
      case "model_call":
        void this.dispatchModelCall(message.call);
        break;
      case "hub_pin_stored":
        if (v2IsPinSecret(message.secret)) {
          void Promise.resolve()
            .then(() => this.deps.onHubPinStored?.(message.secret))
            .catch((err) => console.warn("[v2 relay] storing the hub pin failed:", err));
        }
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
    } else if (await this.paused()) {
      response = { type: "response", id: req.id, ok: false, error: { code: "stopped_by_user", message: PAUSED_MESSAGE } };
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

  private async dispatchModelCall(raw: unknown): Promise<void> {
    const call = v2ParseModelCall(raw);
    if (!call) {
      console.warn("[v2 relay] ignoring malformed model_call");
      return;
    }
    let result: V2ModelResult;
    if (await this.paused()) {
      this.post({ type: "model_result", result: { type: "model_result", id: call.id, ok: false, error: { code: "stopped_by_user", message: PAUSED_MESSAGE } } });
      return;
    }
    try {
      const outcome = await (this.deps.handleModelCall ?? modelNotConfigured)(call);
      result = v2ParseModelResult({ ...outcome, type: "model_result", id: call.id }) ?? {
        type: "model_result",
        id: call.id,
        ok: false,
        error: { code: "model_error", message: "the model proxy returned an invalid result" },
      };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500) || "model call failed";
      result = { type: "model_result", id: call.id, ok: false, error: { code: "model_error", message } };
    }
    this.post({ type: "model_result", result });
  }

  private async paused(): Promise<boolean> {
    try {
      return (await this.deps.isPaused?.()) === true;
    } catch {
      // Fail closed: if the setting can't be read, treat agents as paused.
      return true;
    }
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
