import { describe, expect, it } from "vitest";
import {
  buildGateFlow,
  evalRule,
  evalStepMatch,
  ruleSummary,
} from "../devtools/gate-flow";
import type { GateRecord } from "../devtools/types";

const base: GateRecord = {
  id: "g1",
  name: "checkout_v2",
  enabled: true,
  killswitch: false,
  rolloutPct: 0,
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("buildGateFlow", () => {
  it("normalizes a stacked gate top-to-bottom with a public floor", () => {
    const steps = buildGateFlow({
      ...base,
      stack: [
        { id: "s1", type: "condition", name: "Business plans", rules: [{ attr: "plan", op: "in", value: ["business"] }] },
        { id: "s2", type: "rollout", rolloutPct: 2500, locked: true },
      ],
    });
    expect(steps.map((s) => s.title)).toEqual(["Business plans", "Public"]);
    expect(steps[0].source).toBe("user");
    expect(steps[0].rolloutPct).toBe(10000); // condition admits everyone who matches
    expect(steps[1].isPublicFloor).toBe(true);
    expect(steps[1].rolloutPct).toBe(2500);
  });

  it("colours request-derived attrs as an auto source", () => {
    const [step] = buildGateFlow({
      ...base,
      stack: [{ id: "s1", type: "condition", rules: [{ attr: "country", op: "in", value: ["US"] }] }],
    });
    expect(step.source).toBe("auto");
  });

  it("falls back to flat rules + rolloutPct when there is no stack", () => {
    const steps = buildGateFlow({
      ...base,
      rolloutPct: 5000,
      rules: [{ attr: "email", op: "contains", value: "@acme" }],
    });
    expect(steps.map((s) => s.type)).toEqual(["condition", "rollout"]);
    expect(steps[1].rolloutPct).toBe(5000);
    expect(steps[1].isPublicFloor).toBe(true);
  });

  it("extracts whitelist identities from the first rule value", () => {
    const [step] = buildGateFlow({
      ...base,
      stack: [{ id: "w", type: "condition", whitelist: true, rules: [{ attr: "user_id", op: "in", value: ["u1", "u2"] }] }],
    });
    expect(step.source).toBe("whitelist");
    expect(step.whitelist).toEqual(["u1", "u2"]);
  });
});

describe("evalRule", () => {
  const user = { plan: "business", country: "US", age: 30, version: "2.4.1", email: "a@acme.io" };
  it("handles equality + membership", () => {
    expect(evalRule({ attr: "plan", op: "eq", value: "business" }, user)).toBe(true);
    expect(evalRule({ attr: "plan", op: "neq", value: "free" }, user)).toBe(true);
    expect(evalRule({ attr: "country", op: "in", value: ["US", "CA"] }, user)).toBe(true);
    expect(evalRule({ attr: "country", op: "not_in", value: ["US"] }, user)).toBe(false);
  });
  it("handles numeric + semver + contains + regex", () => {
    expect(evalRule({ attr: "age", op: "gte", value: 18 }, user)).toBe(true);
    expect(evalRule({ attr: "age", op: "lt", value: 18 }, user)).toBe(false);
    expect(evalRule({ attr: "version", op: "semver_gte", value: "2.4.0" }, user)).toBe(true);
    expect(evalRule({ attr: "version", op: "semver_gt", value: "2.5.0" }, user)).toBe(false);
    expect(evalRule({ attr: "email", op: "contains", value: "@acme" }, user)).toBe(true);
    expect(evalRule({ attr: "email", op: "regex", value: "^a@" }, user)).toBe(true);
  });
  it("treats a missing attribute as not-in-set", () => {
    expect(evalRule({ attr: "missing", op: "eq", value: "x" }, user)).toBe(false);
    expect(evalRule({ attr: "missing", op: "neq", value: "x" }, user)).toBe(true);
    expect(evalRule({ attr: "missing", op: "not_in", value: ["x"] }, user)).toBe(true);
  });
});

describe("evalStepMatch", () => {
  const gate: GateRecord = {
    ...base,
    stack: [
      { id: "s1", type: "condition", rules: [{ attr: "plan", op: "in", value: ["business"] }, { attr: "country", op: "eq", value: "US" }] },
      { id: "s2", type: "rollout", rolloutPct: 2500, locked: true },
    ],
  };
  const [cond, floor] = buildGateFlow(gate);

  it("passes when all rules match (default all)", () => {
    expect(evalStepMatch(cond, { plan: "business", country: "US" })).toBe("pass");
  });
  it("fails when one rule misses under all-mode", () => {
    expect(evalStepMatch(cond, { plan: "business", country: "CA" })).toBe("fail");
  });
  it("passes under any-mode when one rule matches", () => {
    expect(evalStepMatch(cond, { plan: "business", country: "CA" }, "any")).toBe("pass");
  });
  it("returns n/a for rollout / public steps and null users", () => {
    expect(evalStepMatch(floor, { plan: "business" })).toBe("n/a");
    expect(evalStepMatch(cond, null)).toBe("n/a");
  });
});

describe("ruleSummary", () => {
  it("renders operator labels", () => {
    const [step] = buildGateFlow({
      ...base,
      stack: [{ id: "s1", type: "condition", rules: [{ attr: "plan", op: "in", value: ["business", "team"] }] }],
    });
    expect(ruleSummary(step)).toBe("plan is one of business, team");
  });
});
