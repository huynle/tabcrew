/**
 * Settings the extension popup can read and change over the extension socket (`ext_request`).
 *
 * - Keys (OPENROUTER_API_KEY, TEXT_MODEL_API_KEY) and TEXT_MODEL_BASE_URL live in `<home>/env`
 *   (0600); jev_model / text_model live in `<home>/config.toml`. Both are written atomically.
 * - Keys are never returned in full: only their source and last 4 characters.
 * - A value set in the daemon's real environment wins after a restart, so it cannot be changed here.
 * - Successful updates are applied to the running Jev settings (the next browse uses them).
 * - Logs name the changed fields only, never values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  V2ExtOp,
  V2KeySource,
  V2KeyView,
  V2SettingsPatch,
  V2SettingsView,
  V2ValueSource,
  V2ValueView,
} from "@tabcrew/shared/v2";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { readEnvFileValue, removeEnvFileValue, upsertEnvFileValue, validateOpenRouterKey, writePrivateFileAtomic } from "./cli/openrouter.js";
import { DEFAULT_JEV_MODEL, DEFAULT_TEXT_MODEL } from "./config.js";
import { DaemonError } from "./errors.js";
import type { Env } from "./home.js";
import type { ModelSettings } from "./jev/decisions.js";
import { log } from "./log.js";

export interface SettingsDeps {
  readonly home: string;
  /** The daemon's process environment; mirrored when `<home>/env` values change. */
  readonly env: Env;
  /** Variables `loadEnvFile` set from `<home>/env` (everything else in `env` is the real environment). */
  readonly envFileVars: Iterable<string>;
  readonly fetch: typeof fetch;
  /** The live Jev settings; replaced after each successful update. */
  readonly runtime: { settings: ModelSettings };
}

export interface SettingsUpdateResult {
  readonly settings: V2SettingsView;
  readonly updated: string[];
  readonly warnings: string[];
}

type Field = keyof V2SettingsPatch;
const FIELDS: readonly Field[] = ["openrouter_api_key", "text_model_api_key", "text_model_base_url", "jev_model", "text_model"];

/** Where each field is stored. */
const ENV_FIELDS = {
  openrouter_api_key: "OPENROUTER_API_KEY",
  text_model_api_key: "TEXT_MODEL_API_KEY",
  text_model_base_url: "TEXT_MODEL_BASE_URL",
} as const;
const TOML_FIELDS = {
  jev_model: { variable: "JEV_MODEL", fallback: DEFAULT_JEV_MODEL },
  text_model: { variable: "TEXT_MODEL", fallback: DEFAULT_TEXT_MODEL },
} as const;
type EnvField = keyof typeof ENV_FIELDS;
type TomlField = keyof typeof TOML_FIELDS;

const MAX_KEY = 512;
const MAX_MODEL = 200;
const MAX_URL = 2048;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(message: string): DaemonError {
  return new DaemonError("invalid_args", message);
}

function hint(value: string): string | null {
  return value.length >= 8 ? value.slice(-4) : null;
}

/** Normalise one patch value: trimmed string, or null (remove / reset). */
function clean(field: Field, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw invalid(`${field} must be a string or null`);
  if (/[\r\n]/.test(raw)) throw invalid(`${field} must be a single line`);
  const value = raw.trim();
  if (CONTROL.test(value)) throw invalid(`${field} contains control characters`);
  if (field === "openrouter_api_key" || field === "text_model_api_key") {
    if (!value) throw invalid(`${field} is empty; send null to remove it`);
    if (value.length > MAX_KEY) throw invalid(`${field} is too long`);
    return value;
  }
  if (!value) return null;
  if (field === "text_model_base_url") {
    if (value.length > MAX_URL || !z.string().url().safeParse(value).success || !/^https?:\/\//i.test(value)) {
      throw invalid("text_model_base_url must be an http(s) URL");
    }
    return value;
  }
  if (value.length > MAX_MODEL) throw invalid(`${field} is too long`);
  return value;
}

/**
 * Set (string) or delete (null) a top-level `key = "value"` line in TOML text, keeping every other
 * line (and comment) as it is. New keys go before the first table header.
 */
export function setTopLevelTomlString(text: string, key: string, value: string | null): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let tableStart = lines.findIndex((l) => /^\s*\[/.test(l));
  if (tableStart < 0) tableStart = lines.length;
  const pattern = new RegExp(`^\\s*["']?${key}["']?\\s*=`);
  const at = lines.slice(0, tableStart).findIndex((l) => pattern.test(l));
  const line = value === null ? null : `${key} = ${JSON.stringify(value)}`;
  if (at >= 0) {
    if (line === null) lines.splice(at, 1);
    else lines[at] = line;
  } else if (line !== null) {
    let insert = tableStart;
    while (insert > 0 && lines[insert - 1].trim() === "") insert--;
    lines.splice(insert, 0, line);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export class SettingsService {
  private readonly fileVars: Set<string>;
  private openrouterCheck: "valid" | "unreachable" | null = null;

  constructor(private readonly deps: SettingsDeps) {
    this.fileVars = new Set(deps.envFileVars);
  }

  private get envPath(): string {
    return join(this.deps.home, "env");
  }

  private get tomlPath(): string {
    return join(this.deps.home, "config.toml");
  }

  /** A variable from the real environment (not one the daemon loaded from `<home>/env`). */
  private realEnv(variable: string): string | undefined {
    if (this.fileVars.has(variable)) return undefined;
    return this.deps.env[variable]?.trim() || undefined;
  }

  private envFileValue(variable: string): string | undefined {
    return readEnvFileValue(this.envPath, variable)?.trim() || undefined;
  }

  private envSetting(variable: string): { value: string | undefined; source: V2KeySource } {
    const fromEnv = this.realEnv(variable);
    if (fromEnv) return { value: fromEnv, source: "env" };
    const fromFile = this.envFileValue(variable);
    if (fromFile) return { value: fromFile, source: "file" };
    return { value: undefined, source: "unset" };
  }

  private readToml(): Record<string, unknown> {
    if (!existsSync(this.tomlPath)) return {};
    try {
      return parseToml(readFileSync(this.tomlPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private tomlSetting(field: TomlField, toml = this.readToml()): V2ValueView {
    const { variable, fallback } = TOML_FIELDS[field];
    // JEV_MODEL / TEXT_MODEL from <home>/env also beat config.toml, so they count as "env" here.
    const fromEnv = this.deps.env[variable]?.trim();
    if (fromEnv) return { value: fromEnv, source: "env", default: fallback };
    const fromFile = toml[field];
    if (typeof fromFile === "string" && fromFile.trim()) return { value: fromFile.trim(), source: "file", default: fallback };
    return { value: fallback, source: "default", default: fallback };
  }

  private keyView(variable: string): V2KeyView {
    const { value, source } = this.envSetting(variable);
    return { source, hint: value ? hint(value) : null };
  }

  view(): V2SettingsView {
    const toml = this.readToml();
    const baseUrl = this.envSetting(ENV_FIELDS.text_model_base_url);
    const openrouter = this.keyView(ENV_FIELDS.openrouter_api_key);
    return {
      openrouter_api_key: { ...openrouter, check: openrouter.source === "unset" ? null : this.openrouterCheck },
      text_model_api_key: this.keyView(ENV_FIELDS.text_model_api_key),
      jev_model: this.tomlSetting("jev_model", toml),
      text_model: this.tomlSetting("text_model", toml),
      text_model_base_url: {
        value: baseUrl.value ?? null,
        source: (baseUrl.source === "unset" ? "default" : baseUrl.source) satisfies V2ValueSource,
        default: null,
      },
    };
  }

  /** Why `field` cannot be changed here, or null. */
  private lockReason(field: Field): string | null {
    if (field in TOML_FIELDS) {
      const { variable } = TOML_FIELDS[field as TomlField];
      if (!this.deps.env[variable]?.trim()) return null;
      return this.fileVars.has(variable)
        ? `${variable} is set in ${this.envPath}, which wins over config.toml; remove it there first`
        : `${variable} is set in the daemon's environment, which wins over settings saved here; change or unset it there`;
    }
    const variable = ENV_FIELDS[field as EnvField];
    return this.realEnv(variable)
      ? `${variable} is set in the daemon's environment, which wins over settings saved here; change or unset it there`
      : null;
  }

  async update(patch: V2SettingsPatch): Promise<SettingsUpdateResult> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("settings_set needs an object of fields");
    const unknown = Object.keys(patch).filter((k) => !(FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) throw invalid(`unknown setting(s): ${unknown.join(", ")}`);
    const changes = new Map<Field, string | null>();
    for (const field of FIELDS) {
      if (Object.hasOwn(patch, field)) changes.set(field, clean(field, patch[field]));
    }
    if (changes.size === 0) throw invalid("no settings to change");
    for (const field of changes.keys()) {
      const reason = this.lockReason(field);
      if (reason) throw invalid(reason);
    }

    // Check the OpenRouter key before writing anything.
    const warnings: string[] = [];
    let check: "valid" | "unreachable" | null | undefined;
    const newKey = changes.get("openrouter_api_key");
    if (newKey) {
      const result = await validateOpenRouterKey({ fetch: this.deps.fetch }, newKey);
      if (result === "invalid") throw invalid("OpenRouter rejected this API key; nothing was saved");
      if (result === "unreachable") warnings.push("Could not reach OpenRouter to check the key; it was saved anyway");
      check = result;
    } else if (newKey === null) {
      check = null;
    }

    const toml = [...changes].filter(([f]) => f in TOML_FIELDS) as [TomlField, string | null][];
    if (toml.length > 0) this.writeToml(toml);
    for (const [field, value] of changes) {
      if (!(field in ENV_FIELDS)) continue;
      const variable = ENV_FIELDS[field as EnvField];
      if (value === null) {
        removeEnvFileValue(this.envPath, variable);
        delete this.deps.env[variable];
        this.fileVars.delete(variable);
      } else {
        upsertEnvFileValue(this.envPath, variable, value);
        this.deps.env[variable] = value;
        this.fileVars.add(variable);
      }
    }
    if (check !== undefined) this.openrouterCheck = check;

    this.apply(changes);
    const updated = [...changes.keys()];
    log.info(`settings updated: ${updated.join(", ")}`);
    return { settings: this.view(), updated, warnings };
  }

  private writeToml(changes: readonly [TomlField, string | null][]): void {
    const before = existsSync(this.tomlPath) ? readFileSync(this.tomlPath, "utf8") : "";
    let parsedBefore: Record<string, unknown>;
    try {
      parsedBefore = parseToml(before) as Record<string, unknown>;
    } catch {
      throw invalid("config.toml is not valid TOML; fix it by hand first");
    }
    let text = before;
    const expected: Record<string, unknown> = { ...parsedBefore };
    for (const [field, value] of changes) {
      text = setTopLevelTomlString(text, field, value);
      if (value === null) delete expected[field];
      else expected[field] = value;
    }
    // Refuse to write anything that does not parse to exactly the intended result.
    let parsedAfter: unknown;
    try {
      parsedAfter = parseToml(text);
    } catch {
      parsedAfter = undefined;
    }
    if (JSON.stringify(sortKeys(parsedAfter)) !== JSON.stringify(sortKeys(expected))) {
      throw invalid("could not update config.toml safely; edit jev_model/text_model there by hand");
    }
    writePrivateFileAtomic(this.tomlPath, text);
  }

  /** Swap in new live settings so the next browse uses them. */
  private apply(changes: ReadonlyMap<Field, string | null>): void {
    const next: { -readonly [K in keyof ModelSettings]: ModelSettings[K] } = { ...this.deps.runtime.settings };
    const view = this.view();
    for (const field of changes.keys()) {
      switch (field) {
        case "openrouter_api_key":
          next.openrouterApiKey = this.envSetting(ENV_FIELDS.openrouter_api_key).value;
          break;
        case "text_model_api_key":
          next.textModelApiKey = this.envSetting(ENV_FIELDS.text_model_api_key).value;
          break;
        case "text_model_base_url":
          next.textModelBaseUrl = view.text_model_base_url.value ?? undefined;
          break;
        case "jev_model":
          next.jevModel = view.jev_model.value ?? DEFAULT_JEV_MODEL;
          break;
        case "text_model":
          next.textModel = view.text_model.value ?? DEFAULT_TEXT_MODEL;
          break;
      }
    }
    this.deps.runtime.settings = next;
  }

  /** Dispatch one extension request. */
  async handle(op: V2ExtOp, args: unknown): Promise<unknown> {
    switch (op) {
      case "settings_get":
        return this.view();
      case "settings_set":
        return this.update(args as V2SettingsPatch);
      default:
        throw invalid(`unknown request: ${String(op)}`);
    }
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
