// Gatekeeper `stack` evaluation in the server SDK.
//
// Regression guard for the bug where evalGateInternal read only the flat
// `rules`+`rolloutPct` columns and ignored a modern gate's ordered `stack`. The
// canonical model is the stack (mirrors @shipeasy/core evalGatekeeper + the edge
// worker); the flat columns are a lossy approximation that can invert the result
// (a whitelist condition at 100% followed by a 0% public rollout flattens to
// `rolloutPct: 0`). These vectors lock the SDK to the stack.

import { describe, it, expect } from "vitest";

import { Engine, type User } from "../server/index";

const MOD = 10000;

// Construct an Engine with a directly-injected flags blob (no network) — mirrors
// eval-vectors.test.ts / sdk.test.ts.
function makeClient(gates: Record<string, unknown>): Engine {
  const client = new Engine({ apiKey: "test", baseUrl: "http://localhost" });
  (client as unknown as { flagsBlob: unknown }).flagsBlob = {
    version: "v1",
    plan: "free",
    gates,
    configs: {},
    killswitches: {},
  };
  (client as unknown as { initialized: boolean }).initialized = true;
  return client;
}

const P = "e976b15e-3ccc-44d3-821d-87f06d5a0e43";

// The exact shape the KV rebuild ships for a whitelist gatekeeper: a condition
// (no explicit rolloutPct ⇒ 100%) that whitelists a project, then a locked 0%
// public rollout. The flat columns are the lossy approximation.
function whitelistGate() {
  return {
    name: "release_module",
    enabled: 1,
    salt: "caf3a1ae",
    // Lossy flat approximation — must NOT be what decides the result.
    rules: [{ attr: "project_id", op: "in", value: [P] }],
    rolloutPct: 0,
    stack: [
      {
        id: "gq578snc",
        type: "condition",
        pass: "all",
        rules: [{ attr: "project_id", op: "in", value: [P] }],
      },
      { id: "gu0uein4", type: "rollout", rolloutPct: 0, bucketBy: "user_id", salt: "public" },
    ],
  };
}

describe("gatekeeper stack evaluation", () => {
  it("passes a whitelisted caller even though the flat rolloutPct is 0", () => {
    const client = makeClient({ release_module: whitelistGate() });
    const user: User = { user_id: "cdewqzx@gmail.com", project_id: P };
    // The regression: the flat path would read "matches whitelist AND 0% bucket"
    // = false. The stack short-circuits on the 100% condition → true.
    expect(client.getFlag("release_module", user)).toBe(true);
  });

  it("hides a non-whitelisted caller (condition misses, public rollout is 0%)", () => {
    const client = makeClient({ release_module: whitelistGate() });
    const user: User = { user_id: "someone@else.com", project_id: "other-project" };
    expect(client.getFlag("release_module", user)).toBe(false);
  });

  it("passes a whitelisted caller with no identity (100% condition needs no unit)", () => {
    const client = makeClient({ release_module: whitelistGate() });
    // No user_id/anonymous_id: a fully-rolled bucket is answerable without one.
    expect(client.getFlag("release_module", { project_id: P })).toBe(true);
  });

  it("a matching condition still gates on its own rollout %", () => {
    const gate = {
      name: "g",
      enabled: 1,
      salt: "s",
      rules: [],
      rolloutPct: 0,
      stack: [
        {
          id: "c1",
          type: "condition",
          pass: "all",
          rules: [{ attr: "project_id", op: "in", value: [P] }],
          rolloutPct: 0, // matched but 0% → never
        },
      ],
    };
    const client = makeClient({ g: gate });
    expect(client.getFlag("g", { user_id: "u1", project_id: P })).toBe(false);
  });

  it("supports pass:'any' conditions", () => {
    const gate = {
      name: "g",
      enabled: 1,
      salt: "s",
      rules: [],
      rolloutPct: 0,
      stack: [
        {
          id: "c1",
          type: "condition",
          pass: "any",
          rules: [
            { attr: "plan", op: "eq", value: "pro" },
            { attr: "project_id", op: "in", value: [P] },
          ],
        },
      ],
    };
    const client = makeClient({ g: gate });
    // Neither the plan matches nor... one branch matches → pass.
    expect(client.getFlag("g", { user_id: "u", plan: "free", project_id: P })).toBe(true);
    expect(client.getFlag("g", { user_id: "u", plan: "free", project_id: "x" })).toBe(false);
  });

  it("falls through to a later rollout entry as a catch-all", () => {
    const gate = {
      name: "g",
      enabled: 1,
      salt: "s",
      rules: [],
      rolloutPct: 0,
      stack: [
        {
          id: "c1",
          type: "condition",
          pass: "all",
          rules: [{ attr: "project_id", op: "in", value: [P] }],
        },
        { id: "public", type: "rollout", rolloutPct: MOD }, // everyone else: 100%
      ],
    };
    const client = makeClient({ g: gate });
    expect(client.getFlag("g", { user_id: "u", project_id: "not-whitelisted" })).toBe(true);
  });

  it("a disabled or killed stacked gate is off", () => {
    const base = whitelistGate();
    const disabled = makeClient({ g: { ...base, enabled: 0 } });
    expect(disabled.getFlag("g", { user_id: "u", project_id: P })).toBe(false);
    const killed = makeClient({ g: { ...base, killswitch: 1 } });
    expect(killed.getFlag("g", { user_id: "u", project_id: P })).toBe(false);
  });

  it("a stack-less gate still uses the legacy flat path", () => {
    const client = makeClient({
      on: { name: "on", enabled: 1, salt: "s", rules: [], rolloutPct: MOD },
      off: { name: "off", enabled: 1, salt: "s", rules: [], rolloutPct: 0 },
    });
    expect(client.getFlag("on", { user_id: "u" })).toBe(true);
    expect(client.getFlag("off", { user_id: "u" })).toBe(false);
  });
});
