// Auto-metric exposure gate (4.1.0): `__auto_*` metric events are only
// emitted for visitors in ≥1 active experiment, except `__auto_abandoned`
// (unconditional) — with an `autoCollectAlways` escape hatch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Listener = (ev?: unknown) => void;

function setupDom() {
  const docListeners = new Map<string, Listener[]>();
  const doc = {
    visibilityState: "visible" as string,
    readyState: "complete",
    addEventListener: (type: string, fn: Listener) => {
      const arr = docListeners.get(type) ?? [];
      arr.push(fn);
      docListeners.set(type, arr);
    },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: { search: "", pathname: "/" },
    screen: { width: 1024, height: 768 },
    fetch: undefined,
  });
  // window.fetch must reference the stubbed global fetch for the error wrapper.
  vi.stubGlobal("navigator", { language: "en-US", userAgent: "test-ua" });
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
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("performance", {
    now: () => 0,
    getEntriesByType: (type: string) =>
      type === "navigation"
        ? [
            {
              startTime: 0,
              loadEventEnd: 1200,
              responseStart: 80,
              domContentLoadedEventEnd: 600,
            },
          ]
        : [],
  });
  vi.stubGlobal("setInterval", () => 1);
  return { doc, docListeners };
}

/** All metric events POSTed to /collect across every fetch call. */
function collectedMetricNames(mockFetch: ReturnType<typeof vi.fn>): string[] {
  const names: string[] = [];
  for (const call of mockFetch.mock.calls) {
    const url = String(call[0]);
    if (!url.includes("/collect")) continue;
    const body = JSON.parse((call[1] as { body: string }).body) as {
      events?: Array<{ type: string; event_name?: string }>;
    };
    for (const e of body.events ?? []) {
      if (e.type === "metric" && e.event_name) names.push(e.event_name);
    }
  }
  return names;
}

const EVAL_WITH_EXPERIMENT = {
  flags: {},
  configs: {},
  experiments: {
    checkout: { group: "test", params: {}, inExperiment: true },
  },
};
const EVAL_EMPTY = { flags: {}, configs: {}, experiments: {} };

async function makeClient(evalResult: unknown, opts: { always?: boolean } = {}) {
  vi.resetModules();
  const mockFetch = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => evalResult });
  vi.stubGlobal("fetch", mockFetch);
  const { Engine } = await import("../client/index");
  const client = new Engine({
    sdkKey: "k",
    baseUrl: "http://x",
    autoCollectAlways: opts.always,
  });
  await client.identify({ user_id: "u1" });
  return { client, mockFetch };
}

describe("auto-metric exposure gate", () => {
  let dom: ReturnType<typeof setupDom>;

  beforeEach(() => {
    dom = setupDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fireHide() {
    dom.doc.visibilityState = "hidden";
    for (const fn of dom.docListeners.get("visibilitychange") ?? []) fn();
  }

  it("emits only __auto_abandoned for a visitor with no exposures", async () => {
    const { mockFetch } = await makeClient(EVAL_EMPTY);
    fireHide();
    const names = collectedMetricNames(mockFetch);
    expect(names).toContain("__auto_abandoned");
    expect(names.filter((n) => n !== "__auto_abandoned")).toEqual([]);
  });

  it("emits nav-timing vitals once the visitor is in an experiment", async () => {
    const { client, mockFetch } = await makeClient(EVAL_WITH_EXPERIMENT);
    // getExperiment records the exposure → the gate opens.
    const r = client.getExperiment("checkout", {});
    expect(r.inExperiment).toBe(true);
    fireHide();
    const names = collectedMetricNames(mockFetch);
    expect(names).toContain("__auto_page_load");
    expect(names).toContain("__auto_ttfb");
    expect(names).toContain("__auto_dom_ready");
    expect(names).toContain("__auto_abandoned");
  });

  it("autoCollectAlways: true emits vitals without any exposure", async () => {
    const { mockFetch } = await makeClient(EVAL_EMPTY, { always: true });
    fireHide();
    const names = collectedMetricNames(mockFetch);
    expect(names).toContain("__auto_page_load");
    expect(names).toContain("__auto_session_active");
  });

  it("nav-timing is not lost: gated at load, it still emits on the post-exposure flush", async () => {
    const { client, mockFetch } = await makeClient(EVAL_WITH_EXPERIMENT);
    // First hide BEFORE exposure: nothing but abandoned.
    fireHide();
    expect(collectedMetricNames(mockFetch)).not.toContain("__auto_page_load");
    // Exposure lands, user hides again — nav timing emits now.
    client.getExperiment("checkout", {});
    fireHide();
    expect(collectedMetricNames(mockFetch)).toContain("__auto_page_load");
  });
});
