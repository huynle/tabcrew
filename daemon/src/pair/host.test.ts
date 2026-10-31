import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TABCREW_EXTENSION_IDS } from "@tabcrew/shared/product";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "../testing/helpers.js";
import { callerOrigin, decodeMessage, encodeMessage, handlePairRequest, originAllowed, runPairHost } from "./host.js";

const ORIGIN = `chrome-extension://${TABCREW_EXTENSION_IDS.dev}/`;
const TOKEN = "k".repeat(43);

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
function homeWithToken(): string {
  const t = tempHome();
  cleanup = t.cleanup;
  const home = join(t.home, ".tabcrew");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "token"), `${TOKEN}\n`, { mode: 0o600 });
  return t.home;
}

/** Feed `input` to the host over fake stdio and decode what it writes back. */
async function roundTrip(input: Buffer[], argv: string[], userHome: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c));
  const done = runPairHost({ stdin, stdout }, { argv, env: {}, homedir: userHome });
  for (const chunk of input) stdin.write(chunk);
  const returned = await done;
  const decoded = decodeMessage(Buffer.concat(chunks));
  return { returned, written: decoded?.message, rest: decoded?.rest.length };
}

describe("native messaging framing", () => {
  it("encodes uint32 LE length + UTF-8 JSON and decodes it back", () => {
    const frame = encodeMessage({ type: "get_token", note: "é" });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(decodeMessage(frame)).toEqual({ message: { type: "get_token", note: "é" }, rest: Buffer.alloc(0) });
    expect(decodeMessage(frame.subarray(0, 3))).toBeNull();
    expect(decodeMessage(frame.subarray(0, frame.length - 1))).toBeNull();
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(10 * 1024 * 1024, 0);
    expect(() => decodeMessage(huge)).toThrow(/too large/);
  });
});

describe("pair host", () => {
  it("answers get_token with the token, even when the request arrives in pieces", async () => {
    const userHome = homeWithToken();
    const frame = encodeMessage({ type: "get_token" });
    const { returned, written, rest } = await roundTrip([frame.subarray(0, 2), frame.subarray(2, 7), frame.subarray(7)], [ORIGIN], userHome);
    expect(written).toEqual({ token: TOKEN });
    expect(returned).toEqual({ token: TOKEN });
    expect(rest).toBe(0);
  });

  it("refuses callers that are not a TabCrew extension", async () => {
    const userHome = homeWithToken();
    const frame = encodeMessage({ type: "get_token" });
    expect((await roundTrip([frame], ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], userHome)).written).toEqual({
      error: "caller is not a TabCrew extension",
    });
    expect((await roundTrip([frame], [], userHome)).written).toMatchObject({ error: expect.any(String) });
  });

  it("answers other requests and malformed input with an error", async () => {
    const userHome = homeWithToken();
    expect((await roundTrip([encodeMessage({ type: "other" })], [ORIGIN], userHome)).written).toEqual({ error: "unsupported request" });
    const bad = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{{{")]);
    expect((await roundTrip([bad], [ORIGIN], userHome)).written).toEqual({ error: "malformed request" });
  });

  it("reports a missing token without crashing and honours TABCREW_HOME", () => {
    const t = tempHome();
    cleanup = t.cleanup;
    expect(handlePairRequest({ type: "get_token" }, { argv: [ORIGIN], env: {}, homedir: t.home })).toEqual({
      error: "no token: run npx tabcrew setup",
    });
    const custom = join(t.home, "custom");
    mkdirSync(custom);
    writeFileSync(join(custom, "token"), TOKEN);
    expect(handlePairRequest({ type: "get_token" }, { argv: [ORIGIN], env: { TABCREW_HOME: custom }, homedir: t.home })).toEqual({
      token: TOKEN,
    });
  });

  it("finds the origin among Chrome's arguments and normalizes the trailing slash", () => {
    expect(callerOrigin(["--parent-window=0", ORIGIN])).toBe(ORIGIN);
    expect(originAllowed(ORIGIN.slice(0, -1))).toBe(true);
    expect(originAllowed(null)).toBe(false);
    expect(originAllowed("chrome-extension://evil/")).toBe(false);
  });

  it("allows the Chrome Web Store build as well as the dev build", () => {
    expect(originAllowed("chrome-extension://bahebfheemnjhfnelblbiejbjljapgpa/")).toBe(true);
    expect(originAllowed(ORIGIN)).toBe(true);
    expect(originAllowed(`chrome-extension://${"b".repeat(32)}/`)).toBe(false);
  });
});
