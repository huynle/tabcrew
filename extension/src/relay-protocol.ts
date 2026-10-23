/**
 * Messages on the long-lived `chrome.runtime` port between the offscreen document (which owns
 * the daemon WebSocket) and the service worker (which owns every chrome.* call).
 */

import type {
  V2Event,
  V2ExtRequest,
  V2ExtResponse,
  V2ModelCall,
  V2ModelResult,
  V2Request,
  V2Response,
  V2ServiceInfo,
  V2Welcome,
} from "@tabcrew/shared/v2";
import type { BridgeStatus, ConnectionMode, HubPin } from "./config.js";

export const BRIDGE_PORT_NAME = "v2-bridge";

/** Offscreen document → service worker. */
export type ToServiceWorker =
  | { readonly type: "status"; readonly status: BridgeStatus }
  | { readonly type: "welcome"; readonly welcome: V2Welcome }
  /** Sent when the port (re)opens while connected: a restarted service worker missed the welcome. */
  | { readonly type: "service"; readonly service: V2ServiceInfo }
  | { readonly type: "request"; readonly request: V2Request }
  /** The daemon's answer to an `ext_request` (or a local extension_offline failure). */
  | { readonly type: "ext_response"; readonly response: V2ExtResponse }
  /** Sent on every daemon ping so the service worker's idle timer keeps resetting while connected. */
  | { readonly type: "keepalive" }
  /** Hub mode: a verified, sanitized model call to run in the service worker (it holds the provider settings). */
  | { readonly type: "model_call"; readonly call: V2ModelCall }
  /** Hub mode: the hub stored this pin secret; the service worker marks the stored pin confirmed. */
  | { readonly type: "hub_pin_stored"; readonly secret: string };

/** Service worker → offscreen document. */
export type ToOffscreen =
  /** Offscreen documents cannot read chrome.storage, so the service worker pushes the config. */
  | {
      readonly type: "config";
      /** Daemon token; always null in hub mode (never sent to a hub). */
      readonly token: string | null;
      readonly port: number;
      readonly reconfigure: boolean;
      /** "hub" in hub mode; absent means daemon mode (the pre-hub message shape). */
      readonly mode?: ConnectionMode;
      /** Hub mode: the TOFU pin. */
      readonly hub_pin?: HubPin | null;
      /** Online mode: the relay socket URL and a fresh access token (null when signed out). */
      readonly online?: { readonly url: string; readonly access_token: string } | null;
    }
  | { readonly type: "frame"; readonly frame: V2Response | V2Event }
  /** A popup request for the daemon (settings). Never stored; answered with `ext_response`. */
  | { readonly type: "ext_request"; readonly request: V2ExtRequest }
  /** Keepalive alarm: reconnect if nothing is connected or pending. */
  | { readonly type: "ensure" }
  /** Hub mode: the answer to a `model_call`. */
  | { readonly type: "model_result"; readonly result: V2ModelResult };

/** The structural subset of chrome.runtime.Port used on both sides (lets tests inject fakes). */
export interface PortLike {
  readonly name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(fn: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(fn: () => void): void };
}

/** Socket send timing, kept in memory in the offscreen document (`v2:bridge_stats`). */
export interface BridgeStats {
  readonly sends: number;
  readonly slow_sends_over_200ms: number;
  readonly max_send_ms: number;
}

export const BRIDGE_STATS_MESSAGE = "v2:bridge_stats";
