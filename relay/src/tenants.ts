import { createCore, type TabcrewCore } from "@tabcrew/daemon/dist/core.js";
import { DEFAULT_JEV_MODEL } from "@tabcrew/daemon/dist/config.js";
import { HUB_MODEL_PLACEHOLDER } from "@tabcrew/daemon/dist/hub/config.js";
import { Limiter } from "@tabcrew/daemon/dist/jev/browse.js";
import { log } from "@tabcrew/daemon/dist/log.js";

export interface Tenant {
  readonly userId: string;
  readonly core: TabcrewCore;
  lastUsed: number;
}

export interface TenantOptions {
  readonly version: string;
  /** How long requests wait for the user's browser (default 45 s: a sleeping service worker reconnects). */
  readonly offlineWaitMs?: number;
  /** Browser sessions end after this long unused (default 30 min), as in the daemon. */
  readonly sessionIdleMs?: number;
  /** A tenant with no browser and no sessions is dropped after this long unused (default 10 min). */
  readonly tenantIdleMs?: number;
  readonly browseConcurrency?: number;
  readonly now?: () => number;
}

/**
 * One TabCrew core per user. Cores are built on first use and hold that user's sessions,
 * extension bridge (relay auth: the relay authenticates sockets and hands them over) and
 * browse runtime. Every model call goes through the user's own extension.
 */
export class TenantManager {
  private readonly tenants = new Map<string, Tenant>();
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: TenantOptions) {
    this.now = o.now ?? Date.now;
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  get size(): number {
    return this.tenants.size;
  }

  all(): Iterable<Tenant> {
    return this.tenants.values();
  }

  /** The user's tenant, if it exists (never creates one). */
  get(userId: string): Tenant | undefined {
    return this.tenants.get(userId);
  }

  /** The user's tenant, created on first use. */
  for(userId: string): Tenant {
    let tenant = this.tenants.get(userId);
    if (!tenant) {
      const core = createCore({
        bridge: {
          auth: { kind: "relay" },
          offlineWaitMs: this.o.offlineWaitMs ?? 45_000,
          daemonVersion: this.o.version,
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
      });
      tenant = { userId, core, lastUsed: this.now() };
      this.tenants.set(userId, tenant);
      log.info(`relay: tenant created (${this.tenants.size} active)`);
    }
    tenant.lastUsed = this.now();
    return tenant;
  }

  /** Drop tenants with no browser connected, no sessions and no recent use. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - (this.o.tenantIdleMs ?? 10 * 60_000);
    for (const [userId, t] of this.tenants) {
      if (t.lastUsed > cutoff || t.core.bridge.connected || t.core.registry.size > 0) continue;
      this.tenants.delete(userId);
      await t.core.close({ save: false });
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const all = [...this.tenants.values()];
    this.tenants.clear();
    await Promise.allSettled(all.map((t) => t.core.close({ save: false })));
  }
}
