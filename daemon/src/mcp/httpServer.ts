import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { hostAllowed } from "../localhost.js";
import { log } from "../log.js";
import { safeEqual } from "../token.js";
import { createProtocolServer } from "./protocol.js";
import type { ToolContext } from "./tools.js";

export { SERVER_INSTRUCTIONS } from "./protocol.js";

export interface McpHttpOptions extends ToolContext {
  readonly token: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly version: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export class McpHttpServer {
  private http: HttpServer | null = null;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private shuttingDown = false;

  constructor(private readonly opts: McpHttpOptions) {}

  get mcpSessionCount(): number {
    return this.transports.size;
  }

  async start(): Promise<number> {
    const http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error(`mcp http: ${(err as Error).message}`);
        jsonRpcError(res, 500, "internal error");
      });
    });
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.opts.port, "127.0.0.1", () => resolve());
    });
    return (http.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    const transports = [...this.transports.values()];
    this.transports.clear();
    await Promise.allSettled(transports.map((t) => t.close()));
    if (!this.http) return;
    const http = this.http;
    this.http = null;
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    if (origin !== undefined && !this.opts.allowedOrigins.includes(origin)) {
      sendJson(res, 403, { error: "forbidden", message: "origin not allowed" });
      return;
    }
    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { error: "forbidden", message: "host not allowed" });
      return;
    }

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      sendJson(res, 200, { ok: true, version: this.opts.version, extension_connected: this.opts.bridge.connected });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const presented = bearer(req);
    if (presented === null || !safeEqual(presented, this.opts.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="tabcrew"');
      sendJson(res, 401, { error: "unauthorized", message: "missing or invalid bearer token" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? this.transports.get(sessionId) : undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        jsonRpcError(res, 400, (err as Error).message);
        return;
      }
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (sessionId === undefined && isInitializeRequest(body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) this.transports.delete(transport.sessionId);
        };
        await createProtocolServer(this.opts, this.opts.version, () => this.shuttingDown).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (sessionId !== undefined) {
        sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "MCP session not found" }, id: null });
        return;
      }
      jsonRpcError(res, 400, "no valid MCP session id");
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        sendJson(res, sessionId === undefined ? 400 : 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "MCP session not found" },
          id: null,
        });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    res.setHeader("allow", "GET, POST, DELETE");
    sendJson(res, 405, { error: "method_not_allowed" });
  }
}
