import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "@tabcrew/daemon/dist/log.js";
import { SERVER_INSTRUCTIONS } from "@tabcrew/daemon/dist/mcp/protocol.js";
import { callTool, closeSession, TOOL_DEFINITIONS, type ToolContext } from "@tabcrew/daemon/dist/mcp/tools.js";
import type { Session } from "@tabcrew/daemon/dist/sessions.js";
import type { V2ErrorCode } from "@tabcrew/shared/v2";
import type { Store } from "./store/types.js";
import type { BrowserTenant, TenantManager } from "./tenants.js";

const BROWSER_PROP = {
  type: "string",
  description:
    "Name of the signed-in browser to work in (see browser_list). Default: the most recently connected browser that is online.",
} as const;

/** The daemon's tools, with `browser` on session_open, plus browser_list. */
export const RELAY_TOOLS: Tool[] = [
  ...TOOL_DEFINITIONS.map((tool) =>
    tool.name === "session_open"
      ? {
          ...tool,
          description: `${tool.description} TabCrew Online: the user may have several browsers signed in; pass browser to pick one (browser_list shows them).`,
          inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, browser: BROWSER_PROP } },
        }
      : tool,
  ),
  {
    name: "browser_list",
    description: "List the user's browsers signed in to TabCrew Online: name, whether it is online now, and when it last connected.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const RELAY_INSTRUCTIONS = `${SERVER_INSTRUCTIONS} This is TabCrew Online: the user's browsers connect through a relay. If the user has several browsers signed in, call browser_list and pass session_open({browser}).`;

const BAD_SESSION = "unknown or closed session; call session_open and use the returned handle";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(code: V2ErrorCode, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
}

export interface RelayProtocolDeps {
  readonly userId: string;
  readonly tenants: TenantManager;
  readonly store: Store;
  readonly version: string;
  readonly maxSessions: number;
  readonly isShuttingDown: () => boolean;
  readonly now?: () => number;
}

/**
 * One MCP protocol server per MCP session of one user. session_open picks a browser and the
 * returned handle is remembered with it; every other tool runs in the core of the browser its
 * handle belongs to. Handles of other users are unknown here (bad_session, like a made-up one).
 * Sessions opened over this connection end when it closes, as in the daemon.
 */
export function createRelayProtocolServer(d: RelayProtocolDeps): Server {
  const server = new Server({ name: "tabcrew", version: d.version }, { capabilities: { tools: {} }, instructions: RELAY_INSTRUCTIONS });
  const opened: { tenant: BrowserTenant; session: Session }[] = [];
  const now = d.now ?? Date.now;

  const ctxFor = (tenant: BrowserTenant): ToolContext => ({
    ...tenant.core.ctx,
    onSessionOpened: (session) => opened.push({ tenant, session }),
  });

  server.onclose = () => {
    if (d.isShuttingDown()) return;
    for (const { tenant, session } of opened.splice(0)) {
      void closeSession(tenant.core.ctx, session, !session.stopped)
        .then((r) => {
          if (r.closed) log.info(`session ${session.short_id} ended (MCP connection ended; ${r.kept_tabs} tab(s) handed to the user)`);
        })
        .catch(() => {});
    }
  };

  async function browserList() {
    const live = new Map(d.tenants.ofUser(d.userId).map((t) => [t.browserId, t]));
    const browsers = (await d.store.listBrowsers(d.userId)).map((b) => {
      const t = live.get(b.id);
      return {
        name: b.name,
        online: t?.core.bridge.connected === true,
        last_connected: t?.lastConnected ? new Date(t.lastConnected).toISOString() : null,
        extension_version: t?.core.bridge.version ?? null,
      };
    });
    return browsers.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function openSession(args: Record<string, unknown>): Promise<CallToolResult> {
    const browsers = await d.store.listBrowsers(d.userId);
    if (browsers.length === 0) {
      return fail(
        "extension_offline",
        "no browser is signed in to TabCrew Online for this account; ask the user to sign in the TabCrew extension (Connection: Online) first",
      );
    }
    let chosen = undefined as (typeof browsers)[number] | undefined;
    if (args.browser !== undefined) {
      chosen = browsers.find((b) => b.name === args.browser);
      if (!chosen) {
        return fail("invalid_args", `unknown browser ${JSON.stringify(String(args.browser).slice(0, 60))}; signed-in browsers: ${browsers.map((b) => b.name).join(", ")}`);
      }
    } else {
      const live = d.tenants.ofUser(d.userId).filter((t) => browsers.some((b) => b.id === t.browserId));
      const pick =
        live.filter((t) => t.core.bridge.connected).sort((a, b) => b.lastConnected - a.lastConnected)[0] ??
        live.sort((a, b) => b.lastConnected - a.lastConnected)[0];
      chosen = (pick && browsers.find((b) => b.id === pick.browserId)) ?? browsers[0];
    }
    if (d.tenants.sessionCount(d.userId) >= d.maxSessions) {
      return fail("invalid_args", `at most ${d.maxSessions} open sessions per account; close finished sessions with session_close first`);
    }
    const tenant = d.tenants.forBrowser(d.userId, chosen!.id, chosen!.name);
    const { browser: _browser, ...rest } = args;
    const result = await callTool(ctxFor(tenant), "session_open", rest);
    if (result.isError) return result;
    const text = result.content.find((c) => c.type === "text");
    const value = text && text.type === "text" ? (JSON.parse(text.text) as Record<string, unknown>) : {};
    if (typeof value.session === "string") d.tenants.rememberHandle(d.userId, value.session, tenant.browserId);
    return ok({ ...value, browser: tenant.name });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: RELAY_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = now();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let result: CallToolResult;
    if (name === "browser_list") {
      result = ok({ browsers: await browserList() });
    } else if (name === "session_open") {
      result = await openSession(args);
    } else {
      const tenant = d.tenants.byHandle(d.userId, args.session);
      // Unknown tools are reported by callTool; anything else needs a handle of this user.
      result = tenant ? await callTool(ctxFor(tenant), name, args) : RELAY_TOOLS.some((t) => t.name === name) ? fail("bad_session", BAD_SESSION) : await callTool({} as ToolContext, name, args);
    }
    log.debug(`relay tool ${name} ${Math.round(now() - started)} ms${result.isError ? " error" : ""}`);
    return result;
  });
  return server;
}
