import { chmodSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.js";
import { createProtocolServer } from "./protocol.js";
import type { ToolContext } from "./tools.js";

export interface McpSocketServerOptions extends ToolContext {
  /**
   * Unix socket to listen on. Its directory must be private (0700, owned by the user): the socket is
   * chmod 0600 right after it is created, and file permissions are the only authentication.
   */
  readonly socketPath: string;
  readonly version: string;
  /** Called after every connect/disconnect with the new number of connections. */
  readonly onConnectionCountChange?: (count: number) => void;
  /** Called when the last connection closes (not while shutting down). */
  readonly onIdle?: () => void;
}

/** StdioServerTransport over a socket whose `send` never hangs on a socket that went away. */
class SocketServerTransport extends StdioServerTransport {
  constructor(private readonly sock: Socket) {
    super(sock, sock);
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.sock.destroyed || !this.sock.writable) {
        resolve();
        return;
      }
      if (this.sock.write(serializeMessage(message))) {
        resolve();
        return;
      }
      this.sock.once("drain", resolve);
      this.sock.once("close", resolve);
    });
  }
}

/**
 * MCP over a Unix socket (hub mode): newline-delimited JSON-RPC, exactly what `tabcrew mcp` relays
 * from its stdio. One MCP protocol server per connection, all sharing the browser-session registry;
 * when a connection closes, the browser sessions it opened are handed to the user.
 */
export class McpSocketServer {
  private server: NetServer | null = null;
  private readonly sockets = new Set<Socket>();
  private shuttingDown = false;

  constructor(private readonly opts: McpSocketServerOptions) {}

  get connectionCount(): number {
    return this.sockets.size;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  /** Listen on `socketPath`. Rejects (e.g. EADDRINUSE) if it exists; stale-socket cleanup is the caller's job. */
  async start(): Promise<void> {
    const server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(this.opts.socketPath, 0o600);
    } catch (err) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw err;
    }
    server.on("error", (err) => log.error(`mcp socket: ${err.message}`));
    this.server = server;
  }

  /** Stop listening and drop every connection. Sessions survive (as on a daemon restart). */
  async close(): Promise<void> {
    this.shuttingDown = true;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    this.notify(() => this.opts.onConnectionCountChange?.(this.sockets.size));
    const transport = new SocketServerTransport(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      this.sockets.delete(socket);
      // StdioServerTransport does not watch its stream for 'close'; closing it ends the MCP server,
      // which hands this connection's browser sessions to the user.
      void transport.close();
      this.notify(() => this.opts.onConnectionCountChange?.(this.sockets.size));
      if (this.sockets.size === 0 && !this.shuttingDown) this.notify(() => this.opts.onIdle?.());
    });
    createProtocolServer(this.opts, this.opts.version, () => this.shuttingDown)
      .connect(transport)
      .catch((err) => {
        log.error(`mcp socket: connect failed: ${(err as Error).message}`);
        socket.destroy();
      });
  }

  private notify(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error(`mcp socket: listener failed: ${(err as Error).message}`);
    }
  }
}
