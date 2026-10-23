/**
 * The offscreen-document side of the bridge: owns the daemon WebSocket (`Bridge`) and relays
 * requests, welcome and status to the service worker over one `chrome.runtime` port.
 *
 * Offscreen documents only get `chrome.runtime`, so the token, port, mode and hub pin arrive from
 * the service worker as `config` messages (and a pin the hub stored goes back as `hub_pin_stored`;
 * hub `model_call`s go to the service worker, which holds the provider settings). If the port drops (service worker restarted), it is reopened; any
 * request forwarded to the dead service worker simply gets no response (the daemon times it out).
 */

import { v2ServiceInfo, type V2Request, type V2ServiceInfo, type V2Welcome } from "@tabcrew/shared/v2";
import { parseHubPin } from "../config.js";
import { Bridge, type SocketLike } from "../bridge.js";
import type { BridgeConfig, BridgeStatus } from "../config.js";
import type { BridgeStats, PortLike, ToOffscreen, ToServiceWorker } from "../relay-protocol.js";

export const PORT_RECONNECT_MS = 500;

export interface OffscreenHostDeps {
  /** Opens the `v2-bridge` port to the service worker. */
  connect(): PortLike;
  createSocket(url: string): SocketLike;
  extensionVersion: string;
  now?(): number;
}

export class OffscreenHost {
  readonly bridge: Bridge;
  private port: PortLike | null = null;
  private portTimer: ReturnType<typeof setTimeout> | null = null;
  private config: BridgeConfig | null = null;
  private configWaiters: ((config: BridgeConfig) => void)[] = [];
  /** From the current connection's welcome; replayed to a restarted service worker. */
  private service: V2ServiceInfo | null = null;

  constructor(private readonly deps: OffscreenHostDeps) {
    this.bridge = new Bridge({
      loadConfig: () => this.loadConfig(),
      createSocket: deps.createSocket,
      extensionVersion: deps.extensionVersion,
      now: deps.now,
      onRequest: (request: V2Request) => this.post({ type: "request", request }),
      onWelcome: (welcome: V2Welcome) => {
        this.service = v2ServiceInfo(welcome);
        this.post({ type: "welcome", welcome });
      },
      onPing: () => this.post({ type: "keepalive" }),
      onStatus: (status: BridgeStatus) => {
        if (status !== "connected") this.service = null;
        this.post({ type: "status", status });
      },
      onExtResponse: (response) => this.post({ type: "ext_response", response }),
      onModelCall: (call) => this.post({ type: "model_call", call }),
      onHubPinStored: (secret) => this.post({ type: "hub_pin_stored", secret }),
    });
  }

  start(): void {
    this.openPort();
  }

  stats(): BridgeStats {
    return this.bridge.stats();
  }

  private loadConfig(): Promise<BridgeConfig> {
    if (this.config) return Promise.resolve(this.config);
    return new Promise((resolve) => this.configWaiters.push(resolve));
  }

  private openPort(): void {
    if (this.port) return;
    let port: PortLike;
    try {
      port = this.deps.connect();
    } catch (err) {
      // Extension context invalidated (reload/uninstall): this document is going away.
      console.warn("[v2 offscreen] cannot connect to the service worker:", err);
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port === port) this.handle(message as ToOffscreen);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.schedulePortReconnect();
    });
    // A (re)started service worker knows nothing: tell it where the socket stands.
    this.postOn(port, { type: "status", status: this.bridge.status });
    if (this.bridge.status === "connected" && this.service) this.postOn(port, { type: "service", service: this.service });
  }

  private schedulePortReconnect(): void {
    if (this.portTimer !== null) return;
    this.portTimer = setTimeout(() => {
      this.portTimer = null;
      this.openPort();
    }, PORT_RECONNECT_MS);
  }

  private handle(message: ToOffscreen): void {
    switch (message?.type) {
      case "config":
        this.applyConfig(configFrom(message), message.reconfigure);
        break;
      case "model_result":
        this.bridge.sendModelResult(message.result);
        break;
      case "frame":
        if (message.frame.type === "response") this.bridge.sendResponse(message.frame);
        else this.bridge.sendEvent(message.frame);
        break;
      case "ext_request":
        if (!this.bridge.sendExtRequest(message.request)) {
          this.post({
            type: "ext_response",
            response: {
              type: "ext_response",
              id: message.request.id,
              ok: false,
              error: { code: "extension_offline", message: "not connected to the TabCrew daemon" },
            },
          });
        }
        break;
      case "ensure":
        if (this.config) void this.bridge.ensureConnected();
        break;
      default:
        console.warn("[v2 offscreen] unknown port message:", (message as { type?: unknown })?.type);
    }
  }

  private applyConfig(config: BridgeConfig, reconfigure: boolean): void {
    const previous = this.config;
    this.config = config;
    if (!previous) {
      const waiters = this.configWaiters.splice(0);
      if (waiters.length > 0) waiters.forEach((resolve) => resolve(config));
      else void this.bridge.start();
      return;
    }
    // A pin that only became confirmed keeps the connection; the next hello challenges the hub.
    // A refreshed online access token keeps the connection too (it is only checked at hello);
    // the next reconnect uses it.
    const changed =
      previous.token !== config.token ||
      previous.port !== config.port ||
      previous.mode !== config.mode ||
      previous.hubPin?.secret !== config.hubPin?.secret ||
      previous.online?.url !== config.online?.url ||
      !previous.online !== !config.online;
    if (reconfigure || changed) {
      void this.bridge.reconfigure();
    } else {
      void this.bridge.ensureConnected();
    }
  }

  /** Post to the service worker, reopening the port if it dropped. */
  private post(message: ToServiceWorker): void {
    if (!this.port) {
      this.clearPortTimer();
      this.openPort();
      // openPort already posted the current status.
      if (message.type === "status" || !this.port) return;
    }
    this.postOn(this.port, message);
  }

  private postOn(port: PortLike, message: ToServiceWorker): void {
    try {
      port.postMessage(message);
    } catch (err) {
      console.warn("[v2 offscreen] post failed:", err);
    }
  }

  private clearPortTimer(): void {
    if (this.portTimer !== null) {
      clearTimeout(this.portTimer);
      this.portTimer = null;
    }
  }
}

function configFrom(message: Extract<ToOffscreen, { type: "config" }>): BridgeConfig {
  if (message.mode === "online") {
    const o = message.online;
    const online = o && typeof o.url === "string" && typeof o.access_token === "string" ? { url: o.url, accessToken: o.access_token } : null;
    return { token: null, port: 0, mode: "online", online };
  }
  if (message.mode !== "hub") return { token: message.token, port: message.port, mode: "daemon" };
  return { token: null, port: message.port, mode: "hub", hubPin: parseHubPin(message.hub_pin) };
}
