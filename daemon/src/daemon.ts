import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tabcrewExtensionOrigins } from "@tabcrew/shared/product";
import { V2_HUB_EXTENSION_PORT } from "@tabcrew/shared/v2";
import type { BridgeAuth } from "./bridge.js";
import { createCore, type TabcrewCore } from "./core.js";
import { Limiter, type JevRuntime } from "./jev/browse.js";
import type { DaemonConfig } from "./config.js";
import type { Env } from "./home.js";
import { log } from "./log.js";
import { McpHttpServer } from "./mcp/httpServer.js";
import { McpSocketServer } from "./mcp/socketServer.js";
import type { PinStore } from "./pin.js";
import { SettingsService } from "./settings.js";
import { ensureHome, ensureToken } from "./token.js";

export interface DaemonOverrides {
  /** How long requests wait for the extension to connect (default 10 s). */
  readonly offlineWaitMs?: number;
  readonly helloTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** Overrides `idle_timeout_minutes`. */
  readonly idleTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
  /** Backoff base for model-call retries (default 500 ms). */
  readonly modelRetryBaseMs?: number;
  /** Environment the settings service mirrors (default process.env). */
  readonly env?: Env;
  /** Variables loaded from <home>/env by `loadEnvFile` (so they are reported as "file", not "env"). */
  readonly envFileVars?: readonly string[];
  /** fetch for the OpenRouter key check (default global fetch). */
  readonly fetch?: typeof fetch;
}

/** Hub mode requests wait this long for the extension (its service worker may be asleep). */
export const HUB_OFFLINE_WAIT_MS = 45_000;

/**
 * Hub mode (`startDaemon(config, overrides, {mode: "hub", ...})`): no token, no `<home>` writes, no
 * settings service, no HTTP endpoint. MCP is served on `socketPath`; the extension authenticates by
 * Origin + TOFU pin; model calls go through the extension. Only `config.idleTimeoutMinutes`,
 * `browseConcurrency` and the model fields of `config` are used.
 */
export interface HubModeOptions {
  readonly mode: "hub";
  /** Private runtime dir (created 0700 if missing; ownership checks are the caller's): sessions.json lives here. */
  readonly runtimeDir: string;
  /** MCP Unix socket (normally inside runtimeDir); must not exist yet. */
  readonly socketPath: string;
  readonly pinStore: PinStore;
  /** Extension origins allowed on the WebSocket. Default: the known TabCrew extension IDs. */
  readonly allowedOrigins?: readonly string[];
  /** Extension WebSocket port. Default V2_HUB_EXTENSION_PORT (8775); 0 picks a free port. */
  readonly extensionPort?: number;
  /** Called with the number of MCP socket connections after each connect/disconnect. */
  readonly onConnectionCountChange?: (count: number) => void;
  /** Called when the last MCP socket connection closes (idle-exit hook). */
  readonly onIdle?: () => void;
}

interface RunningCore extends TabcrewCore {
  readonly extensionPort: number;
}

/** The launchd daemon: token auth, HTTP MCP endpoint. */
export interface RunningDaemon extends RunningCore {
  readonly mode: "daemon";
  readonly mcpPort: number;
  readonly token: string;
}

/** A hub (see HubModeOptions). */
export interface RunningHub extends RunningCore {
  readonly mode: "hub";
  readonly socketPath: string;
  /** Open MCP socket connections (shims). */
  readonly connectionCount: number;
}

declare const __TABCREW_VERSION__: string | undefined;

export function daemonVersion(): string {
  // Bundled runtimes (cli/dist/*.mjs) have the version inlined; package.json is not next to them.
  if (typeof __TABCREW_VERSION__ === "string") return __TABCREW_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function startDaemon(config: DaemonConfig, overrides?: DaemonOverrides): Promise<RunningDaemon>;
export function startDaemon(config: DaemonConfig, overrides: DaemonOverrides | undefined, hub: HubModeOptions): Promise<RunningHub>;
export async function startDaemon(
  config: DaemonConfig,
  overrides: DaemonOverrides = {},
  hub?: HubModeOptions,
): Promise<RunningDaemon | RunningHub> {
  // Hub mode never touches <home>: no token, no settings files; its state lives in the runtime dir.
  let token = "";
  if (hub) mkdirSync(hub.runtimeDir, { recursive: true, mode: 0o700 });
  else {
    ensureHome(config.home);
    token = ensureToken(config.home);
  }
  const stateDir = hub ? hub.runtimeDir : config.home;
  const auth: BridgeAuth = hub
    ? { kind: "hub", allowedOrigins: hub.allowedOrigins ?? tabcrewExtensionOrigins(), pinStore: hub.pinStore }
    : { kind: "token", token };
  const idleTimeoutMs = overrides.idleTimeoutMs ?? config.idleTimeoutMinutes * 60_000;

  const jev: JevRuntime = {
    settings: {
      jevModel: config.jevModel,
      textModel: config.textModel,
      openrouterApiKey: config.openrouterApiKey,
      textModelApiKey: config.textModelApiKey,
      textModelBaseUrl: config.textModelBaseUrl,
      textModelReasoning: config.textModelReasoning,
      textModelFallback: config.textModelFallback,
      // Hub mode: the text helper's default budget allows for the extension round trip (jev/text.ts).
      textModelTimeoutMs: hub ? undefined : config.textModelTimeoutMs,
      decisionProvider: config.decisionProvider,
      decisionModel: config.decisionModel,
      decisionModelApiKey: config.decisionModelApiKey,
      decisionModelBaseUrl: config.decisionModelBaseUrl,
      decisionModelReasoning: config.decisionModelReasoning,
      retryBaseMs: overrides.modelRetryBaseMs,
    },
    limiter: new Limiter(config.browseConcurrency),
  };
  // Hub mode has no <home>: model settings live in the extension, so there is nothing to edit here.
  const settings = hub
    ? null
    : new SettingsService({
        home: config.home,
        env: overrides.env ?? process.env,
        envFileVars: overrides.envFileVars ?? [],
        fetch: overrides.fetch ?? fetch,
        runtime: jev,
      });

  const version = daemonVersion();
  const core = createCore({
    bridge: {
      auth,
      port: hub ? (hub.extensionPort ?? V2_HUB_EXTENSION_PORT) : config.extensionPort,
      offlineWaitMs: overrides.offlineWaitMs ?? (hub ? HUB_OFFLINE_WAIT_MS : undefined),
      helloTimeoutMs: overrides.helloTimeoutMs,
      pingIntervalMs: overrides.pingIntervalMs,
      defaultRequestTimeoutMs: overrides.requestTimeoutMs,
      onExtRequest: settings ? (op, args) => settings.handle(op, args) : undefined,
      daemonVersion: version,
    },
    jev,
    // Hub mode: every model call goes through the extension (it holds provider, model and key).
    modelViaExtension: !!hub,
    sessionsFile: join(stateDir, "sessions.json"),
    idleTimeoutMs,
    sweepIntervalMs: overrides.sweepIntervalMs,
  });
  const { ctx } = core;
  const mcp = hub
    ? new McpSocketServer({
        ...ctx,
        socketPath: hub.socketPath,
        version,
        onConnectionCountChange: hub.onConnectionCountChange,
        onIdle: hub.onIdle,
      })
    : new McpHttpServer({
        ...ctx,
        token,
        port: config.mcpPort,
        allowedOrigins: config.allowedOrigins,
        version,
      });

  let extensionPort: number;
  try {
    extensionPort = await core.bridge.start();
  } catch (err) {
    await core.close({ save: false });
    throw err;
  }
  let mcpPort = 0;
  try {
    if (mcp instanceof McpSocketServer) await mcp.start();
    else mcpPort = await mcp.start();
  } catch (err) {
    await core.close({ save: false });
    throw err;
  }

  const where = hub ? `mcp unix:${hub.socketPath}` : `mcp http://127.0.0.1:${mcpPort}/mcp`;
  log.info(
    `tabcrew-${hub ? "hub" : "daemon"} ${version} listening: ${where}, extension ws://127.0.0.1:${extensionPort}, ${core.registry.size} session(s) restored`,
  );

  const running: RunningCore = {
    ...core,
    extensionPort,
    async close() {
      await mcp.close();
      await core.close();
    },
  };
  if (mcp instanceof McpSocketServer) {
    return {
      ...running,
      mode: "hub",
      socketPath: mcp.socketPath,
      get connectionCount() {
        return mcp.connectionCount;
      },
    } satisfies RunningHub;
  }
  return { ...running, mode: "daemon", mcpPort, token } satisfies RunningDaemon;
}
