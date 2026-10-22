import { V2_HUB_EXTENSION_PORT } from "@tabcrew/shared/v2";
import { DEFAULT_JEV_MODEL, type DaemonConfig } from "../config.js";

/** Minutes without any MCP client before the hub exits (0 disables). */
export const HUB_DEFAULT_IDLE_MINUTES = 10;

/**
 * Model name the hub puts in its config. In hub mode every model call goes through the extension
 * (`model_call`), which picks the real model from its popup settings, so the hub never knows (or
 * needs) a model name or key. It is non-empty so the chat-decision path and the text fallback
 * stay enabled; the extension answers `model_not_configured` when it has no fallback model.
 */
export const HUB_MODEL_PLACEHOLDER = "extension";

/** Session idle timeout (the daemon's default): idle browser sessions hand their tabs to the user. */
const HUB_SESSION_IDLE_MINUTES = 30;
/** Per-attempt text-helper budget: one extra hop (hub -> extension -> provider). */
const HUB_TEXT_MODEL_TIMEOUT_MS = 8_000;

export interface HubArgs {
  /** Extension WebSocket port (0 picks a free one; tests). */
  readonly port: number;
  /** Idle exit after this many minutes without MCP clients (0 disables; fractions allowed). */
  readonly idleMinutes: number;
  readonly help: boolean;
}

export type ParsedHubArgs = { readonly ok: true; readonly args: HubArgs } | { readonly ok: false; readonly error: string };

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

function parseMinutes(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return Number(raw);
}

/** Parse `daemon.mjs hub` arguments: --port N, --idle-minutes N, --help. */
export function parseHubArgs(argv: readonly string[]): ParsedHubArgs {
  let port = V2_HUB_EXTENSION_PORT;
  let idleMinutes = HUB_DEFAULT_IDLE_MINUTES;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const m = /^(--port|--idle-minutes)(?:=(.*))?$/.exec(arg);
    if (!m) return { ok: false, error: `unknown argument: ${arg}` };
    const [, flag, inline] = m;
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") return { ok: false, error: `${flag} needs a value` };
    if (flag === "--port") {
      const parsed = parsePort(value);
      if (parsed === null) return { ok: false, error: `invalid --port: ${value} (0-65535)` };
      port = parsed;
    } else {
      const parsed = parseMinutes(value);
      if (parsed === null) return { ok: false, error: `invalid --idle-minutes: ${value} (a number >= 0)` };
      idleMinutes = parsed;
    }
  }
  return { ok: true, args: { port, idleMinutes, help } };
}

/**
 * The hub's DaemonConfig, built in code: no ~/.tabcrew, no config.toml, no environment. Hub mode
 * only uses the extension port, session idle timeout, browse concurrency and the model fields
 * (placeholders; see HUB_MODEL_PLACEHOLDER). `home` is set to the runtime dir but hub mode never
 * writes to config.home.
 */
export function hubConfig(args: HubArgs, runtimeDir: string): DaemonConfig {
  return {
    home: runtimeDir,
    mcpPort: 0,
    extensionPort: args.port,
    idleTimeoutMinutes: HUB_SESSION_IDLE_MINUTES,
    browseConcurrency: 8,
    jevModel: DEFAULT_JEV_MODEL,
    textModel: HUB_MODEL_PLACEHOLDER,
    allowedOrigins: [],
    openrouterApiKey: undefined,
    textModelApiKey: undefined,
    textModelBaseUrl: undefined,
    textModelReasoning: "none",
    textModelFallback: HUB_MODEL_PLACEHOLDER,
    textModelTimeoutMs: HUB_TEXT_MODEL_TIMEOUT_MS,
    decisionProvider: "chat",
    decisionModel: HUB_MODEL_PLACEHOLDER,
    decisionModelApiKey: undefined,
    decisionModelBaseUrl: undefined,
    decisionModelReasoning: "none",
  };
}
