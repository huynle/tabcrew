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

  it("keeps the API key input write-only (password; only ever filled from the form, which never holds the saved key)", () => {
    expect(tag("provider-key")).toMatch(/type="password"/);
    const assigned = [...ts.matchAll(/"provider-key"\)\.value\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(assigned).toEqual(["form.api_key"]);
    const fill = ts.slice(ts.indexOf("function fillProviderForm("), ts.indexOf("\n}\n", ts.indexOf("function fillProviderForm(")));
    expect(fill).toContain('"provider-key").value = form.api_key');
    // The key is never shown as text anywhere: only the password input's value.
    expect(ts).not.toMatch(/textContent\s*=\s*[^;]*api_key/);
  });

  it("keeps the unsaved provider draft in chrome.storage.session (never local or sync)", () => {
    const draft = readFileSync(new URL("./draft.ts", import.meta.url), "utf8");
    expect(draft).toContain("chrome.storage.session.set(");
    expect(draft).not.toMatch(/chrome\.storage\.(local|sync)\.\w+\(/);
    expect(ts).not.toContain("storage.sync");
    expect(ts).toMatch(/\$\("provider-group"\)\.addEventListener\("input",/);
    expect(ts).toMatch(/\$\("provider-group"\)\.addEventListener\("change",/);
  });

  it("writes the draft before asking for access in Load models and Test (the prompt closes the popup)", () => {
    for (const id of ["load-models", "test-provider"]) {
      const body = clickHandler(id);
      const persist = body.indexOf("persistDraft(");
      expect(persist, id).toBeGreaterThan(-1);
      expect(persist, id).toBeLessThan(body.indexOf("chrome.permissions.request("));
    }
  });

  it("clears the draft on Save and Remove, and restores it on open (auto-load never prompts)", () => {
    expect(clickHandler("save-provider")).toContain("clearProviderDraft(");
    const remove = ts.slice(ts.indexOf('remove.addEventListener("click", async () => {'));
    expect(remove.slice(0, remove.indexOf("\n  });\n"))).toContain("clearProviderDraft(");
    const load = ts.slice(ts.indexOf("async function loadProvider("), ts.indexOf("\n}\n", ts.indexOf("async function loadProvider(")));
    for (const call of ["loadProviderDraft(", "draftDiffers(", "DRAFT_RESTORED", "autoLoadModels("]) expect(load, call).toContain(call);
    expect(load).not.toContain("chrome.permissions.request(");
    expect(tag("provider-draft-note")).toMatch(/class="note/);
  });

  it("shows form problems next to the clicked button: Load models in its status line, Test and Save in provider-note", () => {
    expect(clickHandler("load-models")).toMatch(/providerProblem\("provider-models-status", input\.field, input\.error\)/);
    expect(clickHandler("test-provider")).toMatch(/providerProblem\("provider-note", input\.field, input\.error\)/);
    expect(clickHandler("save-provider")).toMatch(/providerProblem\("provider-note", built\.field, built\.error\)/);
    const problem = ts.slice(ts.indexOf("function providerProblem("), ts.indexOf("\n}\n", ts.indexOf("function providerProblem(")));
    expect(problem).toContain('classList.add("invalid")');
    expect(problem).toContain(".focus()");
    const between = html.slice(html.indexOf('id="load-models"'), html.indexOf('<p id="provider-models-status"'));
    expect(between.length).toBeGreaterThan(0);
    expect(between).not.toMatch(/<(label|input|select|p)\b/);
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
