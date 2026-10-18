import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Request } from "@tabcrew/shared/v2";
import { OpError } from "./errors.js";
import { BridgeRelay, RECHECK_OFFSCREEN_MS, SERVICE_TOO_OLD_ERROR, type RelayDeps } from "./relay.js";
import { FakePort, createPortPair, flush } from "./test/fakes.js";

const session = { short_id: "abcd1234", label: "agent" };

function request(id: string): V2Request {
  return { type: "request", id, op: "tab_list", session, args: {} } as V2Request;
}

function setup(overrides: Partial<RelayDeps> = {}) {
  const deps: RelayDeps = {
    loadConfig: async () => ({ token: "t", port: 8771 }),
    handleRequest: vi.fn(async () => ({ ok: 1 })),
    onWelcome: vi.fn(),
    ensureOffscreen: vi.fn(async () => undefined),
    ...overrides,
  };
  const relay = new BridgeRelay(deps);
  /** `offscreen` is the offscreen document's end; the relay holds the other. */
  const attach = async (): Promise<FakePort> => {
    const [offscreen, sw] = createPortPair("v2-bridge");
    relay.attach(sw);
    await flush();
    return offscreen;
  };
  return { relay, deps, attach };
}

async function frames(offscreen: FakePort) {
  await flush();
  return offscreen
    .messages<{ type: string; frame?: Record<string, unknown> }>()
    .filter((m) => m.type === "frame")
    .map((m) => m.frame);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BridgeRelay", () => {
  it("pushes the stored config when the offscreen document connects", async () => {
    const { attach } = setup();
    const offscreen = await attach();
    expect(offscreen.messages()).toEqual([{ type: "config", token: "t", port: 8771, reconfigure: false }]);
  });

  it("mirrors the status posted by the offscreen document", async () => {
    const { relay, attach } = setup();
    const offscreen = await attach();
    expect(relay.status).toBe("offline");
    offscreen.postMessage({ type: "status", status: "connected" });
    await flush();
    expect(relay.status).toBe("connected");
    offscreen.postMessage({ type: "status", status: "unauthorized" });
    await flush();
    expect(relay.status).toBe("unauthorized");
  });

  it("handles forwarded requests concurrently and posts each response by id", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    const started: string[] = [];
    const { attach } = setup({
      handleRequest: (req) =>
        new Promise((resolve) => {
          started.push(req.id);
          resolvers[req.id] = resolve;
        }),
    });
    const offscreen = await attach();
    offscreen.postMessage({ type: "request", request: request("r1") });
    offscreen.postMessage({ type: "request", request: request("r2") });
    await flush();
    expect(started).toEqual(["r1", "r2"]); // both in flight before either finished

    resolvers.r2!({ tabs: [] });
    await flush();
    resolvers.r1!({ tabs: [1] });
    expect(await frames(offscreen)).toEqual([
      { type: "response", id: "r2", ok: true, result: { tabs: [] } },
      { type: "response", id: "r1", ok: true, result: { tabs: [1] } },
    ]);
  });

  it("maps thrown errors to typed error responses without stacks", async () => {
    const { attach } = setup({
      handleRequest: async (req) => {
        if (req.id === "a") throw new OpError("tab_not_owned", "tab 5 is not in this session's tab group");
        throw new Error("boom\n    at stack line");
      },
    });
    const offscreen = await attach();
    offscreen.postMessage({ type: "request", request: request("a") });
    offscreen.postMessage({ type: "request", request: request("b") });
    const responses = await frames(offscreen);
    expect(responses).toContainEqual({
      type: "response",
      id: "a",
      ok: false,
      error: { code: "tab_not_owned", message: "tab 5 is not in this session's tab group" },
    });
    expect(responses).toContainEqual({ type: "response", id: "b", ok: false, error: { code: "internal", message: "boom" } });
  });

  it("rejects requests without op or session", async () => {
    const { attach, deps } = setup();
    const offscreen = await attach();
    offscreen.postMessage({ type: "request", request: { type: "request", id: "x", args: {} } });
    expect(await frames(offscreen)).toEqual([
      { type: "response", id: "x", ok: false, error: { code: "invalid_args", message: "request needs op and session.short_id" } },
    ]);
    expect(deps.handleRequest).not.toHaveBeenCalled();
  });

  it("runs onWelcome after a relayed welcome", async () => {
    const { attach, deps } = setup();
    const offscreen = await attach();
    offscreen.postMessage({ type: "welcome", welcome: { type: "welcome", protocol: 2, sessions: [] } });
    await flush();
    expect(deps.onWelcome).toHaveBeenCalledWith({ type: "welcome", protocol: 2, sessions: [] });
  });

  it("drops events unless the socket is connected", async () => {
    const { relay, attach } = setup();
    expect(relay.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(false); // no port
    const offscreen = await attach();
    expect(relay.sendEvent({ type: "event", event: "stop", short_id: null })).toBe(false); // not welcomed
    offscreen.postMessage({ type: "status", status: "connected" });
    await flush();
    expect(relay.sendEvent({ type: "event", event: "stop", short_id: "abcd1234" })).toBe(true);
    expect(await frames(offscreen)).toEqual([{ type: "event", event: "stop", short_id: "abcd1234" }]);
  });

  it("goes offline and re-ensures the offscreen document when the port disconnects", async () => {
    const { relay, attach, deps } = setup();
    const offscreen = await attach();
    offscreen.postMessage({ type: "status", status: "connected" });
    await flush();
    offscreen.disconnect(); // offscreen document closed or crashed
    await flush();
    expect(relay.status).toBe("offline");
    expect(deps.ensureOffscreen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECHECK_OFFSCREEN_MS);
    expect(deps.ensureOffscreen).toHaveBeenCalledTimes(2);
  });

  it("keeps only the newest port", async () => {
    const { relay, attach } = setup();
    const first = await attach();
    const second = await attach();
    expect(first.connected).toBe(false);
    second.postMessage({ type: "status", status: "connected" });
    await flush();
    expect(relay.status).toBe("connected");
  });

  it("ensure() creates the document if needed and nudges the socket", async () => {
    const { relay, attach, deps } = setup();
    const offscreen = await attach();
    await relay.ensure();
    await flush();
    expect(deps.ensureOffscreen).toHaveBeenCalled();
    expect(offscreen.messages().at(-1)).toEqual({ type: "ensure" });
  });

  it("pushConfig(true) forces a reconnect in the offscreen document", async () => {
    const { relay, attach } = setup();
    const offscreen = await attach();
    await relay.pushConfig(true);
    await flush();
    expect(offscreen.messages().at(-1)).toEqual({ type: "config", token: "t", port: 8771, reconfigure: true });
  });
});

describe("BridgeRelay.daemonRequest", () => {
  async function connectedRelay() {
    const ctx = setup();
    const offscreen = await ctx.attach();
    offscreen.postMessage({ type: "status", status: "connected" });
    await flush();
    return { ...ctx, offscreen };
  }
  const extRequests = (offscreen: FakePort) =>
    offscreen.messages<{ type: string; request?: { id: string; op: string; args: unknown } }>().filter((m) => m.type === "ext_request");

  it("posts an ext_request and resolves with the matching ext_response result", async () => {
    const { relay, offscreen } = await connectedRelay();
    const pending = relay.daemonRequest("settings_set", { jev_model: "a/b" });
    await flush();
    const [sent] = extRequests(offscreen);
    expect(sent.request).toMatchObject({ type: "ext_request", op: "settings_set", args: { jev_model: "a/b" } });
    const id = sent.request!.id;
    offscreen.postMessage({ type: "ext_response", response: { type: "ext_response", id: "other", ok: true, result: 0 } });
    offscreen.postMessage({ type: "ext_response", response: { type: "ext_response", id, ok: true, result: { updated: ["jev_model"] } } });
    await expect(pending).resolves.toEqual({ updated: ["jev_model"] });
  });

  it("rejects with the daemon's message on ok:false", async () => {
    const { relay, offscreen } = await connectedRelay();
    const pending = relay.daemonRequest("settings_get", {});
    await flush();
    const id = extRequests(offscreen)[0].request!.id;
    offscreen.postMessage({
      type: "ext_response",
      response: { type: "ext_response", id, ok: false, error: { code: "invalid_args", message: "OpenRouter rejected this API key" } },
    });
    await expect(pending).rejects.toThrow("OpenRouter rejected this API key");
  });

  it("rejects at once when not connected", async () => {
    const { relay, attach } = setup();
    await expect(relay.daemonRequest("settings_get", {})).rejects.toThrow(/not connected/);
    await attach();
    await expect(relay.daemonRequest("settings_get", {})).rejects.toThrow(/not connected/);
  });

  it("times out after 15 s", async () => {
    const { relay } = await connectedRelay();
    const pending = relay.daemonRequest("settings_get", {});
    const assertion = expect(pending).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(14_999);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("fails pending requests when the connection drops", async () => {
    const { relay, offscreen } = await connectedRelay();
    const pending = relay.daemonRequest("settings_get", {});
    const assertion = expect(pending).rejects.toThrow(/lost/);
    offscreen.postMessage({ type: "status", status: "offline" });
    await flush();
    await assertion;
  });
});

describe("BridgeRelay service features", () => {
  const welcome = (extra: Record<string, unknown> = {}) => ({ type: "welcome", protocol: 2, sessions: [], ...extra });
  const extRequests = (offscreen: FakePort) => offscreen.messages<{ type: string }>().filter((m) => m.type === "ext_request");

  async function connectedRelay(w: Record<string, unknown> | null) {
    const ctx = setup();
    const offscreen = await ctx.attach();
    offscreen.postMessage({ type: "status", status: "connected" });
    if (w) offscreen.postMessage({ type: "welcome", welcome: w });
    await flush();
    return { ...ctx, offscreen };
  }

  it("is null until a welcome arrives", async () => {
    const { relay } = await connectedRelay(null);
    expect(relay.service).toBeNull();
  });

  it("an old welcome (no features) means no settings, and settings requests fail at once without being sent", async () => {
    const { relay, offscreen } = await connectedRelay(welcome());
    expect(relay.service).toEqual({ version: null, settings: false });
    await expect(relay.daemonRequest("settings_get", {})).rejects.toThrow(SERVICE_TOO_OLD_ERROR);
    await expect(relay.daemonRequest("settings_set", { jev_model: "a/b" })).rejects.toThrow(SERVICE_TOO_OLD_ERROR);
    await flush();
    expect(extRequests(offscreen)).toEqual([]);
    expect(SERVICE_TOO_OLD_ERROR).toBe("Your TabCrew service is too old for settings here. Update it: npx tabcrew@latest setup");
  });

  it("a welcome with the settings feature relays settings requests", async () => {
    const { relay, offscreen } = await connectedRelay(welcome({ daemon_version: "0.5.0", features: ["settings"] }));
    expect(relay.service).toEqual({ version: "0.5.0", settings: true });
    void relay.daemonRequest("settings_get", {}).catch(() => undefined);
    await flush();
    expect(extRequests(offscreen)).toHaveLength(1);
  });

  it("takes the service replayed by the offscreen document after a service worker restart", async () => {
    const { relay, offscreen } = await connectedRelay(null);
    offscreen.postMessage({ type: "service", service: { version: "0.5.0", features: ["settings"] } });
    await flush();
    expect(relay.service).toEqual({ version: "0.5.0", settings: true });
  });

  it("forgets the service when the connection drops or the port disconnects", async () => {
    const { relay, offscreen } = await connectedRelay(welcome({ features: ["settings"] }));
    offscreen.postMessage({ type: "status", status: "offline" });
    await flush();
    expect(relay.service).toBeNull();

    offscreen.postMessage({ type: "status", status: "connected" });
    offscreen.postMessage({ type: "welcome", welcome: welcome({ features: ["settings"] }) });
    await flush();
    expect(relay.service?.settings).toBe(true);
    offscreen.disconnect();
    await flush();
    expect(relay.service).toBeNull();
  });
});
