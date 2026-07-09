// Universe-first assignment (the mutual-exclusion pool model, doc 20 §B).
//
// `engine.universe(name).assign(user)` returns an Assignment: the ≤1 experiment
// the unit landed in within the universe, its variant, and resolved params
// (variant override ?? universe default ?? fallback). These specs lock the merge
// (§B2), the not-enrolled defaults path, pooled mutual exclusion (§B4), reserved
// headroom (§B5), and the holdout gate (§B3). They seed the blobs directly (no
// network) the way sdk.test.ts / eval-vectors.test.ts do.

import { describe, it, expect } from "vitest";

import { Engine, _murmur3ForTests, type FlagsBlob, type ExpsBlob } from "../server/index";

const MOD = 10000;
const universeSeg = (universe: string, uid: string) => _murmur3ForTests(`${universe}:${uid}`) % MOD;

function makeEngine(flags: Partial<FlagsBlob>, exps: Partial<ExpsBlob>): Engine {
  const client = new Engine({ apiKey: "test", baseUrl: "http://localhost", disableTelemetry: true });
  (client as unknown as { flagsBlob: FlagsBlob }).flagsBlob = {
    version: "v1",
    plan: "free",
    gates: {},
    configs: {},
    killswitches: {},
    ...flags,
  } as FlagsBlob;
  (client as unknown as { expsBlob: ExpsBlob }).expsBlob = {
    version: "v1",
    universes: {},
    experiments: {},
    ...exps,
  } as ExpsBlob;
  (client as unknown as { initialized: boolean }).initialized = true;
  return client;
}

describe("universe().assign() — param merge (§B2)", () => {
  // A universe owns button_color=red, size=1. The one running experiment's
  // assigned variant overrides only button_color.
  const build = () =>
    makeEngine(
      {},
      {
        universes: {
          u: {
            holdout_range: null,
            param_schema: [
              { name: "button_color", type: "string", default: "red" },
              { name: "size", type: "int", default: 1 },
            ],
          },
        },
        experiments: {
          exp: {
            universe: "u",
            allocationPct: 10000,
            salt: "s",
            status: "running",
            groups: [{ name: "treatment", weight: 10000, params: { button_color: "blue" } }],
          },
        },
      } as unknown as Partial<ExpsBlob>,
    );

  it("variant override wins, unset params inherit the universe default, unknown fields fall back", () => {
    const a = build().universe("u").assign({ user_id: "u1" });
    expect(a.enrolled).toBe(true);
    expect(a.group).toBe("treatment");
    // Overridden by the variant.
    expect(a.get("button_color")).toBe("blue");
    // Not overridden → inherited from the universe default.
    expect(a.get("size")).toBe(1);
    // Absent everywhere → the caller's fallback.
    expect(a.get("missing", "fb")).toBe("fb");
  });
});

describe("universe().assign() — not enrolled still gets universe defaults", () => {
  it("allocationPct 0 → not enrolled, group null, but universe default resolves", () => {
    const engine = makeEngine(
      {},
      {
        universes: {
          u: {
            holdout_range: null,
            param_schema: [{ name: "button_color", type: "string", default: "red" }],
          },
        },
        experiments: {
          exp: {
            universe: "u",
            allocationPct: 0, // nobody allocated
            salt: "s",
            status: "running",
            groups: [{ name: "treatment", weight: 10000, params: { button_color: "blue" } }],
          },
        },
      } as unknown as Partial<ExpsBlob>,
    );
    const a = engine.universe("u").assign({ user_id: "u1" });
    expect(a.enrolled).toBe(false);
    expect(a.group).toBeNull();
    // Not enrolled → universe default, not the variant override.
    expect(a.get("button_color")).toBe("red");
  });
});

describe("universe().assign() — pooled mutual exclusion (§B4)", () => {
  // Two experiments in ONE universe, hashVersion 2, disjoint pool slices:
  //   A = [0, 4000), B = [4000, 8000). Segment >= 8000 is unallocated headroom.
  const engine = makeEngine(
    {},
    {
      universes: { u: { holdout_range: null } },
      experiments: {
        expA: {
          universe: "u",
          hashVersion: 2,
          poolOffsetBp: 0,
          poolSizeBp: 4000,
          allocationPct: 10000,
          salt: "sA",
          status: "running",
          groups: [{ name: "A", weight: 10000, params: {} }],
        },
        expB: {
          universe: "u",
          hashVersion: 2,
          poolOffsetBp: 4000,
          poolSizeBp: 4000,
          allocationPct: 10000,
          salt: "sB",
          status: "running",
          groups: [{ name: "B", weight: 10000, params: {} }],
        },
      },
    } as unknown as Partial<ExpsBlob>,
  );

  it("no unit lands in both; each slice + the free tail all get some units", () => {
    let inA = 0;
    let inB = 0;
    let neither = 0;
    for (let i = 0; i < 400; i++) {
      const uid = `u${i}`;
      const a = engine.universe("u").assign({ user_id: uid });
      // assign returns ≤1 experiment, so double-enrolment is impossible by design;
      // cross-check the landing against the unit's own universe segment.
      const seg = universeSeg("u", uid);
      if (a.name === "expA") {
        inA++;
        expect(seg).toBeLessThan(4000);
      } else if (a.name === "expB") {
        inB++;
        expect(seg).toBeGreaterThanOrEqual(4000);
        expect(seg).toBeLessThan(8000);
      } else {
        neither++;
        expect(a.enrolled).toBe(false);
        expect(seg).toBeGreaterThanOrEqual(8000);
      }
    }
    // The partition is real: all three buckets are populated over 400 users.
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0);
    expect(neither).toBeGreaterThan(0);
    expect(inA + inB + neither).toBe(400);
  });
});

describe("universe().assign() — reserved headroom (§B5)", () => {
  // 100% allocation, groups summing to 5000 with reservedHeadroomBp 5000: units
  // whose group hash falls in the reserved tail are left not-enrolled.
  const engine = makeEngine(
    {},
    {
      universes: { u: { holdout_range: null } },
      experiments: {
        exp: {
          universe: "u",
          allocationPct: 10000,
          reservedHeadroomBp: 5000,
          salt: "s",
          status: "running",
          groups: [{ name: "control", weight: 5000, params: {} }],
        },
      },
    } as unknown as Partial<ExpsBlob>,
  );

  it("a chunk of fully-allocated users still land in the reserved (not-enrolled) tail", () => {
    let enrolled = 0;
    let reserved = 0;
    for (let i = 0; i < 400; i++) {
      const a = engine.universe("u").assign({ user_id: `u${i}` });
      if (a.enrolled) enrolled++;
      else reserved++;
    }
    // Both populated: allocation is 100% yet the reserved tail carves out ~half.
    expect(enrolled).toBeGreaterThan(0);
    expect(reserved).toBeGreaterThan(0);
  });
});

describe("universe().assign() — holdoutGate (§B3)", () => {
  it("a unit for whom the holdout gate passes is held out (not enrolled)", () => {
    const engine = makeEngine(
      {
        gates: {
          // enabled, 100% rollout, no rules → passes for every identified unit.
          hg: { rules: [], rolloutPct: 10000, salt: "hg", enabled: 1 },
        },
      } as unknown as Partial<FlagsBlob>,
      {
        universes: { u: { holdout_range: null } },
        experiments: {
          exp: {
            universe: "u",
            holdoutGate: "hg",
            allocationPct: 10000,
            salt: "s",
            status: "running",
            groups: [{ name: "treatment", weight: 10000, params: {} }],
          },
        },
      } as unknown as Partial<ExpsBlob>,
    );
    const a = engine.universe("u").assign({ user_id: "u1" });
    expect(a.enrolled).toBe(false);
    expect(a.group).toBeNull();
  });
});

describe("universe().assign() — durable overrides (v3, forced-but-gated)", () => {
  // An experiment allocated 0% (nobody enrolls naturally) with an ID override for
  // one unit + a cohort override keyed on a gate. Proves the override is what
  // enrolls, and that gates still filter forced units.
  const pass = { rules: [], rolloutPct: 10000, salt: "g", enabled: 1 as const };
  const fail = { rules: [], rolloutPct: 0, salt: "g", enabled: 1 as const };
  const build = (gates: Record<string, unknown>, expExtra: Record<string, unknown>) =>
    makeEngine(
      { gates } as never,
      {
        universes: { u: { holdout_range: null } },
        experiments: {
          exp: {
            universe: "u",
            allocationPct: 0, // nobody enrolls naturally
            salt: "s",
            status: "running",
            groups: [
              { name: "control", weight: 5000, params: { c: "A" } },
              { name: "treatment", weight: 5000, params: { c: "B" } },
            ],
            ...expExtra,
          },
        },
      } as never,
    );

  it("ID override forces the group despite 0% allocation", () => {
    const e = build({}, { idOverrides: { forced_unit: "treatment" } });
    expect(e.universe("u").assign({ user_id: "someone_else" }).enrolled).toBe(false);
    const a = e.universe("u").assign({ user_id: "forced_unit" });
    expect(a.group).toBe("treatment");
    expect(a.get("c")).toBe("B");
  });

  it("ID override is forced-but-gated: a failing targeting gate → not enrolled", () => {
    const e = build({ beta: fail }, { targetingGate: "beta", idOverrides: { forced_unit: "treatment" } });
    expect(e.universe("u").assign({ user_id: "forced_unit" }).enrolled).toBe(false);
  });

  it("ID override is forced-but-gated: a passing targeting gate → forced group", () => {
    const e = build({ beta: pass }, { targetingGate: "beta", idOverrides: { forced_unit: "treatment" } });
    expect(e.universe("u").assign({ user_id: "forced_unit" }).group).toBe("treatment");
  });

  it("cohort/GK override forces the group when its gate passes, not when it fails", () => {
    const passing = build({ vip: pass }, { cohortOverrides: [{ gate: "vip", group: "treatment", priority: 0 }] });
    expect(passing.universe("u").assign({ user_id: "anyone" }).group).toBe("treatment");
    const failing = build({ vip: fail }, { cohortOverrides: [{ gate: "vip", group: "treatment", priority: 0 }] });
    expect(failing.universe("u").assign({ user_id: "anyone" }).enrolled).toBe(false);
  });

  it("ID override (tier 1) beats a matching cohort override (tier 2)", () => {
    const e = build(
      { vip: pass },
      { idOverrides: { forced_unit: "control" }, cohortOverrides: [{ gate: "vip", group: "treatment", priority: 0 }] },
    );
    expect(e.universe("u").assign({ user_id: "forced_unit" }).group).toBe("control");
  });
});
