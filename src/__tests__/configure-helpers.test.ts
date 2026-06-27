// Tests for the doc-23 configure() family + package-level helpers:
//   - configureForTesting / configureForOffline (REPLACE, not first-wins)
//   - overrideFlag/overrideConfig/overrideExperiment/clearOverrides
//   - onChange (requires poll; here we just assert it delegates)
// All Engine-free: read through the bound `new Client(user)`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Client,
  configureForTesting,
  configureForOffline,
  overrideFlag,
  overrideConfig,
  overrideExperiment,
  clearOverrides,
  _resetShipeasyServerForTests,
  _resetConfigureForTests,
  type FlagsBlob,
  type ExpsBlob,
} from "../server/index";

beforeEach(() => {
  _resetShipeasyServerForTests();
  _resetConfigureForTests();
});
afterEach(() => {
  _resetShipeasyServerForTests();
  _resetConfigureForTests();
});

describe("configureForTesting", () => {
  it("seeds flags/configs/experiments read through new Client(user)", () => {
    configureForTesting({
      flags: { new_checkout: true },
      configs: { theme: { color: "blue" } },
      experiments: { price_test: ["treatment", { price: 9 }] },
    });
    const c = new Client({ user_id: "u_1" });
    expect(c.getFlag("new_checkout")).toBe(true);
    expect(c.getConfig("theme")).toEqual({ color: "blue" });
    const exp = c.getExperiment("price_test", { price: 0 });
    expect(exp.inExperiment).toBe(true);
    expect(exp.group).toBe("treatment");
    expect(exp.params).toEqual({ price: 9 });
  });

  it("REPLACES prior config (not first-config-wins)", () => {
    configureForTesting({ flags: { f: true } });
    expect(new Client({}).getFlag("f")).toBe(true);
    configureForTesting({ flags: { f: false } });
    expect(new Client({}).getFlag("f")).toBe(false);
  });

  it("applies the attributes transform", () => {
    configureForTesting({
      attributes: (u: { id: string }) => ({ user_id: u.id }),
      flags: { f: true },
    });
    const c = new Client({ id: "u_42" });
    expect(c.attributes.user_id).toBe("u_42");
  });

  it("an unseeded flag falls back to its default (FLAG_NOT_FOUND, not CLIENT_NOT_READY)", () => {
    configureForTesting({});
    expect(new Client({}).getFlag("missing", true)).toBe(true);
    expect(new Client({}).getFlag("missing")).toBe(false);
  });
});

describe("on-the-spot overrides", () => {
  it("overrideFlag/Config/Experiment win over the seed; clearOverrides drops the seed too", () => {
    configureForTesting({ flags: { f: true } });
    overrideFlag("f", false);
    overrideConfig("c", 123);
    overrideExperiment("e", "B", { v: 2 });
    const c = new Client({ user_id: "u" });
    expect(c.getFlag("f")).toBe(false);
    expect(c.getConfig("c")).toBe(123);
    expect(c.getExperiment("e", {}).group).toBe("B");

    // Under test mode there is no blob beneath, so clearOverrides drops the
    // configureForTesting seed too — everything reverts to empty-blob defaults.
    clearOverrides();
    expect(new Client({}).getFlag("f")).toBe(false);
    expect(new Client({}).getConfig("c")).toBeUndefined();
    expect(new Client({}).getExperiment("e", { d: 1 }).inExperiment).toBe(false);
  });

  it("override helpers throw before any configure*", () => {
    expect(() => overrideFlag("f", true)).toThrow(/before configure/);
  });
});

describe("configureForOffline", () => {
  const flags: FlagsBlob = {
    version: "snap",
    plan: "free",
    gates: {
      // Enabled gate, 100% rollout (rolloutPct is basis points; 10000 = 100%),
      // no rules → evaluates true for everyone.
      on_for_all: {
        rules: [],
        rolloutPct: 10000,
        salt: "s",
        enabled: 1,
      } as unknown as FlagsBlob["gates"][string],
    },
    configs: { color: { value: "green" } } as unknown as FlagsBlob["configs"],
    killswitches: {},
  };
  const experiments: ExpsBlob = { version: "snap", experiments: {}, universes: {} };

  it("evaluates the REAL rules from an in-memory snapshot", () => {
    configureForOffline({ snapshot: { flags, experiments } });
    const c = new Client({ user_id: "u_1" });
    expect(c.getFlag("on_for_all")).toBe(true);
    expect(c.getConfig("color")).toBe("green");
  });

  it("layers overrides on top of the snapshot; clearOverrides reverts to the snapshot", () => {
    configureForOffline({ snapshot: { flags, experiments }, flags: { on_for_all: false } });
    expect(new Client({}).getFlag("on_for_all")).toBe(false);
    clearOverrides();
    expect(new Client({}).getFlag("on_for_all")).toBe(true);
  });

  it("throws without snapshot or path", () => {
    expect(() => configureForOffline({})).toThrow(/snapshot.*path/);
  });
});
