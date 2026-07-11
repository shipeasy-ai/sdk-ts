// Engine ⇄ devtools bridge — the globalThis accessor the overlays read live
// values / the identified user / the override store through, plus the
// structured event feed. Uses Engine.forTesting() (offline, no network).

import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../client";
import { ENGINE_BRIDGE_KEY, readEngineBridge, watchEngineBridge } from "../devtools/bridge";
import type { DevtoolsStateEvent } from "../devtools/bridge";

function freshBridge() {
  const engine = Engine.forTesting();
  const bridge = readEngineBridge();
  if (!bridge) throw new Error("engine did not publish the bridge");
  return { engine, bridge };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ENGINE_BRIDGE_KEY];
});

describe("engine devtools bridge", () => {
  it("is published on globalThis at construction", () => {
    expect(readEngineBridge()).toBeNull();
    Engine.forTesting();
    expect(readEngineBridge()).not.toBeNull();
  });

  it("applies flag overrides live and notifies subscribers", () => {
    const { engine, bridge } = freshBridge();
    expect(engine.getFlag("new_checkout")).toBe(false);

    const listener = vi.fn();
    const unsub = bridge.subscribe(listener);
    bridge.setFlagOverride("new_checkout", true);

    expect(engine.getFlag("new_checkout")).toBe(true);
    expect(bridge.getFlag("new_checkout")).toBe(true);
    expect(engine.getFlagDetail("new_checkout").reason).toBe("OVERRIDE");
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("removeOverride restores a single entity; clearOverrides nukes all", () => {
    const { bridge } = freshBridge();
    bridge.setFlagOverride("a", true);
    bridge.setFlagOverride("b", false);
    bridge.setConfigOverride("cfg", { x: 1 });
    bridge.setExperimentOverride("exp", "variant_b");

    expect(bridge.getOverrides()).toEqual({
      flags: { a: true, b: false },
      configs: { cfg: { x: 1 } },
      experiments: { exp: "variant_b" },
    });

    bridge.removeOverride("flag", "a");
    expect(bridge.getOverrides().flags).toEqual({ b: false });
    expect(bridge.getOverrides().configs).toEqual({ cfg: { x: 1 } });

    bridge.clearOverrides();
    expect(bridge.getOverrides()).toEqual({ flags: {}, configs: {}, experiments: {} });
  });

  it("config overrides win in getConfig", () => {
    const { engine, bridge } = freshBridge();
    bridge.setConfigOverride("pricing.tiers", { tier: "pro" });
    expect(engine.getConfig("pricing.tiers")).toEqual({ tier: "pro" });
    expect(bridge.getConfig("pricing.tiers")).toEqual({ tier: "pro" });
  });

  it("forcing a variant delivers that variant's params over the universe defaults", () => {
    const { engine, bridge } = freshBridge();
    // Seed a universe with defaults + an experiment mapped to it (the shape
    // /sdk/evaluate returns), so universe().assign() can resolve the override.
    engine.initFromBootstrap({
      flags: {},
      configs: {},
      experiments: { paywall: { inExperiment: false, group: "control", params: {}, universe: "u" } },
      universes: { u: { defaults: { headline: "Default", cta: "Start" } } },
    });

    // Force variant_a with its own param override map (headline only).
    bridge.setExperimentOverride("paywall", "variant_a", { headline: "Do more with Pro" });

    const a = engine.universe("u").assign({ logExposure: false });
    expect(a.group).toBe("variant_a");
    // The variant's value wins…
    expect(a.get("headline")).toBe("Do more with Pro");
    // …and unset params still inherit the universe default.
    expect(a.get("cta")).toBe("Start");
  });

  it("captures the identify() payload for the User panel (offline mode)", async () => {
    const { bridge } = freshBridge();
    expect(bridge.getUser()).toBeNull();
    await bridge.identify({ user_id: "u_1", plan: "pro" });
    expect(bridge.getUser()).toMatchObject({ user_id: "u_1", plan: "pro" });
  });

  it("streams override mutations into the event feed", () => {
    const { bridge } = freshBridge();
    const events: DevtoolsStateEvent[] = [];
    const unsub = bridge.onEvent((e) => events.push(e));

    bridge.setFlagOverride("gate_x", true);
    bridge.setExperimentOverride("exp_y", "treatment");
    bridge.removeOverride("experiment", "exp_y");
    bridge.clearOverrides();

    expect(events.map((e) => [e.kind, e.subject, e.value])).toEqual([
      ["override", "gate gate_x", "true"],
      ["override", "experiment exp_y", "treatment"],
      ["override", "experiment exp_y", "restored"],
      ["override", "overrides", "cleared"],
    ]);

    unsub();
    bridge.setFlagOverride("gate_z", false);
    expect(events).toHaveLength(4); // unsubscribed — no further deliveries
  });

  it("watchEngineBridge attaches late when the client configures after the overlay", () => {
    vi.useFakeTimers();
    try {
      const listener = vi.fn();
      const unsub = watchEngineBridge(listener); // no bridge yet — polls
      Engine.forTesting();
      vi.advanceTimersByTime(1100); // 1 Hz poll finds the bridge
      expect(listener).toHaveBeenCalled();

      const bridge = readEngineBridge();
      listener.mockClear();
      bridge!.setFlagOverride("late", true);
      expect(listener).toHaveBeenCalled(); // now subscribed for real
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });
});
