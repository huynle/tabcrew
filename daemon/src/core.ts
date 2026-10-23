import type { V2Event } from "@tabcrew/shared/v2";
import { ExtensionBridge, type BridgeAuth, type BridgeCommonOptions } from "./bridge.js";
import { DaemonError } from "./errors.js";
import type { JevRuntime } from "./jev/browse.js";
import { modelCallTransport } from "./jev/decisions.js";
import { log } from "./log.js";
import { closeSession, type ToolContext } from "./mcp/tools.js";
import { ObservationCache } from "./observe.js";
import { Scheduler } from "./scheduler.js";
import { SessionRegistry, type Session } from "./sessions.js";

/**
 * Everything one TabCrew core needs, without a home directory, token, MCP server or listening
 * port: the daemon, the hub and (per user and browser) the Online relay each build one.
 */
export interface CoreOptions {
  /** The extension bridge; `sessions` and `onEvent` are wired to the core. */
  readonly bridge: Omit<BridgeCommonOptions, "sessions" | "onEvent"> & { readonly auth: BridgeAuth };
  readonly jev: JevRuntime;
  /** Every model call goes through the extension (`model_call`): hub and relay. */
  readonly modelViaExtension?: boolean;
  /** Where sessions persist; omitted keeps them in memory. */
  readonly sessionsFile?: string;
  /** 0 turns the idle sweep off. */
  readonly idleTimeoutMs: number;
  readonly sweepIntervalMs?: number;
}

export interface TabcrewCore {
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  readonly scheduler: Scheduler;
  readonly observations: ObservationCache;
  /** Live Jev settings (replaced when the popup changes settings). */
  readonly jev: JevRuntime;
  /** What the MCP tools run against. */
  readonly ctx: ToolContext;
  /** End idle sessions now, handing their tabs to the user (also runs on a timer). */
  sweepIdle(): Promise<void>;
  /**
   * Stop the sweep, close the bridge and save sessions (`save: false` skips that, e.g. when startup
   * failed and another instance may own the sessions file). Does not start or stop any server.
   */
  close(options?: { save?: boolean }): Promise<void>;
}

const STOPPED = (): DaemonError =>
  new DaemonError("stopped_by_user", "the user pressed Stop for this session in Chrome; ask the user before continuing");

export function createCore(options: CoreOptions): TabcrewCore {
  const { idleTimeoutMs, jev } = options;
  const registry = new SessionRegistry({ file: options.sessionsFile, idleTimeoutMs });
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

  const bridge = new ExtensionBridge({ ...options.bridge, sessions: () => registry.refs(), onEvent });
  if (options.modelViaExtension) jev.transport = modelCallTransport(bridge);

  const ctx: ToolContext = { registry, bridge, scheduler, observations, jev };

  const closeIdle = async (session: Session): Promise<void> => {
    // Idle sessions finish with the user's default (from the popup); a stopped session's tabs stay exactly where they are.
    const release = !session.stopped;
    try {
      await closeSession(ctx, session, release);
      log.info(`session ${session.short_id} ended after idle timeout${release ? " (tabs finished with the user's default)" : " (stopped; tabs left as they are)"}`);
    } catch (err) {
      log.warn(`session ${session.short_id}: finishing its tabs failed (${(err as { code?: string }).code ?? "error"})`);
    }
  };
  const sweepIdle = async (): Promise<void> => {
    await Promise.all(registry.idleSessions().map(closeIdle));
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  if (idleTimeoutMs > 0) {
    const every = options.sweepIntervalMs ?? Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 2)));
    sweepTimer = setInterval(() => void sweepIdle(), every);
    sweepTimer.unref();
  }

  return {
    registry,
    bridge,
    scheduler,
    observations,
    jev,
    ctx,
    sweepIdle,
    async close({ save = true } = {}) {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      await bridge.close();
      if (save) registry.save();
    },
  };
}
