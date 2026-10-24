import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const DEV_ORIGIN = "chrome-extension://aejgcpbbemekfbmmkabpbgdkgmddfamo/";

describe("tabcrew package metadata", () => {
  it("is publishable with only the bundles, README and LICENSE", () => {
    expect(pkg.name).toBe("tabcrew");
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ tabcrew: "dist/cli.mjs" });
    expect(pkg.files).toEqual(["dist/cli.mjs", "dist/daemon.mjs", "dist/pair-host.mjs", "README.md", "LICENSE"]);
    expect(pkg.engines.node).toBe(">=20.0.0");
    expect(pkg.license).toBe("MIT");
    // npm --provenance requires repository.url to match the GitHub repository the workflow runs in.
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/huynle/tabcrew.git", directory: "cli" });
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe("bundles", () => {
  let out;
  let home;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "tabcrew-bundle-"));
    home = mkdtempSync(join(tmpdir(), "tabcrew-bundle-home-"));
    execFileSync(process.execPath, [join(root, "build.mjs")], { env: { ...process.env, TABCREW_BUILD_OUT: out }, stdio: "pipe" });
  }, 60_000);
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("are three executable ESM files that import only node built-ins", () => {
    expect(readdirSync(out).sort()).toEqual(["cli.mjs", "daemon.mjs", "pair-host.mjs"]);
    for (const file of readdirSync(out)) {
      const text = readFileSync(join(out, file), "utf8");
      expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
      const imports = [...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const spec of imports) expect(spec).toMatch(/^node:|^(fs|path|os|url|crypto|http|https|net|events|stream|util|child_process|readline|zlib|buffer|module|tls|querystring|string_decoder|assert|async_hooks|process|worker_threads)$/);
    }
  });

  it("run from outside the repository (no node_modules)", () => {
    const env = { ...process.env, TABCREW_HOME: join(home, "h"), NODE_PATH: "" };
    const help = spawnSync(process.execPath, [join(out, "cli.mjs"), "--help"], { cwd: out, env, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: tabcrew");
    const token = spawnSync(process.execPath, [join(out, "cli.mjs"), "token"], { cwd: out, env, encoding: "utf8" });
    expect(token.status).toBe(0);
    expect(token.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const daemonHelp = spawnSync(process.execPath, [join(out, "daemon.mjs"), "--help"], { cwd: out, env, encoding: "utf8" });
    expect(daemonHelp.status).toBe(0);
    expect(daemonHelp.stdout).toContain("TabCrew daemon");
    const mcpHelp = spawnSync(process.execPath, [join(out, "cli.mjs"), "mcp", "--help"], { cwd: out, env, encoding: "utf8" });
    expect(mcpHelp.status).toBe(0);
    expect(mcpHelp.stdout).toContain("usage: tabcrew mcp");
    const hubHelp = spawnSync(process.execPath, [join(out, "daemon.mjs"), "hub", "--help"], { cwd: out, env, encoding: "utf8" });
    expect(hubHelp.status).toBe(0);
    expect(hubHelp.stdout).toContain("usage: daemon.mjs hub");

    const body = Buffer.from(JSON.stringify({ type: "get_token" }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const pair = spawnSync(process.execPath, [join(out, "pair-host.mjs"), DEV_ORIGIN], { cwd: out, env, input: Buffer.concat([header, body]) });
    expect(pair.status).toBe(0);
    const reply = JSON.parse(pair.stdout.subarray(4, 4 + pair.stdout.readUInt32LE(0)).toString("utf8"));
    expect(reply).toEqual({ token: token.stdout.trim() });
    expect(pair.stderr.toString()).not.toContain(reply.token);
    // Six bundled processes in a row: past vitest's default 5 s when the machine is busy.
  }, 30_000);
});

/** A free TCP port on 127.0.0.1, at or above 18775 (8771 belongs to other tools on some machines). */
async function freePort(from = 18775) {
  for (let port = from; port < from + 200; port++) {
    const ok = await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free port");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("tabcrew mcp end to end (built bundles, real hub)", () => {
  let out;
  let base;
  let env;
  const hubPids = new Set();
  const transports = [];
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "tabcrew-bundle-"));
    execFileSync(process.execPath, [join(root, "build.mjs")], { env: { ...process.env, TABCREW_BUILD_OUT: out }, stdio: "pipe" });
    // Short paths: the hub socket must fit in 104 bytes. Never the user's real runtime/state dirs.
    base = mkdtempSync(join(tmpdir(), "tc-e2e-"));
    env = { ...process.env, TABCREW_HUB_RUNTIME_DIR: join(base, "rt"), TABCREW_HUB_STATE_DIR: join(base, "st") };
  }, 60_000);
  afterAll(async () => {
    for (const t of transports) await t.close().catch(() => {});
    for (const pid of hubPids) if (alive(pid)) process.kill(pid, "SIGTERM");
    rmSync(out, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  async function client(port) {
    const stderr = [];
    const errors = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(out, "cli.mjs"), "mcp", "--port", String(port), "--idle-minutes", "0.05"],
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (c) => stderr.push(String(c)));
    transports.push(transport);
    const c = new Client({ name: "e2e", version: "0" });
    await c.connect(transport);
    // Anything on the shim's stdout that is not JSON-RPC surfaces here.
    transport.onerror = (err) => errors.push(err);
    return { c, transport, stderr, errors };
  }

  it("spawns one shared hub, serves the TabCrew tools to two clients, then idle-exits", async () => {
    const port = await freePort();
    const rt = join(base, "rt");
    const info = () => JSON.parse(readFileSync(join(rt, "hub.json"), "utf8"));

    const a = await client(port);
    const toolsA = (await a.c.listTools()).tools.map((t) => t.name);
    expect(toolsA).toEqual(expect.arrayContaining(["session_open", "browse", "session_close"]));
    await until(() => existsSync(join(rt, "hub.json")), 5_000, "hub.json");
    const hub = info();
    hubPids.add(hub.pid);
    expect(hub.wsPort).toBe(port);

    const b = await client(port);
    const toolsB = (await b.c.listTools()).tools.map((t) => t.name);
    expect(toolsB.sort()).toEqual([...toolsA].sort());
    expect(info().pid).toBe(hub.pid);
    expect(alive(hub.pid)).toBe(true);

    for (const x of [a, b]) {
      expect(x.errors).toEqual([]);
      expect(x.stderr.join("")).not.toMatch(/warning|failed|lost connection/);
    }
    await a.transport.close();
    await b.transport.close();

    // --idle-minutes 0.05 = 3 s after the last client: the hub exits and cleans up after itself.
    await until(() => !alive(hub.pid) && !existsSync(join(rt, "hub.sock")) && !existsSync(join(rt, "hub.json")), 15_000, "hub idle exit");
  }, 40_000);
});
