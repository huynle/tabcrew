import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { daemonVersion } from "@tabcrew/daemon/dist/daemon.js";
import { log } from "@tabcrew/daemon/dist/log.js";
import { createProtocolServer } from "@tabcrew/daemon/dist/mcp/protocol.js";
import { isTabcrewExtensionOrigin, tabcrewExtensionOrigins } from "@tabcrew/shared/product";
import { V2_CLOSE_BAD_HELLO } from "@tabcrew/shared/v2";
import { WebSocketServer, type WebSocket } from "ws";
import type { Provider } from "./auth/providers.js";
import { AuthServer } from "./auth/server.js";
import { bearer, readBody, sendJson } from "./http.js";
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
}

export async function startRelay(o: RelayOptions): Promise<RunningRelay> {
  if (o.signingKey.length < 32) throw new Error("signing key must be at least 32 bytes");
  await o.store.init();
  const version = daemonVersion();
  const now = o.now ?? Date.now;
  const extensionOrigins = o.extensionOrigins ?? tabcrewExtensionOrigins();
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
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version });
      return;
    }
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }
    if (await auth!.handle(req, res, url)) return;
    sendJson(res, 404, { error: "not_found" });
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const claims = auth!.verify(bearer(req), "mcp");
    if (!claims) {
      sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${auth!.resourceMetadataUrl}"` });
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
      if (existing) {
        tenants.for(claims.sub);
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId !== undefined) return notFound();
      if (!isInitializeRequest(body)) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "no valid MCP session id" }, id: null });
        return;
      }
      const tenant = tenants.for(claims.sub);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, { transport, userId: claims.sub });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
      };
      await createProtocolServer(tenant.core.ctx, version, () => shuttingDown).connect(transport);
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
      if (hello?.type !== "hello" || !claims) {
        ws.close(V2_CLOSE_BAD_HELLO, "bad hello");
        return;
      }
      delete hello.token;
      log.info("relay: browser connected");
      tenants.for(claims.sub).core.bridge.attach(ws, hello);
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
    accessTtlSec: o.accessTtlSec,
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
