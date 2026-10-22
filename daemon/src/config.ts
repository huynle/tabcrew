import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { V2_EXTENSION_PORT, V2_MCP_PORT } from "@tabcrew/shared/v2";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { productEnv, resolveHome, type Env } from "./home.js";
import { DECISION_PROVIDERS, type DecisionProvider } from "./jev/decisions.js";
import { log } from "./log.js";

export { resolveHome } from "./home.js";

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const DEFAULT_TEXT_MODEL = "inception/mercury-2.5";

export interface DaemonConfig {
  readonly home: string;
  readonly mcpPort: number;
  readonly extensionPort: number;
  /** 0 disables idle closing. */
  readonly idleTimeoutMinutes: number;
  readonly browseConcurrency: number;
  readonly jevModel: string;
  readonly textModel: string;
  /** Exact `Origin` header values allowed on the MCP endpoint. Requests without Origin are always allowed. */
  readonly allowedOrigins: readonly string[];
  /** From the environment only; never read from config.toml. */
  readonly openrouterApiKey: string | undefined;
  /** Text helper overrides (environment only): key, OpenAI-compatible base URL, reasoning effort or "none". */
  readonly textModelApiKey: string | undefined;
  readonly textModelBaseUrl: string | undefined;
  readonly textModelReasoning: string;
  /** Second text model tried once if the first is slow or fails; null disables. */
  readonly textModelFallback: string | null;
  /** Per-attempt budget for the text helper. */
  readonly textModelTimeoutMs: number;
  /** Who chooses browse steps; defaults to "chat" when decisionModel is set, else "jev". */
  readonly decisionProvider: DecisionProvider;
  /** Chat-completion model for chat decisions (e.g. an Anthropic Haiku slug on OpenRouter). */
  readonly decisionModel: string | undefined;
  /** Chat decision overrides (environment only): key, OpenAI-compatible base URL, reasoning effort or "none". */
  readonly decisionModelApiKey: string | undefined;
  readonly decisionModelBaseUrl: string | undefined;
  readonly decisionModelReasoning: string;
}

const port = z.coerce.number().int().min(0).max(65535);

const fileSchema = z
  .object({
    mcp_port: port.optional(),
    extension_port: port.optional(),
    idle_timeout_minutes: z.coerce.number().min(0).optional(),
    browse_concurrency: z.coerce.number().int().min(1).max(64).optional(),
    jev_model: z.string().min(1).optional(),
    text_model: z.string().min(1).optional(),
    decision_provider: z.enum(DECISION_PROVIDERS).optional(),
    decision_model: z.string().min(1).optional(),
    allowed_origins: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

function readConfigFile(home: string): z.infer<typeof fileSchema> {
  const path = join(home, "config.toml");
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid config.toml: ${(err as Error).message.split("\n")[0]}`);
  }
  if (raw && typeof raw === "object" && "openrouter_api_key" in raw) {
    log.warn("config.toml: openrouter_api_key is ignored; set OPENROUTER_API_KEY in the environment or <home>/env");
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid config.toml: ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

/** A `TABCREW_<name>` setting (deprecated fallback: `CHROMEUSE_<name>`). */
function productValue<T>(env: Env, name: string, schema: z.ZodType<T>): T | undefined {
  const found = productEnv(env, name);
  if (!found) return undefined;
  const parsed = schema.safeParse(found.value);
  if (!parsed.success) throw new Error(`invalid ${found.from}: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

function envValue<T>(env: Env, name: string, schema: z.ZodType<T>): T | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = schema.safeParse(raw.trim());
  if (!parsed.success) throw new Error(`invalid ${name}: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

export function loadConfig(env: Env = process.env): DaemonConfig {
  const home = resolveHome(env);
  const file = readConfigFile(home);
  const origins = productValue(env, "ALLOWED_ORIGINS", z.string());
  const decisionModel = envValue(env, "DECISION_MODEL", z.string().min(1)) ?? file.decision_model;
  const decisionProvider =
    envValue(env, "DECISION_PROVIDER", z.enum(DECISION_PROVIDERS)) ?? file.decision_provider ?? (decisionModel ? "chat" : "jev");
  if (decisionProvider !== "jev" && !decisionModel) {
    throw new Error(`decision_provider "${decisionProvider}" needs decision_model (DECISION_MODEL) to be set`);
  }
  return {
    home,
    mcpPort: productValue(env, "MCP_PORT", port) ?? file.mcp_port ?? V2_MCP_PORT,
    extensionPort: productValue(env, "EXTENSION_PORT", port) ?? file.extension_port ?? V2_EXTENSION_PORT,
    idleTimeoutMinutes:
      productValue(env, "IDLE_TIMEOUT_MINUTES", z.coerce.number().min(0)) ?? file.idle_timeout_minutes ?? 30,
    browseConcurrency:
      productValue(env, "BROWSE_CONCURRENCY", z.coerce.number().int().min(1).max(64)) ??
      file.browse_concurrency ??
      8,
    jevModel: envValue(env, "JEV_MODEL", z.string().min(1)) ?? file.jev_model ?? DEFAULT_JEV_MODEL,
    textModel: envValue(env, "TEXT_MODEL", z.string().min(1)) ?? file.text_model ?? DEFAULT_TEXT_MODEL,
    allowedOrigins:
      origins !== undefined
        ? origins
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : (file.allowed_origins ?? []),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    textModelApiKey: env.TEXT_MODEL_API_KEY?.trim() || undefined,
    textModelBaseUrl: envValue(env, "TEXT_MODEL_BASE_URL", z.string().url()),
    textModelReasoning: envValue(env, "TEXT_MODEL_REASONING", z.string().min(1)) ?? "none",
    textModelFallback: ((v) => (v === "none" ? null : v))(
      envValue(env, "TEXT_MODEL_FALLBACK", z.string().min(1)) ?? "google/gemini-2.5-flash-lite",
    ),
    textModelTimeoutMs: envValue(env, "TEXT_MODEL_TIMEOUT_MS", z.coerce.number().int().min(500).max(60_000)) ?? 3_000,
    decisionProvider,
    decisionModel,
    decisionModelApiKey: env.DECISION_MODEL_API_KEY?.trim() || undefined,
    decisionModelBaseUrl: envValue(env, "DECISION_MODEL_BASE_URL", z.string().url()),
    decisionModelReasoning: envValue(env, "DECISION_MODEL_REASONING", z.string().min(1)) ?? "none",
  };
}

/**
 * Load `<home>/env` (simple KEY=VALUE lines) into `env` without overriding existing values.
 * The file must not be readable by group/other; otherwise it is skipped with a warning.
 * Returns the names of the variables that were set.
 */
export function loadEnvFile(home: string, env: Env = process.env): string[] {
  const path = join(home, "env");
  if (!existsSync(path)) return [];
  if ((statSync(path).mode & 0o077) !== 0) {
    log.warn(`${path} is readable by other users; skipped (run: chmod 600 ${path})`);
    return [];
  }
  const set: string[] = [];
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    let value = rawValue.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      set.push(key);
    }
  }
  return set;
}
