import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { V2_DEFAULT_GROUP_NAME } from "@tabcrew/shared/v2";
import { log } from "../log.js";
import type { Session } from "../sessions.js";
import { callTool, closeSession, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

export const SERVER_INSTRUCTIONS = [
  "TabCrew drives the user's real browser (Chrome). Each agent or subagent opens its own session with session_open and passes the handle on every call.",
  `By default all agents' tabs share one TabCrew window and one tab group ("${V2_DEFAULT_GROUP_NAME}" unless the user renamed it); you only see and control your own tabs. Pass session_open({group}) to work in a named group; group_list and group_rename manage TabCrew groups (never the user's own).`,
  "Prefer browse for multi-step goals, observe/act for precise control, read_text for long content. browse's DONE is a claim: verify the page.",
  "When your task is finished, close any throwaway tabs with tab_close, then call session_close: by default your remaining tabs stay open for the user to review (the user picks the default in the TabCrew popup; pass tabs \"keep\", \"close\" or \"collect\" to choose), and you no longer control them. Sessions left open are finished the same way, with the user's default, when your connection ends or after they sit idle.",
].join(" ");

/**
 * One MCP protocol server per MCP session; all share the same browser-session registry. Browser
 * sessions opened over this connection are ended when the connection closes: their tabs finish
 * with the user's default finish mode (stopped sessions' tabs are left as they are).
 */
export function createProtocolServer(opts: ToolContext, version: string, isShuttingDown: () => boolean): Server {
  const server = new Server(
    { name: "tabcrew", version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const opened = new Set<Session>();
  const ctx: ToolContext = { ...opts, onSessionOpened: (session) => opened.add(session) };
  server.onclose = () => {
    // A daemon restart closes every connection too; agents' sessions must survive that.
    if (isShuttingDown()) return;
    for (const session of opened) {
      void closeSession(opts, session, !session.stopped)
        .then((r) => {
          if (r.closed) log.info(`session ${session.short_id} ended (MCP connection ended; ${r.kept_tabs} tab(s) handed to the user)`);
        })
        .catch(() => {});
    }
    opened.clear();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const result = await callTool(ctx, request.params.name, request.params.arguments);
    log.debug(`tool ${request.params.name} ${Math.round(performance.now() - started)} ms${result.isError ? " error" : ""}`);
    return result;
  });
  return server;
}
