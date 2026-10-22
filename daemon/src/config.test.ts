import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadEnvFile, resolveHome } from "./config.js";
import { launchdPlist, stableNodePath, writeLaunchdPlist } from "./launchd.js";
import { tempHome } from "./testing/helpers.js";
import { ensureToken, safeEqual } from "./token.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
function home(): string {
  const t = tempHome();
  cleanup = t.cleanup;
  return t.home;
}

describe("config", () => {
  it("uses defaults", () => {
    const h = home();
    const c = loadConfig({ TABCREW_HOME: h });
    expect(c).toMatchObject({
      home: h,
      mcpPort: 8770,
      extensionPort: 8771,
      idleTimeoutMinutes: 30,
      browseConcurrency: 8,
      jevModel: "typesafe/jev-1.13",
      textModel: "inception/mercury-2.5",
      allowedOrigins: [],
      openrouterApiKey: undefined,
    });
  });

  it("reads config.toml and lets env override it; port 0 allowed", () => {
    const h = home();
    writeFileSync(
      join(h, "config.toml"),
      'mcp_port = 9000\nextension_port = 9001\nidle_timeout_minutes = 5\njev_model = "x/y"\nallowed_origins = ["http://ok"]\nopenrouter_api_key = "nope"\n',
    );
    const c = loadConfig({ TABCREW_HOME: h, TABCREW_MCP_PORT: "0", JEV_MODEL: "env/model", OPENROUTER_API_KEY: "k" });
    expect(c.mcpPort).toBe(0);
    expect(c.extensionPort).toBe(9001);
    expect(c.idleTimeoutMinutes).toBe(5);
    expect(c.jevModel).toBe("env/model");
    expect(c.allowedOrigins).toEqual(["http://ok"]);
    expect(c.openrouterApiKey).toBe("k");
  });

  it("configures chat decisions: decision_model implies chat; provider and env overrides", () => {
    const h = home();
    expect(loadConfig({ TABCREW_HOME: h })).toMatchObject({ decisionProvider: "jev", decisionModel: undefined, decisionModelReasoning: "none" });
    writeFileSync(join(h, "config.toml"), 'decision_model = "anthropic/claude-haiku"\n');
    expect(loadConfig({ TABCREW_HOME: h })).toMatchObject({ decisionProvider: "chat", decisionModel: "anthropic/claude-haiku" });
    const c = loadConfig({
      TABCREW_HOME: h,
      DECISION_PROVIDER: "auto",
      DECISION_MODEL: "other/model",
      DECISION_MODEL_API_KEY: " k ",
      DECISION_MODEL_BASE_URL: "http://localhost:1234/v1",
    });
    expect(c).toMatchObject({ decisionProvider: "auto", decisionModel: "other/model", decisionModelApiKey: "k", decisionModelBaseUrl: "http://localhost:1234/v1" });
    expect(() => loadConfig({ TABCREW_HOME: h, DECISION_PROVIDER: "gpt" })).toThrow(/DECISION_PROVIDER/);
    writeFileSync(join(h, "config.toml"), 'decision_provider = "chat"\n');
    expect(() => loadConfig({ TABCREW_HOME: h })).toThrow(/needs decision_model/);
  });

  it("rejects invalid values", () => {
    const h = home();
    expect(() => loadConfig({ TABCREW_HOME: h, TABCREW_MCP_PORT: "70000" })).toThrow(/TABCREW_MCP_PORT/);
    expect(() => loadConfig({ TABCREW_HOME: h, CHROMEUSE_MCP_PORT: "70000" })).toThrow(/CHROMEUSE_MCP_PORT/);
    writeFileSync(join(h, "config.toml"), "mcp_port = -1\n");
    expect(() => loadConfig({ TABCREW_HOME: h })).toThrow(/mcp_port/);
  });

  it("reads TABCREW_* first and falls back to the deprecated CHROMEUSE_* names", () => {
    const h = home();
    const legacy = loadConfig({
      CHROMEUSE_HOME: h,
      CHROMEUSE_MCP_PORT: "9100",
      CHROMEUSE_EXTENSION_PORT: "9101",
      CHROMEUSE_IDLE_TIMEOUT_MINUTES: "7",
      CHROMEUSE_BROWSE_CONCURRENCY: "3",
      CHROMEUSE_ALLOWED_ORIGINS: "http://a, http://b",
    });
    expect(legacy).toMatchObject({
      home: h,
      mcpPort: 9100,
      extensionPort: 9101,
      idleTimeoutMinutes: 7,
      browseConcurrency: 3,
      allowedOrigins: ["http://a", "http://b"],
    });
    const both = loadConfig({
      TABCREW_HOME: h,
      CHROMEUSE_HOME: "/nonexistent-legacy",
      TABCREW_MCP_PORT: "9200",
      CHROMEUSE_MCP_PORT: "9100",
      TABCREW_IDLE_TIMEOUT_MINUTES: " ",
      CHROMEUSE_IDLE_TIMEOUT_MINUTES: "9",
    });
    expect(both).toMatchObject({ home: h, mcpPort: 9200, idleTimeoutMinutes: 9 });
  });

  it("defaults the home to ~/.tabcrew", () => {
    expect(resolveHome({}, "/Users/x")).toBe("/Users/x/.tabcrew");
    expect(resolveHome({ CHROMEUSE_HOME: "/legacy" }, "/Users/x")).toBe("/legacy");
    expect(resolveHome({ TABCREW_HOME: "/new", CHROMEUSE_HOME: "/legacy" }, "/Users/x")).toBe("/new");
  });

  it("loads <home>/env without overriding existing vars, only when 0600", () => {
    const h = home();
    const file = join(h, "env");
    writeFileSync(file, '# comment\nOPENROUTER_API_KEY="abc"\nexport FOO=bar\nKEEP=new\n', { mode: 0o600 });
    const env: Record<string, string | undefined> = { KEEP: "old" };
    expect(loadEnvFile(h, env).sort()).toEqual(["FOO", "OPENROUTER_API_KEY"]);
    expect(env).toEqual({ KEEP: "old", OPENROUTER_API_KEY: "abc", FOO: "bar" });

    chmodSync(file, 0o644);
    const env2: Record<string, string | undefined> = {};
    expect(loadEnvFile(h, env2)).toEqual([]);
    expect(env2).toEqual({});
  });
});

describe("token", () => {
  it("creates a 0600 token once in a 0700 home", () => {
    const h = join(home(), "nested");
    const t1 = ensureToken(h);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(h, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(h).mode & 0o777).toBe(0o700);
    expect(ensureToken(h)).toBe(t1);
    expect(safeEqual(t1, t1)).toBe(true);
    expect(safeEqual(t1, `${t1}x`)).toBe(false);
  });
});

describe("launchd", () => {
  it("writes the com.tabcrew.daemon plist without secrets and with logs under home", () => {
    const h = home();
    const opts = {
      home: h,
      launchAgentsDir: join(h, "LaunchAgents"),
      nodePath: "/usr/local/bin/node",
      scriptPath: "/Users/x/.tabcrew/app/daemon.mjs",
      pathEnv: "/usr/bin:/bin",
    };
    const path = writeLaunchdPlist(opts);
    expect(path).toBe(join(h, "LaunchAgents", "com.tabcrew.daemon.plist"));
    const plist = launchdPlist(opts);
    expect(plist).toContain("<string>com.tabcrew.daemon</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>\n    <string>/Users/x/.tabcrew/app/daemon.mjs</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/usr/bin:/bin</string>");
    expect(plist).toContain(join(h, "logs", "daemon.err.log"));
    expect(plist).toContain(join(h, "logs", "daemon.out.log"));
    expect(plist).not.toMatch(/OPENROUTER|TABCREW_HOME/);
    expect(statSync(join(h, "logs")).isDirectory()).toBe(true);
  });

  it("sets TABCREW_HOME only for a custom home and escapes XML", () => {
    const plist = launchdPlist({
      home: "/tmp/a&b",
      launchAgentsDir: "/tmp/la",
      nodePath: "/n",
      scriptPath: "/s<x>",
      pathEnv: "/bin",
      tabcrewHome: "/tmp/a&b",
    });
    expect(plist).toContain("<key>TABCREW_HOME</key>\n    <string>/tmp/a&amp;b</string>");
    expect(plist).toContain("<string>/s&lt;x&gt;</string>");
  });

  it("prefers a stable node link over a versioned Cellar path", () => {
    const real = (p: string) => (p === "/opt/homebrew/bin/node" || p === "/cellar/node/22/bin/node" ? "/cellar/node/22/bin/node" : p);
    expect(stableNodePath("/cellar/node/22/bin/node", real)).toBe("/opt/homebrew/bin/node");
    expect(stableNodePath("/somewhere/node", (p) => p)).toBe("/somewhere/node");
  });
});
