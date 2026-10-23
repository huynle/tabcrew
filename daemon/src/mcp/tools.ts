import {
  V2_DEFAULT_GROUP_NAME,
  V2_FINISH_MODES,
  V2_GROUP_NAME_MAX_LENGTH,
  v2IsFinishMode,
  v2NormaliseGroupName,
  type V2ConsoleEntry,
  type V2FinishMode,
  type V2NetworkEntry,
} from "@tabcrew/shared/v2";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionBridge } from "../bridge.js";
import { DaemonError, toV2Error } from "../errors.js";
import { DEFAULT_MAX_STEPS, MAX_GOAL, MAX_MAX_STEPS, runBrowse, type JevRuntime } from "../jev/browse.js";
import { isCode, onTab } from "../lanes.js";
import { log } from "../log.js";
import {
  actionSpace,
  checkSnapshot,
  MAX_TYPE_TEXT,
  OPERATIONS,
  resolveAct,
  toObservation,
  type ObservationCache,
} from "../observe.js";
import type { Scheduler } from "../scheduler.js";
import { sessionRef, type Session, type SessionRegistry } from "../sessions.js";

export interface ToolContext {
  readonly registry: SessionRegistry;
  readonly bridge: ExtensionBridge;
  readonly scheduler: Scheduler;
  readonly observations: ObservationCache;
  readonly jev: JevRuntime;
  /** Called when this connection opens a browser session, so it can be closed if the connection goes away. */
  readonly onSessionOpened?: (session: Session) => void;
}

const SESSION_HINT = "Your session handle from session_open. Never share it with other agents.";

const sessionArg = z.string().min(1).max(200);
const tabIdArg = z.number().int().nonnegative();
const urlArg = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => URL.canParse(v), "must be an absolute URL");

const httpUrlArg = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), "must be an absolute http(s) URL");

export const READ_TEXT_DEFAULT = 20_000;
export const READ_TEXT_MAX = 100_000;
export const LOGS_DEFAULT = 50;
export const LOGS_MAX = 200;

const schemas = {
  session_open: z.object({ label: z.string().max(200).optional(), group: z.string().max(200).optional() }),
  session_close: z.object({ session: sessionArg, tabs: z.enum(V2_FINISH_MODES).optional() }),
  group_rename: z.object({ session: sessionArg, name: z.string().max(200), group: z.string().max(200).optional() }),
  group_list: z.object({ session: sessionArg }),
  tab_create: z.object({ session: sessionArg, url: urlArg.optional() }),
  tab_list: z.object({ session: sessionArg }),
  tab_close: z.object({ session: sessionArg, tab_id: tabIdArg }),
  screenshot: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  observe: z.object({ session: sessionArg, tab_id: tabIdArg }),
  act: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    fingerprint: z.string().min(1).max(200),
    operation: z.enum(OPERATIONS),
    target: z.union([z.string().max(32), z.number().int().nonnegative()]).optional(),
    text: z.string().max(MAX_TYPE_TEXT).optional(),
  }),
  browse: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    goal: z
      .string()
      .max(MAX_GOAL)
      .refine((v) => v.trim().length > 0, "must not be empty"),
    max_steps: z.number().int().min(1).max(MAX_MAX_STEPS).optional(),
  }),
  navigate: z
    .object({
      session: sessionArg,
      tab_id: tabIdArg,
      url: httpUrlArg.optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
    })
    .refine((v) => (v.url === undefined) !== (v.action === undefined), "give exactly one of url or action"),
  read_text: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    max_length: z.number().int().min(1).max(READ_TEXT_MAX).optional(),
  }),
  debug_logs: z.object({
    session: sessionArg,
    tab_id: tabIdArg,
    source: z.enum(["console", "network"]),
    limit: z.number().int().min(1).max(LOGS_MAX).optional(),
    only_errors: z.boolean().optional(),
  }),
};
type ToolName = keyof typeof schemas;

const sessionProp = { type: "string", description: SESSION_HINT } as const;
const tabIdProp = { type: "integer", minimum: 0, description: "Tab id from tab_create or tab_list." } as const;
const GROUP_NAME_RULES = `1-${V2_GROUP_NAME_MAX_LENGTH} characters, not starting with "✓ "`;

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "session_open",
    description:
      `Open a private browser session and get its handle. Open one session per agent or subagent, pass the handle on every call, and never share it. Your tabs open in one TabCrew window, in a tab group shared by all agents ("${V2_DEFAULT_GROUP_NAME}" unless the user renamed it); you only see and control your own tabs there. Pass group to join or create a named TabCrew group instead. When your task is finished, call session_close (close any throwaway tabs first with tab_close): by default your tabs are left for the user to review.`,
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short name for your session, e.g. your task." },
        group: {
          type: "string",
          description: `Name of the TabCrew tab group to join, created if missing (${GROUP_NAME_RULES}). Default: the shared "${V2_DEFAULT_GROUP_NAME}" group.`,
        },
      },
    },
  },
  {
    name: "session_close",
    description:
      `Finish your session and hand its tabs to the user for review; you no longer control them afterwards. tabs picks what happens to them: "keep" leaves them in their TabCrew group, marked finished; "close" closes them; "collect" moves them into one collapsed "✓ ${V2_DEFAULT_GROUP_NAME}" group of finished tabs. Omit tabs to use the user's choice from the TabCrew popup (normally "keep"). Close any throwaway tabs first with tab_close. Call this as soon as you are done with the browser; do not leave sessions open.`,
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tabs: {
          type: "string",
          enum: [...V2_FINISH_MODES],
          description: "What happens to your tabs. Default: the user's choice in the TabCrew popup.",
        },
      },
      required: ["session"],
    },
  },
  {
    name: "group_rename",
    description:
      "Rename a TabCrew tab group: your own group by default, or the TabCrew group named in group (see group_list). Every agent in that group keeps its tabs and keeps working; the user's own tab groups are never touched. Returns the new and the previous name.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        name: { type: "string", description: `New group name (${GROUP_NAME_RULES}).` },
        group: { type: "string", description: "Current name of the TabCrew group to rename. Default: your own group." },
      },
      required: ["session", "name"],
    },
  },
  {
    name: "group_list",
    description:
      "List the names of the TabCrew tab groups, with mine: true for the group your session is in. The user's own groups and other agents' tabs are never listed.",
    inputSchema: { type: "object", properties: { session: sessionProp }, required: ["session"] },
  },
  {
    name: "tab_create",
    description: "Open a background tab in your session (optionally at a URL). Returns its tab_id.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, url: { type: "string", description: "Absolute URL to open." } },
      required: ["session"],
    },
  },
  {
    name: "tab_list",
    description: "List the tabs in your session (only yours).",
    inputSchema: { type: "object", properties: { session: sessionProp }, required: ["session"] },
  },
  {
    name: "tab_close",
    description: "Close one of your session's tabs.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, tab_id: tabIdProp },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "screenshot",
    description: "Capture the visible part of one of your tabs as an image.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
        quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality." },
      },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "observe",
    description:
      "For precise step-by-step control. Read one of your tabs: URL, title, visible text, a numbered element table (each element lists the operations it supports; selects list options as \"<index>:<n>\"), available controls, and a fingerprint to pass to act. Scroll controls for an open dialog or a scrollable panel carry a target like \"s1\"; while a modal dialog is open, the table and text cover the dialog, not the page behind it.",
    inputSchema: {
      type: "object",
      properties: { session: sessionProp, tab_id: tabIdProp },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "act",
    description:
      "Do one operation on a tab, using the fingerprint and element indices from your latest observe of that tab. CLICK/TYPE_TEXT take an element index, SELECT takes an option index like \"3:2\", SCROLL_UP/SCROLL_DOWN take the target of a listed scroll control (\"s1\" for a dialog or panel, \"page\") or no target for the first listed one, WAIT takes no target. Targets are scrolled into view before they are clicked or typed into. Returns stale_page (nothing done) if the page changed. Always observe again after act.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        fingerprint: { type: "string", description: "fingerprint from your latest observe of this tab." },
        operation: { type: "string", enum: [...OPERATIONS] },
        target: {
          type: ["string", "integer"],
          description:
            "Element index (CLICK, TYPE_TEXT), option index like \"3:2\" (SELECT), or scroll target like \"s1\" / \"page\" (SCROLL_UP, SCROLL_DOWN; omit for the first listed).",
        },
        text: { type: "string", maxLength: MAX_TYPE_TEXT, description: "Text to enter; required for TYPE_TEXT." },
      },
      required: ["session", "tab_id", "fingerprint", "operation"],
    },
  },
  {
    name: "browse",
    description:
      "Preferred for multi-step goals. Let Jev pursue a natural-language goal on one of your tabs: it repeatedly observes, chooses one operation (CLICK, TYPE_TEXT, SELECT, scroll, WAIT) and acts, until DONE, BLOCKED, no progress, max_steps, or Stop. Returns a status, the step trace, the final URL/title and a short element table, and model usage/cost. DONE is only Jev's claim: verify the result with observe or screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        goal: { type: "string", maxLength: MAX_GOAL, description: "What to achieve on this tab, in plain language, with every required value." },
        max_steps: { type: "integer", minimum: 1, maximum: MAX_MAX_STEPS, description: `Maximum actions (default ${DEFAULT_MAX_STEPS}).` },
      },
      required: ["session", "tab_id", "goal"],
    },
  },
  {
    name: "navigate",
    description:
      "Open an http(s) URL in one of your tabs, or go back, forward or reload. Waits for the page to load (at most 15 s) and returns the tab's URL and title. Observe again afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        url: { type: "string", description: "Absolute http(s) URL. Give url or action, not both." },
        action: { type: "string", enum: ["back", "forward", "reload"] },
      },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "read_text",
    description:
      "Read the full text of one of your tabs (the whole page, not just the visible part). Best for reading long content; use observe for elements to act on.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        max_length: {
          type: "integer",
          minimum: 1,
          maximum: READ_TEXT_MAX,
          description: `Maximum characters (default ${READ_TEXT_DEFAULT}).`,
        },
      },
      required: ["session", "tab_id"],
    },
  },
  {
    name: "debug_logs",
    description:
      "For debugging a page: recent console messages or network requests of one of your tabs (newest last). Network entries show method, URL without query string, status, type and timing; never headers or bodies.",
    inputSchema: {
      type: "object",
      properties: {
        session: sessionProp,
        tab_id: tabIdProp,
        source: { type: "string", enum: ["console", "network"] },
        limit: { type: "integer", minimum: 1, maximum: LOGS_MAX, description: `Newest entries to return (default ${LOGS_DEFAULT}).` },
        only_errors: { type: "boolean", description: "Console errors/exceptions, or failed / HTTP >= 400 requests only." },
      },
      required: ["session", "tab_id", "source"],
    },
  },
];

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(toV2Error(err)) }] };
}

function parseArgs<N extends ToolName>(name: N, args: unknown): z.infer<(typeof schemas)[N]> {
  const parsed = schemas[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new DaemonError("invalid_args", `${where}${issue.message}`);
  }
  return parsed.data as z.infer<(typeof schemas)[N]>;
}

/** Run one tool call. Never throws: errors become `isError` results with `{code, message}`. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<CallToolResult> {
  try {
    if (!(name in schemas)) throw new DaemonError("invalid_args", `unknown tool ${name}`);
    return await dispatch(ctx, name as ToolName, args);
  } catch (err) {
    if (!(err instanceof DaemonError)) log.error(`tool ${name} failed: ${(err as Error)?.message ?? "error"}`);
    return fail(err);
  }
}

/** Queue `fn` on the session's lane (tab creation and listing). */
function onSession<T>(ctx: ToolContext, session: Session, fn: () => Promise<T>): Promise<T> {
  return ctx.scheduler.runSession(session.short_id, async () => {
    ctx.registry.requireActive(session);
    return fn();
  });
}

/** Legacy hand-over (extensions without shared groups): the group moved into the user's window. */
export const HANDED_OVER_NOTE = "Your tabs were handed to the user for review; you no longer control them.";

const FINISH_NOTES: Record<V2FinishMode, string> = {
  keep: "Your tabs stay in their TabCrew group, marked finished, for the user to review; you no longer control them.",
  close: "Your tabs were closed; you no longer control this session.",
  collect: `Your tabs were moved into the collapsed group of finished tabs ("✓ ${V2_DEFAULT_GROUP_NAME}" by default) for the user to review; you no longer control them.`,
};

/** The note session_close returns for the finish mode applied (legacy hand-over when unknown). */
export function handedOverNote(mode?: V2FinishMode): string {
  return mode ? FINISH_NOTES[mode] : HANDED_OVER_NOTE;
}

export const GROUPS_IGNORED_NOTE =
  "The connected TabCrew extension does not support named tab groups, so group is ignored for now; ask the user to update the TabCrew extension.";

const GROUP_NAME_HINT = `must be ${GROUP_NAME_RULES}, without control characters, and not shaped like "<label> · <8-char id>"`;

/** A valid group name from an agent, or `invalid_args` naming the field. */
function groupNameArg(field: "group" | "name", raw: string): string {
  const name = v2NormaliseGroupName(raw);
  if (name === null) throw new DaemonError("invalid_args", `${field}: ${GROUP_NAME_HINT}`);
  return name;
}

export interface CloseResult {
  closed: boolean;
  kept_tabs: number;
  moved?: boolean;
  closed_tabs?: number;
  mode?: V2FinishMode;
  note?: string;
  tabs_left_open?: number;
}

const count = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);

/**
 * Forget a session now (later calls get bad_session, queued work is rejected), then finish its
 * tabs (`session_release` with the agent's finish mode, or the user's default when `tabs` is
 * missing) after any in-flight session-level op. `release: false` (stopped sessions) leaves them
 * exactly where they are. Extensions without shared groups get the legacy ops: `session_close`
 * for tabs "close", otherwise `session_release` (hand over into the user's window).
 */
export async function closeSession(ctx: ToolContext, session: Session, release = true, tabs?: V2FinishMode): Promise<CloseResult> {
  const { registry, scheduler, observations, bridge } = ctx;
  const ref = sessionRef(session);
  const owned = session.tabs.size;
  if (!registry.close(session)) return { closed: false, kept_tabs: 0 };
  scheduler.dropSession(ref.short_id, new DaemonError("bad_session", "session was closed"));
  observations.forgetSession(ref.short_id);
  if (!release) return { closed: true, kept_tabs: 0, tabs_left_open: owned };
  return scheduler.runSession(ref.short_id, async (): Promise<CloseResult> => {
    if (!bridge.connected) return { closed: true, kept_tabs: 0, tabs_left_open: owned };
    if (!bridge.supportsGroups) {
      if (tabs === "close") {
        const result = await bridge.request(ref, "session_close", {});
        return { closed: true, kept_tabs: 0, closed_tabs: count(result?.closed_tabs), mode: "close", note: handedOverNote("close") };
      }
      const result = await bridge.request(ref, "session_release", {});
      return { closed: true, kept_tabs: result.kept_tabs, moved: result.moved, note: HANDED_OVER_NOTE };
    }
    const result = await bridge.request(ref, "session_release", tabs ? { tabs } : {});
    const mode = v2IsFinishMode(result?.mode) ? result.mode : tabs;
    return {
      closed: true,
      kept_tabs: count(result?.kept_tabs),
      moved: result?.moved === true,
      ...(result?.closed_tabs !== undefined && { closed_tabs: count(result.closed_tabs) }),
      ...(mode && { mode }),
      note: handedOverNote(mode),
    };
  });
}

async function dispatch(ctx: ToolContext, name: ToolName, rawArgs: unknown): Promise<CallToolResult> {
  const { registry, bridge, observations } = ctx;
  switch (name) {
    case "session_open": {
      const args = parseArgs(name, rawArgs);
      const group = args.group === undefined ? undefined : groupNameArg("group", args.group);
      const { handle, session } = registry.open(args.label, group);
      ctx.onSessionOpened?.(session);
      log.info(`session ${session.short_id} opened`);
      return ok({
        session: handle,
        short_id: session.short_id,
        label: session.label,
        ...(session.group !== undefined && { group: session.group }),
        ...(session.group !== undefined && bridge.connected && !bridge.supportsGroups && { note: GROUPS_IGNORED_NOTE }),
      });
    }
    case "session_close": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const result = await closeSession(ctx, session, true, args.tabs);
      log.info(`session ${session.short_id} closed`);
      return ok(result);
    }
    case "group_rename": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const newName = groupNameArg("name", args.name);
      const target = args.group === undefined ? undefined : groupNameArg("group", args.group);
      const renamed = await onSession(ctx, session, async () => {
        const result = await bridge.request(sessionRef(session), "group_rename", target ? { group: target, name: newName } : { name: newName });
        const applied = v2NormaliseGroupName(result?.name) ?? newName;
        const previous = typeof result?.previous === "string" ? result.previous : (target ?? "");
        // Later refs carry the new name; the caller follows its own group even if it used the default.
        registry.renameGroup(previous, applied, target === undefined ? session : undefined);
        return { name: applied, previous };
      });
      log.info(`session ${session.short_id} renamed a TabCrew group`);
      return ok(renamed);
    }
    case "group_list": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const listed = await onSession(ctx, session, () => bridge.request(sessionRef(session), "group_list", {}));
      const groups = (Array.isArray(listed?.groups) ? listed.groups : [])
        .filter((g): g is { name: string; mine: boolean } => !!g && typeof g.name === "string")
        .map((g) => ({ name: g.name.slice(0, 200), mine: g.mine === true }));
      return ok({ groups });
    }
    case "tab_create": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const tab = await onSession(ctx, session, async () => {
        const created = await bridge.request(sessionRef(session), "tab_create", args.url ? { url: args.url } : {});
        if (registry.getByShortId(session.short_id) !== session) {
          throw new DaemonError("bad_session", "session was closed while the tab was being created");
        }
        registry.addTab(session.short_id, created.tab_id);
        return created;
      });
      return ok(tab);
    }
    case "tab_list": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const tabs = await onSession(ctx, session, async () => {
        const { tabs: listed } = await bridge.request(sessionRef(session), "tab_list", {});
        if (registry.getByShortId(session.short_id) !== session) return [];
        return registry.setTabs(session, listed);
      });
      return ok({ tabs });
    }
    case "tab_close": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const result = await onTab(ctx, session, args.tab_id, async () => {
        const closed = await bridge.request(sessionRef(session), "tab_close", { tab_id: args.tab_id });
        registry.removeTab(session.short_id, args.tab_id);
        return closed;
      });
      return ok(result);
    }
    case "screenshot": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const opArgs: { tab_id: number; format?: "jpeg" | "png"; quality?: number } = { tab_id: args.tab_id };
      if (args.format) opArgs.format = args.format;
      if (args.quality !== undefined) opArgs.quality = args.quality;
      const shot = await onTab(ctx, session, args.tab_id, () => bridge.request(sessionRef(session), "screenshot", opArgs));
      return {
        content: [
          { type: "image", data: shot.data, mimeType: shot.media_type },
          { type: "text", text: JSON.stringify({ width: shot.width, height: shot.height, media_type: shot.media_type }) },
        ],
      };
    }
    case "observe": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const observation = await onTab(ctx, session, args.tab_id, async () => {
        const snapshot = checkSnapshot(await bridge.request(sessionRef(session), "snapshot", { tab_id: args.tab_id }));
        const space = actionSpace(snapshot.actions);
        observations.set(session.short_id, args.tab_id, snapshot.fingerprint, space);
        return toObservation(snapshot, space);
      });
      return ok(observation);
    }
    case "act": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      if (args.operation === "TYPE_TEXT" && !args.text) {
        throw new DaemonError("invalid_args", "TYPE_TEXT needs non-empty text");
      }
      const executed = await onTab(ctx, session, args.tab_id, async () => {
        const space = observations.require(session.short_id, args.tab_id, args.fingerprint);
        const { action, target } = resolveAct(space, args.operation, args.target);
        const opArgs: { tab_id: number; fingerprint: string; action_id: string; text?: string } = {
          tab_id: args.tab_id,
          fingerprint: args.fingerprint,
          action_id: action.id,
        };
        if (action.kind === "fill") opArgs.text = args.text;
        let result;
        try {
          // Browser actions are never retried.
          result = await bridge.request(sessionRef(session), "act", opArgs);
        } catch (err) {
          // Nothing executed on target_covered/target_invalid, so the observation stays usable.
          if (!isCode(err, "target_covered", "target_invalid")) observations.forget(session.short_id, args.tab_id);
          throw err;
        }
        observations.forget(session.short_id, args.tab_id);
        return {
          executed: { operation: args.operation, target, label: action.label },
          page_changed: typeof result?.page_changed === "boolean" ? result.page_changed : null,
        };
      });
      return ok(executed);
    }
    case "browse": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      registry.requireTab(session, args.tab_id);
      return ok(await runBrowse(ctx, session, args.tab_id, args.goal.trim(), args.max_steps ?? DEFAULT_MAX_STEPS));
    }
    case "navigate": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const opArgs: { tab_id: number; url?: string; action?: "url" | "back" | "forward" | "reload" } = { tab_id: args.tab_id };
      if (args.url !== undefined) {
        opArgs.url = args.url;
        opArgs.action = "url";
      } else {
        opArgs.action = args.action;
      }
      const info = await onTab(ctx, session, args.tab_id, async () => {
        try {
          // Browser actions are never retried.
          return await bridge.request(sessionRef(session), "navigate", opArgs);
        } finally {
          // Whatever happened, the agent's observation of this tab is no longer trustworthy.
          observations.forget(session.short_id, args.tab_id);
        }
      });
      return ok(toTabResult(info));
    }
    case "read_text": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const max = args.max_length ?? READ_TEXT_DEFAULT;
      const page = await onTab(ctx, session, args.tab_id, () =>
        bridge.request(sessionRef(session), "read_text", { tab_id: args.tab_id, max_length: max }),
      );
      const text = typeof page?.text === "string" ? page.text.slice(0, max) : "";
      return ok({
        url: typeof page?.url === "string" ? page.url : "",
        title: typeof page?.title === "string" ? page.title : "",
        text,
        truncated: text.length >= max,
      });
    }
    case "debug_logs": {
      const args = parseArgs(name, rawArgs);
      const session = registry.use(args.session);
      const opArgs: { tab_id: number; source: "console" | "network"; limit: number; only_errors?: boolean } = {
        tab_id: args.tab_id,
        source: args.source,
        limit: args.limit ?? LOGS_DEFAULT,
      };
      if (args.only_errors !== undefined) opArgs.only_errors = args.only_errors;
      const logs = await onTab(ctx, session, args.tab_id, () => bridge.request(sessionRef(session), "debug_logs", opArgs));
      return ok(sanitizeLogs(args.source, logs, opArgs.limit));
    }
  }
}

function toTabResult(info: unknown): { tab_id: number; url: string; title: string } {
  const t = (info ?? {}) as Record<string, unknown>;
  return {
    tab_id: typeof t.tab_id === "number" ? t.tab_id : -1,
    url: typeof t.url === "string" ? t.url : "",
    title: typeof t.title === "string" ? t.title : "",
  };
}

const CONSOLE_LEVELS = new Set(["log", "info", "warning", "error", "debug", "exception"]);

/** Origin + path only; data:/blob: keep the scheme. Mirrors the extension (defense in depth). */
export function stripUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol;
    return (u.origin !== "null" ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname}`).slice(0, 500);
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, 500);
  }
}

/**
 * Re-whitelist the extension's entries: only the documented fields of V2ConsoleEntry /
 * V2NetworkEntry reach the agent, whatever the extension sent.
 */
export function sanitizeLogs(
  source: "console" | "network",
  value: unknown,
  limit: number,
): { source: "console" | "network"; entries: V2ConsoleEntry[] | V2NetworkEntry[]; dropped: number } {
  const v = (value ?? {}) as { entries?: unknown; dropped?: unknown };
  const raw = (Array.isArray(v.entries) ? v.entries : []).slice(-limit) as Record<string, unknown>[];
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const dropped = typeof v.dropped === "number" && Number.isInteger(v.dropped) && v.dropped >= 0 ? v.dropped : 0;
  if (source === "console") {
    const entries: V2ConsoleEntry[] = raw
      .filter((e) => e && typeof e === "object")
      .map((e) => ({
        level: (CONSOLE_LEVELS.has(e.level as string) ? e.level : "log") as V2ConsoleEntry["level"],
        text: typeof e.text === "string" ? e.text.slice(0, 500) : "",
        ...(typeof e.url === "string" && e.url && { url: stripUrl(e.url) }),
        t: num(e.t) ?? 0,
      }));
    return { source, entries, dropped };
  }
  const entries: V2NetworkEntry[] = raw
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      method: typeof e.method === "string" ? e.method.slice(0, 16) : "",
      url: stripUrl(e.url),
      status: num(e.status),
      type: typeof e.type === "string" ? e.type.slice(0, 32) : "",
      ...(typeof e.failed === "string" && { failed: e.failed.slice(0, 200) }),
      ms: num(e.ms),
      t: num(e.t) ?? 0,
    }));
  return { source, entries, dropped };
}
