import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderSettings } from "../model/settings.js";
import { createFakeChrome, type FakeChrome } from "../test/fakes.js";
import { DRAFT_KEY, clearProviderDraft, draftDiffers, loadProviderDraft, parseProviderDraft, saveProviderDraft } from "./draft.js";
import { providerFormFrom, type ProviderForm } from "./view.js";

const SAVED: ProviderSettings = {
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  api_key: "sk-provider-secret-1234",
  headers: { "OpenAI-Organization": "org-1" },
  decision_model: "gemini-3.6-flash",
  text_model: "gemini-3.1-flash-lite",
};

const DRAFT: ProviderForm = {
  preset: "provider-b",
  base_url: "https://llm2.example.com/v1",
  api_key: "sk-typed-5678",
  headers: [{ name: "X-Team", value: "crew" }],
  decision_model: "gpt-6-luna",
  text_model: "",
  fallback_text_model: "my-custom-model",
};

describe("parseProviderDraft", () => {
  it("keeps a well-formed draft", () => {
    expect(parseProviderDraft(structuredClone(DRAFT))).toEqual(DRAFT);
  });

  it("rejects anything that isn't a draft", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, { ...DRAFT, preset: "nope" }, { ...DRAFT, api_key: 3 }, { ...DRAFT, headers: "x" }, { ...DRAFT, headers: [{ name: 1, value: "" }] }, { ...DRAFT, text_model: null }]) {
      expect(parseProviderDraft(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("draftDiffers", () => {
  it("the form built from saved settings never carries the saved key (the input stays write-only)", () => {
    expect(providerFormFrom(SAVED).api_key).toBe("");
  });

  it("an untouched form matches its saved settings (or the empty form when nothing is saved)", () => {
    expect(draftDiffers(providerFormFrom(SAVED), SAVED)).toBe(false);
    expect(draftDiffers(providerFormFrom(null), null)).toBe(false);
  });

  it("ignores blank header rows, whitespace and a trailing slash on the base URL", () => {
    const form = providerFormFrom(SAVED);
    expect(
      draftDiffers(
        {
          ...form,
          base_url: " https://llm.example.com/v1/ ",
          headers: [...form.headers.map((h) => ({ name: ` ${h.name}`, value: `${h.value} ` })), { name: "", value: "" }],
          decision_model: " gemini-3.6-flash",
        },
        SAVED,
      ),
    ).toBe(false);
  });

  it("re-typing the saved key is not a change; any other key is", () => {
    const form = providerFormFrom(SAVED);
    expect(draftDiffers({ ...form, api_key: "sk-provider-secret-1234" }, SAVED)).toBe(false);
    expect(draftDiffers({ ...form, api_key: "sk-other" }, SAVED)).toBe(true);
    expect(draftDiffers({ ...providerFormFrom(null), api_key: "sk-typed" }, null)).toBe(true);
  });

  it("any changed field is a change", () => {
    const form = providerFormFrom(SAVED);
    const changes: Partial<ProviderForm>[] = [
      { preset: "custom" },
      { base_url: "https://llm2.example.com/v1" },
      { headers: [] },
      { headers: [{ name: "OpenAI-Organization", value: "org-2" }] },
      { decision_model: "gpt-6-luna" },
      { text_model: "" },
      { fallback_text_model: "gpt-6-luna" },
    ];
    for (const change of changes) expect(draftDiffers({ ...form, ...change }, SAVED), JSON.stringify(change)).toBe(true);
    expect(draftDiffers({ ...providerFormFrom(null), decision_model: "x" }, null)).toBe(true);
  });
});

describe("draft storage", () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = createFakeChrome();
    fake.install();
  });

  it("round-trips through chrome.storage.session only (never local or sync)", async () => {
    await saveProviderDraft(DRAFT);
    expect(fake.chrome.storage.session._data()[DRAFT_KEY]).toEqual(DRAFT);
    expect(fake.chrome.storage.local._data()).toEqual({});
    expect(await loadProviderDraft()).toEqual(DRAFT);
  });

  it("starts the write synchronously, so a popup closing right after still keeps it", () => {
    void saveProviderDraft(DRAFT);
    expect(fake.chrome.storage.session.set).toHaveBeenCalledWith({ [DRAFT_KEY]: DRAFT });
  });

  it("clears it, and ignores a malformed or missing draft", async () => {
    await saveProviderDraft(DRAFT);
    await clearProviderDraft();
    expect(await loadProviderDraft()).toBeNull();
    await fake.chrome.storage.session.set({ [DRAFT_KEY]: { junk: true } });
    expect(await loadProviderDraft()).toBeNull();
  });
});
