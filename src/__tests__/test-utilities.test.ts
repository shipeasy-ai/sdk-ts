// Local-override test utility (Statsig-style): forTesting() returns a
// no-network client, and overrideFlag/overrideConfig/overrideExperiment seed
// every entity. Covers both the server Engine and the browser
// BrowserEngine. These specs make NO network calls — any fetch would throw.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Engine } from "../server/index";
import { Engine as BrowserEngine } from "../client/index";

// Any accidental network call inside forTesting() should fail loudly.
const failingFetch = vi.fn(() => {
  throw new Error("network call in test mode");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Engine.forTesting() — server", () => {
  it("needs no network and no key, and is immediately initialized", async () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    // init()/initOnce() must be no-ops — never fetch.
    await client.init();
    await client.initOnce();
    expect(failingFetch).not.toHaveBeenCalled();
    // Unknown flag falls back to false (already "initialized", empty blob).
    expect(client.getFlag("anything", { user_id: "u1" })).toBe(false);
  });

  it("overrideFlag wins and is returned by getFlag", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    client.overrideFlag("new_checkout", true);
    expect(client.getFlag("new_checkout", { user_id: "u1" })).toBe(true);
    client.overrideFlag("new_checkout", false);
    expect(client.getFlag("new_checkout", { user_id: "u1" })).toBe(false);
  });

  it("overrideConfig is returned by getConfig (raw + decoded)", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    client.overrideConfig("limits", { max_uploads: 42 });
    expect(client.getConfig("limits")).toEqual({ max_uploads: 42 });
    expect(
      client.getConfig<number>("limits", (raw) => (raw as { max_uploads: number }).max_uploads),
    ).toBe(42);
  });

  it("overrideExperiment returns { inExperiment: true, group, params }", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    client.overrideExperiment("hero_cta", "treatment", { label: "Buy now" });
    const res = client.getExperiment("hero_cta", { user_id: "u1" }, { label: "Sign up" });
    expect(res.inExperiment).toBe(true);
    expect(res.group).toBe("treatment");
    expect(res.params).toEqual({ label: "Buy now" });
  });

  it("clearOverrides resets every entity back to default", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    client.overrideFlag("g", true);
    client.overrideConfig("c", 1);
    client.overrideExperiment("e", "treatment", { x: 1 });
    client.clearOverrides();
    expect(client.getFlag("g", { user_id: "u1" })).toBe(false);
    expect(client.getConfig("c")).toBeUndefined();
    expect(client.getExperiment("e", { user_id: "u1" }, { x: 0 }).inExperiment).toBe(false);
  });

  it("track() is a no-op in test mode (no network, no throw)", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.forTesting();
    expect(() => client.track("u1", "purchase", { amount: 10 })).not.toThrow();
    expect(failingFetch).not.toHaveBeenCalled();
  });

  it("overrides also work on a normal (non-test-mode) client", () => {
    const client = new Engine({ apiKey: "k", baseUrl: "http://localhost", disableTelemetry: true });
    client.overrideFlag("g", true);
    expect(client.getFlag("g", { user_id: "u1" })).toBe(true);
  });
});

describe("BrowserEngine.forTesting() — browser", () => {
  it("needs no network and no key, identify() is a no-op", async () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    expect(client.ready).toBe(true);
    await client.identify({ user_id: "u1" });
    expect(failingFetch).not.toHaveBeenCalled();
    expect(client.getFlag("anything")).toBe(false);
  });

  it("overrideFlag wins and is returned by getFlag", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    client.overrideFlag("new_checkout", true);
    expect(client.getFlag("new_checkout")).toBe(true);
  });

  it("overrideConfig is returned by getConfig (raw + decoded)", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    client.overrideConfig("limits", { max_uploads: 7 });
    expect(client.getConfig("limits")).toEqual({ max_uploads: 7 });
    expect(
      client.getConfig<number>("limits", (raw) => (raw as { max_uploads: number }).max_uploads),
    ).toBe(7);
  });

  it("overrideExperiment returns { inExperiment: true, group, params }", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    client.overrideExperiment("hero_cta", "treatment", { label: "Buy now" });
    const res = client.getExperiment("hero_cta", { label: "Sign up" });
    expect(res.inExperiment).toBe(true);
    expect(res.group).toBe("treatment");
    expect(res.params).toEqual({ label: "Buy now" });
  });

  it("clearOverrides resets every entity back to default", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    client.overrideFlag("g", true);
    client.overrideConfig("c", 1);
    client.overrideExperiment("e", "treatment", { x: 1 });
    client.clearOverrides();
    expect(client.getFlag("g")).toBe(false);
    expect(client.getConfig("c")).toBeUndefined();
    expect(client.getExperiment("e", { x: 0 }).inExperiment).toBe(false);
  });

  it("track() is a no-op in test mode (no network, no throw)", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = BrowserEngine.forTesting();
    expect(() => client.track("purchase", { amount: 10 })).not.toThrow();
    expect(failingFetch).not.toHaveBeenCalled();
  });
});
