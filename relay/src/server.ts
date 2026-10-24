import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { daemonVersion } from "@tabcrew/daemon/dist/daemon.js";
import { log } from "@tabcrew/daemon/dist/log.js";
import { isTabcrewExtensionOrigin, tabcrewExtensionOrigins } from "@tabcrew/shared/product";
import { V2_CLOSE_BAD_HELLO } from "@tabcrew/shared/v2";
import { WebSocketServer, type WebSocket } from "ws";
import { AccountPages } from "./account.js";
import type { Provider } from "./auth/providers.js";
import { AuthServer } from "./auth/server.js";
import { bearer, readBody, sendJson } from "./http.js";
import { sitePage } from "./site.js";
import { clientIp, DEFAULT_LIMITS, TokenBucket, type Limits } from "./limits.js";
import { createRelayProtocolServer } from "./mcpServer.js";
import type { Store } from "./store/types.js";
import { TenantManager } from "./tenants.js";

export interface RelayOptions {
  readonly store: Store;
  /** HMAC key for access tokens (at least 32 bytes). */
  readonly signingKey: Buffer;
  readonly providers: readonly Provider[];
  /** Public base URL (no trailing slash). Default `http://<host>:<port>` after listening. */
  readonly publicUrl?: string;
  readonly host?: string;
  readonly port: number;
  /** Extension origins allowed on /ext and as chromiumapp.org redirects. Default: the TabCrew extension IDs. */
  readonly extensionOrigins?: readonly string[];
  readonly offlineWaitMs?: number;
  readonly sessionIdleMs?: number;
  readonly tenantIdleMs?: number;
  readonly helloTimeoutMs?: number;
  readonly accessTtlSec?: number;
  readonly now?: () => number;
  /** Per-user and per-IP limits (defaults: DEFAULT_LIMITS). */
  readonly limits?: Partial<Limits>;
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For (its right-most entry). */
  readonly trustProxy?: boolean;
  /** Tool calls and MCP replies at least this slow are logged at info (default 10 s). */
  readonly slowCallMs?: number;
}

export interface RunningRelay {
  readonly url: string;
  readonly port: number;
  readonly tenants: TenantManager;
  close(): Promise<void>;
}

const MAX_MCP_BODY = 4 * 1024 * 1024;
/** Screenshots travel extension -> relay; keep the frame cap below the daemon's 64 MB. */
const MAX_EXT_FRAME = 32 * 1024 * 1024;

interface McpSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly userId: string;
  readonly clientId: string;
}

/** Paths that start or finish a sign-in: rate-limited per client IP. */
const AUTH_PATHS = /^\/(register|authorize|token|auth\/[a-z]+(\/callback)?|account\/login)$/;

export async function startRelay(o: RelayOptions): Promise<RunningRelay> {
  if (o.signingKey.length < 32) throw new Error("signing key must be at least 32 bytes");
  await o.store.init();
  const version = daemonVersion();
  const now = o.now ?? Date.now;
  const extensionOrigins = o.extensionOrigins ?? tabcrewExtensionOrigins();
  const limits: Limits = { ...DEFAULT_LIMITS, ...o.limits };
  const authBucket = new TokenBucket({ capacity: limits.authPerMinute, refillPerSec: limits.authPerMinute / 60, now });
  const mcpBucket = new TokenBucket({ capacity: limits.mcpBurst, refillPerSec: limits.mcpPerSecond, now });
  const accessTtlSec = o.accessTtlSec ?? 15 * 60;
  const slowCallMs = o.slowCallMs ?? 10_000;
  /** `${userId}|${clientId}` -> until (ms): revoked clients whose access tokens may not have expired yet. */
  const revokedClients = new Map<string, number>();
  const tenants = new TenantManager({
    version,
    offlineWaitMs: o.offlineWaitMs,
    sessionIdleMs: o.sessionIdleMs,
    tenantIdleMs: o.tenantIdleMs,
    now,
  });
  const mcpSessions = new Map<string, McpSession>();
  let shuttingDown = false;
  let auth: AuthServer | null = null;
  let account: AccountPages | null = null;

  const http = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`relay: ${req.method} ${req.url?.split("?")[0]}: ${(err as Error).message}`);
      sendJson(res, 500, { error: "internal" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay");
    if (!auth) {
      sendJson(res, 503, { error: "starting" });
      return;
    }
    if (AUTH_PATHS.test(url.pathname) && !authBucket.take(clientIp(req, o.trustProxy === true))) {
      sendJson(res, 429, { error: "too_many_requests", error_description: "too many sign-in requests; wait a minute" }, { "retry-after": "60" });
      return;
    }
    if ((url.pathname === "/health" || url.pathname === "/healthz") && req.method === "GET") {
      sendJson(res, 200, { ok: true, version });
      return;
    }
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }
    if (url.pathname === "/token") {
      // The extension's service worker calls /token from its chrome-extension:// origin; no other
      // origin (web pages) may read token replies.
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!isTabcrewExtensionOrigin(origin, extensionOrigins)) {
          sendJson(res, 403, { error: "invalid_request", error_description: "origin not allowed" });
          return;
        }
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        if (req.method === "OPTIONS") {
          res.writeHead(204, { "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }).end();
          return;
        }
      }
    }
    if (sitePage(req, res, url, publicUrl)) return;
    if (await account!.handle(req, res, url)) return;
    if (await auth!.handle(req, res, url)) return;
    sendJson(res, 404, { error: "not_found" });
  }

  /** Log MCP POST replies that were cut off before they were sent, or sent late (never args or ids). */
  function watchReply(res: ServerResponse, body: unknown): void {
    const started = now();
    const what = describeRpc(body);
    res.once("close", () => {
      const ms = Math.round(now() - started);
      if (!res.writableFinished) log.warn(`relay: MCP reply cut off after ${ms} ms (${what})`);
      else if (ms >= slowCallMs) log.info(`relay: MCP reply sent after ${ms} ms (${what}, HTTP ${res.statusCode})`);
    });
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verified = auth!.verify(bearer(req), "mcp");
    const revokedUntil = verified ? revokedClients.get(`${verified.sub}|${verified.cid}`) : undefined;
    const claims = verified && !(revokedUntil !== undefined && revokedUntil > now()) ? verified : null;
    if (!claims) {
      sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${auth!.resourceMetadataUrl}"` });
      return;
    }
    if (!mcpBucket.take(claims.sub)) {
      sendJson(res, 429, { jsonrpc: "2.0", error: { code: -32000, message: "too many requests; slow down" }, id: null }, { "retry-after": "1" });
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const found = typeof sessionId === "string" ? mcpSessions.get(sessionId) : undefined;
    // Another user's MCP session id looks exactly like an unknown one.
    const existing = found && found.userId === claims.sub ? found : undefined;
    const notFound = () => sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "MCP session not found" }, id: null });

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req, MAX_MCP_BODY);
      } catch (err) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null });
        return;
      }
      watchReply(res, body);
      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId !== undefined) return notFound();
      if (!isInitializeRequest(body)) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "no valid MCP session id" }, id: null });
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, { transport, userId: claims.sub, clientId: claims.cid });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
      };
      transport.onerror = (err) => log.warn(`relay: MCP transport error: ${String(err?.message ?? err).slice(0, 200)}`);
      await createRelayProtocolServer({
        userId: claims.sub,
        tenants,
        store: o.store,
        version,
        maxSessions: limits.maxSessions,
        isShuttingDown: () => shuttingDown,
        now,
        slowCallMs,
      }).connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) return notFound();
      await existing.transport.handleRequest(req, res);
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET, POST, DELETE" });
  }

  // --- /ext: the user's browser ------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_EXT_FRAME });
  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    const origin = req.headers.origin;
    if (path !== "/ext" || !auth) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return;
    }
    // Only the TabCrew extension: web pages, unknown extensions and Origin-less clients are refused.
    if (!isTabcrewExtensionOrigin(origin, extensionOrigins)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => acceptExtension(ws));
  });

  function acceptExtension(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(V2_CLOSE_BAD_HELLO, "hello timeout"), o.helloTimeoutMs ?? 5_000);
    ws.on("error", () => {});
    ws.once("message", (data) => {
      clearTimeout(timer);
      let hello: Record<string, unknown>;
      try {
        hello = JSON.parse(data.toString());
      } catch {
        ws.close(V2_CLOSE_BAD_HELLO, "invalid hello");
        return;
      }
      const token = typeof hello?.token === "string" ? hello.token : null;
      const claims = auth!.verify(token, "ext");
      if (hello?.type !== "hello" || !claims?.bid) {
        log.warn(`relay: refused a browser (${hello?.type !== "hello" ? "no hello" : token ? "invalid or expired ext token" : "no token"})`);
        ws.close(V2_CLOSE_BAD_HELLO, "bad hello");
        return;
      }
      delete hello.token;
      // A revoked browser's access token may not have expired yet: check the browser itself.
      void o.store
        .getBrowser(claims.bid)
        .then((browser) => {
          if (!browser || browser.userId !== claims.sub || browser.revoked) {
            log.warn(`relay: refused a browser (${!browser ? "unknown browser" : browser.revoked ? "browser revoked" : "browser of another user"})`);
            ws.close(V2_CLOSE_BAD_HELLO, "sign-in revoked");
            return;
          }
          log.info("relay: browser connected");
          tenants.forBrowser(claims.sub, browser.id, browser.name).core.bridge.attach(ws, hello);
        })
        .catch((err) => {
          log.error(`relay: browser lookup failed: ${(err as Error).message}`);
          ws.close(1011, "internal error");
        });
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(o.port, o.host ?? "0.0.0.0", () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  const publicUrl = (o.publicUrl ?? `http://${o.host ?? "127.0.0.1"}:${port}`).replace(/\/$/, "");
  auth = new AuthServer({
    publicUrl,
    store: o.store,
    signingKey: o.signingKey,
    providers: o.providers,
    extensionOrigins,
    now,
    accessTtlSec,
    maxBrowsers: limits.maxBrowsers,
  });
  account = new AccountPages({
    publicUrl,
    store: o.store,
    auth,
    providers: o.providers,
    tenants,
    signingKey: o.signingKey,
    refreshTtlMs: 30 * 24 * 3600 * 1000,
    revokeClient(userId, clientId) {
      for (const [key, until] of revokedClients) if (until <= now()) revokedClients.delete(key);
      revokedClients.set(`${userId}|${clientId}`, now() + accessTtlSec * 1000);
      for (const [id, s] of mcpSessions) {
        if (s.userId !== userId || s.clientId !== clientId) continue;
        mcpSessions.delete(id);
        void s.transport.close();
      }
    },
  });
  log.info(`tabcrew-relay ${version} listening on ${port} as ${publicUrl}`);

  return {
    url: publicUrl,
    port,
    tenants,
    async close() {
      shuttingDown = true;
      await Promise.allSettled([...mcpSessions.values()].map((s) => s.transport.close()));
      mcpSessions.clear();
      for (const c of wss.clients) c.terminate();
      await tenants.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      await o.store.close();
    },
  };
}

/** "tools/call act", "tools/list", "batch of 2", ...: the JSON-RPC method (and tool name) only. */
function describeRpc(body: unknown): string {
  if (Array.isArray(body)) return `batch of ${body.length}`;
  const m = body as { method?: unknown; params?: { name?: unknown } } | undefined;
  const method = typeof m?.method === "string" ? m.method.slice(0, 40) : "response";
  const tool = method === "tools/call" && typeof m?.params?.name === "string" ? ` ${m.params.name.slice(0, 40)}` : "";
  return method + tool;
}
