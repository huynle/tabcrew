import { createCore, type TabcrewCore } from "@tabcrew/daemon/dist/core.js";
import { DEFAULT_JEV_MODEL } from "@tabcrew/daemon/dist/config.js";
import { HUB_MODEL_PLACEHOLDER } from "@tabcrew/daemon/dist/hub/config.js";
import { Limiter } from "@tabcrew/daemon/dist/jev/browse.js";
import { log } from "@tabcrew/daemon/dist/log.js";
import { sha256 } from "./crypto.js";
import { relayModelTransport, type AccountModels } from "./modelSettings.js";

/** One signed-in browser of one user: its own TabCrew core (sessions, bridge, browse runtime). */
export interface BrowserTenant {
  readonly userId: string;
  readonly browserId: string;
  name: string;
  readonly core: TabcrewCore;
  /** When its extension last connected (0: never in this process). */
  lastConnected: number;
  lastUsed: number;
}

export interface TenantOptions {
  readonly version: string;
  /** How long requests wait for the browser (default 45 s: a sleeping service worker reconnects). */
  readonly offlineWaitMs?: number;
  /** Browser sessions end after this long unused (default 30 min), as in the daemon. */
  readonly sessionIdleMs?: number;
  /** A tenant with no browser connected and no sessions is dropped after this long unused (default 10 min). */
  readonly tenantIdleMs?: number;
  readonly browseConcurrency?: number;
  readonly now?: () => number;
  /** Account model settings: the relay calls the provider unless the browser uses its own. */
  readonly models?: AccountModels;
  /** Shown in "set a model provider" errors. */
  readonly settingsUrl?: string;
}

/**
 * Cores per (user, browser), built on first use. Each core's bridge uses relay auth (the relay
 * authenticates sockets and hands them over), and every model call goes through that browser's
 * extension. Session handles are remembered per user so later calls reach the right browser.
 */
export class TenantManager {
  private readonly browsers = new Map<string, BrowserTenant>();
  /** userId -> (sha256 of a session handle -> browserId). A handle is only ever looked up within its user. */
  private readonly handles = new Map<string, Map<string, string>>();
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: TenantOptions) {
    this.now = o.now ?? Date.now;
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  get size(): number {
    return this.browsers.size;
  }

  all(): Iterable<BrowserTenant> {
    return this.browsers.values();
  }

  /** The user's browser tenants that exist in this process. */
  ofUser(userId: string): BrowserTenant[] {
    return [...this.browsers.values()].filter((b) => b.userId === userId);
  }

  /** Open browser sessions of the user, across their browsers. */
  sessionCount(userId: string): number {
    return this.ofUser(userId).reduce((n, b) => n + b.core.registry.size, 0);
  }

  /** The tenant of this user's browser, created on first use. */
  forBrowser(userId: string, browserId: string, name: string): BrowserTenant {
    let tenant = this.browsers.get(browserId);
    if (tenant && tenant.userId !== userId) throw new Error("browser belongs to another user");
    if (!tenant) {
      const t: BrowserTenant = {
        userId,
        browserId,
        name,
        lastConnected: 0,
        lastUsed: this.now(),
        core: createCore({
          bridge: {
            auth: { kind: "relay" },
            offlineWaitMs: this.o.offlineWaitMs ?? 45_000,
            daemonVersion: this.o.version,
            onConnect: () => {
              t.lastConnected = this.now();
            },
          },
          jev: {
            settings: {
              jevModel: DEFAULT_JEV_MODEL,
              openrouterApiKey: undefined,
              textModel: HUB_MODEL_PLACEHOLDER,
              textModelReasoning: "none",
              textModelFallback: HUB_MODEL_PLACEHOLDER,
              decisionProvider: "chat",
              decisionModel: HUB_MODEL_PLACEHOLDER,
              decisionModelReasoning: "none",
            },
            limiter: new Limiter(this.o.browseConcurrency ?? 4),
          },
          modelViaExtension: true,
          idleTimeoutMs: this.o.sessionIdleMs ?? 30 * 60_000,
        }),
      };
      if (this.o.models) {
        t.core.jev.transport = relayModelTransport({ userId, models: this.o.models, bridge: t.core.bridge, settingsUrl: this.o.settingsUrl ?? "/settings" });
      }
      tenant = t;
      this.browsers.set(browserId, tenant);
      log.info(`relay: browser tenant created (${this.browsers.size} active)`);
    }
    tenant.name = name;
    tenant.lastUsed = this.now();
    return tenant;
  }

  /** Remember which browser a session handle belongs to. */
  rememberHandle(userId: string, handle: string, browserId: string): void {
    let map = this.handles.get(userId);
    if (!map) this.handles.set(userId, (map = new Map()));
    map.set(sha256(handle), browserId);
  }

  /** The tenant a handle of this user belongs to (undefined for unknown, closed or foreign handles). */
  byHandle(userId: string, handle: unknown): BrowserTenant | undefined {
    if (typeof handle !== "string") return undefined;
    const browserId = this.handles.get(userId)?.get(sha256(handle));
    const tenant = browserId ? this.browsers.get(browserId) : undefined;
    if (tenant) tenant.lastUsed = this.now();
    return tenant;
  }

  /** The user's revoked browser: drop its extension socket (4401, so it refreshes and finds it is signed out). */
  disconnect(browserId: string): void {
    this.browsers.get(browserId)?.core.bridge.disconnect(4401, "sign-in revoked");
  }

  /** Drop browser tenants with no extension connected, no sessions and no recent use. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - (this.o.tenantIdleMs ?? 10 * 60_000);
    for (const [browserId, t] of this.browsers) {
      if (t.lastUsed > cutoff || t.core.bridge.connected || t.core.registry.size > 0) continue;
      this.browsers.delete(browserId);
      const map = this.handles.get(t.userId);
      if (map) for (const [h, b] of map) if (b === browserId) map.delete(h);
      await t.core.close({ save: false });
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const all = [...this.browsers.values()];
    this.browsers.clear();
    this.handles.clear();
    await Promise.allSettled(all.map((t) => t.core.close({ save: false })));
  }
}
