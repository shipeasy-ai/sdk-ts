// Gate → evaluation-flow normalization + a client-side rule evaluator, shared
// by the devtools overlays. A gate is rendered as an ordered list of "flow
// steps" (a rule set + its own rollout %, checked top-to-bottom, first match
// wins) — the same model the dashboard's read-gate view + hovercard use
// (apps/ui/src/lib/gate-flow.ts). Framework-agnostic: no DOM/React.
//
// The overlay ALSO annotates each condition step with whether the *current*
// identified user passes it — evaluated locally against the identify()
// attributes. This is an approximation of the edge's decision: attribute
// predicates are exact, but rollout bucketing (murmur/salt) is NOT reproduced
// here, so rollout steps carry their % only and the engine's served value
// remains the ground truth.

import type { GateRecord, GateRule, GateStackEntry } from "./types";

export type StepSource = "user" | "auto" | "whitelist" | "public";

/** Whether the current user satisfies a step's predicate. `n/a` = not an
 *  attribute condition (rollout / public floor — outcome comes from the edge). */
export type StepMatch = "pass" | "fail" | "n/a";

export interface GateFlowStep {
  key: string;
  type: "condition" | "rollout";
  title: string;
  rules: GateRule[];
  /** all rules must match ("all", default) vs any ("any"). */
  pass: "all" | "any";
  /** 0–10000 basis points. Conditions with no explicit ramp admit everyone. */
  rolloutPct: number;
  bucketBy: string;
  source: StepSource;
  /** The always-last locked public floor. */
  isPublicFloor: boolean;
  /** Listed identities when the step is a whitelist. */
  whitelist: string[] | null;
}

// Request-derived attributes render as an "auto" source; everything else a
// condition references is treated as a user-provided field. (Mirrors
// apps/ui gate-flow's AUTO_ATTRS.)
const AUTO_ATTRS = new Set([
  "country",
  "continent",
  "region",
  "is_eu",
  "is_bot",
  "browser",
  "os",
  "device",
  "is_mobile",
  "ip",
  "referrer",
  "request_url",
  "locale",
  "timezone",
  "city",
]);

/** Operator → human phrasing (mirrors OP_LABELS in the gate editor). */
export const OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is not one of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  regex: "matches",
  semver_gt: "version >",
  semver_gte: "version ≥",
  semver_lt: "version <",
  semver_lte: "version ≤",
};

export function fmtValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function sourceFor(step: { whitelist: string[] | null; isPublicFloor: boolean; rules: GateRule[] }): StepSource {
  if (step.whitelist) return "whitelist";
  if (step.isPublicFloor || step.rules.length === 0) return "public";
  if (step.rules.some((r) => AUTO_ATTRS.has(r.attr))) return "auto";
  return "user";
}

function stepTitle(e: GateStackEntry): string {
  if (e.locked) return "Public";
  if (e.whitelist) return e.name?.trim() || "Whitelist";
  if (e.name?.trim()) return e.name.trim();
  if (e.type === "rollout") return "Percentage rollout";
  return "Condition";
}

/** Normalize a gate (stacked or legacy flat rules + rolloutPct) into an ordered
 *  list of flow steps — checked top-to-bottom, first match returns the gate ON. */
export function buildGateFlow(gate: GateRecord): GateFlowStep[] {
  const stack = Array.isArray(gate.stack) ? gate.stack : [];
  if (stack.length > 0) {
    return stack.map((e, i) => {
      const type: GateFlowStep["type"] = e.type === "rollout" ? "rollout" : "condition";
      const rules = Array.isArray(e.rules) ? e.rules : [];
      const whitelist = e.whitelist
        ? (Array.isArray(rules[0]?.value) ? (rules[0]!.value as unknown[]).map(String) : [])
        : null;
      const isPublicFloor = Boolean(e.locked) && type === "rollout";
      const base = {
        key: e.id ?? String(i),
        type,
        title: stepTitle(e),
        rules,
        pass: e.pass === "any" ? ("any" as const) : ("all" as const),
        rolloutPct: e.rolloutPct ?? (type === "condition" ? 10000 : 0),
        bucketBy: e.bucketBy?.trim() || "user_id",
        isPublicFloor,
        whitelist,
      };
      return { ...base, source: sourceFor(base) };
    });
  }

  const flatRules = Array.isArray(gate.rules) ? gate.rules : [];
  const steps: GateFlowStep[] = [];
  if (flatRules.length) {
    const cond = {
      key: "flat-cond",
      type: "condition" as const,
      title: "Targeting rules",
      rules: flatRules,
      pass: "all" as const,
      rolloutPct: 10000,
      bucketBy: "user_id",
      isPublicFloor: false,
      whitelist: null,
    };
    steps.push({ ...cond, source: sourceFor(cond) });
  }
  const floor = {
    key: "flat-rollout",
    type: "rollout" as const,
    title: "Public",
    rules: [] as GateRule[],
    pass: "all" as const,
    rolloutPct: gate.rolloutPct ?? 0,
    bucketBy: "user_id",
    isPublicFloor: true,
    whitelist: null,
  };
  steps.push({ ...floor, source: sourceFor(floor) });
  return steps;
}

/** One-line plain-text summary of a step's predicate. */
export function ruleSummary(step: GateFlowStep): string {
  if (step.whitelist) return step.whitelist.length ? step.whitelist.join(", ") : "No entries yet";
  if (step.rules.length === 0) return "everyone who reaches here";
  return step.rules
    .map((r) => `${r.attr} ${OP_LABELS[r.op] ?? r.op} ${fmtValue(r.value) || "—"}`)
    .join(" · ");
}

// ── local rule evaluation ────────────────────────────────────────────────────

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Evaluate one predicate against a user attribute bag. Missing attribute →
 *  false for positive ops, true for negative (`neq`/`not_in`), matching the
 *  usual "absent means not-in-set" semantics. */
export function evalRule(rule: GateRule, user: Record<string, unknown>): boolean {
  const has = Object.prototype.hasOwnProperty.call(user, rule.attr);
  const uv = user[rule.attr];
  const v = rule.value;
  const s = (x: unknown) => (x == null ? "" : String(x));
  switch (rule.op) {
    case "eq":
      return has && s(uv) === s(v);
    case "neq":
      return !has || s(uv) !== s(v);
    case "in":
      return has && Array.isArray(v) && v.some((x) => s(x) === s(uv));
    case "not_in":
      return !has || !Array.isArray(v) || !v.some((x) => s(x) === s(uv));
    case "gt":
      return has && Number(uv) > Number(v);
    case "gte":
      return has && Number(uv) >= Number(v);
    case "lt":
      return has && Number(uv) < Number(v);
    case "lte":
      return has && Number(uv) <= Number(v);
    case "contains":
      return has && s(uv).includes(s(v));
    case "regex":
      try {
        return has && new RegExp(s(v)).test(s(uv));
      } catch {
        return false;
      }
    case "semver_gt":
      return has && cmpSemver(s(uv), s(v)) > 0;
    case "semver_gte":
      return has && cmpSemver(s(uv), s(v)) >= 0;
    case "semver_lt":
      return has && cmpSemver(s(uv), s(v)) < 0;
    case "semver_lte":
      return has && cmpSemver(s(uv), s(v)) <= 0;
    default:
      return false;
  }
}

/** Whether the current user satisfies a step's attribute predicate. Rollout /
 *  public / whitelist steps return `n/a` (no local attribute decision —
 *  whitelist membership and bucketing are the edge's call). `pass`/`any` mode
 *  comes from the raw stack entry, defaulting to all-must-match. */
export function evalStepMatch(
  step: GateFlowStep,
  user: Record<string, unknown> | null,
  passOverride?: "all" | "any",
): StepMatch {
  if (step.type !== "condition" || step.rules.length === 0 || step.whitelist) return "n/a";
  if (!user) return "n/a";
  const mode = passOverride ?? step.pass ?? "all";
  const results = step.rules.map((r) => evalRule(r, user));
  const ok = mode === "any" ? results.some(Boolean) : results.every(Boolean);
  return ok ? "pass" : "fail";
}
