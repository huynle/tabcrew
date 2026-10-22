import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tabcrewExtensionOrigins } from "@tabcrew/shared/product";
import { V2_HUB_EXTENSION_PORT, type V2Event } from "@tabcrew/shared/v2";
import { ExtensionBridge, type BridgeAuth } from "./bridge.js";
import { Limiter, type JevRuntime } from "./jev/browse.js";
import { modelCallTransport } from "./jev/decisions.js";
import type { DaemonConfig } from "./config.js";
import { DaemonError } from "./errors.js";
import type { Env } from "./home.js";
import { log } from "./log.js";
import { McpHttpServer } from "./mcp/httpServer.js";
import { McpSocketServer } from "./mcp/socketServer.js";
import { closeSession, type ToolContext } from "./mcp/tools.js";
import { ObservationCache } from "./observe.js";
import type { PinStore } from "./pin.js";
import { Scheduler } from "./scheduler.js";
import { SessionRegistry, type Session } from "./sessions.js";
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

interface RunningCore {
  readonly extensionPort: number;
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  readonly scheduler: Scheduler;
  readonly observations: ObservationCache;
  /** Live Jev settings (replaced when the popup changes settings). */
  readonly jev: JevRuntime;
  /** End idle sessions now, handing their tabs to the user (also runs on a timer). */
  sweepIdle(): Promise<void>;
  close(): Promise<void>;
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

const STOPPED = (): DaemonError =>
  new DaemonError("stopped_by_user", "the user pressed Stop for this session in Chrome; ask the user before continuing");

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

  const registry = new SessionRegistry({ file: join(stateDir, "sessions.json"), idleTimeoutMs });
  registry.load();
  const scheduler = new Scheduler();
  const observations = new ObservationCache();
  registry.onTabRemoved((tabId, shortId) => {
    scheduler.dropTab(tabId, new DaemonError("tab_gone", `tab ${tabId} is gone; use tab_list or tab_create`));
    observations.forget(shortId, tabId);
  });

  const stopSessions = (shortId: string | null): void => {
    const stopped = registry.stop(shortId);
    for (const session of stopped) {
      scheduler.dropSession(session.short_id, STOPPED());
      for (const tabId of session.tabs) scheduler.dropTab(tabId, STOPPED());
      observations.forgetSession(session.short_id);
    }
    log.info(`extension: stop requested for ${shortId ?? "all sessions"} (${stopped.length} stopped)`);
  };

  const onEvent = (event: V2Event): void => {
    switch (event.event) {
      case "groups":
        registry.reconcile(event.groups);
        return;
      case "tab_adopted":
        if (typeof event.short_id === "string" && event.tab && Number.isInteger(event.tab.tab_id)) {
          registry.addTab(event.short_id, event.tab.tab_id, { steal: false });
        }
        return;
      case "tab_removed":
        if (typeof event.short_id === "string" && Number.isInteger(event.tab_id)) registry.removeTab(event.short_id, event.tab_id);
        return;
      case "stop":
        stopSessions(typeof event.short_id === "string" ? event.short_id : null);
        return;
    }
  };

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
  const bridge = new ExtensionBridge({
    auth,
    port: hub ? (hub.extensionPort ?? V2_HUB_EXTENSION_PORT) : config.extensionPort,
    offlineWaitMs: overrides.offlineWaitMs ?? (hub ? HUB_OFFLINE_WAIT_MS : undefined),
    helloTimeoutMs: overrides.helloTimeoutMs,
    pingIntervalMs: overrides.pingIntervalMs,
    defaultRequestTimeoutMs: overrides.requestTimeoutMs,
    sessions: () => registry.refs(),
    onEvent,
    onExtRequest: settings ? (op, args) => settings.handle(op, args) : undefined,
    daemonVersion: version,
  });

  // Hub mode: every model call goes through the extension (it holds provider, model and key).
  if (hub) jev.transport = modelCallTransport(bridge);

  const ctx: ToolContext = { registry, bridge, scheduler, observations, jev };
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

  const extensionPort = await bridge.start();
  let mcpPort = 0;
  try {
    if (mcp instanceof McpSocketServer) await mcp.start();
    else mcpPort = await mcp.start();
  } catch (err) {
    await bridge.close();
    throw err;
  }

  const closeIdle = async (session: Session): Promise<void> => {
    // Idle sessions hand their tabs to the user; a stopped session's tabs stay exactly where they are.
    const handOver = !session.stopped;
    try {
      await closeSession(ctx, session, handOver);
      log.info(`session ${session.short_id} ended after idle timeout${handOver ? " (tabs handed to the user)" : " (stopped; tabs left as they are)"}`);
    } catch (err) {
      log.warn(`session ${session.short_id}: handing tabs over failed (${(err as { code?: string }).code ?? "error"})`);
    }
  };
  const sweepIdle = async (): Promise<void> => {
    await Promise.all(registry.idleSessions().map(closeIdle));
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const every = overrides.sweepIntervalMs ?? Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 2)));
    sweepTimer = setInterval(() => void sweepIdle(), every);
    sweepTimer.unref();
  }

  const where = hub ? `mcp unix:${hub.socketPath}` : `mcp http://127.0.0.1:${mcpPort}/mcp`;
  log.info(
    `tabcrew-${hub ? "hub" : "daemon"} ${version} listening: ${where}, extension ws://127.0.0.1:${extensionPort}, ${registry.size} session(s) restored`,
  );

  const core: RunningCore = {
    extensionPort,
    registry,
    bridge,
    scheduler,
    observations,
    jev,
    sweepIdle,
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      await mcp.close();
      await bridge.close();
      registry.save();
    },
  };
  if (mcp instanceof McpSocketServer) {
    return {
      ...core,
      mode: "hub",
      socketPath: mcp.socketPath,
      get connectionCount() {
        return mcp.connectionCount;
      },
    } satisfies RunningHub;
  }
  return { ...core, mode: "daemon", mcpPort, token } satisfies RunningDaemon;
}
