import { describe, expect, it } from "vitest";
import { v2GroupTitle, v2ParseGroupTitle, v2ReleasedGroupTitle } from "./v2.js";

describe("v2 group titles", () => {
  it("round-trips a session group title", () => {
    const ref = { short_id: "aaaa1111", label: "alice" };
    expect(v2ParseGroupTitle(v2GroupTitle(ref))).toEqual(ref);
  });

  it("a released title is ✓ <label> and never parses as a session group", () => {
    expect(v2ReleasedGroupTitle("alice")).toBe("✓ alice");
    expect(v2ParseGroupTitle(v2ReleasedGroupTitle("alice"))).toBeNull();
    // Even a label that looks like a full session title cannot be re-adopted.
    const tricky = v2ReleasedGroupTitle("bob · bbbb2222");
    expect(tricky.startsWith("✓ ")).toBe(true);
    expect(v2ParseGroupTitle(tricky)).toBeNull();
  });
});

describe("shared tab groups: contracts", () => {
  it("lists every daemon -> extension op, including group_rename and group_list", async () => {
    const { V2_OPS, v2IsOp } = await import("./v2.js");
    expect([...V2_OPS].sort()).toEqual(
      [
        "act",
        "debug_logs",
        "group_list",
        "group_rename",
        "navigate",
        "read_text",
        "screenshot",
        "session_close",
        "session_release",
        "snapshot",
        "tab_close",
        "tab_create",
        "tab_list",
      ].sort(),
    );
    expect(v2IsOp("group_rename")).toBe(true);
    expect(v2IsOp("group_list")).toBe(true);
    expect(v2IsOp("tab_create")).toBe(true);
    expect(v2IsOp("settings_get")).toBe(false);
    expect(v2IsOp("__proto__")).toBe(false);
    expect(v2IsOp("toString")).toBe(false);
    expect(v2IsOp(1)).toBe(false);
  });

  it("knows the finish modes keep | close | collect", async () => {
    const { V2_FINISH_MODES, v2IsFinishMode } = await import("./v2.js");
    expect([...V2_FINISH_MODES]).toEqual(["keep", "close", "collect"]);
    for (const m of V2_FINISH_MODES) expect(v2IsFinishMode(m)).toBe(true);
    expect(v2IsFinishMode("KEEP")).toBe(false);
    expect(v2IsFinishMode("release")).toBe(false);
    expect(v2IsFinishMode(undefined)).toBe(false);
  });

  it("exports the groups extension feature and the default group name", async () => {
    const { V2_EXT_FEATURE_GROUPS, V2_DEFAULT_GROUP_NAME, V2_GROUP_NAME_MAX_LENGTH } = await import("./v2.js");
    expect(V2_EXT_FEATURE_GROUPS).toBe("groups");
    expect(V2_DEFAULT_GROUP_NAME).toBe("TabCrew");
    expect(V2_GROUP_NAME_MAX_LENGTH).toBe(40);
  });

  it("normalises group names: trims and collapses whitespace", async () => {
    const { v2NormaliseGroupName } = await import("./v2.js");
    expect(v2NormaliseGroupName("TabCrew")).toBe("TabCrew");
    expect(v2NormaliseGroupName("  research   team ")).toBe("research team");
    expect(v2NormaliseGroupName("a\tb\nc")).toBe("a b c");
    expect(v2NormaliseGroupName("✓")).toBe("✓");
    expect(v2NormaliseGroupName("x".repeat(40))).toBe("x".repeat(40));
    // Length counts characters (code points), after normalising.
    expect(v2NormaliseGroupName(`  ${"🙂".repeat(40)}  `)).toBe("🙂".repeat(40));
  });

  it("rejects invalid group names", async () => {
    const { v2NormaliseGroupName, v2GroupTitle, v2ReleasedGroupTitle } = await import("./v2.js");
    expect(v2NormaliseGroupName("")).toBeNull();
    expect(v2NormaliseGroupName("   ")).toBeNull();
    expect(v2NormaliseGroupName("x".repeat(41))).toBeNull();
    expect(v2NormaliseGroupName("🙂".repeat(41))).toBeNull();
    expect(v2NormaliseGroupName("bad\u0000name")).toBeNull();
    expect(v2NormaliseGroupName("bad\u007fname")).toBeNull();
    expect(v2NormaliseGroupName("bad\u001bname")).toBeNull();
    // Reserved for finished groups.
    expect(v2NormaliseGroupName("✓ TabCrew")).toBeNull();
    expect(v2NormaliseGroupName(v2ReleasedGroupTitle("alice"))).toBeNull();
    expect(v2NormaliseGroupName("  ✓   done ")).toBeNull();
    // Must not look like a legacy per-session group.
    expect(v2NormaliseGroupName(v2GroupTitle({ label: "alice", short_id: "aaaa1111" }))).toBeNull();
    expect(v2NormaliseGroupName("alice  ·  aaaa1111")).toBeNull();
    expect(v2NormaliseGroupName(42)).toBeNull();
    expect(v2NormaliseGroupName(null)).toBeNull();
    expect(v2NormaliseGroupName(undefined)).toBeNull();
  });

  it("titles the collect group ✓ TabCrew (or ✓ <name>) and never re-accepts it as a group name", async () => {
    const { v2CollectGroupTitle, v2NormaliseGroupName, v2ParseGroupTitle } = await import("./v2.js");
    expect(v2CollectGroupTitle()).toBe("✓ TabCrew");
    expect(v2CollectGroupTitle("research")).toBe("✓ research");
    expect(v2CollectGroupTitle("  research   team ")).toBe("✓ research team");
    // Invalid names fall back to the default.
    expect(v2CollectGroupTitle("")).toBe("✓ TabCrew");
    expect(v2CollectGroupTitle("alice · aaaa1111")).toBe("✓ TabCrew");
    expect(v2CollectGroupTitle("x".repeat(41))).toBe("✓ TabCrew");
    expect(v2NormaliseGroupName(v2CollectGroupTitle("research"))).toBeNull();
    expect(v2ParseGroupTitle(v2CollectGroupTitle("research"))).toBeNull();
  });

  it("types: session refs, groups events and session_release/group ops carry the new optional fields", async () => {
    type V2 = typeof import("./v2.js");
    const ref: import("./v2.js").V2SessionRef = { short_id: "aaaa1111", label: "alice", group: "research" };
    const legacy: import("./v2.js").V2SessionRef = { short_id: "aaaa1111", label: "alice" };
    const event: import("./v2.js").V2Event = {
      type: "event",
      event: "groups",
      groups: [{ short_id: "aaaa1111", tabs: [], group: "research" }, { short_id: "bbbb2222", tabs: [] }],
    };
    type Release = import("./v2.js").V2OpMap["session_release"];
    const releaseArgs: Release["args"][] = [{}, { tabs: "keep" }, { tabs: "close" }, { tabs: "collect" }];
    const releaseResults: Release["result"][] = [
      { kept_tabs: 1, moved: false },
      { kept_tabs: 0, moved: false, closed_tabs: 2, mode: "close" },
    ];
    type Rename = import("./v2.js").V2OpMap["group_rename"];
    const rename: [Rename["args"], Rename["result"]] = [{ name: "x", group: "TabCrew" }, { name: "x", previous: "TabCrew" }];
    type List = import("./v2.js").V2OpMap["group_list"];
    const list: [List["args"], List["result"]] = [{}, { groups: [{ name: "TabCrew", mine: true }] }];
    const v2: V2 = await import("./v2.js");
    expect([ref.group, legacy.group, event.event, releaseArgs.length, releaseResults.length, rename[1].previous, list[1].groups[0].mine]).toEqual([
      "research",
      undefined,
      "groups",
      4,
      2,
      "TabCrew",
      true,
    ]);
    expect(typeof v2.v2IsOp).toBe("function");
  });
});

describe("extension -> daemon requests", () => {
  it("v2IsExtOp accepts only the known ops", async () => {
    const { v2IsExtOp, V2_EXT_OPS } = await import("./v2.js");
    expect([...V2_EXT_OPS].sort()).toEqual(["settings_get", "settings_set"]);
    expect(v2IsExtOp("settings_get")).toBe(true);
    expect(v2IsExtOp("settings_set")).toBe(true);
    expect(v2IsExtOp("tab_list")).toBe(false);
    expect(v2IsExtOp("__proto__")).toBe(false);
    expect(v2IsExtOp(42)).toBe(false);
  });
});

describe("service features in welcome", () => {
  it("reads the daemon version and features from a new welcome", async () => {
    const { v2ServiceInfo, V2_FEATURE_SETTINGS } = await import("./v2.js");
    expect(V2_FEATURE_SETTINGS).toBe("settings");
    expect(v2ServiceInfo({ type: "welcome", protocol: 2, sessions: [], daemon_version: "0.5.0", features: ["settings"] })).toEqual({
      version: "0.5.0",
      features: ["settings"],
    });
  });

  it("treats an old welcome (no version, no features) as a service without features", async () => {
    const { v2ServiceInfo } = await import("./v2.js");
    expect(v2ServiceInfo({ type: "welcome", protocol: 2, sessions: [] })).toEqual({ version: null, features: [] });
  });

  it("ignores malformed fields", async () => {
    const { v2ServiceInfo } = await import("./v2.js");
    expect(v2ServiceInfo({ daemon_version: 5, features: "settings" })).toEqual({ version: null, features: [] });
    expect(v2ServiceInfo({ daemon_version: "x".repeat(100), features: ["settings", 3, null, "y".repeat(100)] })).toEqual({
      version: "x".repeat(40),
      features: ["settings"],
    });
    expect(v2ServiceInfo(null)).toEqual({ version: null, features: [] });
  });
});

describe("hub mode: hello", () => {
  it("exports the hub port, features and close codes", async () => {
    const v2 = await import("./v2.js");
    expect(v2.V2_HUB_EXTENSION_PORT).toBe(8775);
    expect(v2.V2_EXTENSION_PORT).toBe(8771);
    expect(v2.V2_FEATURE_HUB).toBe("hub");
    expect(v2.V2_EXT_FEATURE_MODEL_CALL).toBe("model_call");
    expect(v2.V2_CLOSE_BAD_HELLO).toBe(4401);
    expect(v2.V2_CLOSE_PIN_MISMATCH).toBe(4403);
    expect(v2.V2_CLOSE_REPLACED).toBe(4409);
    expect(v2.V2_ERROR_CODES).toContain("model_not_configured");
  });

  it("reads mode and features from a hub-mode hello", async () => {
    const { v2HelloFeatures } = await import("./v2.js");
    expect(
      v2HelloFeatures({ type: "hello", protocol: 2, extension_version: "0.6.0", mode: "hub", features: ["model_call"] }),
    ).toEqual({ version: "0.6.0", mode: "hub", features: ["model_call"] });
  });

  it("treats an old daemon-mode hello (token, no mode/features) as unknown mode without features", async () => {
    const { v2HelloFeatures } = await import("./v2.js");
    expect(v2HelloFeatures({ type: "hello", protocol: 2, token: "t".repeat(43), extension_version: "0.5.0" })).toEqual({
      version: "0.5.0",
      mode: null,
      features: [],
    });
  });

  it("ignores malformed hello fields", async () => {
    const { v2HelloFeatures } = await import("./v2.js");
    expect(v2HelloFeatures({ mode: "proxy", features: "model_call", extension_version: 3 })).toEqual({
      version: null,
      mode: null,
      features: [],
    });
    expect(v2HelloFeatures({ mode: "daemon", features: ["model_call", 1, "", "z".repeat(41)], extension_version: "v".repeat(50) })).toEqual({
      version: "v".repeat(40),
      mode: "daemon",
      features: ["model_call"],
    });
    expect(v2HelloFeatures(null)).toEqual({ version: null, mode: null, features: [] });
    expect(v2HelloFeatures("hello")).toEqual({ version: null, mode: null, features: [] });
  });
});

describe("hub mode: TOFU pin", () => {
  const secret = "11".repeat(32);
  const nonce_e = "aa".repeat(16);
  const nonce_h = "bb".repeat(16);
  const proof = "cd".repeat(32);

  it("validates pin secrets, nonces and proofs as lowercase hex of the exact length", async () => {
    const { v2IsPinSecret, v2IsPinNonce, v2IsPinProof } = await import("./v2.js");
    expect(v2IsPinSecret(secret)).toBe(true);
    expect(v2IsPinSecret(secret.slice(2))).toBe(false);
    expect(v2IsPinSecret(secret.toUpperCase().replace(/1/g, "A"))).toBe(false);
    expect(v2IsPinSecret(42)).toBe(false);
    expect(v2IsPinNonce(nonce_e)).toBe(true);
    expect(v2IsPinNonce(nonce_e + "a")).toBe(false);
    expect(v2IsPinNonce("zz".repeat(16))).toBe(false);
    expect(v2IsPinProof(proof)).toBe(true);
    expect(v2IsPinProof(proof + "\n")).toBe(false);
    expect(v2IsPinProof(undefined)).toBe(false);
  });

  it("parses the hello pin (new | pinned) and rejects anything else", async () => {
    const { v2HelloPin } = await import("./v2.js");
    expect(v2HelloPin({ type: "hello", pin: { state: "new", secret } })).toEqual({ state: "new", secret });
    expect(v2HelloPin({ type: "hello", pin: { state: "pinned", nonce_e } })).toEqual({ state: "pinned", nonce_e });
    // Extra fields are dropped, not echoed.
    expect(v2HelloPin({ pin: { state: "pinned", nonce_e, secret } })).toEqual({ state: "pinned", nonce_e });
    expect(v2HelloPin({ type: "hello", token: "t" })).toBeNull();
    expect(v2HelloPin({ pin: { state: "new", secret: "short" } })).toBeNull();
    expect(v2HelloPin({ pin: { state: "pinned", nonce_e: secret } })).toBeNull();
    expect(v2HelloPin({ pin: { state: "stored" } })).toBeNull();
    expect(v2HelloPin({ pin: "new" })).toBeNull();
    expect(v2HelloPin(null)).toBeNull();
  });

  it("parses the welcome pin (stored | challenge) and rejects anything else", async () => {
    const { v2WelcomePin } = await import("./v2.js");
    expect(v2WelcomePin({ type: "welcome", pin: { state: "stored" } })).toEqual({ state: "stored" });
    expect(v2WelcomePin({ pin: { state: "challenge", nonce_h, hub_proof: proof } })).toEqual({
      state: "challenge",
      nonce_h,
      hub_proof: proof,
    });
    expect(v2WelcomePin({ type: "welcome", protocol: 2, sessions: [] })).toBeNull();
    expect(v2WelcomePin({ pin: { state: "challenge", nonce_h } })).toBeNull();
    expect(v2WelcomePin({ pin: { state: "challenge", nonce_h: "x", hub_proof: proof } })).toBeNull();
    expect(v2WelcomePin({ pin: { state: "new", secret } })).toBeNull();
    expect(v2WelcomePin(undefined)).toBeNull();
  });

  it("reads ext_proof from an auth frame only", async () => {
    const { v2AuthProof } = await import("./v2.js");
    expect(v2AuthProof({ type: "auth", ext_proof: proof })).toBe(proof);
    expect(v2AuthProof({ type: "auth", ext_proof: "nothex" })).toBeNull();
    expect(v2AuthProof({ type: "hello", ext_proof: proof })).toBeNull();
    expect(v2AuthProof(null)).toBeNull();
  });

  it("builds domain-separated proof inputs", async () => {
    const { v2HubProofInput, v2ExtProofInput } = await import("./v2.js");
    expect(v2HubProofInput({ nonce_e, nonce_h })).toBe(`tabcrew-hub|${nonce_e}|${nonce_h}`);
    expect(v2ExtProofInput({ nonce_e, nonce_h })).toBe(`tabcrew-ext|${nonce_h}|${nonce_e}`);
    expect(v2HubProofInput({ nonce_e, nonce_h })).not.toBe(v2ExtProofInput({ nonce_e: nonce_h, nonce_h: nonce_e }));
  });

  it("refuses to build proof inputs from invalid nonces", async () => {
    const { v2HubProofInput, v2ExtProofInput } = await import("./v2.js");
    expect(() => v2HubProofInput({ nonce_e: `${nonce_e.slice(1)}|`, nonce_h })).toThrow(TypeError);
    expect(() => v2ExtProofInput({ nonce_e, nonce_h: "" })).toThrow(TypeError);
  });

  it("HMAC-SHA256 over the inputs (key = decoded secret bytes) matches the reference vectors", async () => {
    const { createHmac } = await import("node:crypto");
    const { v2HubProofInput, v2ExtProofInput } = await import("./v2.js");
    const hmac = (input: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(input, "utf8").digest("hex");
    expect(hmac(v2HubProofInput({ nonce_e, nonce_h }))).toBe("ec437cae1b4eaa52ed910d9b77485e6c735684cb608756170f70447464dc8be2");
    expect(hmac(v2ExtProofInput({ nonce_e, nonce_h }))).toBe("07da2add5751f467195f45aa121ba9305158beeeb3f12f0af92e8e989ee58fdc");
  });

  it("compares proofs in constant time", async () => {
    const { v2ProofEquals } = await import("./v2.js");
    expect(v2ProofEquals(proof, proof)).toBe(true);
    expect(v2ProofEquals(proof, "cd".repeat(31) + "ce")).toBe(false);
    expect(v2ProofEquals(proof, proof.slice(2))).toBe(false);
    expect(v2ProofEquals("", "")).toBe(false);
  });
});

describe("hub mode: model_call proxy frames", () => {
  const body = {
    messages: [
      { role: "system", content: "Reply with JSON." },
      { role: "user", content: "{}" },
    ],
    max_tokens: 400,
    response_format: { type: "json_object" },
  };

  it("knows the model purposes", async () => {
    const { V2_MODEL_PURPOSES, v2IsModelPurpose } = await import("./v2.js");
    expect([...V2_MODEL_PURPOSES]).toEqual(["chat_decision", "text", "text_fallback"]);
    expect(v2IsModelPurpose("text")).toBe(true);
    expect(v2IsModelPurpose("decision")).toBe(false);
    expect(v2IsModelPurpose("toString")).toBe(false);
    expect(v2IsModelPurpose(1)).toBe(false);
  });

  it("parses a model_call and keeps only the allowed body fields", async () => {
    const { v2ParseModelCall } = await import("./v2.js");
    const frame = {
      type: "model_call",
      id: "m1",
      purpose: "chat_decision",
      body: { ...body, model: "evil/model", stream: true, url: "https://evil.example" },
      timeout_ms: 5000,
      headers: { authorization: "x" },
    };
    expect(v2ParseModelCall(frame)).toEqual({ type: "model_call", id: "m1", purpose: "chat_decision", body, timeout_ms: 5000 });
    const { response_format: _omit, ...plain } = body;
    expect(v2ParseModelCall({ ...frame, body: plain, purpose: "text_fallback" })).toEqual({
      type: "model_call",
      id: "m1",
      purpose: "text_fallback",
      body: plain,
      timeout_ms: 5000,
    });
  });

  it("rejects malformed model_call frames", async () => {
    const { v2ParseModelCall } = await import("./v2.js");
    const ok = { type: "model_call", id: "m1", purpose: "text", body, timeout_ms: 3000 };
    expect(v2ParseModelCall(ok)).not.toBeNull();
    for (const bad of [
      null,
      { ...ok, type: "request" },
      { ...ok, id: "" },
      { ...ok, id: "x".repeat(101) },
      { ...ok, purpose: "jev" },
      { ...ok, timeout_ms: 0 },
      { ...ok, timeout_ms: 120_001 },
      { ...ok, timeout_ms: 1.5 },
      { ...ok, body: null },
      { ...ok, body: { ...body, messages: [] } },
      { ...ok, body: { ...body, messages: [{ role: "tool", content: "x" }] } },
      { ...ok, body: { ...body, messages: [{ role: "user", content: 1 }] } },
      { ...ok, body: { ...body, max_tokens: 0 } },
      { ...ok, body: { ...body, max_tokens: 100_000 } },
      { ...ok, body: { ...body, response_format: { type: "json_schema" } } },
    ]) {
      expect(v2ParseModelCall(bad)).toBeNull();
    }
  });

  it("parses model_result success and failure frames", async () => {
    const { v2ParseModelResult } = await import("./v2.js");
    const json = { choices: [{ message: { content: "{}" } }] };
    expect(
      v2ParseModelResult({ type: "model_result", id: "m1", ok: true, result: { status: 200, json, model: "gemini-3.6-flash" } }),
    ).toEqual({ type: "model_result", id: "m1", ok: true, result: { status: 200, json, model: "gemini-3.6-flash" } });
    // Non-2xx HTTP replies are still ok:true; the hub interprets the status.
    expect(v2ParseModelResult({ type: "model_result", id: "m1", ok: true, result: { status: 401, json: null, model: "m" } })).toEqual({
      type: "model_result",
      id: "m1",
      ok: true,
      result: { status: 401, json: null, model: "m" },
    });
    expect(
      v2ParseModelResult({
        type: "model_result",
        id: "m2",
        ok: false,
        error: { code: "model_not_configured", message: "set a model provider in the TabCrew popup" },
      }),
    ).toEqual({
      type: "model_result",
      id: "m2",
      ok: false,
      error: { code: "model_not_configured", message: "set a model provider in the TabCrew popup" },
    });
  });

  it("rejects malformed model_result frames", async () => {
    const { v2ParseModelResult } = await import("./v2.js");
    const ok = { type: "model_result", id: "m1", ok: true, result: { status: 200, json: {}, model: "m" } };
    for (const bad of [
      null,
      { ...ok, type: "response" },
      { ...ok, id: 5 },
      { ...ok, ok: "yes" },
      { ...ok, result: { status: "200", json: {}, model: "m" } },
      { ...ok, result: { status: 99, json: {}, model: "m" } },
      { ...ok, result: { status: 200, json: {}, model: "" } },
      { ...ok, result: { status: 200, json: {} } },
      { type: "model_result", id: "m1", ok: false, error: { code: "nope", message: "x" } },
      { type: "model_result", id: "m1", ok: false, error: { code: "model_error" } },
      { type: "model_result", id: "m1", ok: false },
    ]) {
      expect(v2ParseModelResult(bad)).toBeNull();
    }
  });
});
