import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
const ts = readFileSync(new URL("./popup.ts", import.meta.url), "utf8");

/** The source of the click handler registered on `$("<id>")`. */
function clickHandler(id: string): string {
  const start = ts.indexOf(`$("${id}").addEventListener("click", async () => {`);
  expect(start, id).toBeGreaterThan(-1);
  const end = ts.indexOf("\n});\n", start);
  return ts.slice(start, end);
}

/** The opening tag of the element with this id. */
function tag(id: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  expect(match, id).not.toBeNull();
  return match![0];
}

describe("popup.html / popup.ts wiring", () => {
  it("has every element popup.ts looks up by id", () => {
    const ids = new Set([...ts.matchAll(/\$(?:<[A-Za-z]+>)?\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));
    for (const id of ['"provider-base-url"', '"provider-key"', '"provider-decision-model"', '"provider-text-model"']) ids.add(id.slice(1, -1));
    expect(ids.size).toBeGreaterThan(30);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
  });

  it("marks the daemon-only groups and keeps the provider hidden until hub mode", () => {
    expect(tag("provider-group")).toMatch(/class="group hub-only"/);
    expect(tag("provider-group")).toMatch(/\bhidden\b/);
    const daemonOnly = html.split('class="group daemon-only"').length - 1;
    expect(daemonOnly).toBe(3); // OpenRouter key, daemon models, text model override
    const tokenBlock = html.slice(html.indexOf('<div class="daemon-only">'), html.indexOf('id="port-label"'));
    expect(tokenBlock).toContain('id="token"');
    expect(html).toMatch(/<select id="mode"[^>]*>\s*<option value="auto">Auto<\/option>\s*<option value="hub">[^<]+<\/option>\s*<option value="daemon">/);
  });

  it("keeps the API key input write-only (password, never filled from storage)", () => {
    expect(tag("provider-key")).toMatch(/type="password"/);
    const assigned = [...ts.matchAll(/"provider-key"\)\.value\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned.every((v) => v === '""')).toBe(true);
  });

  it("requests host access synchronously in the Save, Test and Load models clicks, before any await", () => {
    for (const id of ["save-provider", "test-provider", "load-models"]) {
      const body = clickHandler(id);
      const request = body.indexOf("chrome.permissions.request(");
      expect(request, id).toBeGreaterThan(-1);
      expect(body.indexOf("await "), id).toBeGreaterThan(request);
    }
  });

  it("never prompts for access when the popup opens: the auto-load only checks it", () => {
    const load = ts.slice(ts.indexOf("async function autoLoadModels("), ts.indexOf("\n}\n", ts.indexOf("async function autoLoadModels(")));
    expect(load).toContain("chrome.permissions.contains(");
    expect(load).not.toContain("chrome.permissions.request(");
    expect(ts.match(/chrome\.permissions\.request\(/g)).toHaveLength(3);
  });

  it("makes the three models dropdowns with a Custom… text input and guidance under each", () => {
    const guidance: Record<string, string> = {
      "provider-decision-model": "Picks each browse step. Use a fast model that reliably returns JSON.",
      "provider-text-model": "Writes text into form fields. A small, cheap model is fine.",
      "provider-fallback-model": "Tried once if the text model fails. Optional.",
    };
    for (const [id, text] of Object.entries(guidance)) {
      expect(tag(id)).toMatch(/^<select\b/);
      expect(tag(`${id}-custom`)).toMatch(/^<input\b[^>]*type="text"[^>]*\bhidden\b/);
      const after = html.slice(html.indexOf(`id="${id}-custom"`));
      expect(after.slice(0, after.indexOf("<label") === -1 ? undefined : after.indexOf("<label"))).toContain(text);
    }
    expect(html).not.toContain("<datalist");
    expect(tag("load-models")).toMatch(/^<button\b/);
    expect(tag("provider-models-status")).toMatch(/class="note"/);
  });
});
