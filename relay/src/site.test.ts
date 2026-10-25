import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestRelay, type TestRelay } from "./testing/harness.js";

let t: TestRelay;
beforeEach(async () => {
  t = await startTestRelay();
});
afterEach(async () => {
  await t.close();
});

describe("public pages", () => {
  it("serves a home page with the MCP address and links to the privacy policy and account", async () => {
    const res = await fetch(`${t.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("TabCrew Online");
    expect(html).toContain(`${t.url}/mcp`);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/account"');
    expect(html).toContain("https://github.com/huynle/tabcrew");
  });

  it("serves the privacy policy, with heading anchors that its own links use", async () => {
    const res = await fetch(`${t.url}/privacy`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("TabCrew privacy policy");
    expect(html).toContain('id="online-mode-tabcrew-relay"');
    expect(html).toContain('href="#online-mode-tabcrew-relay"');
    expect(html).not.toContain("title: TabCrew privacy policy");
  });

  it("links the stylesheet by content version, and serves it and the fonts", async () => {
    const html = await (await fetch(`${t.url}/`)).text();
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(href).toMatch(/^\/static\/tabcrew\.css\?v=[0-9a-f]{10}$/);
    const css = await fetch(`${t.url}${href}`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain(".nav-link");
    const font = await fetch(`${t.url}/static/fonts/plex-sans-400.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${t.url}/static/fonts/../../package.json`)).status).toBe(404);
  });

  it("only answers GET and HEAD", async () => {
    expect((await fetch(`${t.url}/privacy`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${t.url}/`, { method: "POST" })).status).toBe(405);
  });

  it("the bundled privacy policy matches docs/privacy.md", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "gen-privacy.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
