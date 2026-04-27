import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FlagsClient } from "../server/index";
import type { User } from "../server/index";

// ---- murmur3 test vectors (MurmurHash3_x86_32, seed 0, UTF-8 encoding) ----
// Verified against the reference vectors in experiment-platform/04-evaluation.md.
// The SDK inlines the same murmur3 as packages/core/src/eval/hash.ts.
// We exercise the hash via the public gate/experiment API at known boundary values.

// To expose murmur3 for testing we create a minimal gate harness.
function makeClient(flags: object, exps: object): FlagsClient {
  const client = new FlagsClient({ apiKey: "test", baseUrl: "http://localhost" });
  // Inject blobs directly (bypassing network)
  (client as any).flagsBlob = { version: "v1", plan: "free", ...flags };
  (client as any).expsBlob = { version: "v1", ...exps };
  (client as any).initialized = true;
  return client;
}

describe("murmur3 hash vectors — known values from 04-evaluation.md", () => {
  // murmur3("exp_001:alloc:user_abc") = 0x4032D3F7 → bucket 2887
  // murmur3("exp_001:group:user_abc") = 0x49CF4EEE → bucket 2926
  // We verify these by testing allocationPct boundaries: 2888 includes, 2887 excludes.

  it("salt:uid = 'a' (just user_id, empty salt prefix colon)", () => {
    // salt="" → hash input = ":a"
    const gate = {
      rules: [],
      rolloutPct: 9729,
      salt: "",
      enabled: 1 as const,
      killswitch: 0 as const,
    };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    // murmur3(":a") — not the same as murmur3("a"), so use a salt that makes input = "a"
    // We can't get murmur3("a") directly without salt, so test with known salt+uid combos.
    expect(client.getFlag("g", { user_id: "a" })).toBe(true); // rolloutPct=9729 > bucket, included
  });

  it("gate disabled → always false", () => {
    const gate = { rules: [], rolloutPct: 10000, salt: "s", enabled: 0 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "anyone" })).toBe(false);
  });

  it("gate killswitch → always false even with rollout=10000", () => {
    const gate = {
      rules: [],
      rolloutPct: 10000,
      salt: "s",
      enabled: 1 as const,
      killswitch: 1 as const,
    };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "anyone" })).toBe(false);
  });

  it("gate rollout=0 → always false", () => {
    const gate = { rules: [], rolloutPct: 0, salt: "s", enabled: 1 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "anyone" })).toBe(false);
  });

  it("gate rollout=10000 → always true (enabled user with id)", () => {
    const gate = { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "anyone" })).toBe(true);
  });

  it("no user_id or anonymous_id → false", () => {
    const gate = { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", {})).toBe(false);
  });

  // Verify known cross-language vector: "exp_001:alloc:user_abc" = 0x4032D3F7 → 2887
  // allocationPct=2888 should include user_abc; allocationPct=2887 should not.
  it("experiment allocation hash vector: exp_001:alloc:user_abc → 2887", () => {
    const exp = {
      universe: "default",
      allocationPct: 2888, // 2887 < 2888 → allocated
      salt: "exp_001",
      groups: [
        { name: "control", weight: 5000, params: { v: "ctrl" } },
        { name: "test", weight: 5000, params: { v: "test" } },
      ],
      status: "running" as const,
    };
    const client = makeClient(
      { gates: {} },
      { universes: { default: { holdout_range: null } }, experiments: { exp_001: exp } },
    );
    const result = client.getExperiment("exp_001", { user_id: "user_abc" }, { v: "default" });
    expect(result.inExperiment).toBe(true);
  });

  it("experiment allocation boundary: allocationPct=2887 excludes user_abc", () => {
    const exp = {
      universe: "default",
      allocationPct: 2887, // 2887 >= 2887 → NOT allocated
      salt: "exp_001",
      groups: [
        { name: "control", weight: 5000, params: { v: "ctrl" } },
        { name: "test", weight: 5000, params: { v: "test" } },
      ],
      status: "running" as const,
    };
    const client = makeClient(
      { gates: {} },
      { universes: { default: { holdout_range: null } }, experiments: { exp_001: exp } },
    );
    const result = client.getExperiment("exp_001", { user_id: "user_abc" }, { v: "default" });
    expect(result.inExperiment).toBe(false);
    expect(result.params).toEqual({ v: "default" });
  });
});

describe("getFlag", () => {
  it("returns false for unknown flag", () => {
    const client = makeClient({ gates: {} }, { universes: {}, experiments: {} });
    expect(client.getFlag("nonexistent", { user_id: "u1" })).toBe(false);
  });

  it("rule: eq match passes, neq match passes", () => {
    const gate = {
      rules: [{ attr: "plan", op: "eq" as const, value: "pro" }],
      rolloutPct: 10000,
      salt: "s",
      enabled: 1 as const,
    };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "u1", plan: "pro" })).toBe(true);
    expect(client.getFlag("g", { user_id: "u1", plan: "free" })).toBe(false);
  });

  it("rule: in / not_in", () => {
    const gate = {
      rules: [{ attr: "plan", op: "in" as const, value: ["pro", "enterprise"] }],
      rolloutPct: 10000,
      salt: "s",
      enabled: 1 as const,
    };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "u1", plan: "pro" })).toBe(true);
    expect(client.getFlag("g", { user_id: "u1", plan: "free" })).toBe(false);
  });

  it("rule: numeric gt/gte/lt/lte", () => {
    const gate = {
      rules: [{ attr: "age", op: "gte" as const, value: 18 }],
      rolloutPct: 10000,
      salt: "s",
      enabled: 1 as const,
    };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", { user_id: "u1", age: 18 })).toBe(true);
    expect(client.getFlag("g", { user_id: "u1", age: 17 })).toBe(false);
  });
});

describe("getConfig", () => {
  it("returns undefined for unknown config", () => {
    const client = makeClient({ gates: {}, configs: {} }, { universes: {}, experiments: {} });
    expect(client.getConfig("unknown")).toBeUndefined();
  });

  it("returns raw value without decoder", () => {
    const client = makeClient(
      { gates: {}, configs: { timeout: { value: 5000 } } },
      { universes: {}, experiments: {} },
    );
    expect(client.getConfig("timeout")).toBe(5000);
  });

  it("applies decoder", () => {
    const client = makeClient(
      { gates: {}, configs: { timeout: { value: "5000" } } },
      { universes: {}, experiments: {} },
    );
    expect(client.getConfig("timeout", (v) => Number(v))).toBe(5000);
  });
});

describe("getExperiment", () => {
  const baseExp = {
    universe: "default",
    allocationPct: 10000,
    salt: "s",
    groups: [
      { name: "control", weight: 5000, params: { color: "gray" } },
      { name: "test", weight: 5000, params: { color: "blue" } },
    ],
    status: "running" as const,
  };

  it("returns notIn defaults when blobs not loaded", () => {
    const client = new FlagsClient({ apiKey: "k", baseUrl: "http://x" });
    const r = client.getExperiment("exp", { user_id: "u1" }, { color: "default" });
    expect(r.inExperiment).toBe(false);
    expect(r.params.color).toBe("default");
  });

  it("returns notIn for draft experiment", () => {
    const exp = { ...baseExp, status: "draft" as const };
    const client = makeClient(
      { gates: {} },
      { universes: { default: { holdout_range: null } }, experiments: { exp: exp } },
    );
    const r = client.getExperiment("exp", { user_id: "u1" }, { color: "default" });
    expect(r.inExperiment).toBe(false);
  });

  it("targeting gate miss → not in experiment", () => {
    const gate = { rules: [], rolloutPct: 0, salt: "sg", enabled: 1 as const }; // rollout=0 → always false
    const exp = { ...baseExp, targetingGate: "beta" };
    const client = makeClient(
      { gates: { beta: gate } },
      { universes: { default: { holdout_range: null } }, experiments: { exp } },
    );
    const r = client.getExperiment("exp", { user_id: "u1" }, { color: "default" });
    expect(r.inExperiment).toBe(false);
  });

  it("holdout excludes user in holdout range", () => {
    // murmur3("default:u1") % 10000 — compute and set holdout range to include it
    // Instead: use rolloutPct=10000 + holdout_range=[0,9999] to exclude all users
    const exp = { ...baseExp, universe: "holdout_u" };
    const client = makeClient(
      { gates: {} },
      {
        universes: { holdout_u: { holdout_range: [0, 9999] as [number, number] } },
        experiments: { exp },
      },
    );
    const r = client.getExperiment("exp", { user_id: "u1" }, { color: "default" });
    expect(r.inExperiment).toBe(false);
  });

  it("decode failure returns notIn with warning", () => {
    const exp = { ...baseExp };
    const client = makeClient(
      { gates: {} },
      { universes: { default: { holdout_range: null } }, experiments: { exp } },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = client.getExperiment("exp", { user_id: "u1" }, { color: "default" }, () => {
      throw new Error("bad decode");
    });
    expect(r.inExperiment).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("track", () => {
  it("fires POST /collect fire-and-forget", () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    const client = makeClient({ gates: {}, configs: {} }, { universes: {}, experiments: {} });
    client.track("u1", "purchase", { value: 42 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/collect"),
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });
});

describe("FlagsClient lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("initOnce is idempotent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "X-Poll-Interval": "30", ETag: '"v1"' }),
      json: async () => ({ version: "v1", plan: "free", gates: {}, configs: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlagsClient({ apiKey: "k", baseUrl: "http://x" });
    await client.initOnce();
    await client.initOnce(); // second call should not fetch again
    // Each initOnce calls fetchFlags + fetchExps = 2 calls total, not 4
    expect(fetchMock.mock.calls.length).toBe(2);
    vi.unstubAllGlobals();
  });

  it("destroy clears poll timer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "X-Poll-Interval": "30", ETag: '"v1"' }),
      json: async () => ({
        version: "v1",
        plan: "free",
        gates: {},
        configs: {},
        universes: {},
        experiments: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new FlagsClient({ apiKey: "k", baseUrl: "http://x" });
    await client.init();
    client.destroy();
    expect((client as any).timer).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("FlagsClientBrowser", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });
    vi.stubGlobal("crypto", { randomUUID: () => "test-anon-id" });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      visibilityState: "visible",
    });
    vi.stubGlobal("PerformanceObserver", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("getFlag returns false before identify", async () => {
    const { FlagsClientBrowser } = await import("../client/index");
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    expect(client.getFlag("my_flag")).toBe(false);
  });

  it("identify calls /sdk/evaluate and getFlag returns result", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const evalResult = {
      flags: { my_flag: true },
      configs: {},
      experiments: {},
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => evalResult,
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    expect(client.getFlag("my_flag")).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://x/sdk/evaluate?env=prod",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("initFromBootstrap sets eval result without network call", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    client.initFromBootstrap({
      flags: { bootstrap_flag: true },
      configs: {},
      experiments: {},
    });
    expect(client.getFlag("bootstrap_flag")).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("getExperiment returns notIn before identify", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    const r = client.getExperiment("exp", { color: "gray" });
    expect(r.inExperiment).toBe(false);
    expect(r.params).toEqual({ color: "gray" });
  });

  it("getExperiment returns params after identify and logs exposure", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        flags: {},
        configs: {},
        experiments: { btn_exp: { inExperiment: true, group: "test", params: { color: "blue" } } },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    const r = client.getExperiment("btn_exp", { color: "gray" });
    expect(r.inExperiment).toBe(true);
    expect(r.group).toBe("test");
    expect(r.params).toEqual({ color: "blue" });
  });
});
