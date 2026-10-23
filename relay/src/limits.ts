import type { IncomingMessage } from "node:http";

/** Per-user and per-IP limits of a public relay. */
export interface Limits {
  /** Sign-in endpoints (/register, /authorize, /token, /auth/*, /account/login) per client IP. */
  readonly authPerMinute: number;
  /** /mcp requests per user: burst and sustained rate. */
  readonly mcpBurst: number;
  readonly mcpPerSecond: number;
  /** Browsers signed in per user. */
  readonly maxBrowsers: number;
  /** Open browser sessions per user, across their browsers. */
  readonly maxSessions: number;
}

export const DEFAULT_LIMITS: Limits = {
  authPerMinute: 60,
  mcpBurst: 120,
  mcpPerSecond: 20,
  maxBrowsers: 10,
  maxSessions: 50,
};

/** Classic token bucket per key; idle keys are dropped so memory stays bounded. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(private readonly o: { readonly capacity: number; readonly refillPerSec: number; readonly now?: () => number }) {
    this.now = o.now ?? Date.now;
  }

  take(key: string): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.o.capacity, at: now };
    b.tokens = Math.min(this.o.capacity, b.tokens + ((now - b.at) / 1000) * this.o.refillPerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.prune(now);
    return ok;
  }

  private prune(now: number): void {
    const full = this.o.refillPerSec > 0 ? (this.o.capacity / this.o.refillPerSec) * 1000 : Infinity;
    for (const [k, b] of this.buckets) if (now - b.at > full) this.buckets.delete(k);
  }
}

/**
 * The client address. Behind a trusted reverse proxy (ingress) the proxy appends the client to
 * X-Forwarded-For, so the right-most entry is the one it saw; otherwise the socket address.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
