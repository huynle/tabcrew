import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TABCREW_EXTENSION_IDS } from "@tabcrew/shared/product";
import { afterEach, describe, expect, it } from "vitest";
import { fakeSystem, type FakeSystem } from "../testing/fakeSystem.js";
import { tempHome } from "../testing/helpers.js";
import { cliMain } from "./main.js";
import { setup } from "./setup.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const LEGACY_TOKEN = "L".repeat(43);
const GOOD_KEY = "sk-or-good-123";
const BAD_KEY = "sk-or-bad-456";

const OPENCODE_V2 = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // the browser
      "chromeuse": {
        "type": "remote",
        "url": "http://127.0.0.1:8770/mcp",
        "headers": { "Authorization": "Bearer {file:~/.chromeuse/token}" },
        "oauth": false,
        "timeout": { "catalog": 30000, "execution": 900000 }
      },
      "other": { "type": "remote", "url": "https://example.com/mcp" } // keep me
    }
  }
}
`;

interface World {
  readonly root: string;
  readonly sys: FakeSystem;
  readonly runtimeDir: string;
  readonly support: string;
}

/** A temp HOME with a ChromeUse install: ~/.chromeuse, its plist and loaded job, an OpenCode config, Brave and claude. */
function world(opts: { legacy?: boolean; opencode?: string | null; claude?: boolean; platform?: NodeJS.Platform } = {}): World {
  const t = tempHome();
  cleanup = t.cleanup;
  const root = t.home;
  const runtimeDir = join(root, "pkg", "dist");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "daemon.mjs"), "// daemon bundle\n");
  writeFileSync(join(runtimeDir, "pair-host.mjs"), "// pair host bundle\n");
  const support = join(root, "Library", "Application Support");
  mkdirSync(join(support, "BraveSoftware", "Brave-Browser"), { recursive: true });

  const sys = fakeSystem(root, {
    runtimeDir,
    platform: opts.platform ?? "darwin",
    which: (cmd) => (cmd === "claude" && opts.claude !== false ? "/fake/bin/claude" : null),
  });
  if (opts.legacy !== false) {
    const legacy = join(root, ".chromeuse");
    mkdirSync(join(legacy, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, "token"), `${LEGACY_TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(legacy, "env"), `OPENROUTER_API_KEY=${GOOD_KEY}\n`, { mode: 0o600 });
    writeFileSync(join(legacy, "sessions.json"), "[]", { mode: 0o600 });
    mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(root, "Library", "LaunchAgents", "com.chromeuse.daemon.plist"), "<plist/>");
    sys.state.loaded.add("com.chromeuse.daemon");
  }
  const opencode = opts.opencode === undefined ? OPENCODE_V2 : opts.opencode;
  if (opencode !== null) {
    mkdirSync(join(root, ".config", "opencode"), { recursive: true });
    writeFileSync(join(root, ".config", "opencode", "opencode.jsonc"), opencode);
  }
  return { root, sys, runtimeDir, support };
}

const launchctlCalls = (sys: FakeSystem) => sys.calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(1).join(" "));

describe("tabcrew setup", () => {
  it("migrates ChromeUse, installs the runtime, swaps the launchd job, registers pairing and harnesses", async () => {
    const { root, sys, support } = world();
    const code = await setup(sys, { yes: true, harness: true });
    expect(code).toBe(0);
    const home = join(root, ".tabcrew");

    // 1. migration
    expect(readFileSync(join(home, "token"), "utf8").trim()).toBe(LEGACY_TOKEN);
    expect(lstatSync(join(root, ".chromeuse")).isSymbolicLink()).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);

    // 2. key already in env: no prompt, no network
    expect(sys.fetchUrls.filter((u) => u.includes("openrouter"))).toEqual([]);

    // 3. runtime copied into ~/.tabcrew/app
    expect(readFileSync(join(home, "app", "daemon.mjs"), "utf8")).toBe("// daemon bundle\n");
    expect(readFileSync(join(home, "app", "pair-host.mjs"), "utf8")).toBe("// pair host bundle\n");

    // 4. launchd: legacy job out (plist deleted), new plist bootstrapped, health awaited
    const plist = join(root, "Library", "LaunchAgents", "com.tabcrew.daemon.plist");
    expect(launchctlCalls(sys)).toEqual([
      "print gui/501/com.chromeuse.daemon",
      "bootout gui/501/com.chromeuse.daemon",
      "print gui/501/com.tabcrew.daemon",
      `bootstrap gui/501 ${plist}`,
    ]);
    expect(existsSync(join(root, "Library", "LaunchAgents", "com.chromeuse.daemon.plist"))).toBe(false);
    const plistText = readFileSync(plist, "utf8");
    expect(plistText).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plistText).toContain(`<string>${join(home, "app", "daemon.mjs")}</string>`);
    expect(plistText).toContain(join(home, "logs", "daemon.err.log"));
    expect(plistText).not.toContain("TABCREW_HOME");
    expect(sys.fetchUrls).toContain("http://127.0.0.1:8770/health");
    expect(sys.state.loaded).toEqual(new Set(["com.tabcrew.daemon"]));

    // 5. native messaging host: Chrome always, Brave because it is installed, Edge not
    const wrapper = join(home, "app", "pair-host");
    const chromeManifest = join(support, "Google", "Chrome", "NativeMessagingHosts", "com.tabcrew.pair.json");
    expect(JSON.parse(readFileSync(chromeManifest, "utf8"))).toEqual({
      name: "com.tabcrew.pair",
      description: expect.stringContaining("TabCrew"),
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${TABCREW_EXTENSION_IDS.dev}/`, "chrome-extension://bahebfheemnjhfnelblbiejbjljapgpa/"],
    });
    expect(existsSync(join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", "com.tabcrew.pair.json"))).toBe(true);
    expect(existsSync(join(support, "Microsoft Edge"))).toBe(false);
    accessSync(wrapper, constants.X_OK);
    expect(readFileSync(wrapper, "utf8")).toBe(
      `#!/bin/sh\n# TabCrew pairing host launcher, written by \`tabcrew setup\`. Chrome starts it via com.tabcrew.pair.\nexport TABCREW_HOME='${home}'\nexec '/opt/homebrew/bin/node' '${join(home, "app", "pair-host.mjs")}' "$@"\n`,
    );

    // 6. harnesses: chromeuse entry replaced in place (comments kept); Claude registered with the token
    const opencode = readFileSync(join(root, ".config", "opencode", "opencode.jsonc"), "utf8");
    expect(opencode).toContain("// my settings");
    expect(opencode).toContain("// keep me");
    expect(opencode).not.toContain('"chromeuse"');
    expect(opencode).toContain('"Authorization": "Bearer {file:~/.tabcrew/token}"');
    expect(opencode).toContain('"execution": 900000');
    expect(opencode.indexOf('"tabcrew"')).toBeLessThan(opencode.indexOf('"other"'));
    const add = sys.calls.find((c) => c[0] === "/fake/bin/claude" && c[2] === "add");
    expect(add).toEqual([
      "/fake/bin/claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "tabcrew",
      "http://127.0.0.1:8770/mcp",
      "--header",
      `Authorization: Bearer ${LEGACY_TOKEN}`,
    ]);

    // 7. next steps, and the token is never printed
    expect(sys.output()).toContain("Pairing is automatic");
    expect(sys.output()).not.toContain(LEGACY_TOKEN);
  });

  it("is idempotent: a second run restarts the job and changes nothing else", async () => {
    const { root, sys } = world();
    await setup(sys, { yes: true, harness: true });
    const opencodePath = join(root, ".config", "opencode", "opencode.jsonc");
    const before = readFileSync(opencodePath, "utf8");
    const token = readFileSync(join(root, ".tabcrew", "token"), "utf8");
    sys.calls.length = 0;

    expect(await setup(sys, { yes: true, harness: true })).toBe(0);
    expect(launchctlCalls(sys)).toEqual([
      "print gui/501/com.chromeuse.daemon",
      "print gui/501/com.tabcrew.daemon",
      "bootout gui/501/com.tabcrew.daemon",
      `bootstrap gui/501 ${join(root, "Library", "LaunchAgents", "com.tabcrew.daemon.plist")}`,
    ]);
    expect(readFileSync(opencodePath, "utf8")).toBe(before);
    expect(readFileSync(join(root, ".tabcrew", "token"), "utf8")).toBe(token);
    expect(sys.calls.filter((c) => c[0] === "/fake/bin/claude").map((c) => c[2])).toEqual(["get"]);
    expect(sys.output()).toContain("tabcrew already configured");
  });

  it("prompts for the OpenRouter key (hidden), rejects a bad one and saves a valid one with mode 600", async () => {
    const { root, sys } = world({ legacy: false, opencode: null, claude: false });
    sys.answers.secret.push(BAD_KEY, GOOD_KEY);
    expect(await setup(sys, { yes: false, harness: true })).toBe(0);
    const env = join(root, ".tabcrew", "env");
    expect(readFileSync(env, "utf8")).toBe(`OPENROUTER_API_KEY=${GOOD_KEY}\n`);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(sys.fetchUrls.filter((u) => u === "https://openrouter.ai/api/v1/key")).toHaveLength(2);
    expect(sys.output()).toContain("OpenRouter rejected that key");
    expect(sys.output()).not.toContain(GOOD_KEY);
    expect(sys.output()).not.toContain(BAD_KEY);
    // No ChromeUse install: no legacy bootout.
    expect(launchctlCalls(sys)[0]).toBe("print gui/501/com.chromeuse.daemon");
    expect(launchctlCalls(sys)).not.toContain("bootout gui/501/com.chromeuse.daemon");
  });

  it("with --yes takes the key from the environment, or skips it", async () => {
    const a = world({ legacy: false, opencode: null, claude: false });
    (a.sys.env as Record<string, string>).OPENROUTER_API_KEY = GOOD_KEY;
    expect(await setup(a.sys, { yes: true, harness: false })).toBe(0);
    expect(readFileSync(join(a.root, ".tabcrew", "env"), "utf8")).toContain(GOOD_KEY);
    cleanup?.();

    const b = world({ legacy: false, opencode: null, claude: false });
    expect(await setup(b.sys, { yes: true, harness: false })).toBe(0);
    expect(existsSync(join(b.root, ".tabcrew", "env"))).toBe(false);
    expect(b.sys.output()).toContain("browse will report model_error");
  });

  it("skips harnesses with --no-harness and when the user declines", async () => {
    const a = world();
    await setup(a.sys, { yes: true, harness: false });
    expect(a.sys.calls.some((c) => c[0] === "/fake/bin/claude")).toBe(false);
    expect(readFileSync(join(a.root, ".config", "opencode", "opencode.jsonc"), "utf8")).toBe(OPENCODE_V2);
    cleanup?.();

    const b = world();
    b.sys.answers.confirm.push(false, false);
    await setup(b.sys, { yes: false, harness: true });
    expect(b.sys.calls.some((c) => c[0] === "/fake/bin/claude")).toBe(false);
    expect(readFileSync(join(b.root, ".config", "opencode", "opencode.jsonc"), "utf8")).toBe(OPENCODE_V2);
  });

  it("can keep the chromeuse OpenCode entry and only point it at the new token path", async () => {
    const { root, sys } = world({ claude: false });
    sys.answers.confirm.push(true, false);
    await setup(sys, { yes: false, harness: true });
    const text = readFileSync(join(root, ".config", "opencode", "opencode.jsonc"), "utf8");
    expect(text).toContain('"chromeuse"');
    expect(text).not.toContain('"tabcrew"');
    expect(text).toContain("{file:~/.tabcrew/token}");
  });

  it("retries a failed bootstrap and fails clearly when the daemon never becomes healthy", async () => {
    const a = world({ opencode: null, claude: false });
    a.sys.state.bootstrapFailures = 1;
    expect(await setup(a.sys, { yes: true, harness: false })).toBe(0);
    expect(launchctlCalls(a.sys).filter((c) => c.startsWith("bootstrap"))).toHaveLength(2);
    cleanup?.();

    const b = world({ opencode: null, claude: false });
    b.sys.state.healthy = () => false;
    const start = b.sys.now();
    expect(await setup(b.sys, { yes: true, harness: false })).toBe(1);
    expect(b.sys.now() - start).toBeGreaterThanOrEqual(15_000);
    expect(b.sys.output()).toContain("did not answer");
    // Pairing is still registered so it works once the daemon starts.
    expect(existsSync(join(b.root, ".tabcrew", "app", "pair-host"))).toBe(true);
  });

  it("--from-source runs from a built checkout without copying the runtime", async () => {
    const { root, sys } = world({ opencode: null, claude: false });
    const repo = join(root, "repo");
    mkdirSync(join(repo, "daemon", "dist"), { recursive: true });
    mkdirSync(join(repo, "cli", "dist"), { recursive: true });
    writeFileSync(join(repo, "daemon", "dist", "index.js"), "");
    writeFileSync(join(repo, "cli", "dist", "pair-host.mjs"), "");
    expect(await setup(sys, { yes: true, harness: false, fromSource: repo })).toBe(0);
    expect(readFileSync(join(root, "Library", "LaunchAgents", "com.tabcrew.daemon.plist"), "utf8")).toContain(
      `<string>${join(repo, "daemon", "dist", "index.js")}</string>`,
    );
    expect(readFileSync(join(root, ".tabcrew", "app", "pair-host"), "utf8")).toContain(join(repo, "cli", "dist", "pair-host.mjs"));
    expect(existsSync(join(root, ".tabcrew", "app", "daemon.mjs"))).toBe(false);
  });

  it("uses TABCREW_HOME for a custom home and leaves ~/.chromeuse alone", async () => {
    const { root, sys } = world({ opencode: null, claude: false });
    const custom = join(root, "custom-home");
    (sys.env as Record<string, string>).TABCREW_HOME = custom;
    expect(await setup(sys, { yes: true, harness: false })).toBe(0);
    expect(lstatSync(join(root, ".chromeuse")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "Library", "LaunchAgents", "com.tabcrew.daemon.plist"), "utf8")).toContain(
      `<key>TABCREW_HOME</key>\n    <string>${custom}</string>`,
    );
  });

  it("does not install a service on other platforms", async () => {
    const { root, sys } = world({ legacy: false, opencode: null, claude: false, platform: "linux" });
    expect(await setup(sys, { yes: true, harness: false })).toBe(1);
    expect(sys.calls).toEqual([]);
    expect(sys.output()).toContain("not supported on linux yet");
    expect(existsSync(join(root, ".tabcrew", "token"))).toBe(true);
  });
});

describe("tabcrew CLI", () => {
  it("prints help, rejects unknown commands and options", async () => {
    const { sys } = world({ legacy: false, opencode: null, claude: false });
    expect(await cliMain(["--help"], sys)).toBe(0);
    expect(sys.output()).toContain("usage: tabcrew");
    expect(await cliMain(["frobnicate"], sys)).toBe(2);
    expect(await cliMain(["setup", "--purge"], sys)).toBe(2);
    expect(await cliMain(["setup", "--from-source"], sys)).toBe(2);
  });

  it("token prints (and creates) the token; it is the only command that prints it", async () => {
    const { root, sys } = world({ legacy: false, opencode: null, claude: false });
    expect(await cliMain(["token"], sys)).toBe(0);
    const token = readFileSync(join(root, ".tabcrew", "token"), "utf8").trim();
    expect(sys.lines).toEqual([token]);
  });

  it("update reinstalls the runtime and restarts the job", async () => {
    const { root, runtimeDir, sys } = world({ opencode: null, claude: false });
    await setup(sys, { yes: true, harness: false });
    writeFileSync(join(runtimeDir, "daemon.mjs"), "// newer daemon\n");
    sys.calls.length = 0;
    expect(await cliMain(["update"], sys)).toBe(0);
    expect(readFileSync(join(root, ".tabcrew", "app", "daemon.mjs"), "utf8")).toBe("// newer daemon\n");
    expect(launchctlCalls(sys)).toContain("bootout gui/501/com.tabcrew.daemon");
    expect(launchctlCalls(sys).at(-1)).toMatch(/^bootstrap gui\/501 /);
  });
});
