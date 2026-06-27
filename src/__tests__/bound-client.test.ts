// Tests for the top-level `configure()` + user-bound `new Client(user)` API
// (the ergonomic front door added in 6.0.0 alongside the FlagsClient(Browser)
// -> Engine rename). Covers BOTH entrypoints:
//   - server (@shipeasy/sdk/server): synchronous eval against the local blob.
//   - browser (@shipeasy/sdk/client): single-user, identify() under the hood.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- server entry ----

import {
  configure as serverConfigure,
  Client as ServerClient,
  Engine as ServerEngine,
  _resetShipeasyServerForTests,
  _resetConfigureForTests as _resetServerConfigure,
  type FlagsBlob,
} from "../server/index";

// A blob with one gate that is fully rolled out only for plan === "pro".
function proGateBlob(): FlagsBlob {
  return {
    version: "1",
    plan: "free",
    gates: {
      pro_only: {
        rules: [{ attr: "plan", op: "eq", value: "pro" }],
        rolloutPct: 10000,
        salt: "s",
        enabled: 1,
      },
    },
    configs: {},
    killswitches: {},
  } as FlagsBlob;
}

describe("server configure() + new Client(user)", () => {
  beforeEach(() => {
    _resetShipeasyServerForTests();
    _resetServerConfigure();
  });
  afterEach(() => {
    _resetShipeasyServerForTests();
    _resetServerConfigure();
  });

  it("configure({apiKey}) then new Client(user).getFlag works", () => {
    // testMode keeps it network-free; seed the engine via initialBlob.
    serverConfigure({ apiKey: "k", testMode: true, initialBlob: proGateBlob() });
    const flags = new ServerClient({ user_id: "u1", plan: "pro" });
    expect(flags.getFlag("pro_only")).toBe(true);
    const free = new ServerClient({ user_id: "u2", plan: "free" });
    expect(free.getFlag("pro_only")).toBe(false);
  });

  it("applies the attributes transform to the raw user object", () => {
    serverConfigure({
      apiKey: "k",
      testMode: true,
      initialBlob: proGateBlob(),
      // Map a custom user shape into the targeting attribute bag.
      attributes: (u: { id: string; tier: string }) => ({ user_id: u.id, plan: u.tier }),
    });
    const flags = new ServerClient({ id: "u1", tier: "pro" });
    // The transform mapped tier -> plan, so the pro_only gate matches.
    expect(flags.attributes).toEqual({ user_id: "u1", plan: "pro" });
    expect(flags.getFlag("pro_only")).toBe(true);
  });

  it("identity transform uses the user object verbatim when none configured", () => {
    serverConfigure({ apiKey: "k", testMode: true, initialBlob: proGateBlob() });
    const flags = new ServerClient({ user_id: "u1", plan: "pro" });
    expect(flags.attributes).toEqual({ user_id: "u1", plan: "pro" });
  });

  it("returns the configured Engine", () => {
    const engine = serverConfigure({ apiKey: "k", testMode: true });
    expect(engine).toBeInstanceOf(ServerEngine);
  });

  it("constructing Client before configure() throws loudly", () => {
    expect(() => new ServerClient({ user_id: "u1" })).toThrowError(
      /new Client\(user\) called before configure/,
    );
  });

  it("Client.getConfig / getKillswitch forward to the engine", () => {
    const engine = serverConfigure({ apiKey: "k", testMode: true });
    engine.overrideConfig("hero", { variant: "b" });
    const flags = new ServerClient({ user_id: "u1" });
    expect(flags.getConfig("hero")).toEqual({ variant: "b" });
    expect(flags.getKillswitch("missing")).toBe(false);
  });

  it("Client.track derives the user_id from the bound attributes and forwards to Engine.track", () => {
    const engine = serverConfigure({ apiKey: "k", testMode: true });
    const spy = vi.spyOn(engine, "track");
    const flags = new ServerClient({ user_id: "u1", plan: "pro" });
    flags.track("purchase", { value: 42 });
    expect(spy).toHaveBeenCalledWith("u1", "purchase", { value: 42 });
  });

  it("Client.track falls back to anonymous_id when no user_id is bound", () => {
    const engine = serverConfigure({ apiKey: "k", testMode: true });
    const spy = vi.spyOn(engine, "track");
    const flags = new ServerClient({ anonymous_id: "anon-9" });
    flags.track("signup");
    expect(spy).toHaveBeenCalledWith("anon-9", "signup", undefined);
  });

  it("Client.logExposure forwards the bound attribute bag to Engine.logExposure", () => {
    const engine = serverConfigure({ apiKey: "k", testMode: true });
    const spy = vi.spyOn(engine, "logExposure");
    const flags = new ServerClient({ user_id: "u1", plan: "pro" });
    flags.logExposure("price_test");
    expect(spy).toHaveBeenCalledWith({ user_id: "u1", plan: "pro" }, "price_test");
  });
});

// ---- browser entry ----

describe("browser configure() + new Client(user)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { search: "", pathname: "/", protocol: "https:" },
      screen: { width: 1024, height: 768 },
    });
    vi.stubGlobal("navigator", { language: "en-US", userAgent: "test-ua" });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: "visible",
      cookie: "",
      createElement: () => ({ setAttribute: vi.fn() }),
      querySelector: () => null,
      head: { appendChild: vi.fn() },
    });
    vi.stubGlobal("setInterval", () => 1);
    vi.stubGlobal("clearInterval", () => {});
    vi.stubGlobal("PerformanceObserver", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("configure({clientKey}) then new Client(user).getFlag works (testMode)", async () => {
    const sdk = await import("../client/index");
    sdk._resetShipeasyForTests();
    sdk._resetConfigureForTests();
    // Build a test-mode engine directly so identify() never hits the network,
    // then register it as the singleton + the attributes transform.
    sdk.configureShipeasy({ sdkKey: "", testMode: true, autoGuardrails: false });
    sdk._resetConfigureForTests();
    const engine = sdk.getShipeasyClient()!;
    engine.overrideFlag("new_checkout", true);

    const flags = new sdk.Client({ user_id: "u1", plan: "pro" });
    await flags.ready();
    expect(flags.getFlag("new_checkout")).toBe(true);
    expect(flags.attributes).toEqual({ user_id: "u1", plan: "pro" });
  });

  it("applies the attributes transform in the browser Client", async () => {
    const sdk = await import("../client/index");
    sdk._resetShipeasyForTests();
    sdk._resetConfigureForTests();
    sdk.configureShipeasy({ sdkKey: "", testMode: true, autoGuardrails: false });
    // Register a transform via the public configure() path. We pass autoIdentify
    // false and a test-mode engine is already the singleton, so configure reuses it.
    const transform = (u: { id: string; tier: string }) => ({ user_id: u.id, plan: u.tier });
    // Manually install the transform by going through configure(); the singleton
    // is reused (first-config-wins) so no network identify fires.
    sdk.configure({ clientKey: "", attributes: transform, autoIdentify: false });

    const flags = new sdk.Client({ id: "u1", tier: "pro" });
    await flags.ready();
    expect(flags.attributes).toEqual({ user_id: "u1", plan: "pro" });
  });

  it("constructing browser Client before configure() throws loudly", async () => {
    const sdk = await import("../client/index");
    sdk._resetShipeasyForTests();
    sdk._resetConfigureForTests();
    expect(() => new sdk.Client({ user_id: "u1" })).toThrowError(
      /new Client\(user\) called before configure/,
    );
  });

  it("Client.track / logExposure forward to the engine for the identified user", async () => {
    const sdk = await import("../client/index");
    sdk._resetShipeasyForTests();
    sdk._resetConfigureForTests();
    sdk.configureShipeasy({ sdkKey: "", testMode: true, autoGuardrails: false });
    sdk._resetConfigureForTests();
    const engine = sdk.getShipeasyClient()!;
    const trackSpy = vi.spyOn(engine, "track");
    const exposureSpy = vi.spyOn(engine, "logExposure");

    const flags = new sdk.Client({ user_id: "u1", plan: "pro" });
    await flags.ready();
    // Browser Engine.track is (event, props?) — no user arg; the engine already
    // knows the identified visitor.
    flags.track("purchase", { value: 42 });
    expect(trackSpy).toHaveBeenCalledWith("purchase", { value: 42 });
    flags.logExposure("price_test");
    expect(exposureSpy).toHaveBeenCalledWith("price_test");
  });
});
