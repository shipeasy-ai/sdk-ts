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
  it("seeds flags/configs read through new Client(user)", () => {
    configureForTesting({
      flags: { new_checkout: true },
      configs: { theme: { color: "blue" } },
    });
    const c = new Client({ user_id: "u_1" });
    expect(c.getFlag("new_checkout")).toBe(true);
    expect(c.getConfig("theme")).toEqual({ color: "blue" });
  });

  it("an experiment override surfaces through universe().assign() when the experiment exists in the universe", () => {
    // Overrides refine an experiment that lives in a universe — they don't invent
    // one in an empty universe. Seed a real (offline) experiment in universe
    // `pricing`, then force the enrolment with overrideExperiment.
    configureForOffline({
      snapshot: {
        flags: { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {} },
        experiments: {
          version: "t",
          universes: { pricing: { holdout_range: null } },
          experiments: {
            price_test: {
              universe: "pricing",
              allocationPct: 10000,
              salt: "s",
              status: "running",
              groups: [{ name: "control", weight: 10000, params: { price: 0 } }],
            },
          } as unknown as ExpsBlob["experiments"],
        },
      },
      experiments: { price_test: ["treatment", { price: 9 }] },
    });
    const c = new Client({ user_id: "u_1" });
    const exp = c.universe("pricing").assign();
    expect(exp.enrolled).toBe(true);
    expect(exp.group).toBe("treatment");
    expect(exp.get("price")).toBe(9);
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
    // Seed a real experiment `e` in universe `u` so the experiment override is
    // reachable via universe().assign(); flags/configs still ride the empty blob.
    configureForOffline({
      snapshot: {
        flags: { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {} },
        experiments: {
          version: "t",
          universes: { u: { holdout_range: null } },
          experiments: {
            e: {
              universe: "u",
              allocationPct: 10000,
              salt: "s",
              status: "running",
              groups: [{ name: "A", weight: 10000, params: { v: 1 } }],
            },
          } as unknown as ExpsBlob["experiments"],
        },
      },
      flags: { f: true },
    });
    overrideFlag("f", false);
    overrideConfig("c", 123);
    overrideExperiment("e", "B", { v: 2 });
    const c = new Client({ user_id: "u" });
    expect(c.getFlag("f")).toBe(false);
    expect(c.getConfig("c")).toBe(123);
    expect(c.universe("u").assign().group).toBe("B");

    // clearOverrides drops the override layer; flags/configs revert to the (empty)
    // snapshot, and the experiment reverts to its real assignment (group A).
    clearOverrides();
    expect(new Client({}).getFlag("f")).toBe(false);
    expect(new Client({}).getConfig("c")).toBeUndefined();
    expect(new Client({ user_id: "u" }).universe("u").assign().group).toBe("A");
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
