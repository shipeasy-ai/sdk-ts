import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Manual / suppressible exposure logging (doc 20 §3). Browser getExperiment
// auto-logs a deduped exposure unless suppressed per-call (`{ logExposure:false }`)
// or per-client (`disableAutoExposure: true`); `logExposure(name)` fires it on
// demand. We capture exposure events out of the /collect fetches.

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
          exp: { inExperiment: true, group: "test", params: { color: "blue" } },
        },
      }),
    } as Response);
  });
}

describe("manual / suppressible exposure — browser", () => {
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

  it("auto-logs exactly one exposure by default", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.getExperiment("exp", { color: "gray" });
    await client.flush();
    expect(captured.filter((e) => e.experiment === "exp")).toHaveLength(1);
    expect(captured[0].group).toBe("test");
  });

  it("logExposure:false suppresses the exposure", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    const r = client.getExperiment("exp", { color: "gray" }, { logExposure: false });
    expect(r.inExperiment).toBe(true);
    expect(r.params).toEqual({ color: "blue" });
    await client.flush();
    expect(captured).toHaveLength(0);
  });

  it("manual logExposure emits exactly once after a suppressed read", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.getExperiment("exp", { color: "gray" }, { logExposure: false });
    client.logExposure("exp");
    await client.flush();
    expect(captured).toHaveLength(1);
  });

  it("auto + manual never double-count (session dedup)", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.getExperiment("exp", { color: "gray" }); // auto
    client.logExposure("exp"); // manual — deduped
    await client.flush();
    expect(captured).toHaveLength(1);
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
    client.getExperiment("exp", { color: "gray" }); // suppressed by client default
    await client.flush();
    expect(captured).toHaveLength(0);

    client.getExperiment("exp", { color: "gray" }, { logExposure: true }); // forced on
    await client.flush();
    expect(captured).toHaveLength(1);
  });

  it("logExposure is a no-op when the visitor isn't enrolled", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const captured: ExposureEv[] = [];
    vi.stubGlobal("fetch", mockEvalFetch(captured));
    const client = new BrowserEngine({ sdkKey: "k", baseUrl: "http://x" });
    await client.identify({ user_id: "u1" });
    client.logExposure("not_enrolled");
    await client.flush();
    expect(captured).toHaveLength(0);
  });
});

describe("server logExposure", () => {
  it("emits an exposure for an enrolled user, no-op otherwise", async () => {
    vi.resetModules();
    const { Engine } = await import("../server/index");
    const collectBodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/collect") && init?.body) collectBodies.push(init.body as string);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    // A snapshot with one fully-allocated running experiment, single group.
    const client = Engine.fromSnapshot({
      flags: { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {} },
      experiments: {
        version: "t",
        universes: { u: { holdout_range: null } },
        experiments: {
          exp: {
            universe: "u",
            allocationPct: 10000,
            salt: "s",
            status: "running",
            groups: [{ name: "test", weight: 10000, params: { color: "blue" } }],
          },
        },
      },
    } as never);
    // fromSnapshot is testMode → logExposure no-ops; rebuild as a live client
    // with the same blob so the /collect POST actually fires.
    const live = new Engine({ apiKey: "k", baseUrl: "http://x", disableTelemetry: true });
    (live as unknown as { flagsBlob: unknown }).flagsBlob = (
      client as unknown as { flagsBlob: unknown }
    ).flagsBlob;
    (live as unknown as { expsBlob: unknown }).expsBlob = (
      client as unknown as { expsBlob: unknown }
    ).expsBlob;
    (live as unknown as { initialized: boolean }).initialized = true;

    live.logExposure("user_abc", "exp");
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

    live.logExposure("user_abc", "missing_experiment");
    expect(collectBodies).toHaveLength(1); // no new POST
  });
});
