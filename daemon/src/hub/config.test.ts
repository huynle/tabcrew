import { describe, expect, it } from "vitest";
import { HUB_DEFAULT_IDLE_MINUTES, HUB_MODEL_PLACEHOLDER, hubConfig, parseHubArgs } from "./config.js";

describe("parseHubArgs", () => {
  it("defaults to port 8775 and 10 idle minutes", () => {
    expect(parseHubArgs([])).toEqual({ ok: true, args: { port: 8775, idleMinutes: 10, help: false } });
    expect(HUB_DEFAULT_IDLE_MINUTES).toBe(10);
  });

  it("reads --port and --idle-minutes (separate or = values)", () => {
    expect(parseHubArgs(["--port", "18775", "--idle-minutes=1"])).toEqual({
      ok: true,
      args: { port: 18775, idleMinutes: 1, help: false },
    });
    expect(parseHubArgs(["--port=0", "--idle-minutes", "0"])).toEqual({ ok: true, args: { port: 0, idleMinutes: 0, help: false } });
    expect(parseHubArgs(["--idle-minutes", "0.5"])).toMatchObject({ ok: true, args: { idleMinutes: 0.5 } });
  });

  it("recognises --help / -h", () => {
    expect(parseHubArgs(["--help"])).toMatchObject({ ok: true, args: { help: true } });
    expect(parseHubArgs(["-h"])).toMatchObject({ ok: true, args: { help: true } });
  });

  it("rejects bad values, missing values and unknown flags", () => {
    for (const argv of [
      ["--port", "70000"],
      ["--port", "abc"],
      ["--port", "1.5"],
      ["--port"],
      ["--idle-minutes", "-1"],
      ["--idle-minutes", "x"],
      ["--bogus"],
      ["extra"],
    ]) {
      const parsed = parseHubArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

describe("hubConfig", () => {
  it("builds a DaemonConfig in code: given port, chat decisions via the extension, no keys", () => {
    const config = hubConfig({ port: 18775, idleMinutes: 10, help: false }, "/rt");
    expect(config.extensionPort).toBe(18775);
    expect(config.home).toBe("/rt");
    expect(config.decisionProvider).toBe("chat");
    expect(config.decisionModel).toBe(HUB_MODEL_PLACEHOLDER);
    expect(config.textModel).toBe(HUB_MODEL_PLACEHOLDER);
    expect(config.textModelFallback).toBe(HUB_MODEL_PLACEHOLDER);
    expect(config.openrouterApiKey).toBeUndefined();
    expect(config.textModelApiKey).toBeUndefined();
    expect(config.decisionModelApiKey).toBeUndefined();
    expect(config.textModelBaseUrl).toBeUndefined();
    expect(config.decisionModelBaseUrl).toBeUndefined();
    expect(config.allowedOrigins).toEqual([]);
    expect(config.idleTimeoutMinutes).toBeGreaterThan(0);
  });

  it("ignores TABCREW_* / model environment variables (no ~/.tabcrew config in hub mode)", () => {
    const before = { ...process.env };
    process.env.TABCREW_EXTENSION_PORT = "1234";
    process.env.DECISION_MODEL = "x/y";
    process.env.OPENROUTER_API_KEY = "sk-secret";
    try {
      const config = hubConfig({ port: 8775, idleMinutes: 10, help: false }, "/rt");
      expect(config.extensionPort).toBe(8775);
      expect(config.decisionModel).toBe(HUB_MODEL_PLACEHOLDER);
      expect(config.openrouterApiKey).toBeUndefined();
    } finally {
      process.env = before;
    }
  });
});
