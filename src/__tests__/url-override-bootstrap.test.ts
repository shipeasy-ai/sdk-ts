import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../server";

// A `?se_gate_` / `?se_ks_` URL override must force a gate on a page the server
// bootstrapped, not just on a keyless one. Before this, flags.get answered from
// `__SE_BOOTSTRAP` first, so the override link did nothing in prod while
// passing every keyless e2e, and the server ignored the `se_gate_` alias the
// browser and the devtools docs both accept.

describe("server bootstrap: gate URL overrides", () => {
  const engine = () =>
    Engine.forTesting({
      initialBlob: {
        version: "t",
        plan: "free",
        gates: {
          signup_intent_page: { rules: [], rolloutPct: 0, salt: "s", enabled: 1 },
        },
        configs: {},
        killswitches: {},
      },
    });

  it.each(["se_ks_", "se_gate_", "se-gate-"])("applies the %s prefix to the bootstrap flags", (p) => {
    const boot = engine().evaluate({ anonymous_id: "u" }, `?mode=signup&${p}signup_intent_page=true`);
    expect(boot.flags.signup_intent_page).toBe(true);
  });

  it("leaves the evaluated value alone without an override", () => {
    const boot = engine().evaluate({ anonymous_id: "u" }, "?mode=signup");
    expect(boot.flags.signup_intent_page).toBe(false);
  });
});

describe("browser flags.get: URL override vs SSR bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { search: "?se_gate_signup_intent_page=true", pathname: "/auth/signin" },
      screen: { width: 1024, height: 768 },
      __SE_BOOTSTRAP: {
        flags: { signup_intent_page: false, other_gate: true },
        configs: {},
        experiments: {},
        killswitches: {},
      },
    });
    vi.stubGlobal("navigator", { language: "en-US", userAgent: "test-ua" });
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("setInterval", () => 1);
    vi.stubGlobal("PerformanceObserver", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the bootstrap value until hydration, then lets the override win", async () => {
    const sdk = await import("../client/index");
    expect(sdk.flags.get("signup_intent_page")).toBe(false);
    sdk.flags.notifyMounted();
    expect(sdk.flags.get("signup_intent_page")).toBe(true);
    // Gates the URL does not name still read from the bootstrap.
    expect(sdk.flags.get("other_gate")).toBe(true);
  });

  it("lets the override win with a configured client too, and a programmatic override above it", async () => {
    const sdk = await import("../client/index");
    const engine = sdk.configureShipeasy({ sdkKey: "k" });
    sdk.flags.notifyMounted();
    expect(sdk.flags.get("signup_intent_page")).toBe(true);
    engine.overrideFlag("signup_intent_page", false);
    expect(sdk.flags.get("signup_intent_page")).toBe(false);
    engine.overrideFlag("other_gate", false);
    expect(sdk.flags.get("other_gate")).toBe(false);
    sdk._resetShipeasyForTests();
  });
});
