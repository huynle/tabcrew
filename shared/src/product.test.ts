import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TABCREW_EXTENSION_IDS, tabcrewExtensionIds, tabcrewExtensionOrigins } from "./product.js";

/** Chrome's extension ID: sha256 of the DER SubjectPublicKeyInfo, first 32 hex digits mapped 0-f → a-p. */
function extensionIdFromKey(base64Spki: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Spki, "base64")).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

describe("TabCrew extension IDs", () => {
  it("the dev ID matches the public key in extension/dev-key.pub", () => {
    const key = readFileSync(new URL("../../extension/dev-key.pub", import.meta.url), "utf8").trim();
    expect(extensionIdFromKey(key)).toBe(TABCREW_EXTENSION_IDS.dev);
  });

  it("the key file holds only a public key", () => {
    const key = readFileSync(new URL("../../extension/dev-key.pub", import.meta.url), "utf8");
    expect(key).not.toMatch(/PRIVATE/);
    expect(Buffer.from(key.trim(), "base64").length).toBeLessThan(400);
  });

  it("skips the unset store placeholder", () => {
    expect(tabcrewExtensionIds()).toEqual([TABCREW_EXTENSION_IDS.dev]);
    expect(tabcrewExtensionOrigins({ dev: TABCREW_EXTENSION_IDS.dev, store: "b".repeat(32) })).toEqual([
      `chrome-extension://${TABCREW_EXTENSION_IDS.dev}/`,
      `chrome-extension://${"b".repeat(32)}/`,
    ]);
    expect(tabcrewExtensionIds({ dev: TABCREW_EXTENSION_IDS.dev, store: "<pending>" })).toEqual([TABCREW_EXTENSION_IDS.dev]);
  });
});

describe("extension origin checks (hub WebSocket Origin)", () => {
  const dev = `chrome-extension://${TABCREW_EXTENSION_IDS.dev}`;

  it("normalizes origins: no trailing slash, lowercase", async () => {
    const { normalizeOrigin } = await import("./product.js");
    expect(normalizeOrigin(`${dev}/`)).toBe(dev);
    expect(normalizeOrigin(`${dev}//`)).toBe(dev);
    expect(normalizeOrigin(dev)).toBe(dev);
    expect(normalizeOrigin(` ${dev.toUpperCase()}/ `)).toBe(dev);
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("/")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(["x"])).toBeNull();
  });

  it("accepts only known TabCrew extension origins, with or without the trailing slash", async () => {
    const { isTabcrewExtensionOrigin } = await import("./product.js");
    expect(isTabcrewExtensionOrigin(dev)).toBe(true);
    expect(isTabcrewExtensionOrigin(`${dev}/`)).toBe(true);
    expect(isTabcrewExtensionOrigin(`chrome-extension://${"b".repeat(32)}`)).toBe(false);
    expect(isTabcrewExtensionOrigin(`${dev}/popup.html`)).toBe(false);
    expect(isTabcrewExtensionOrigin(`${dev}.evil.example`)).toBe(false);
    expect(isTabcrewExtensionOrigin("http://127.0.0.1:8775")).toBe(false);
    expect(isTabcrewExtensionOrigin("null")).toBe(false);
    expect(isTabcrewExtensionOrigin(undefined)).toBe(false);
    expect(isTabcrewExtensionOrigin(`chrome-extension://${"b".repeat(32)}`, [`chrome-extension://${"b".repeat(32)}/`])).toBe(true);
  });
});
