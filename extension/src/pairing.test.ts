import { describe, expect, it, vi } from "vitest";
import { Pairing, type PairingDeps } from "./pairing.js";

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

function deps(reply: () => Promise<unknown>, stored: string | null = null) {
  let token = stored;
  const d = {
    sendNativeMessage: vi.fn(async (_host: string, _message: unknown) => reply()),
    loadToken: vi.fn(async () => token),
    saveToken: vi.fn(async (t: string) => {
      token = t;
    }),
  } satisfies PairingDeps;
  return { d, token: () => token };
}

describe("Pairing", () => {
  it("asks com.tabcrew.pair for the token and stores it when none is stored", async () => {
    const { d, token } = deps(async () => ({ token: TOKEN_A }));
    const pairing = new Pairing(d);
    expect(await pairing.ensurePaired()).toBe("paired");
    expect(d.sendNativeMessage).toHaveBeenCalledWith("com.tabcrew.pair", { type: "get_token" });
    expect(token()).toBe(TOKEN_A);
    expect(pairing.lastError).toBeNull();
    expect(await pairing.ensurePaired()).toBe("already_paired");
    expect(d.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  it("records the error when the host is missing and retries on the next call", async () => {
    let installed = false;
    const { d } = deps(async () => {
      if (!installed) throw new Error("Specified native messaging host not found.");
      return { token: TOKEN_A };
    });
    const pairing = new Pairing(d);
    expect(await pairing.ensurePaired()).toBe("failed");
    expect(pairing.lastError).toBe("Specified native messaging host not found.");
    installed = true;
    expect(await pairing.ensurePaired()).toBe("paired");
    expect(pairing.lastError).toBeNull();
  });

  it("treats {error} and malformed replies as failures without storing anything", async () => {
    const replies: unknown[] = [{ error: "no token: run npx tabcrew setup" }, { token: "short" }, null];
    const { d, token } = deps(async () => replies.shift());
    const pairing = new Pairing(d);
    expect(await pairing.ensurePaired()).toBe("failed");
    expect(pairing.lastError).toBe("no token: run npx tabcrew setup");
    expect(await pairing.ensurePaired()).toBe("failed");
    expect(await pairing.ensurePaired()).toBe("failed");
    expect(token()).toBeNull();
    expect(d.saveToken).not.toHaveBeenCalled();
  });

  it("shares one native call between concurrent attempts", async () => {
    const { d } = deps(async () => ({ token: TOKEN_A }));
    const pairing = new Pairing(d);
    await Promise.all([pairing.ensurePaired(), pairing.ensurePaired(), pairing.ensurePaired()]);
    expect(d.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  it("re-pairs once per rejected token", async () => {
    const { d, token } = deps(async () => ({ token: TOKEN_B }), TOKEN_A);
    const pairing = new Pairing(d);
    expect(await pairing.repair(TOKEN_A)).toBe(true);
    expect(token()).toBe(TOKEN_B);
    expect(await pairing.repair(TOKEN_A)).toBe(false);
    expect(d.sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(await pairing.repair(null)).toBe(false);
  });

  it("never asks the host in hub mode", async () => {
    const { d } = deps(async () => ({ token: TOKEN_A }));
    const pairing = new Pairing({ ...d, loadModeSetting: async () => "hub" });
    expect(await pairing.ensurePaired()).toBe("skipped");
    expect(await pairing.repair(TOKEN_A)).toBe(false);
    expect(d.sendNativeMessage).not.toHaveBeenCalled();
  });

  it("asks the host only once in auto mode without a token (no pairing loop while in hub mode)", async () => {
    const { d } = deps(async () => {
      throw new Error("Access to the specified native messaging host is forbidden.");
    });
    const pairing = new Pairing({ ...d, loadModeSetting: async () => "auto" });
    expect(await pairing.ensurePaired()).toBe("failed");
    expect(await pairing.ensurePaired()).toBe("skipped");
    expect(await pairing.ensurePaired()).toBe("skipped");
    expect(d.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  it("auto mode pairs on that one attempt when a daemon is installed", async () => {
    const { d, token } = deps(async () => ({ token: TOKEN_A }));
    const pairing = new Pairing({ ...d, loadModeSetting: async () => "auto" });
    expect(await pairing.ensurePaired()).toBe("paired");
    expect(token()).toBe(TOKEN_A);
  });

  it("keeps retrying in daemon mode", async () => {
    const { d } = deps(async () => {
      throw new Error("Specified native messaging host not found.");
    });
    const pairing = new Pairing({ ...d, loadModeSetting: async () => "daemon" });
    await pairing.ensurePaired();
    await pairing.ensurePaired();
    expect(d.sendNativeMessage).toHaveBeenCalledTimes(2);
  });

  it("a re-pair that returns the rejected token changes nothing", async () => {
    const { d } = deps(async () => ({ token: TOKEN_A }), TOKEN_A);
    const pairing = new Pairing(d);
    expect(await pairing.repair(TOKEN_A)).toBe(false);
    expect(d.saveToken).not.toHaveBeenCalled();
  });
});
