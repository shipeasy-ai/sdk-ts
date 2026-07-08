import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProductionEnv } from "../env";
import { Engine as ServerEngine } from "../server";
import { Engine as BrowserEngine } from "../client";

// The env-derived egress defaults: network + usage telemetry are ON in
// production and OFF everywhere else, so an embedding app never phones home from
// a dev / CI run. Production is read from SHIPEASY_ENV / NODE_ENV, falling back
// to the SDK's own `env` option (default "prod") when neither is set.

describe("isProductionEnv", () => {
  const original = { se: process.env.SHIPEASY_ENV, node: process.env.NODE_ENV };
  afterEach(() => {
    process.env.SHIPEASY_ENV = original.se;
    process.env.NODE_ENV = original.node;
  });

  it("treats SHIPEASY_ENV=production as prod (wins over NODE_ENV)", () => {
    process.env.SHIPEASY_ENV = "production";
    process.env.NODE_ENV = "development";
    expect(isProductionEnv("dev")).toBe(true);
  });

  it("treats a native development/test/staging env as non-prod", () => {
    delete process.env.SHIPEASY_ENV;
    process.env.NODE_ENV = "development";
    expect(isProductionEnv("prod")).toBe(false);
    process.env.NODE_ENV = "test";
    expect(isProductionEnv("prod")).toBe(false);
    process.env.NODE_ENV = "staging";
    expect(isProductionEnv("prod")).toBe(false);
  });

  it("falls back to the configured env option when no native env var is set", () => {
    delete process.env.SHIPEASY_ENV;
    delete process.env.NODE_ENV;
    expect(isProductionEnv("prod")).toBe(true);
    expect(isProductionEnv("dev")).toBe(false);
    expect(isProductionEnv(undefined)).toBe(true); // env option itself defaults to prod
  });
});

describe("server Engine env-derived egress", () => {
  const original = { se: process.env.SHIPEASY_ENV, node: process.env.NODE_ENV };
  beforeEach(() => {
    delete process.env.SHIPEASY_ENV;
  });
  afterEach(() => {
    process.env.SHIPEASY_ENV = original.se;
    process.env.NODE_ENV = original.node;
    vi.restoreAllMocks();
  });

  it("goes offline by default outside production: init() never fetches", async () => {
    process.env.NODE_ENV = "development";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const engine = new ServerEngine({ apiKey: "k" });
    await engine.init();
    expect(fetchSpy).not.toHaveBeenCalled();
    // track() and see() are no-ops offline too.
    engine.track("u1", "evt");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an explicit isNetworkEnabled:true overrides the non-prod default", async () => {
    process.env.NODE_ENV = "development";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const engine = new ServerEngine({ apiKey: "k", isNetworkEnabled: true });
    await engine.init();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("fetches by default in production", async () => {
    process.env.NODE_ENV = "production";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const engine = new ServerEngine({ apiKey: "k" });
    await engine.init();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("browser Engine env-derived egress", () => {
  const original = { se: process.env.SHIPEASY_ENV, node: process.env.NODE_ENV };
  beforeEach(() => {
    delete process.env.SHIPEASY_ENV;
    delete process.env.NODE_ENV; // browser has no native env — fall back to `env` option
  });
  afterEach(() => {
    process.env.SHIPEASY_ENV = original.se;
    process.env.NODE_ENV = original.node;
    vi.restoreAllMocks();
  });

  it("env:'dev' keeps the browser client offline: identify() never calls /sdk/evaluate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const engine = new BrowserEngine({ sdkKey: "k", env: "dev" });
    await engine.identify({ user_id: "u1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    engine.track("evt");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaults to network on when env is prod (browser default)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ flags: {}, configs: {}, experiments: {}, killswitches: {} }),
          { status: 200 },
        ),
      ),
    );
    const engine = new BrowserEngine({ sdkKey: "k", env: "prod" });
    await engine.identify({ user_id: "u1" });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
