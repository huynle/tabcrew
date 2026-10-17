import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { V2Event } from "@tabcrew/shared/v2";
import { ExtensionBridge } from "./bridge.js";
import { Limiter, type JevRuntime } from "./jev/browse.js";
import type { DaemonConfig } from "./config.js";
import { DaemonError } from "./errors.js";
import type { Env } from "./home.js";
import { log } from "./log.js";
import { McpHttpServer } from "./mcp/httpServer.js";
import { closeSession, type ToolContext } from "./mcp/tools.js";
import { ObservationCache } from "./observe.js";
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

export interface RunningDaemon {
  readonly mcpPort: number;
  readonly extensionPort: number;
  readonly token: string;
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

export async function startDaemon(config: DaemonConfig, overrides: DaemonOverrides = {}): Promise<RunningDaemon> {
  ensureHome(config.home);
  const token = ensureToken(config.home);
  const idleTimeoutMs = overrides.idleTimeoutMs ?? config.idleTimeoutMinutes * 60_000;

  const registry = new SessionRegistry({ file: join(config.home, "sessions.json"), idleTimeoutMs });
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
      textModelTimeoutMs: config.textModelTimeoutMs,
      retryBaseMs: overrides.modelRetryBaseMs,
    },
    limiter: new Limiter(config.browseConcurrency),
  };
  const settings = new SettingsService({
    home: config.home,
    env: overrides.env ?? process.env,
    envFileVars: overrides.envFileVars ?? [],
    fetch: overrides.fetch ?? fetch,
    runtime: jev,
  });

  const bridge = new ExtensionBridge({
    token,
    port: config.extensionPort,
    offlineWaitMs: overrides.offlineWaitMs,
    helloTimeoutMs: overrides.helloTimeoutMs,
    pingIntervalMs: overrides.pingIntervalMs,
    defaultRequestTimeoutMs: overrides.requestTimeoutMs,
    sessions: () => registry.refs(),
    onEvent,
    onExtRequest: (op, args) => settings.handle(op, args),
  });

  const ctx: ToolContext = { registry, bridge, scheduler, observations, jev };
  const version = daemonVersion();
  const mcp = new McpHttpServer({
    ...ctx,
    token,
    port: config.mcpPort,
    allowedOrigins: config.allowedOrigins,
    version,
  });

  const extensionPort = await bridge.start();
  let mcpPort: number;
  try {
    mcpPort = await mcp.start();
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

  log.info(
    `tabcrew-daemon ${version} listening: mcp http://127.0.0.1:${mcpPort}/mcp, extension ws://127.0.0.1:${extensionPort}, ${registry.size} session(s) restored`,
  );

  return {
    mcpPort,
    extensionPort,
    token,
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
}
