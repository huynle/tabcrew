import { describe, expect, it } from "vitest";
import type { ProviderSettings } from "../model/settings.js";
import { CUSTOM_MODEL, chatModelIds, modelPicker, modelsStatus, pickedModel, providerKeyStatus, type ModelPickerInput } from "./view.js";

const SAVED: ProviderSettings = {
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  api_key: "sk-provider-secret-1234",
  headers: {},
  decision_model: "gemini-3.6-flash",
  text_model: "gemini-3.1-flash-lite",
};

const MODELS = ["claude-haiku-4-5", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gpt-6-luna"];

const picker = (extra: Partial<ModelPickerInput>) =>
  modelPicker({ slot: "decision_model", models: MODELS, value: "", saved: "", recommended: undefined, ...extra });

describe("chatModelIds", () => {
  it("keeps chat models, sorted and unique, dropping embeddings, audio, rerank and moderation", () => {
    expect(
      chatModelIds([
        "gpt-6-luna",
        "text-embedding-3-large",
        "whisper-1",
        "gpt-4o-mini-tts",
        "cohere-rerank-v3",
        "omni-moderation-latest",
        "claude-haiku-4-5",
        "gpt-6-luna",
        "Titan-Embed-Text",
      ]),
    ).toEqual(["claude-haiku-4-5", "gpt-6-luna"]);
  });
});

describe("modelPicker", () => {
  it("before loading: a disabled placeholder and Custom…", () => {
    expect(picker({ models: null })).toEqual({
      options: [
        { value: "", label: "Load models to choose…", disabled: true },
        { value: CUSTOM_MODEL, label: "Custom…", disabled: false },
      ],
      selected: "",
      custom: null,
      preselected: false,
    });
  });

  it("keeps a saved value selectable before loading, shown as (saved)", () => {
    const view = picker({ models: null, value: "gemini-3.6-flash", saved: "gemini-3.6-flash" });
    expect(view.options.map((o) => o.label)).toEqual(["Load models to choose…", "gemini-3.6-flash (saved)", "Custom…"]);
    expect(view.selected).toBe("gemini-3.6-flash");
  });

  it("lists the models and preselects the recommended one when the field is empty", () => {
    const view = picker({ recommended: "gemini-3.6-flash" });
    expect(view.options).toEqual([
      { value: "", label: "Choose a model…", disabled: true },
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5", disabled: false },
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite", disabled: false },
      { value: "gemini-3.6-flash", label: "gemini-3.6-flash (recommended)", disabled: false },
      { value: "gpt-6-luna", label: "gpt-6-luna", disabled: false },
      { value: CUSTOM_MODEL, label: "Custom…", disabled: false },
    ]);
    expect(view.selected).toBe("gemini-3.6-flash");
    expect(view.preselected).toBe(true);
  });

  it("does not preselect a recommendation the provider does not list, nor over a chosen value", () => {
    expect(picker({ recommended: "gemini-9" })).toMatchObject({ selected: "", preselected: false });
    expect(picker({ recommended: "gemini-3.6-flash", value: "gpt-6-luna" })).toMatchObject({ selected: "gpt-6-luna", preselected: false });
  });

  it("keeps a saved value the provider no longer lists, shown as (saved) after the placeholder", () => {
    const view = picker({ value: "old-model", saved: "old-model" });
    expect(view.options[1]).toEqual({ value: "old-model", label: "old-model (saved)", disabled: false });
    expect(view.selected).toBe("old-model");
    expect(view.custom).toBeNull();
  });

  it("shows any other unlisted value as Custom… with its text", () => {
    expect(picker({ value: "my-finetune", saved: "gpt-6-luna" })).toMatchObject({ selected: CUSTOM_MODEL, custom: "my-finetune" });
    expect(picker({ models: null, value: " my-finetune " })).toMatchObject({ selected: CUSTOM_MODEL, custom: "my-finetune" });
  });

  it("offers None for the optional fallback, before and after loading", () => {
    const before = modelPicker({ slot: "fallback_text_model", models: null, value: "", saved: "", recommended: "gpt-6-luna" });
    expect(before.options.map((o) => [o.value, o.label])).toEqual([
      ["", "None"],
      [CUSTOM_MODEL, "Custom…"],
    ]);
    expect(before.selected).toBe("");
    const after = modelPicker({ slot: "fallback_text_model", models: MODELS, value: "", saved: "", recommended: "gpt-6-luna" });
    expect(after.options[0]).toEqual({ value: "", label: "None", disabled: false });
    expect(after.selected).toBe("gpt-6-luna");
    expect(after.preselected).toBe(true);
  });

  it("respects a saved None for the fallback: labels the recommendation but does not preselect it", () => {
    const view = modelPicker({ slot: "fallback_text_model", models: MODELS, value: "", saved: "", saved_provider: true, recommended: "gpt-6-luna" });
    expect(view.options.find((o) => o.value === "gpt-6-luna")?.label).toBe("gpt-6-luna (recommended)");
    expect(view).toMatchObject({ selected: "", preselected: false });
    expect(picker({ saved_provider: true, recommended: "gemini-3.6-flash" })).toMatchObject({ selected: "gemini-3.6-flash", preselected: true });
  });
});

describe("pickedModel", () => {
  it("is the selected id, or the trimmed custom text for Custom…", () => {
    expect(pickedModel("gpt-6-luna", "ignored")).toBe("gpt-6-luna");
    expect(pickedModel("", "x")).toBe("");
    expect(pickedModel(CUSTOM_MODEL, "  my-finetune ")).toBe("my-finetune");
  });
});

describe("modelsStatus", () => {
  const URL = "https://llm.example.com/v1";

  it("counts the chat models from the host", () => {
    expect(modelsStatus({ ok: true, models: ["a", "b", "text-embedding-3"] }, URL, false)).toEqual({
      text: "✓ 2 models from llm.example.com",
      tone: "ok",
    });
    expect(modelsStatus({ ok: true, models: ["a"] }, URL, true)).toEqual({
      text: "✓ 1 model from llm.example.com · recommended models picked, click Save to use them",
      tone: "ok",
    });
  });

  it("suggests Custom… when the provider lists no chat models", () => {
    expect(modelsStatus({ ok: true, models: ["whisper-1"] }, URL, false)).toEqual({
      text: "llm.example.com listed no chat models. Choose Custom… and type the model id.",
      tone: "warn",
    });
  });

  it("shows the error (with its hint) and explains a denied permission", () => {
    expect(modelsStatus({ ok: false, error: "HTTP 401: bad key (check the API key and headers)" }, URL, false)).toEqual({
      text: "✗ HTTP 401: bad key (check the API key and headers)",
      tone: "error",
    });
    expect(modelsStatus({ ok: false, denied: true }, URL, false)).toEqual({
      text: "✗ Access to https://llm.example.com was not granted, so TabCrew can't list its models. Click Load models and choose Allow.",
      tone: "error",
    });
  });
});

describe("providerKeyStatus", () => {
  it("says the typed key is not saved yet, instead of 'Not set'", () => {
    expect(providerKeyStatus(null, "sk-typed")).toEqual({ text: "Not saved yet — click Save", tone: "warn" });
    expect(providerKeyStatus(SAVED, "sk-typed")).toEqual({ text: "Not saved yet — click Save", tone: "warn" });
  });

  it("is 'Not set' only when nothing is typed or saved", () => {
    expect(providerKeyStatus(null, "  ")).toEqual({ text: "Not set — browse disabled", tone: "error" });
    expect(providerKeyStatus(null)).toEqual({ text: "Not set — browse disabled", tone: "error" });
    expect(providerKeyStatus(SAVED, "")).toEqual({ text: "Set …1234 (leave empty to keep it)", tone: "" });
  });
});
