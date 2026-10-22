import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TABCREW_EXTENSION_IDS } from "@tabcrew/shared/product";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.js";

const source = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
const devKey = readFileSync(new URL("../../dev-key.pub", import.meta.url), "utf8").trim();

function extensionId(base64Spki: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Spki, "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

describe("extension manifest", () => {
  it("is TabCrew, asks for nativeMessaging and does not imply Google endorsement", () => {
    expect(source.name).toBe("TabCrew");
    expect(source.permissions).toContain("nativeMessaging");
    expect(String(source.description)).not.toMatch(/chrome|google/i);
    expect(source.key).toBeUndefined();
  });

  it("asks for no host access up front, only optional access for the model provider origin", () => {
    expect(source.host_permissions).toBeUndefined();
    expect(source.optional_host_permissions).toEqual(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);
    const store = buildManifest(source, { kind: "store" });
    expect(store.optional_host_permissions).toEqual(source.optional_host_permissions);
    expect(store.host_permissions).toBeUndefined();
  });

  it("dev builds carry the public key whose ID is the dev ID the pairing host allows", () => {
    const dev = buildManifest(source, { kind: "dev", key: devKey });
    expect(dev.key).toBe(devKey);
    expect(dev.permissions).toContain("nativeMessaging");
    expect(extensionId(String(dev.key))).toBe(TABCREW_EXTENSION_IDS.dev);
  });

  it("store builds have no key", () => {
    const store = buildManifest({ ...source, key: "stray" }, { kind: "store" });
    expect("key" in store).toBe(false);
    expect(store.permissions).toContain("nativeMessaging");
    expect(store.version).toBe(source.version);
  });

  it("declares 16/32/48/128 icons that exist in assets at their stated size", () => {
    const icons = source.icons as Record<string, string>;
    const action = (source.action as { default_icon: Record<string, string> }).default_icon;
    expect(Object.keys(icons).sort()).toEqual(["128", "16", "32", "48"]);
    expect(action).toEqual(icons);
    for (const [size, path] of Object.entries(icons)) {
      const png = readFileSync(new URL(`../../assets/${path.replace(/^icons\//, "")}`, import.meta.url));
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
    }
  });

  it("has the same version as every package.json in the repo", () => {
    for (const pkg of ["../../package.json", "../../../package.json", "../../../cli/package.json", "../../../daemon/package.json", "../../../shared/package.json"]) {
      const version = (JSON.parse(readFileSync(new URL(pkg, import.meta.url), "utf8")) as { version: string }).version;
      expect(version, pkg).toBe(source.version);
    }
  });
});
