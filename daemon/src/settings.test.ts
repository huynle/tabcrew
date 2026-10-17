import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./home.js";
import type { ModelSettings } from "./jev/decisions.js";
import { setLogSink } from "./log.js";
import { SettingsService, type SettingsDeps } from "./settings.js";

const GOOD = "sk-or-good-1234567890abcd";
const BAD = "sk-or-bad-000000000wxyz";

let home: string;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tabcrew-settings-test-"));
  logs = [];
  setLogSink((_level, line) => logs.push(line));
});
afterEach(() => {
  setLogSink(() => {});
  rmSync(home, { recursive: true, force: true });
});

function baseSettings(): ModelSettings {
  return {
    jevModel: "typesafe/jev-1.13",
    textModel: "inception/mercury-2.5",
    openrouterApiKey: undefined,
    textModelReasoning: "none",
    textModelFallback: "google/gemini-2.5-flash-lite",
    textModelTimeoutMs: 3_000,
  };
}

/** Fake OpenRouter /api/v1/key: sk-or-good* is valid, "unreachable" throws, anything else 401. */
function fakeFetch(calls: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    calls.push(key);
    if (key.startsWith("sk-or-unreach")) throw new TypeError("fetch failed");
    return new Response("{}", { status: key.startsWith("sk-or-good") ? 200 : 401 });
  }) as typeof fetch;
}

function make(opts: { env?: Env; envFileVars?: string[]; settings?: Partial<ModelSettings> } = {}) {
  const fetchCalls: string[] = [];
  const runtime = { settings: { ...baseSettings(), ...opts.settings } };
  const env: Env = opts.env ?? {};
  const deps: SettingsDeps = {
    home,
    env,
    envFileVars: opts.envFileVars ?? [],
    fetch: fakeFetch(fetchCalls),
    runtime,
  };
  return { service: new SettingsService(deps), runtime, env, fetchCalls };
}

const envFile = () => readFileSync(join(home, "env"), "utf8");
const mode = (name: string) => statSync(join(home, name)).mode & 0o777;

describe("SettingsService.view", () => {
  it("reports unset keys and default models when nothing is configured", () => {
    const { service } = make();
    expect(service.view()).toEqual({
      openrouter_api_key: { source: "unset", hint: null, check: null },
      text_model_api_key: { source: "unset", hint: null },
      jev_model: { value: "typesafe/jev-1.13", source: "default", default: "typesafe/jev-1.13" },
      text_model: { value: "inception/mercury-2.5", source: "default", default: "inception/mercury-2.5" },
      text_model_base_url: { value: null, source: "default", default: null },
    });
  });

  it("redacts keys to their last 4 characters and tells env from file", () => {
    writeFileSync(join(home, "env"), `OPENROUTER_API_KEY=${GOOD}\n`, { mode: 0o600 });
    const { service } = make({
      env: { OPENROUTER_API_KEY: GOOD, TEXT_MODEL_API_KEY: "tk-real-env-9876" },
      envFileVars: ["OPENROUTER_API_KEY"],
    });
    const view = service.view();
    expect(view.openrouter_api_key).toEqual({ source: "file", hint: "abcd", check: null });
    expect(view.text_model_api_key).toEqual({ source: "env", hint: "9876" });
    expect(JSON.stringify(view)).not.toContain(GOOD);
    expect(JSON.stringify(view)).not.toContain("tk-real-env-9876");
  });

  it("reports config.toml models as file and JEV_MODEL/TEXT_MODEL/TEXT_MODEL_BASE_URL in the environment as env", () => {
    writeFileSync(join(home, "config.toml"), 'jev_model = "a/jev"\ntext_model = "b/text"\n');
    expect(make().service.view()).toMatchObject({
      jev_model: { value: "a/jev", source: "file" },
      text_model: { value: "b/text", source: "file" },
    });
    const { service } = make({ env: { JEV_MODEL: "c/jev", TEXT_MODEL_BASE_URL: "http://localhost:1234/v1" } });
    expect(service.view()).toMatchObject({
      jev_model: { value: "c/jev", source: "env" },
      text_model: { value: "b/text", source: "file" },
      text_model_base_url: { value: "http://localhost:1234/v1", source: "env" },
    });
  });

  it("reports a base URL loaded from <home>/env as file", () => {
    writeFileSync(join(home, "env"), "TEXT_MODEL_BASE_URL=http://localhost:1234/v1\n", { mode: 0o600 });
    const { service } = make({
      env: { TEXT_MODEL_BASE_URL: "http://localhost:1234/v1" },
      envFileVars: ["TEXT_MODEL_BASE_URL"],
    });
    expect(service.view().text_model_base_url).toEqual({ value: "http://localhost:1234/v1", source: "file", default: null });
  });
});

describe("SettingsService.update: OpenRouter key", () => {
  it("saves a valid key to <home>/env (0600), applies it live and logs only the field name", async () => {
    writeFileSync(join(home, "env"), "# mine\nFOO=bar\n", { mode: 0o600 });
    const { service, runtime, env, fetchCalls } = make();
    const result = await service.update({ openrouter_api_key: `  ${GOOD}  ` });
    expect(fetchCalls).toEqual([GOOD]);
    expect(result.updated).toEqual(["openrouter_api_key"]);
    expect(result.warnings).toEqual([]);
    expect(result.settings.openrouter_api_key).toEqual({ source: "file", hint: "abcd", check: "valid" });
    expect(envFile()).toBe(`# mine\nFOO=bar\nOPENROUTER_API_KEY=${GOOD}\n`);
    expect(mode("env")).toBe(0o600);
    expect(runtime.settings.openrouterApiKey).toBe(GOOD);
    expect(env.OPENROUTER_API_KEY).toBe(GOOD);
    expect(logs.join("\n")).toContain("settings updated: openrouter_api_key");
    expect(logs.join("\n")).not.toContain(GOOD);
  });

  it("rejects an invalid key and saves nothing", async () => {
    const { service, runtime } = make();
    await expect(service.update({ openrouter_api_key: BAD })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringMatching(/rejected/i),
    });
    expect(() => envFile()).toThrow();
    expect(runtime.settings.openrouterApiKey).toBeUndefined();
    expect(logs.join("\n")).not.toContain(BAD);
  });

  it("an invalid key in a multi-field update saves none of the fields", async () => {
    const { service, runtime } = make();
    await expect(service.update({ openrouter_api_key: BAD, jev_model: "x/y" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(runtime.settings.jevModel).toBe("typesafe/jev-1.13");
    expect(() => readFileSync(join(home, "config.toml"))).toThrow();
  });

  it("saves the key with a warning when OpenRouter cannot be reached", async () => {
    const { service, runtime } = make();
    const key = "sk-or-unreachable-5555";
    const result = await service.update({ openrouter_api_key: key });
    expect(result.warnings).toEqual([expect.stringMatching(/could not reach OpenRouter/i)]);
    expect(result.settings.openrouter_api_key).toEqual({ source: "file", hint: "5555", check: "unreachable" });
    expect(runtime.settings.openrouterApiKey).toBe(key);
  });

  it("removes the key from <home>/env with null, keeping other lines", async () => {
    writeFileSync(join(home, "env"), `FOO=bar\nOPENROUTER_API_KEY=${GOOD}\nBAZ=1\n`, { mode: 0o600 });
    const { service, runtime, env } = make({
      env: { OPENROUTER_API_KEY: GOOD, FOO: "bar", BAZ: "1" },
      envFileVars: ["OPENROUTER_API_KEY", "FOO", "BAZ"],
      settings: { openrouterApiKey: GOOD },
    });
    const result = await service.update({ openrouter_api_key: null });
    expect(result.settings.openrouter_api_key).toEqual({ source: "unset", hint: null, check: null });
    expect(envFile()).toBe("FOO=bar\nBAZ=1\n");
    expect(mode("env")).toBe(0o600);
    expect(runtime.settings.openrouterApiKey).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("refuses to change a key that comes from the real environment", async () => {
    const { service, runtime } = make({ env: { OPENROUTER_API_KEY: GOOD }, settings: { openrouterApiKey: GOOD } });
    for (const value of [null, "sk-or-good-other-1111"]) {
      await expect(service.update({ openrouter_api_key: value })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringMatching(/OPENROUTER_API_KEY is set in the daemon's environment/),
      });
    }
    expect(runtime.settings.openrouterApiKey).toBe(GOOD);
    expect(() => envFile()).toThrow();
  });

  it("rejects multi-line, empty and oversized keys without calling OpenRouter", async () => {
    const { service, fetchCalls } = make();
    for (const bad of ["sk-or-good\nEVIL=1", "   ", "x".repeat(600)]) {
      await expect(service.update({ openrouter_api_key: bad })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(fetchCalls).toEqual([]);
  });
});

describe("SettingsService.update: text model override", () => {
  it("stores the text model key and base URL in <home>/env and applies them", async () => {
    const { service, runtime, fetchCalls } = make();
    const result = await service.update({ text_model_api_key: "tk-123456", text_model_base_url: "http://localhost:1234/v1" });
    expect(fetchCalls).toEqual([]);
    expect(result.updated.sort()).toEqual(["text_model_api_key", "text_model_base_url"]);
    expect(result.settings.text_model_api_key).toEqual({ source: "file", hint: "3456" });
    expect(result.settings.text_model_base_url).toEqual({ value: "http://localhost:1234/v1", source: "file", default: null });
    expect(envFile()).toBe("TEXT_MODEL_API_KEY=tk-123456\nTEXT_MODEL_BASE_URL=http://localhost:1234/v1\n");
    expect(runtime.settings.textModelApiKey).toBe("tk-123456");
    expect(runtime.settings.textModelBaseUrl).toBe("http://localhost:1234/v1");

    await service.update({ text_model_base_url: null, text_model_api_key: null });
    expect(envFile()).toBe("");
    expect(runtime.settings.textModelApiKey).toBeUndefined();
    expect(runtime.settings.textModelBaseUrl).toBeUndefined();
  });

  it("rejects a base URL that is not an http(s) URL", async () => {
    const { service } = make();
    for (const bad of ["not a url", "file:///etc/passwd", "javascript:alert(1)"]) {
      await expect(service.update({ text_model_base_url: bad })).rejects.toMatchObject({ code: "invalid_args" });
    }
  });
});

describe("SettingsService.update: models", () => {
  it("writes jev_model/text_model to config.toml (0600), keeping other keys and tables, and applies them", async () => {
    writeFileSync(
      join(home, "config.toml"),
      '# my config\nmcp_port = 9000\njev_model = "old/jev" # pinned\n\n[extra]\njev_model = "not top-level"\n',
    );
    const { service, runtime } = make();
    const result = await service.update({ jev_model: " new/jev ", text_model: "new/text" });
    expect(result.updated.sort()).toEqual(["jev_model", "text_model"]);
    const text = readFileSync(join(home, "config.toml"), "utf8");
    expect(text).toContain("# my config");
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(parsed).toEqual({ mcp_port: 9000, jev_model: "new/jev", text_model: "new/text", extra: { jev_model: "not top-level" } });
    expect(mode("config.toml")).toBe(0o600);
    expect(runtime.settings.jevModel).toBe("new/jev");
    expect(runtime.settings.textModel).toBe("new/text");
    expect(result.settings.jev_model).toEqual({ value: "new/jev", source: "file", default: "typesafe/jev-1.13" });
  });

  it("null or an empty string resets a model to its default by removing the line", async () => {
    writeFileSync(join(home, "config.toml"), 'mcp_port = 9000\njev_model = "old/jev"\ntext_model = "old/text"\n');
    const { service, runtime } = make({ settings: { jevModel: "old/jev", textModel: "old/text" } });
    await service.update({ jev_model: null, text_model: "  " });
    expect(parseToml(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({ mcp_port: 9000 });
    expect(runtime.settings.jevModel).toBe("typesafe/jev-1.13");
    expect(runtime.settings.textModel).toBe("inception/mercury-2.5");
  });

  it("escapes quotes so config.toml stays valid", async () => {
    const { service } = make();
    await service.update({ jev_model: 'we"ird\\model' });
    expect(parseToml(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({ jev_model: 'we"ird\\model' });
  });

  it("refuses to change a model set by JEV_MODEL / TEXT_MODEL", async () => {
    const { service } = make({ env: { TEXT_MODEL: "env/text" } });
    await expect(service.update({ text_model: "x/y" })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringMatching(/TEXT_MODEL is set in the daemon's environment/),
    });
  });

  it("rejects unknown fields and non-string values", async () => {
    const { service } = make();
    await expect(service.update({ mcp_port: 1 } as never)).rejects.toMatchObject({ code: "invalid_args" });
    await expect(service.update({ jev_model: 5 } as never)).rejects.toMatchObject({ code: "invalid_args" });
    await expect(service.update({})).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("SettingsService.handle", () => {
  it("dispatches settings_get and settings_set", async () => {
    const { service } = make();
    expect(await service.handle("settings_get", {})).toEqual(service.view());
    const set = (await service.handle("settings_set", { jev_model: "a/b" })) as { updated: string[] };
    expect(set.updated).toEqual(["jev_model"]);
  });
});
