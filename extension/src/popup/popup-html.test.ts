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
    for (const m of ts.matchAll(/\bnote\("([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const id of ['"provider-base-url"', '"provider-key"', '"provider-decision-model"', '"provider-text-model"']) ids.add(id.slice(1, -1));
    expect(ids.size).toBeGreaterThan(30);
    for (const id of ["groups-section", "group-name", "groups", "groups-note", "new-group-note", "finish-section", "finish-note"]) expect(ids, id).toContain(id);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
  });

  it("has the Tab groups section (hidden until the state arrives): default name, group list, new group", () => {
    expect(tag("groups-section")).toMatch(/^<section\b[^>]*\bhidden\b/);
    const section = html.slice(html.indexOf('id="groups-section"'), html.indexOf("</section>", html.indexOf('id="groups-section"')));
    expect(section).toContain("<h2>Tab groups</h2>");
    for (const id of ["group-name", "new-group"]) expect(tag(id)).toMatch(/^<input\b[^>]*type="text"/);
    for (const id of ["save-group-name", "create-group"]) expect(tag(id)).toMatch(/^<button\b/);
    expect(tag("groups")).toMatch(/^<ul\b/);
    // Each control's message line sits right after it.
    for (const [control, noteId] of [["save-group-name", "group-name-note"], ["create-group", "new-group-note"]]) {
      const between = section.slice(section.indexOf(`id="${control}"`), section.indexOf(`<p id="${noteId}"`));
      expect(between.length, control).toBeGreaterThan(0);
      expect(between, control).not.toMatch(/<(label|input|p)\b/);
    }
    expect(section).toContain("it appears when an agent uses it (session_open with group");
  });

  it("has the finish radios: keep (checked), close, collect in the ✓ group, and the per-call override note", () => {
    expect(tag("finish-section")).toMatch(/^<section\b[^>]*\bhidden\b/);
    expect(html).toMatch(/<input type="radio" name="finish-mode" value="keep" checked \/> Keep tabs in the group \(default\)/);
    expect(html).toMatch(/<input type="radio" name="finish-mode" value="close" \/> Close tabs/);
    expect(html).toMatch(/<input type="radio" name="finish-mode" value="collect" \/> <span id="finish-collect-label">Collect in "✓ TabCrew"<\/span>/);
    expect(html).toContain("An agent can override this per call (session_close with tabs: keep, close or collect).");
    expect(ts).toContain('$("finish-collect-label").textContent = collectLabel(groupName)');
    expect(ts).toContain('type: "v2:set_finish_mode", mode');
  });

  it("re-reads the state after every group action and shows problems next to the control", () => {
    for (const [id, noteId, request] of [
      ["save-group-name", "group-name-note", "v2:set_group_name"],
      ["create-group", "new-group-note", "v2:create_group"],
    ]) {
      const body = clickHandler(id);
      expect(body, id).toContain(`type: "${request}"`);
      expect(body, id).toContain("checkGroupName(");
      expect(body, id).toMatch(new RegExp(`note\\("${noteId}", check\\.error, "error"\\)`));
      expect(body, id).toMatch(new RegExp(`note\\("${noteId}", shown\\.text, shown\\.tone\\)`));
      expect(body.indexOf("await refresh()"), id).toBeGreaterThan(body.indexOf(`type: "${request}"`));
    }
    const finish = ts.slice(ts.indexOf('input[name="finish-mode"]\').forEach((radio)'));
    expect(finish.slice(0, finish.indexOf("\n);\n"))).toContain("await refresh()");
    const rename = ts.slice(ts.indexOf("async function saveRename("), ts.indexOf("\n}\n", ts.indexOf("async function saveRename(")));
    // Fresh state first (name-only entries' ids shift), then the request, then a re-read.
    const order = ["getState()", "renameTarget(", "checkGroupName(", 'type: "v2:rename_group"', "await refresh()"].map((s) => rename.indexOf(s));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rename).toContain("setNote(problem, ");
    const edit = ts.slice(ts.indexOf("function editRow("), ts.indexOf("\n}\n", ts.indexOf("function editRow(")));
    expect(edit).toContain('e.key === "Enter"');
    expect(edit).toContain('e.key === "Escape"');
  });

  it("Online mode: account model settings link and the own-provider toggle, before the provider form", () => {
    expect(tag("online-model-group")).toMatch(/\bhidden\b/);
    const group = html.slice(html.indexOf('id="online-model-group"'), html.indexOf('id="provider-group"'));
    expect(group).toContain('id="open-model-settings"');
    expect(group).toMatch(/<input type="checkbox" id="own-model" \/> Use this browser's own provider instead/);
    const apply = ts.slice(ts.indexOf("function applyOwnModel("), ts.indexOf("\n}\n", ts.indexOf("function applyOwnModel(")));
    expect(apply).toContain('$("online-model-group").hidden = mode !== "online"');
    expect(apply).toContain('if (mode === "online") $("provider-group").hidden = !ownModel');
    expect(ts).toContain("chrome.storage.local.set({ [OWN_MODEL_KEY]: ownModel })");
    expect(ts).toContain("/settings`");
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
