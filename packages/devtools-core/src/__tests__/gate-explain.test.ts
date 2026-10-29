import { describe, expect, it } from "vitest";
import { explainGateFalse } from "../gate-flow";
import type { GateRecord } from "../types";

const base: GateRecord = {
  id: "g1",
  name: "checkout_v2",
  enabled: true,
  killswitch: false,
  rolloutPct: 10000,
  updatedAt: "2026-01-01T00:00:00Z",
};

const biz = { attr: "plan", op: "eq", value: "business" };

describe("explainGateFalse", () => {
  it("returns null while the flag serves true", () => {
    expect(explainGateFalse(base, true, null)).toBeNull();
  });

  it("names a disabled flag even at 100% rollout", () => {
    expect(explainGateFalse({ ...base, enabled: false }, false, { id: "u1" })).toBe(
      "flag is disabled",
    );
  });

  it("explains a flat targeting rule that excludes the user at 100% rollout", () => {
    const g = { ...base, rules: [biz] };
    expect(explainGateFalse(g, false, { plan: "free" })).toBe("targeting: Targeting rules needs plan is business");
    expect(explainGateFalse(g, false, null)).toMatch(/no identified user/);
  });

  it("explains a whitelist-only stack", () => {
    const g = {
      ...base,
      stack: [
        {
          id: "w",
          type: "condition" as const,
          name: "Beta list",
          whitelist: true,
          rules: [{ attr: "email", op: "in", value: ["a@x.com"] }],
        },
        { id: "p", type: "rollout" as const, rolloutPct: 0, locked: true },
      ],
    };
    expect(explainGateFalse(g, false, { email: "b@x.com" })).toBe(
      "stack: user is not on the beta list",
    );
  });

  it("explains a stack whose conditions all fail", () => {
    const g = {
      ...base,
      stack: [
        { id: "c", type: "condition" as const, name: "Business", rules: [biz] },
        { id: "p", type: "rollout" as const, rolloutPct: 0, locked: true },
      ],
    };
    expect(explainGateFalse(g, false, { plan: "free" })).toBe(
      "targeting: Business needs plan is business",
    );
  });

  it("reports a partial public rollout as a bucket miss", () => {
    const g = { ...base, stack: [{ id: "p", type: "rollout" as const, rolloutPct: 2500, locked: true }] };
    expect(explainGateFalse(g, false, { id: "u" })).toBe("rollout: user is outside the 25% bucket");
  });
});
