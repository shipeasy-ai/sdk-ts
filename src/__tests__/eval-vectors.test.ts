// Cross-language eval-parity golden-vector test.
//
// Locks this SDK's inline bucketing (murmur3 + gate eval + experiment eval in
// src/server/index.ts) to the canonical fixture owned by packages/core. Every
// Shipeasy SDK that reimplements bucketing must reproduce the SAME vectors, so
// this guards against silent drift from the platform's canonical implementation.
//
// The fixture is COPIED byte-identically from
//   packages/core/src/eval/__fixtures__/eval-vectors.json
// into ./fixtures/eval-vectors.json — never edit the copy; re-vendor it.
//
// Gate + experiment eval are reached the same way sdk.test.ts reaches them:
// construct a FlagsClient and inject the flags/experiments blobs directly (no
// network), then drive the public getFlag/getExperiment surface. The inline
// murmur3 has no public seam (the existing test only probes it at two
// allocation boundaries), so a narrow test-only export `_murmur3ForTests` is
// used to assert the raw unsigned-32-bit hash table directly.

import { describe, it, expect } from "vitest";

import { FlagsClient, _murmur3ForTests, type User } from "../server/index";
import vectors from "./fixtures/eval-vectors.json";

const MOD = vectors.bucketModulo; // 10000

// ---- Fixture types (structural — the JSON is the source of truth) ----

interface HashVector {
  input: string;
  hash: number;
}

interface GateRule {
  attr: string;
  op: string;
  value: unknown;
}

interface GateVector {
  note: string;
  gate: { enabled: boolean; rules: GateRule[]; rolloutPct: number; salt: string };
  user: User;
  pass: boolean;
}

interface ExperimentVector {
  note: string;
  experiment: {
    universe: string;
    targetingGate?: string;
    allocationPct: number;
    salt: string;
    groups: { name: string; weight: number; params: Record<string, unknown> }[];
    status: string;
  };
  user: User;
  flags: Record<string, boolean>;
  holdoutRange: [number, number] | null;
  result: { inExperiment: boolean; group: string | null };
}

// ---- Construct a FlagsClient with directly-injected blobs (no network) ----
// Mirrors sdk.test.ts makeClient(): bypass fetch by setting the private fields.
function makeClient(flagsBlob: object, expsBlob: object): FlagsClient {
  const client = new FlagsClient({ apiKey: "test", baseUrl: "http://localhost" });
  (client as unknown as { flagsBlob: unknown }).flagsBlob = {
    version: "v1",
    plan: "free",
    configs: {},
    killswitches: {},
    ...flagsBlob,
  };
  (client as unknown as { expsBlob: unknown }).expsBlob = {
    version: "v1",
    universes: {},
    experiments: {},
    ...expsBlob,
  };
  (client as unknown as { initialized: boolean }).initialized = true;
  return client;
}

// Synthesize a gate that evaluates to a fixed boolean for ANY user, used to
// reproduce the fixture's pre-computed `flags[targetingGate]` map (the fixture
// states the targeting-gate outcome directly; this SDK evaluates it from the
// gates blob, so we build a gate whose verdict matches). rolloutPct 0 → always
// false; enabled + 100% + no rules → true for any unit with an identity.
function constantGate(value: boolean) {
  return { rules: [], rolloutPct: value ? MOD : 0, salt: "tg", enabled: 1 as const };
}

describe("eval-parity golden vectors — murmur3 hash (unsigned 32-bit)", () => {
  const hashVectors = vectors.hash as HashVector[];

  it("has hash vectors to assert", () => {
    expect(hashVectors.length).toBeGreaterThan(0);
  });

  for (const v of hashVectors) {
    it(`murmur3(${JSON.stringify(v.input)}) === ${v.hash}`, () => {
      const got = _murmur3ForTests(v.input);
      // Must be an unsigned 32-bit integer matching the canonical value exactly.
      expect(got).toBe(v.hash);
      expect(got >>> 0).toBe(got);
    });
  }
});

describe("eval-parity golden vectors — gate evaluation", () => {
  const gateVectors = vectors.gate as GateVector[];

  it("has gate vectors to assert", () => {
    expect(gateVectors.length).toBeGreaterThan(0);
  });

  // KNOWN, DELIBERATE DIVERGENCE from the canonical platform eval.
  //
  // Canonical packages/core/src/eval/gate.ts denies ANY gate when there is no
  // unit id (`if (!uid) return false`) — before the rollout check — so the
  // fixture's "no identity → cannot bucket → false" vector expects `false`
  // even at 100% rollout.
  //
  // This SDK INTENTIONALLY answers a fully-rolled gate `true` for an
  // unidentified unit: `evalGateInternal` does `if (!uid) return rolloutPct >=
  // 10000`. Shipped in @shipeasy/sdk 4.4.0 (commit d00cda9) so a 100%-rollout
  // gate applies during SSR before an `__se_anon_id` is minted (rules are still
  // checked first; fractional rollouts still need a unit). See
  // experiment-platform/18-identity-bucketing.md and the matching assertion in
  // sdk.test.ts ("no unit id + rollout=10000 → true").
  //
  // We do NOT fudge the parity assertion: for this one vector we assert the
  // SDK's ACTUAL (divergent) output and pin the cause. If either side changes
  // (core starts honouring 100% with no unit, OR this SDK drops the
  // short-circuit) this test goes red and forces a deliberate reconciliation.
  function isNoIdentityFullRollout(v: GateVector): boolean {
    const u = v.user.user_id ?? v.user.anonymous_id;
    return (
      !u &&
      v.gate.enabled === true &&
      (v.gate.rules?.length ?? 0) === 0 &&
      v.gate.rolloutPct >= MOD
    );
  }

  for (const v of gateVectors) {
    it(`gate: ${v.note}`, () => {
      // The fixture's `enabled` is a real boolean; the SDK Gate accepts boolean.
      const client = makeClient(
        { gates: { g: v.gate } },
        { universes: {}, experiments: {} },
      );
      const got = client.getFlag("g", v.user);

      if (isNoIdentityFullRollout(v)) {
        // DIVERGENCE: canonical fixture says false; this SDK says true (4.4.0
        // SSR-anon behavior). Assert the SDK's real output, not the fixture's.
        expect(v.pass).toBe(false); // fixture's canonical expectation
        expect(got).toBe(true); // this SDK's deliberate divergence
        return;
      }

      expect(got).toBe(v.pass);
    });
  }
});

describe("eval-parity golden vectors — experiment evaluation", () => {
  const expVectors = vectors.experiment as ExperimentVector[];

  it("has experiment vectors to assert", () => {
    expect(expVectors.length).toBeGreaterThan(0);
  });

  for (const v of expVectors) {
    it(`experiment: ${v.note}`, () => {
      // Reproduce the targeting-gate outcome the fixture states directly.
      const gates: Record<string, object> = {};
      const tg = v.experiment.targetingGate;
      if (tg) gates[tg] = constantGate(v.flags[tg] ?? false);

      const universes: Record<string, { holdout_range: [number, number] | null }> = {
        [v.experiment.universe]: { holdout_range: v.holdoutRange },
      };

      const client = makeClient(
        { gates },
        { universes, experiments: { exp: v.experiment } },
      );

      // defaultParams sentinel so we can confirm it's returned only when NOT in.
      const SENTINEL = { __se_default: true };
      const result = client.getExperiment("exp", v.user, SENTINEL);

      expect(result.inExperiment).toBe(v.result.inExperiment);
      if (v.result.inExperiment) {
        // Assigned: group must match the canonical group exactly.
        expect(result.group).toBe(v.result.group);
        // And the returned params are the assigned group's params, not the default.
        const assigned = v.experiment.groups.find((gr) => gr.name === v.result.group);
        expect(result.params).toEqual(assigned?.params);
      } else {
        // Not assigned: the SDK returns the caller's default params untouched.
        expect(result.params).toEqual(SENTINEL);
      }
    });
  }
});
