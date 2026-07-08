// React Native safety for the browser entry (@shipeasy/sdk/client).
//
// The gotcha: React Native defines a global `window` (=== the global object) but
// exposes NO DOM APIs on it — `window.addEventListener` is undefined and
// `document` / `localStorage` / `sessionStorage` / `document.cookie` /
// `PerformanceObserver` / `sendBeacon` don't exist. Code that used
// `typeof window !== "undefined"` as a "we're in a browser" proxy therefore threw
// on RN. These tests reproduce that runtime and assert the client degrades
// gracefully — configure/identify/read/track/see never throw, and network reads
// still go out over `fetch`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Install a React-Native-like global environment: a bare `window` (no
 * addEventListener), a minimal `navigator` (no sendBeacon), `fetch`, timers —
 * and crucially NO `document`, `localStorage`, `sessionStorage`, `crypto`,
 * or `PerformanceObserver`.
 */
function stubReactNativeEnv(fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })) {
  // RN's `window` is the global object with none of the DOM event machinery.
  vi.stubGlobal("window", { navigator: { product: "ReactNative" } });
  vi.stubGlobal("navigator", { product: "ReactNative", userAgent: "" });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("setInterval", () => 1 as unknown as ReturnType<typeof setInterval>);
  vi.stubGlobal("clearInterval", () => {});
  // Absent in RN — referencing these must not crash the SDK.
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("localStorage", undefined);
  vi.stubGlobal("sessionStorage", undefined);
  vi.stubGlobal("PerformanceObserver", undefined);
  vi.stubGlobal("crypto", undefined);
  return fetchMock;
}

describe("client entry under React Native (no DOM on window)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructing the Engine does not throw (EventBuffer wiring is guarded)", async () => {
    stubReactNativeEnv();
    const { Engine } = await import("../client/index");
    expect(() => new Engine({ sdkKey: "k", baseUrl: "http://x" })).not.toThrow();
  });

  it("reads return safe defaults before identify without throwing", async () => {
    stubReactNativeEnv();
    const { Engine } = await import("../client/index");
    const client = new Engine({ sdkKey: "k", baseUrl: "http://x" });
    expect(client.getFlag("f")).toBe(false);
    expect(client.getConfig("c")).toBeUndefined();
    expect(client.getExperiment("e", {}).inExperiment).toBe(false);
  });

  it("identify() evaluates over fetch and reads reflect the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flags: { new_ui: true },
        configs: {},
        experiments: {},
        killswitches: {},
      }),
    });
    stubReactNativeEnv(fetchMock);
    const { Engine } = await import("../client/index");
    const client = new Engine({ sdkKey: "k", baseUrl: "http://x", disableTelemetry: true });
    await expect(client.identify({ user_id: "u1" })).resolves.not.toThrow();
    expect(fetchMock).toHaveBeenCalled();
    expect(client.getFlag("new_ui")).toBe(true);
  });

  it("track() and logExposure() are safe (buffer flushes over fetch)", async () => {
    stubReactNativeEnv();
    const { Engine } = await import("../client/index");
    const client = new Engine({ sdkKey: "k", baseUrl: "http://x", disableTelemetry: true });
    expect(() => client.track("checkout")).not.toThrow();
    expect(() => client.logExposure("exp")).not.toThrow();
  });

  it("subscribe() does not throw without window.addEventListener", async () => {
    stubReactNativeEnv();
    const { Engine } = await import("../client/index");
    const client = new Engine({ sdkKey: "k", baseUrl: "http://x" });
    let unsub!: () => void;
    expect(() => {
      unsub = client.subscribe(() => {});
    }).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  it("i18n.whenReady() resolves and onUpdate() is a no-op unsubscribe", async () => {
    stubReactNativeEnv();
    const { i18n } = await import("../client/index");
    await expect(i18n.whenReady()).resolves.toBeUndefined();
    const off = i18n.onUpdate(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("attachDevtools() returns a no-op teardown when there is no DOM", async () => {
    stubReactNativeEnv();
    const { Engine, attachDevtools } = await import("../client/index");
    const client = new Engine({ sdkKey: "k", baseUrl: "http://x" });
    const teardown = attachDevtools(client);
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });
});

describe("anonymousStore (React Native persistence)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Extract the `anonymous_id` sent on the /sdk/evaluate call. */
  function anonIdFromEvaluate(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/sdk/evaluate"));
    if (!call) return undefined;
    const body = JSON.parse((call[1] as { body: string }).body);
    return body.user?.anonymous_id;
  }

  it("adopts a persisted id from the store and evaluates with it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: {}, configs: {}, experiments: {}, killswitches: {} }),
    });
    stubReactNativeEnv(fetchMock);
    const store = {
      get: vi.fn().mockResolvedValue("anon_persisted_123"),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const { Engine } = await import("../client/index");
    const client = new Engine({
      sdkKey: "k",
      baseUrl: "http://x",
      disableTelemetry: true,
      anonymousStore: store,
    });
    await client.identify({ user_id: "u1" });
    expect(store.get).toHaveBeenCalledWith("__se_anon_id");
    // The persisted id (not a freshly-minted one) is what bucketing evaluated on.
    expect(anonIdFromEvaluate(fetchMock)).toBe("anon_persisted_123");
    // Nothing to persist — the store already had an id.
    expect(store.set).not.toHaveBeenCalled();
  });

  it("persists the freshly-minted id on a first-run device (empty store)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: {}, configs: {}, experiments: {}, killswitches: {} }),
    });
    stubReactNativeEnv(fetchMock);
    const store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const { Engine } = await import("../client/index");
    const client = new Engine({
      sdkKey: "k",
      baseUrl: "http://x",
      disableTelemetry: true,
      anonymousStore: store,
    });
    await client.identify({ user_id: "u1" });
    // A non-empty id was minted and written back for the next launch.
    expect(store.set).toHaveBeenCalledTimes(1);
    const [key, value] = store.set.mock.calls[0]!;
    expect(key).toBe("__se_anon_id");
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
    // The evaluate call used that same id.
    expect(anonIdFromEvaluate(fetchMock)).toBe(value);
  });

  it("a throwing store is non-fatal — identify still evaluates", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: {}, configs: {}, experiments: {}, killswitches: {} }),
    });
    stubReactNativeEnv(fetchMock);
    const store = {
      get: vi.fn().mockRejectedValue(new Error("AsyncStorage unavailable")),
      set: vi.fn(),
      remove: vi.fn(),
    };
    const { Engine } = await import("../client/index");
    const client = new Engine({
      sdkKey: "k",
      baseUrl: "http://x",
      disableTelemetry: true,
      anonymousStore: store,
    });
    await expect(client.identify({ user_id: "u1" })).resolves.not.toThrow();
    expect(anonIdFromEvaluate(fetchMock)).toBeTruthy();
  });

  it("accepts a synchronous store (get/set return non-promises)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: {}, configs: {}, experiments: {}, killswitches: {} }),
    });
    stubReactNativeEnv(fetchMock);
    const mem = new Map<string, string>([["__se_anon_id", "anon_sync_9"]]);
    const store = {
      get: (k: string) => mem.get(k) ?? null,
      set: (k: string, v: string) => void mem.set(k, v),
      remove: (k: string) => void mem.delete(k),
    };
    const { Engine } = await import("../client/index");
    const client = new Engine({
      sdkKey: "k",
      baseUrl: "http://x",
      disableTelemetry: true,
      anonymousStore: store,
    });
    await client.identify({ user_id: "u1" });
    expect(anonIdFromEvaluate(fetchMock)).toBe("anon_sync_9");
  });
});
