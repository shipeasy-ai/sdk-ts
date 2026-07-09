import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auto / suppressible exposure logging (doc 20 §3). The browser `assign()`
// auto-logs a deduped exposure unless suppressed per-call (`{ logExposure:false }`)
// or per-client (`disableAutoExposure: true`). Exposure is fired by the read
// path itself — there is no manual `logExposure`. We capture exposure events out
// of the /collect fetches.

interface ExposureEv {
  type: string;
  experiment: string;
  group: string;
}

function mockEvalFetch(captured: ExposureEv[]) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/collect") && init?.body) {
      try {
        const body = JSON.parse(init.body as string) as { events?: ExposureEv[] };
        for (const e of body.events ?? []) if (e.type === "exposure") captured.push(e);
      } catch {
        /* ignore */
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        flags: {},
        configs: {},
        experiments: {
          exp: { inExperiment: true, group: "test", params: { color: "blue" }, universe: "u" },
        },
        universes: { u: { defaults: { color: "red" } } },
      }),
    } as Response);
  });
}

describe("auto / suppressible exposure — browser", () => {
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
    vi.stubGlobal("setInterval", () => 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("assign() auto-logs exactly one exposure by default", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.universe("u").assign();
    await client.flush();
    expect(captured.filter((e) => e.experiment === "exp")).toHaveLength(1);
    expect(captured[0].group).toBe("test");
  });

  it("repeated assign() never double-counts (session dedup)", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.universe("u").assign();
    client.universe("u").assign();
    client.universe("u").assign();
    await client.flush();
    expect(captured).toHaveLength(1);
  });

  it("logExposure:false suppresses the exposure but still resolves params", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    const a = client.universe("u").assign({ logExposure: false });
    expect(a.enrolled).toBe(true);
    expect(a.get("color")).toBe("blue");
    await client.flush();
    expect(captured).toHaveLength(0);
  });

  it("disableAutoExposure flips the default; per-call logExposure:true re-enables", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({
      sdkKey: "k",
      baseUrl: "http://x",
      disableAutoExposure: true,
    });
    await client.identify({ user_id: "u1" });
    client.universe("u").assign(); // suppressed by client default
    await client.flush();
    expect(captured).toHaveLength(0);

    client.universe("u").assign({ logExposure: true }); // forced on
    await client.flush();
    expect(captured).toHaveLength(1);
  });

  it("assign() logs nothing when the visitor isn't enrolled", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    const a = client.universe("no_such_universe").assign();
    expect(a.enrolled).toBe(false);
    expect(a.group).toBeNull();
    await client.flush();
    expect(captured).toHaveLength(0);
  });
});

describe("server assign() auto-exposure", () => {
  it("emits an exposure for an enrolled user, deduped, no-op when not enrolled", async () => {
    vi.resetModules();
    const { Engine } = await import("../server/index");
    const collectBodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/collect") && init?.body) collectBodies.push(init.body as string);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    // A snapshot with one fully-allocated running experiment, single group.
    const snapshot = {
      flags: { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {} },
      experiments: {
        version: "t",
        universes: { u: { holdout_range: null } },
        experiments: {
          exp: {
            universe: "u",
            allocationPct: 10000,
            salt: "s",
            status: "running" as const,
            groups: [{ name: "test", weight: 10000, params: { color: "blue" } }],
          },
        },
      },
    };
    // A live (non-testMode) engine seeded with the snapshot blobs so the
    // /collect POST from auto-exposure actually fires.
    const live = new Engine({ apiKey: "k", baseUrl: "http://x", disableTelemetry: true });
    (live as unknown as { flagsBlob: unknown }).flagsBlob = snapshot.flags;
    (live as unknown as { expsBlob: unknown }).expsBlob = snapshot.experiments;
    (live as unknown as { initialized: boolean }).initialized = true;

    const a = live.universe("u").assign({ user_id: "user_abc" });
    expect(a.enrolled).toBe(true);
    expect(a.group).toBe("test");
    // On-read exposure (spec step 7): assign() alone logs NOTHING — reading the
    // `.group`/`.enrolled` standing is side-effect free.
    expect(collectBodies).toHaveLength(0);

    // A peek ({ exposure: false }) reads the param without logging.
    expect(a.get("color", undefined, { exposure: false })).toBe("blue");
    expect(collectBodies).toHaveLength(0);

    // The first real param read fires the single exposure.
    expect(a.get("color")).toBe("blue");
    expect(collectBodies).toHaveLength(1);
    const parsed = JSON.parse(collectBodies[0]) as {
      events: { type: string; experiment: string; group: string; user_id?: string }[];
    };
    expect(parsed.events[0]).toMatchObject({
      type: "exposure",
      experiment: "exp",
      group: "test",
      user_id: "user_abc",
    });

    // A second read of the same assignment does not re-fire.
    expect(a.get("color")).toBe("blue");
    expect(collectBodies).toHaveLength(1);

    // A fresh assign + read for the same (user, exp, group) is deduped per process.
    live.universe("u").assign({ user_id: "user_abc" }).get("color");
    expect(collectBodies).toHaveLength(1); // no new POST

    // A not-enrolled read (unknown universe) never posts, even when get() is called.
    live.universe("missing_universe").assign({ user_id: "user_abc" }).get("color");
    expect(collectBodies).toHaveLength(1);
  });
});
