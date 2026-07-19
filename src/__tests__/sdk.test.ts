import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Engine } from "../server/index";
import type { User } from "../server/index";

// ---- murmur3 test vectors (MurmurHash3_x86_32, seed 0, UTF-8 encoding) ----
// Verified against the reference vectors in experiment-platform/04-evaluation.md.
// The SDK inlines the same murmur3 as packages/core/src/eval/hash.ts.
// We exercise the hash via the public gate/experiment API at known boundary values.

// To expose murmur3 for testing we create a minimal gate harness.
function makeClient(flags: object, exps: object): Engine {
  const client = new Engine({ apiKey: "test", baseUrl: "http://localhost" });
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

  it("no unit id + rollout=10000 → true (fully-rolled gate needs no bucketing)", () => {
    // An unidentified request (e.g. SSR before any anon id is minted) still gets
    // a 100% gate: it's on for everyone, so it's answerable without a unit.
    const gate = { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", {})).toBe(true);
  });

  it("no unit id + fractional rollout → false (can't bucket without a unit)", () => {
    const gate = { rules: [], rolloutPct: 5000, salt: "s", enabled: 1 as const };
    const client = makeClient({ gates: { g: gate } }, { universes: {}, experiments: {} });
    expect(client.getFlag("g", {})).toBe(false);
  });

  it("no unit id + rollout=10000 but failing rule → false", () => {
    // Rules are evaluated before the no-unit short-circuit, so targeting still
    // gates a 100% rollout.
    const gate = {
      rules: [{ attr: "plan", op: "eq" as const, value: "pro" }],
      rolloutPct: 10000,
      salt: "s",
      enabled: 1 as const,
    };
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
    const result = client.universe("default").assign({ user_id: "user_abc" });
    expect(result.enrolled).toBe(true);
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
    const result = client.universe("default").assign({ user_id: "user_abc" });
    expect(result.enrolled).toBe(false);
    expect(result.group).toBeNull();
    expect(result.get("v", "default")).toBe("default");
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

describe("universe assign", () => {
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

  it("returns not-enrolled defaults when blobs not loaded", () => {
    const client = new Engine({ apiKey: "k", baseUrl: "http://x" });
    const r = client.universe("default").assign({ user_id: "u1" });
    expect(r.enrolled).toBe(false);
    expect(r.get("color", "default")).toBe("default");
  });

  it("returns not-enrolled for draft experiment", () => {
    const exp = { ...baseExp, status: "draft" as const };
    const client = makeClient(
      { gates: {} },
      { universes: { default: { holdout_range: null } }, experiments: { exp: exp } },
    );
    const r = client.universe("default").assign({ user_id: "u1" });
    expect(r.enrolled).toBe(false);
  });

  it("targeting gate miss → not enrolled", () => {
    const gate = { rules: [], rolloutPct: 0, salt: "sg", enabled: 1 as const }; // rollout=0 → always false
    const exp = { ...baseExp, targetingGate: "beta" };
    const client = makeClient(
      { gates: { beta: gate } },
      { universes: { default: { holdout_range: null } }, experiments: { exp } },
    );
    const r = client.universe("default").assign({ user_id: "u1" });
    expect(r.enrolled).toBe(false);
  });

  it("holdout excludes user in holdout range", () => {
    // rolloutPct=10000 + holdout_range=[0,9999] excludes all users.
    const exp = { ...baseExp, universe: "holdout_u" };
    const client = makeClient(
      { gates: {} },
      {
        universes: { holdout_u: { holdout_range: [0, 9999] as [number, number] } },
        experiments: { exp },
      },
    );
    const r = client.universe("holdout_u").assign({ user_id: "u1" });
    expect(r.enrolled).toBe(false);
    expect(r.group).toBeNull();
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

describe("Engine lifecycle", () => {
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
    const client = new Engine({ apiKey: "k", baseUrl: "http://x" });
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
    const client = new Engine({ apiKey: "k", baseUrl: "http://x" });
    await client.init();
    client.destroy();
    expect((client as any).timer).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("BrowserEngine", () => {
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
    const { Engine: BrowserEngine } = await import("../client/index");
    vi.stubGlobal("setInterval", () => 1);
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    expect(client.getFlag("my_flag")).toBe(false);
  });

  it("identify calls /sdk/evaluate and getFlag returns result", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
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
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    expect(client.getFlag("my_flag")).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://x/sdk/evaluate?env=prod",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("initFromBootstrap sets eval result without network call", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    client.initFromBootstrap({
      flags: { bootstrap_flag: true },
      configs: {},
      experiments: {},
    });
    expect(client.getFlag("bootstrap_flag")).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("universe assign returns not-enrolled before identify", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    vi.stubGlobal("setInterval", () => 1);
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    const r = client.universe("btns").assign();
    expect(r.enrolled).toBe(false);
    expect(r.get("color", "gray")).toBe("gray");
  });

  it("universe assign returns params after identify and logs exposure", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        flags: {},
        configs: {},
        experiments: {
          btn_exp: { inExperiment: true, group: "test", params: { color: "blue" }, universe: "btns" },
        },
        universes: { btns: { defaults: { color: "gray" } } },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    const r = client.universe("btns").assign();
    expect(r.enrolled).toBe(true);
    expect(r.group).toBe("test");
    expect(r.get("color")).toBe("blue");
  });

  it("late-arriving stale identify does not overwrite a newer result", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
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
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
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
    const { Engine: BrowserEngine } = await import("../client/index");
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
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
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
    sdk.shipeasy({ clientKey: "k", baseUrl: "http://x" });
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
    sdk.shipeasy({ clientKey: "k", baseUrl: "http://x", autoIdentify: false });
    // Give microtasks a chance to run.
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
    sdk._resetShipeasyForTests();
  });

  it("adopts the server bootstrap identity: a matching client identify() is a no-op (no /sdk/evaluate)", async () => {
    vi.resetModules();
    // The server already identified this user + evaluated its flags into the tag.
    (window as unknown as { __SE_BOOTSTRAP?: unknown }).__SE_BOOTSTRAP = {
      flags: { vip: true },
      configs: {},
      experiments: {},
      user: { user_id: "u1", email: "e@x", project_id: "p1" },
    };
    const sdk = await import("../client/index");
    const evalCalls: unknown[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/sdk/evaluate")) evalCalls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ flags: {}, configs: {}, experiments: {} }),
      } as Response);
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("setInterval", () => 1);
    sdk._resetShipeasyForTests();
    sdk.shipeasy({ clientKey: "k", baseUrl: "http://x", autoIdentify: false });
    // Same identity the server bootstrapped → nothing new to learn → no round-trip.
    await sdk.flags.identify({ user_id: "u1", email: "e@x", project_id: "p1" });
    expect(evalCalls.length).toBe(0);
    // The bootstrap already carries this user's flags — no flip.
    expect(sdk.flags.get("vip")).toBe(true);
    delete (window as unknown as { __SE_BOOTSTRAP?: unknown }).__SE_BOOTSTRAP;
    sdk._resetShipeasyForTests();
  });

  it("a client identify() that differs from the bootstrap identity re-evaluates", async () => {
    vi.resetModules();
    (window as unknown as { __SE_BOOTSTRAP?: unknown }).__SE_BOOTSTRAP = {
      flags: { vip: true },
      configs: {},
      experiments: {},
      user: { user_id: "u1", email: "e@x", project_id: "p1" },
    };
    const sdk = await import("../client/index");
    const evalCalls: { user_id?: string }[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (String(url).includes("/sdk/evaluate")) {
        const body = JSON.parse(init.body as string) as { user: { user_id?: string } };
        evalCalls.push(body.user);
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
    sdk.shipeasy({ clientKey: "k", baseUrl: "http://x", autoIdentify: false });
    // Different user → genuine change → one /sdk/evaluate.
    await sdk.flags.identify({ user_id: "u2" });
    expect(evalCalls.length).toBe(1);
    expect(evalCalls[0].user_id).toBe("u2");
    delete (window as unknown as { __SE_BOOTSTRAP?: unknown }).__SE_BOOTSTRAP;
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

describe("server shipeasy() — single server key, no client key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetchOk(): { url: string; key: string | null }[] {
    const calls: { url: string; key: string | null }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), key: headers["X-SDK-Key"] ?? null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          version: "v1",
          plan: "free",
          gates: {},
          configs: {},
          universes: {},
          experiments: {},
          locale: "en",
          strings: {},
        }),
      } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("missing server key → skips flags, experiments AND i18n, logs one error", async () => {
    vi.resetModules();
    // The no-key warning is suppressed in dev/test (isDevOrTestEnv) so it only
    // surfaces on real deploys — force a prod-like env to exercise the warning.
    vi.stubEnv("SHIPEASY_ENV", "production");
    const calls = stubFetchOk();
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    await shipeasy({});
    // Assert on the endpoints this test is about — no flags / experiments / i18n
    // fetch. A global `calls.length === 0` is fragile: prior tests fire
    // fire-and-forget telemetry beacons (t.shipeasy.ai/.../ks/…) that can resolve
    // into this test's fetch stub and are unrelated to shipeasy()'s behaviour.
    const dataFetches = calls.filter((c) => /\/sdk\/(flags|experiments|i18n)/.test(c.url));
    expect(dataFetches).toEqual([]);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("No server key");
    vi.unstubAllEnvs();
  });

  it("server key present → fetches flags/experiments AND i18n, all with the server key", async () => {
    vi.resetModules();
    const calls = stubFetchOk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    await shipeasy({ serverKey: "srv_key_123" });
    const flagsCall = calls.find((c) => c.url.includes("/sdk/flags"));
    const i18nCall = calls.find((c) => c.url.includes("/sdk/i18n"));
    expect(flagsCall).toBeTruthy();
    expect(i18nCall).toBeTruthy();
    // The same server key authenticates every server-side fetch — never a client key.
    expect(flagsCall?.key).toBe("srv_key_123");
    expect(i18nCall?.key).toBe("srv_key_123");
  });

  it("bootstrap tags embed no SDK key (server key must never reach the browser)", async () => {
    vi.resetModules();
    stubFetchOk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    const handle = await shipeasy({ serverKey: "srv_key_secret" });
    const tags = handle.getBootstrapTags();
    const data = handle.getBootstrapData();
    expect(tags).not.toContain("srv_key_secret");
    expect(tags).not.toContain("apiKey");
    // The bootstrap tag carries no key attribute of any kind.
    expect(data.bootstrap.attrs["data-key"]).toBeUndefined();
    expect(JSON.stringify(data.bootstrap.attrs)).not.toContain("srv_key_secret");
    // It points at the static, cross-platform loader.
    expect(data.bootstrap.src).toContain("/sdk/bootstrap.js");
    expect(data.bootstrap.attrs).toHaveProperty("data-se-bootstrap");
  });

  it("mints + emits a __se_anon_id on the bootstrap tag when no user/cookie is present", async () => {
    vi.resetModules();
    stubFetchOk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    // No next/headers in this runtime → no cookie; server mints one.
    const handle = await shipeasy({ serverKey: "srv_key" });
    const data = handle.getBootstrapData();
    // The minted id rides data-anon-id; se-bootstrap.js writes the cookie +
    // exposes it so the browser SDK adopts the exact same bucketing unit.
    expect(data.bootstrap.attrs["data-anon-id"]).toMatch(/^[^"]+$/);
    expect(handle.getBootstrapTags()).toContain("data-anon-id");
  });

  it("buckets against an explicitly-passed user (no anon override)", async () => {
    vi.resetModules();
    stubFetchOk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    const handle = await shipeasy({
      serverKey: "srv_key",
      user: { user_id: "u-123" },
    });
    const data = handle.getBootstrapData();
    // Authenticated caller → no anonymous id is minted or emitted.
    expect(data.bootstrap.attrs["data-anon-id"]).toBeUndefined();
    expect(handle.getBootstrapTags()).not.toContain("data-anon-id");
  });

  it("emits a keyed i18n loader tag with SSR strings when a client key is passed", async () => {
    vi.resetModules();
    stubFetchOk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    const handle = await shipeasy({ serverKey: "srv_key" });
    const data = handle.getBootstrapData({ clientKey: "client_pub_key" });
    expect(data.i18nLoader).not.toBeNull();
    expect(data.i18nLoader?.src).toContain("/sdk/i18n/loader.js");
    expect(data.i18nLoader?.attrs["data-key"]).toBe("client_pub_key");
    expect(data.i18nLoader?.attrs["data-profile"]).toBe("en:prod");
  });
});

describe("server shipeasy() — identity resolver (setServerIdentity / opts.identify)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // /sdk/flags returns one targeting gate `vip` that is true ONLY for
  // user_id === "resolver-user" — so a flag value proves exactly which identity
  // reached flags.evaluate().
  function stubFlagsWithVipGate() {
    const fetchMock = vi.fn(async (url: string) => {
      const isFlags = String(url).includes("/sdk/flags");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          version: "v1",
          plan: "free",
          gates: isFlags
            ? {
                vip: {
                  rules: [{ attr: "user_id", op: "eq", value: "resolver-user" }],
                  rolloutPct: 10000,
                  salt: "s",
                  enabled: 1,
                },
              }
            : {},
          configs: {},
          killswitches: {},
          universes: {},
          experiments: {},
          locale: "en",
          strings: {},
        }),
      } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("evaluates nav + bootstrap for the registered identity (no anon, gate matches)", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => ({ user_id: "resolver-user", email: "r@x.test" }));
    try {
      const handle = await shipeasy({ serverKey: "srv_key" });
      // The identity reached flags.evaluate() → the bootstrap flags (what the
      // browser SDK seeds from) already carry the identified value: no flip.
      expect(handle.flags.vip).toBe(true);
      // An identified user mints no anon id — the bootstrap tag carries none.
      expect(handle.getBootstrapData().bootstrap.attrs["data-anon-id"]).toBeUndefined();
      // The identity itself rides the tag (data-user) so the browser SDK adopts it.
      const emitted = JSON.parse(handle.getBootstrapData().bootstrap.attrs["data-user"]!);
      expect(emitted).toEqual({ user_id: "resolver-user", email: "r@x.test" });
      expect(handle.getBootstrapTags()).toContain("data-user");
    } finally {
      setServerIdentity(null);
    }
  });

  it("emits NO data-user for an anonymous request", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => null);
    try {
      const handle = await shipeasy({ serverKey: "srv_key" });
      // No identity → no data-user (an anon-id-only user adds nothing).
      expect(handle.getBootstrapData().bootstrap.attrs["data-user"]).toBeUndefined();
      expect(handle.getBootstrapTags()).not.toContain("data-user");
    } finally {
      setServerIdentity(null);
    }
  });

  it("opts.identify (per-call) overrides the registered resolver", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => ({ user_id: "someone-else" }));
    try {
      const handle = await shipeasy({
        serverKey: "srv_key",
        identify: async () => ({ user_id: "resolver-user" }),
      });
      expect(handle.flags.vip).toBe(true);
    } finally {
      setServerIdentity(null);
    }
  });

  it("explicit opts.user wins over the resolver (layered under)", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => ({ user_id: "resolver-user" }));
    try {
      // opts.user overrides the resolver's user_id → the vip gate no longer matches.
      const handle = await shipeasy({ serverKey: "srv_key", user: { user_id: "override" } });
      expect(handle.flags.vip).toBe(false);
    } finally {
      setServerIdentity(null);
    }
  });

  it("a resolver returning null leaves the request anonymous (anon id minted)", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => null);
    try {
      const handle = await shipeasy({ serverKey: "srv_key" });
      expect(handle.flags.vip).toBe(false);
      // Anonymous → an anon id is minted + emitted for cross-runtime bucketing.
      expect(handle.getBootstrapData().bootstrap.attrs["data-anon-id"]).toMatch(/^[^"]+$/);
    } finally {
      setServerIdentity(null);
    }
  });

  it("a throwing resolver is swallowed (renders anonymously, never breaks SSR)", async () => {
    vi.resetModules();
    stubFlagsWithVipGate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy, setServerIdentity } = await import("../server");
    setServerIdentity(() => {
      throw new Error("session store down");
    });
    try {
      const handle = await shipeasy({ serverKey: "srv_key" });
      expect(handle.flags.vip).toBe(false);
      expect(handle.getBootstrapData().bootstrap.attrs["data-anon-id"]).toMatch(/^[^"]+$/);
    } finally {
      setServerIdentity(null);
    }
  });
});

describe("server i18n SSR cache TTL", () => {
  // The cache is parked on globalThis (shared across module re-imports), so it
  // persists between vi.resetModules() runs the way it persists across requests
  // in a long-lived worker isolate. Clear it explicitly between tests.
  const CACHE_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n-cache");
  const clearCache = () =>
    (globalThis as Record<symbol, { clear?: () => void }>)[CACHE_SYM]?.clear?.();

  beforeEach(() => {
    clearCache();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCache();
  });

  function stubFetchWithStrings(): string[] {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      const isI18n = u.includes("/sdk/i18n");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          version: "v1",
          plan: "free",
          gates: {},
          configs: {},
          universes: {},
          experiments: {},
          locale: "en",
          // Only the i18n response carries strings — an empty result is never
          // cached, so the cache only populates on a real string payload.
          strings: isI18n ? { greeting: "hello" } : {},
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  // Each run gets a fresh module instance (fresh ALS, fresh flags singleton) but
  // shares the globalThis string cache — mirroring a new SSR request landing on
  // the same isolate.
  async function runShipeasy() {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { shipeasy } = await import("../server");
    await shipeasy({ serverKey: "srv_key_ttl" });
  }

  const i18nCount = (calls: string[]) => calls.filter((u) => u.includes("/sdk/i18n")).length;

  it("serves cached strings within the TTL, then re-fetches once it expires", async () => {
    const calls = stubFetchWithStrings();

    await runShipeasy();
    expect(i18nCount(calls)).toBe(1); // first request fetches + caches

    vi.setSystemTime(30_000); // within the 60s TTL
    await runShipeasy();
    expect(i18nCount(calls)).toBe(1); // cache hit — no new fetch

    vi.setSystemTime(61_000); // past the TTL
    await runShipeasy();
    expect(i18nCount(calls)).toBe(2); // stale entry expired — re-fetched
  });
});
