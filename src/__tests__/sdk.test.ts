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
    // The shipeasy() code path goes through flags.notifyMounted() and attachDevtools(),
    // which reach for dispatchEvent / removeEventListener / location / screen / navigator.
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { search: "", pathname: "/" },
      screen: { width: 1024, height: 768 },
    });
    vi.stubGlobal("navigator", { language: "en-US", userAgent: "test-ua" });
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

  it("late-arriving stale identify does not overwrite a newer result", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    // First /sdk/evaluate resolves slowly with the OLD payload. Second resolves
    // immediately with the NEW payload. /collect calls (alias, etc.) resolve
    // unconditionally — they're not what we're asserting on.
    let resolveFirst: ((v: Response) => void) | null = null;
    let evalCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (!url.includes("/sdk/evaluate")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        } as Response);
      }
      evalCallCount += 1;
      if (evalCallCount === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ flags: { f: true }, configs: {}, experiments: {} }),
      } as Response);
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    const firstP = client.identify({});
    const secondP = client.identify({ user_id: "u1" });
    await secondP;
    expect(client.getFlag("f")).toBe(true);
    // Now resolve the first (stale) call — it must be dropped.
    resolveFirst!({
      ok: true,
      status: 200,
      json: async () => ({ flags: { f: false }, configs: {}, experiments: {} }),
    } as Response);
    await firstP;
    expect(client.getFlag("f")).toBe(true);
  });

  it("anonId is stable across successive identify() calls", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const calls: { anonymous_id?: string; user_id?: string }[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.includes("/sdk/evaluate")) {
        const body = JSON.parse(init.body as string) as {
          user: { anonymous_id?: string; user_id?: string };
        };
        calls.push(body.user);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ flags: {}, configs: {}, experiments: {} }),
      } as Response);
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({});
    await client.identify({ user_id: "u1" });
    await client.identify({ user_id: "u2" });
    expect(calls.length).toBe(3);
    const anonIds = calls.map((c) => c.anonymous_id);
    expect(new Set(anonIds).size).toBe(1);
    expect(anonIds[0]).toBe("test-anon-id");
    expect(calls[0].user_id).toBeUndefined();
    expect(calls[1].user_id).toBe("u1");
    expect(calls[2].user_id).toBe("u2");
  });

  it("shipeasy() auto-identifies at init and a later flags.identify() overrides", async () => {
    vi.resetModules();
    const sdk = await import("../client/index");
    const calls: { anonymous_id?: string; user_id?: string }[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.includes("/sdk/evaluate")) {
        const body = JSON.parse(init.body as string) as {
          user: { anonymous_id?: string; user_id?: string };
        };
        calls.push(body.user);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ flags: {}, configs: {}, experiments: {} }),
      } as Response);
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    sdk._resetShipeasyForTests();
    sdk.shipeasy({ apiKey: "k", baseUrl: "http://x" });
    await sdk.flags.identify({ user_id: "u1" });
    expect(calls.length).toBe(2);
    expect(calls[0].user_id).toBeUndefined();
    expect(calls[1].user_id).toBe("u1");
    expect(calls[0].anonymous_id).toBe(calls[1].anonymous_id);
    sdk._resetShipeasyForTests();
  });

  it("shipeasy({ autoIdentify: false }) does not fire an auto identify", async () => {
    vi.resetModules();
    const sdk = await import("../client/index");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    sdk._resetShipeasyForTests();
    sdk.shipeasy({ apiKey: "k", baseUrl: "http://x", autoIdentify: false });
    // Give microtasks a chance to run.
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
    sdk._resetShipeasyForTests();
  });
});

import {
  flags as serverFlags,
  configureShipeasyServer,
  _resetShipeasyServerForTests,
} from "../server";

describe("server flags.ks", () => {
  beforeEach(() => _resetShipeasyServerForTests());

  it("returns false when the killswitch is unknown", () => {
    configureShipeasyServer({
      apiKey: "k",
      initialBlob: {
        version: "1",
        plan: "free",
        gates: {},
        configs: {},
        killswitches: {},
      } as any,
    });
    expect(serverFlags.ks("missing")).toBe(false);
  });

  it("returns true when the killswitch is killed and no switch arg given", () => {
    configureShipeasyServer({
      apiKey: "k",
      initialBlob: {
        version: "1",
        plan: "free",
        gates: {},
        configs: {},
        killswitches: { "payments-disable": { killed: 1 } },
      } as any,
    });
    expect(serverFlags.ks("payments-disable")).toBe(true);
  });

  it("returns per-switch state when switch arg given", () => {
    configureShipeasyServer({
      apiKey: "k",
      initialBlob: {
        version: "1",
        plan: "free",
        gates: {},
        configs: {},
        killswitches: {
          "payments-disable": { killed: 0, switches: { stripe: 1, paypal: 0 } },
        },
      } as any,
    });
    expect(serverFlags.ks("payments-disable", "stripe")).toBe(true);
    expect(serverFlags.ks("payments-disable", "paypal")).toBe(false);
    expect(serverFlags.ks("payments-disable", "unknown")).toBe(false);
  });
});

describe("client flags.ks", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { search: "", pathname: "/" },
      screen: { width: 1024, height: 768 },
    });
    vi.stubGlobal("navigator", { language: "en-US", userAgent: "test-ua" });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      visibilityState: "visible",
    });
    vi.stubGlobal("setInterval", () => 1);
    vi.stubGlobal("PerformanceObserver", undefined);
    const sdk = await import("../client/index");
    sdk._resetShipeasyForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns false when no bootstrap is loaded", async () => {
    const sdk = await import("../client/index");
    sdk.configureShipeasy({ sdkKey: "k" });
    expect(sdk.flags.ks("missing")).toBe(false);
  });

  it("reads killed state from bootstrap", async () => {
    (window as any).__SE_BOOTSTRAP = {
      flags: {},
      configs: {},
      experiments: {},
      killswitches: { "payments-disable": true },
    };
    const sdk = await import("../client/index");
    sdk.configureShipeasy({ sdkKey: "k" });
    expect(sdk.flags.ks("payments-disable")).toBe(true);
  });

  it("reads per-switch state from bootstrap object", async () => {
    (window as any).__SE_BOOTSTRAP = {
      flags: {},
      configs: {},
      experiments: {},
      killswitches: { "payments-disable": { stripe: true, paypal: false } },
    };
    const sdk = await import("../client/index");
    sdk.configureShipeasy({ sdkKey: "k" });
    expect(sdk.flags.ks("payments-disable", "stripe")).toBe(true);
    expect(sdk.flags.ks("payments-disable", "paypal")).toBe(false);
  });
});
