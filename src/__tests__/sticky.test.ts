import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlagsClient, createInMemoryStickyStore, type FlagsBlob, type ExpsBlob } from "../server/index";

// Sticky bucketing (doc 20 §2): server store + browser __se_sticky cookie.

const FLAGS: FlagsBlob = { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {} };
const expsBlob = (over: Partial<Record<string, unknown>> = {}): ExpsBlob => ({
  version: "t",
  universes: { u: { holdout_range: null } },
  experiments: {
    exp: {
      universe: "u",
      allocationPct: 10000,
      salt: "salt_abcdef",
      status: "running",
      groups: [
        { name: "control", weight: 5000, params: { v: "a" } },
        { name: "treatment", weight: 5000, params: { v: "b" } },
      ],
      ...over,
    },
  },
});

function seededClient(store = createInMemoryStickyStore(), exps: ExpsBlob = expsBlob()): FlagsClient {
  const c = new FlagsClient({ apiKey: "", testMode: true, stickyStore: store });
  (c as unknown as { flagsBlob: FlagsBlob }).flagsBlob = FLAGS;
  (c as unknown as { expsBlob: ExpsBlob }).expsBlob = exps;
  (c as unknown as { initialized: boolean }).initialized = true;
  return c;
}

describe("server sticky store", () => {
  it("no store ⇒ deterministic (unchanged)", () => {
    const c = new FlagsClient({ apiKey: "", testMode: true });
    (c as unknown as { flagsBlob: FlagsBlob }).flagsBlob = FLAGS;
    (c as unknown as { expsBlob: ExpsBlob }).expsBlob = expsBlob();
    (c as unknown as { initialized: boolean }).initialized = true;
    const a = c.getExperiment("exp", { user_id: "u1" }, {});
    const b = c.getExperiment("exp", { user_id: "u1" }, {});
    expect(a.group).toBe(b.group);
  });

  it("a weight change keeps a stickied user in their original group", () => {
    const store = createInMemoryStickyStore();
    const first = seededClient(store).getExperiment("exp", { user_id: "u1" }, {});
    const original = first.group;

    // Reweight so the deterministic pick would flip — the stickied user stays.
    const reweighted = seededClient(
      store,
      expsBlob({
        groups: [
          { name: "control", weight: original === "control" ? 1 : 9999, params: { v: "a" } },
          { name: "treatment", weight: original === "control" ? 9999 : 1, params: { v: "b" } },
        ],
      }),
    );
    expect(reweighted.getExperiment("exp", { user_id: "u1" }, {}).group).toBe(original);
  });

  it("an allocation shrink keeps enrolled users in but denies new ones", () => {
    const store = createInMemoryStickyStore();
    expect(seededClient(store).getExperiment("exp", { user_id: "u1" }, {}).inExperiment).toBe(true);

    const shrunk = () => seededClient(store, expsBlob({ allocationPct: 0 }));
    expect(shrunk().getExperiment("exp", { user_id: "u1" }, {}).inExperiment).toBe(true);
    expect(shrunk().getExperiment("exp", { user_id: "u_new" }, {}).inExperiment).toBe(false);
  });

  it("a salt change reshuffles the stored prefix", () => {
    const store = createInMemoryStickyStore();
    seededClient(store).getExperiment("exp", { user_id: "u1" }, {});
    expect(store.get("u1")!.exp.s).toBe("salt_abc");

    seededClient(store, expsBlob({ salt: "zzzz_newsalt" })).getExperiment("exp", { user_id: "u1" }, {});
    expect(store.get("u1")!.exp.s).toBe("zzzz_new");
  });
});

// ── Browser __se_sticky cookie round-trip ──────────────────────────────────
function installCookieJar() {
  let jar = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    get() {
      return {
        get cookie() {
          return jar;
        },
        set cookie(v: string) {
          // Minimal jar: last write per name wins; we only ever set __se_sticky/anon.
          const [pair] = v.split(";");
          const [name] = pair.split("=");
          const parts = jar ? jar.split("; ").filter((p) => !p.startsWith(`${name}=`)) : [];
          parts.push(pair);
          jar = parts.join("; ");
        },
        addEventListener: vi.fn(),
        visibilityState: "visible",
      };
    },
  });
  return {
    raw: () => jar,
    set: (v: string) => {
      jar = v;
    },
  };
}

describe("browser __se_sticky cookie round-trip", () => {
  let jar: ReturnType<typeof installCookieJar>;
  beforeEach(() => {
    jar = installCookieJar();
    vi.stubGlobal("location", { protocol: "http:" });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() });
    vi.stubGlobal("crypto", { randomUUID: () => "anon-1" });
    vi.stubGlobal("setInterval", () => 1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // @ts-expect-error cleanup the defined property
    delete globalThis.document;
  });

  it("sends the cookie map and persists returned assignments", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const evalBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/sdk/evaluate") && init?.body) evalBodies.push(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            flags: {},
            configs: {},
            experiments: { exp: { inExperiment: true, group: "treatment", params: {} } },
            sticky: { exp: { g: "treatment", s: "salt_abc" } },
          }),
        } as Response);
      }),
    );

    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });

    // First request sent an (empty) sticky map.
    const body1 = JSON.parse(evalBodies[0]) as { sticky?: Record<string, unknown> };
    expect(body1.sticky).toEqual({});

    // The returned assignment was persisted to the cookie.
    expect(jar.raw()).toContain("__se_sticky=");
    const cookieVal = decodeURIComponent(jar.raw().match(/__se_sticky=([^;]+)/)![1]);
    expect(JSON.parse(cookieVal)).toEqual({ exp: { g: "treatment", s: "salt_abc" } });

    // A second identify replays the stored map back to the worker.
    await client.identify({ user_id: "u1" });
    const body2 = JSON.parse(evalBodies[1]) as { sticky?: Record<string, unknown> };
    expect(body2.sticky).toEqual({ exp: { g: "treatment", s: "salt_abc" } });
  });

  it("stickyBucketing:false sends no sticky map", async () => {
    vi.resetModules();
    const { FlagsClientBrowser } = await import("../client/index");
    const evalBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/sdk/evaluate") && init?.body) evalBodies.push(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ flags: {}, configs: {}, experiments: {} }),
        } as Response);
      }),
    );
    const client = new FlagsClientBrowser({ sdkKey: "k", baseUrl: "http://x", stickyBucketing: false });
    await client.identify({ user_id: "u1" });
    const body = JSON.parse(evalBodies[0]) as { sticky?: unknown };
    expect(body.sticky).toBeUndefined();
  });
});
