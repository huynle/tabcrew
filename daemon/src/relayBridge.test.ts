import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  V2_CLOSE_BAD_HELLO,
  V2_CLOSE_REPLACED,
  V2_EXT_FEATURE_MODEL_CALL,
  V2_FEATURE_HUB,
  V2_MODEL_PURPOSES,
  V2_PROTOCOL_VERSION,
  type V2SessionRef,
} from "@tabcrew/shared/v2";
import { ExtensionBridge } from "./bridge.js";
import { FakeExtension, until } from "./testing/helpers.js";

const SESSION: V2SessionRef = { short_id: "abc123", label: "test" };

/**
 * Stands in for the relay: accepts sockets on its own server, reads the first frame (where the
 * relay would check the access token) and hands socket + frame to the bridge.
 */
async function relayFront(bridge: ExtensionBridge): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket: WebSocket) => {
    socket.once("message", (data) => bridge.attach(socket, JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  return {
    port: (wss.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(sessions: readonly V2SessionRef[] = []) {
  const bridge = new ExtensionBridge({ auth: { kind: "relay" }, sessions: () => sessions, offlineWaitMs: 300, pingIntervalMs: 60_000 });
  const front = await relayFront(bridge);
  cleanups.push(() => front.close(), () => bridge.close());
  return { bridge, port: front.port };
}

describe("ExtensionBridge relay auth (attach)", () => {
  it("accepts an attached socket, welcomes it with the sessions and serves requests", async () => {
    const { bridge, port } = await setup([SESSION]);
    const ext = await FakeExtension.connect(port, "relay-access-token");
    await until(() => bridge.connected);
    expect(ext.welcome?.protocol).toBe(V2_PROTOCOL_VERSION);
    expect(ext.welcome?.sessions).toEqual([SESSION]);
    expect(ext.welcome?.features).not.toContain(V2_FEATURE_HUB);
    const result = await bridge.request(SESSION, "tab_list", {});
    expect(result).toEqual({ tabs: [] });
    expect(ext.requests.map((r) => r.op)).toEqual(["tab_list"]);
  });

  it("rejects an attached hello with the wrong protocol (4401) and stays disconnected", async () => {
    const { bridge, port } = await setup();
    await expect(FakeExtension.connect(port, "t", { protocol: V2_PROTOCOL_VERSION + 99 })).rejects.toThrow(`closed ${V2_CLOSE_BAD_HELLO}`);
    expect(bridge.connected).toBe(false);
  });

  it("a newer attached socket replaces the older one (4409)", async () => {
    const { bridge, port } = await setup();
    const first = await FakeExtension.connect(port, "t");
    const second = await FakeExtension.connect(port, "t");
    expect((await first.closed).code).toBe(V2_CLOSE_REPLACED);
    await bridge.request(SESSION, "tab_list", {});
    expect(second.requests).toHaveLength(1);
    expect(first.requests).toHaveLength(0);
  });

  it("routes model calls through the attached extension", async () => {
    const { bridge, port } = await setup();
    const ext = await FakeExtension.connect(port, "t", { features: [V2_EXT_FEATURE_MODEL_CALL] });
    ext.modelHandler = () => ({ status: 200, json: { ok: 1 }, model: "user/model" });
    await until(() => bridge.connected);
    const result = await bridge.modelCall(V2_MODEL_PURPOSES[0], { messages: [], max_tokens: 1 }, 1_000);
    expect(result).toEqual({ status: 200, json: { ok: 1 }, model: "user/model" });
  });

  it("close() closes the attached socket", async () => {
    const { bridge, port } = await setup();
    const ext = await FakeExtension.connect(port, "t");
    await until(() => bridge.connected);
    await bridge.close();
    await ext.closed;
    expect(bridge.connected).toBe(false);
  });

  it("disconnect() closes the attached socket with the given code", async () => {
    const { bridge, port } = await setup();
    const ext = await FakeExtension.connect(port, "t");
    await until(() => bridge.connected);
    bridge.disconnect(4401, "revoked");
    expect((await ext.closed).code).toBe(4401);
    expect(bridge.connected).toBe(false);
  });

  it("has no server of its own", async () => {
    const bridge = new ExtensionBridge({ auth: { kind: "relay" }, sessions: () => [] });
    await expect(bridge.start()).rejects.toThrow(/attach/);
  });

  it("attach() is only for relay bridges", () => {
    const bridge = new ExtensionBridge({ token: "x".repeat(43), port: 0, sessions: () => [] });
    expect(() => bridge.attach({} as WebSocket, {})).toThrow(TypeError);
  });
});
