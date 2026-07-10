// ShipEasy server SDK — polls /sdk/flags + /sdk/experiments, evaluates locally.

import { AsyncLocalStorage } from "node:async_hooks";

import { Telemetry, DEFAULT_TELEMETRY_URL } from "../telemetry";
import { isProductionEnv, setI18nRenderKeysOnly } from "../env";
import { logger, setLogLevel, safeRun, type LogLevel } from "../logger";
import { setInternalReportContext } from "../internal-report";
import {
  buildSeeEvent,
  isExpected,
  SeeLimiter,
  startControlFlowChain,
  startSeeChain,
  startSeeViolationChain,
  type Consequence,
  type SeeChain,
  type SeeControlFlowChain,
  type SeeErrorEvent,
  type SeeExtras,
  type SeeKind,
  type SeeViolationChain,
  type Violation,
} from "../see/core";

export type {
  Consequence,
  SeeChain,
  SeeControlFlowChain,
  SeeErrorEvent,
  SeeExtras,
  SeeKind,
  SeeViolationChain,
  Violation,
};
export { LOG_LEVELS } from "../logger";
export type { LogLevel };

export const version = "4.0.0";

// ---- MurmurHash3_x86_32 (seed 0) — must match packages/core/src/eval/hash.ts ----

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

/**
 * @internal Exported ONLY so the cross-language eval-parity golden-vector test
 * (src/__tests__/eval-vectors.test.ts) can assert the raw unsigned-32-bit hash
 * against the canonical fixture. Not part of the public SDK surface — do not
 * rely on it in product code; the bucketing contract lives behind getFlag /
 * getExperiment. Name-prefixed with `_` to signal "test seam, not API".
 */
export function _murmur3ForTests(key: string): number {
  return murmur3(key);
}

function murmur3(key: string): number {
  const bytes = new TextEncoder().encode(key);
  const len = bytes.length;
  const nblocks = len >>> 2;
  let h1 = 0;
  for (let i = 0; i < nblocks; i++) {
    const off = i * 4;
    let k1 = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
    h1 |= 0;
  }
  let k1 = 0;
  const tail = nblocks * 4;
  switch (len & 3) {
    case 3:
      k1 ^= bytes[tail + 2] << 16;
    // fallthrough
    case 2:
      k1 ^= bytes[tail + 1] << 8;
    // fallthrough
    case 1:
      k1 ^= bytes[tail];
      k1 = Math.imul(k1, C1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, C2);
      h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

// ---- Types ----

export interface User {
  user_id?: string;
  anonymous_id?: string;
  [attr: string]: unknown;
}

export interface ExperimentResult<P> {
  inExperiment: boolean;
  group: string;
  params: P;
  /** The universe this experiment belongs to. Carried in the SSR bootstrap +
   *  `/sdk/evaluate` so the client can resolve `universe(name).assign()` by
   *  finding the enrolled experiment in a universe. */
  universe?: string;
}

/**
 * Why a flag evaluated the way it did (LaunchDarkly variationDetail parity).
 * Computed at the client boundary, never inside the canonical eval:
 *   - CLIENT_NOT_READY — no rules blob loaded yet (init()/initOnce() pending)
 *   - FLAG_NOT_FOUND   — the gate name isn't present in the loaded blob
 *   - OFF              — the gate exists but is disabled / killed
 *   - OVERRIDE         — a local override (overrideFlag) decided the value
 *   - RULE_MATCH       — the gate evaluated true (rules + rollout passed)
 *   - DEFAULT          — the gate evaluated false (a rule or the rollout denied)
 */
export const FLAG_REASONS = [
  "CLIENT_NOT_READY",
  "FLAG_NOT_FOUND",
  "OFF",
  "OVERRIDE",
  "RULE_MATCH",
  "DEFAULT",
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export interface FlagDetail {
  value: boolean;
  reason: FlagReason;
}

/** Options object form of `getConfig` — keeps the legacy `decode` callback and
 *  adds a `defaultValue` returned when the config key is absent. */
export interface GetConfigOptions<T = unknown> {
  /** Decode the raw stored value into the typed shape callers want. */
  decode?: (raw: unknown) => T;
  /** Returned when the config key is absent (not overridden, not in the blob). */
  defaultValue?: T;
}

interface GateRule {
  attr: string;
  op: "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "regex";
  value: unknown;
}

interface Gate {
  rules: GateRule[];
  rolloutPct: number;
  salt: string;
  enabled: 0 | 1 | boolean;
  killswitch?: 0 | 1 | boolean;
}

interface ExperimentGroup {
  name: string;
  weight: number;
  params: Record<string, unknown>;
}

interface Experiment {
  universe: string;
  targetingGate?: string | null;
  /**
   * Per-experiment holdout flag (a `type='holdout'` gate). When set and the flag
   * passes for a unit, that unit is *held out* of THIS experiment — never
   * assigned, sees the universe defaults. Checked after the universe holdout,
   * before allocation. Mirrors @shipeasy/core §B3.
   */
  holdoutGate?: string | null;
  allocationPct: number;
  /**
   * Contiguous half-open slice `[poolOffsetBp, poolOffsetBp + poolSizeBp)` of the
   * *universe* hash space this experiment claims. Used only when `hashVersion >= 2`
   * (pooled assignment / real mutual exclusion, §B4): the unit's universe segment
   * must fall in this range to be in the experiment. Null ⇒ fall back to the
   * legacy independent-salt `allocationPct` gate.
   */
  poolOffsetBp?: number | null;
  poolSizeBp?: number | null;
  /**
   * A tail of the group split kept empty (basis points) so a new variant can be
   * appended into it while running without reshuffling enrolled units. Group
   * weights sum to `10000 − reservedHeadroomBp`; a unit hashing into the reserved
   * tail is treated as not-assigned (sees universe defaults). §B5.
   */
  reservedHeadroomBp?: number | null;
  salt: string;
  groups: ExperimentGroup[];
  status: "draft" | "running" | "stopped" | "archived";
  /** Bucketing scheme version. `>= 2` unlocks pooled (mutually-exclusive) assignment. */
  hashVersion?: number;
  /** Attribute to bucket on (e.g. company_id); defaults to user_id/anonymous_id. */
  bucketBy?: string | null;
  /**
   * Durable per-unit overrides (spec step 1, tier 1): bucketing-unit value → the
   * forced group. Forced-but-gated — the unit still has to pass targeting and not
   * be held out, else it sees universe defaults. Bypasses allocation + the
   * weighted pick only. Applies on every hash_version. Mirrors @shipeasy/core.
   */
  idOverrides?: Record<string, string> | null;
  /**
   * Durable cohort/GK overrides (spec step 1, tier 2): priority-ordered
   * `{ gate, group }`. First entry whose gate passes forces that group (again
   * forced-but-gated). ID overrides win over cohort overrides. Mirrors @shipeasy/core.
   */
  cohortOverrides?: { gate: string; group: string; priority?: number }[] | null;
}

/** One param the universe owns: a name, a type, and the default a variant
 *  inherits when it doesn't override the value (§A/§B2). */
export interface UniverseParam {
  name: string;
  type: "bool" | "int" | "number" | "string";
  default: unknown;
}
export type UniverseParamSchema = UniverseParam[];

/** One persisted sticky assignment: group + 8-char salt prefix (reshuffle key). */
export interface StickyEntry {
  g: string;
  s: string;
}

/** Per-experiment sticky seam bound to one (unit, experiment): `get` reads the
 *  stored entry, `set` persists a freshly-assigned one. Built over a
 *  {@link StickyBucketStore} by the assignment path. */
interface StickyContext {
  get(): StickyEntry | undefined;
  set(entry: StickyEntry): void;
}

/**
 * Pluggable sticky-bucketing store for the server (doc 20 §2). Keyed by the
 * bucketing unit; the value is that unit's per-experiment assignments. Absent
 * from {@link EngineOptions} ⇒ today's deterministic behaviour. Use
 * {@link createInMemoryStickyStore} or a cookie-bridge built from request
 * cookies.
 */
export interface StickyBucketStore {
  get(unit: string): Record<string, StickyEntry> | undefined;
  set(unit: string, exp: string, entry: StickyEntry): void;
}

/** A process-local sticky store (Map-backed). Handy for tests + single-process servers. */
export function createInMemoryStickyStore(
  seed?: Record<string, Record<string, StickyEntry>>,
): StickyBucketStore {
  const m = new Map<string, Record<string, StickyEntry>>(Object.entries(seed ?? {}));
  return {
    get: (unit) => m.get(unit),
    set: (unit, exp, entry) => {
      const cur = m.get(unit) ?? {};
      cur[exp] = entry;
      m.set(unit, cur);
    },
  };
}

interface Universe {
  holdout_range: [number, number] | null;
  /**
   * The universe's config schema — the single source of truth for param names,
   * types, and defaults (§A). The `assign()` merge layers these defaults *under*
   * an assigned variant's overrides so an unset param still returns the universe
   * default. Null/absent ⇒ no defaults (legacy: variant params returned verbatim).
   */
  param_schema?: UniverseParamSchema | null;
}

interface Killswitch {
  killed: 0 | 1 | boolean;
  switches?: Record<string, 0 | 1 | boolean>;
}

/** Body of `GET /sdk/flags` — the snapshot's `flags` field. See {@link Engine.fromSnapshot}. */
export interface FlagsBlob {
  version: string;
  plan: string;
  gates: Record<string, Gate>;
  configs: Record<string, { value: unknown }>;
  killswitches: Record<string, Killswitch>;
}

/** Body of `GET /sdk/experiments` — the snapshot's `experiments` field. See {@link Engine.fromSnapshot}. */
export interface ExpsBlob {
  version: string;
  universes: Record<string, Universe>;
  experiments: Record<string, Experiment>;
}

export interface BootstrapPayload {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, ExperimentResult<Record<string, unknown>>>;
  killswitches: Record<string, boolean | Record<string, boolean>>;
  /** Per-universe param defaults (name → default map) so the client can resolve
   *  `universe(name).get(field)` to the universe default even when the unit is
   *  not enrolled in any experiment there. Only universes with running
   *  experiments are included. */
  universes?: Record<string, { defaults: Record<string, unknown> }>;
}

// ---- Evaluation helpers ----

function isEnabled(v: 0 | 1 | boolean | undefined): boolean {
  return v === 1 || v === true;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function matchRule(rule: GateRule, user: User): boolean {
  const actual = user[rule.attr];
  switch (rule.op) {
    case "eq":
      return actual === rule.value;
    case "neq":
      return actual !== rule.value;
    case "in":
      return Array.isArray(rule.value) && (rule.value as unknown[]).includes(actual as unknown);
    case "not_in":
      return Array.isArray(rule.value) && !(rule.value as unknown[]).includes(actual as unknown);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNum(actual);
      const b = toNum(rule.value);
      if (a === null || b === null) return false;
      if (rule.op === "gt") return a > b;
      if (rule.op === "gte") return a >= b;
      if (rule.op === "lt") return a < b;
      return a <= b;
    }
    case "contains":
      if (typeof actual === "string" && typeof rule.value === "string")
        return actual.includes(rule.value);
      if (Array.isArray(actual)) return (actual as unknown[]).includes(rule.value);
      return false;
    case "regex":
      if (typeof actual !== "string" || typeof rule.value !== "string") return false;
      try {
        return new RegExp(rule.value).test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// Cross-SDK identity contract: the stable anonymous bucketing unit lives in a
// first-party, JS-readable `__se_anon_id` cookie. Every SDK (TS server/client,
// Ruby, React, future ones) reads this cookie as the default unit so buckets
// agree across the whole stack. Name + format are frozen — see
// experiment-platform/18-identity-bucketing.md.
export const ANON_ID_COOKIE = "__se_anon_id";

// The cookie value is client-controllable, and we both bucket on it and inline
// it into a bootstrap <script>. Constrain it to an opaque token charset so a
// tampered cookie can never break out of the script or poison bucketing — a
// value that fails this is treated as absent (we mint a fresh one instead).
const ANON_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;

function mintAnonId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `anon_${Math.random().toString(36).slice(2)}`;
}

/**
 * Resolve the bucketing unit. With `bucketBy` set (e.g. company_id), hash on
 * that attribute so a whole org buckets together; else fall back to
 * user_id ?? anonymous_id. Mirrors the canonical `pickIdentifier` in
 * @shipeasy/core (doc 20 §4) — keep in sync across every SDK.
 */
function pickIdentifier(user: User, bucketBy?: string | null): string | undefined {
  if (bucketBy) {
    const v = user[bucketBy];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return user.user_id ?? user.anonymous_id;
}

function evalGateInternal(gate: Gate, user: User): boolean {
  if (isEnabled(gate.killswitch)) return false;
  if (!isEnabled(gate.enabled)) return false;
  for (const rule of gate.rules ?? []) {
    if (!matchRule(rule, user)) return false;
  }
  const uid = user.user_id ?? user.anonymous_id;
  // No unit id (e.g. an unidentified SSR request before any anon id is minted):
  // a fully-rolled gate is on for everyone, so it can be answered without
  // bucketing. A fractional rollout genuinely needs a stable unit to bucket —
  // deny rather than guess. See experiment-platform/18-identity-bucketing.md.
  if (!uid) return gate.rolloutPct >= 10000;
  return murmur3(`${gate.salt}:${uid}`) % 10000 < gate.rolloutPct;
}

// ---- Universe assignment (mutual-exclusion pool eval) ----

/** Flatten a universe param schema to a plain `name → default` map — the
 *  defaults `assign()` layers under a variant's override map (§B2). Returns null
 *  for a null/empty schema so the merge short-circuits. Mirrors @shipeasy/core. */
function paramDefaultsFromSchema(
  schema: UniverseParamSchema | null | undefined,
): Record<string, unknown> | null {
  if (!schema || schema.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const p of schema) out[p.name] = p.default;
  return out;
}

/** `universeDefaults ⊕ variantOverride` — a variant inherits every universe
 *  default it doesn't explicitly override (§B2). */
function mergeParams(
  paramDefaults: Record<string, unknown> | null,
  groupParams: Record<string, unknown>,
): Record<string, unknown> {
  return paramDefaults ? { ...paramDefaults, ...groupParams } : { ...groupParams };
}

/** A unit's standing in one experiment: an assigned `group` (with merged params),
 *  `holdout` (universe carve-out or holdout gate — never assigned), or `out`. */
interface ExpStanding {
  state: "group" | "holdout" | "out";
  group?: string;
  params?: Record<string, unknown>;
}

/**
 * Targeting → universe holdout → holdout gate → sticky → allocation (pooled or
 * legacy) → weighted group split. The single local mirror of @shipeasy/core's
 * `classifyExperiment` — keep the two in sync (see experiment-platform/04). The
 * caller supplies `evalGate` (a gate-name → boolean lookup over the flags blob)
 * so the two gate checks reuse the SDK's real gate evaluation.
 */
/** Resolve a forced override group for `uid` (spec step 1): ID overrides (tier 1)
 *  beat cohort/GK overrides (tier 2); within cohort overrides the first (pre-sorted
 *  by priority) gate that passes wins. Returns the forced group name or null. The
 *  caller applies eligibility + group-existence (forced-but-gated). Mirrors
 *  @shipeasy/core `resolveForcedGroup`, but evaluates cohort gates via `evalGate`. */
function resolveForcedGroupLocal(
  exp: Experiment,
  uid: string,
  evalGate: (name: string) => boolean,
): string | null {
  const byId = exp.idOverrides?.[uid];
  if (byId) return byId;
  if (exp.cohortOverrides) {
    for (const co of exp.cohortOverrides) {
      if (evalGate(co.gate)) return co.group;
    }
  }
  return null;
}

function classifyExperimentLocal(
  exp: Experiment,
  user: User,
  holdoutRange: [number, number] | null,
  paramDefaults: Record<string, unknown> | null,
  evalGate: (name: string) => boolean,
  sticky?: StickyContext,
): ExpStanding {
  const asGroup = (g: ExperimentGroup): ExpStanding => ({
    state: "group",
    group: g.name,
    params: mergeParams(paramDefaults, g.params),
  });

  if (exp.targetingGate && !evalGate(exp.targetingGate)) return { state: "out" };

  const uid = pickIdentifier(user, exp.bucketBy);
  if (!uid) return { state: "out" };

  // One segment in the universe's shared `[0, 10000)` hash space. The holdout
  // carve-out AND every experiment's pool slice are disjoint ranges of THIS
  // segment — that's what makes "held out / taken / free" a real partition.
  const universeSeg = murmur3(`${exp.universe}:${uid}`) % 10000;

  if (holdoutRange) {
    const [lo, hi] = holdoutRange;
    if (universeSeg >= lo && universeSeg <= hi) return { state: "holdout" };
  }

  if (exp.holdoutGate && evalGate(exp.holdoutGate)) return { state: "holdout" };

  const salt8 = exp.salt.slice(0, 8);

  // Durable overrides (spec step 1, forced-but-gated). Reached only once the unit
  // has passed targeting and is not held out, so an override may now pin the group
  // — bypassing allocation + the weighted pick but NOT the gates above. ID
  // overrides (tier 1) beat cohort/GK overrides (tier 2); a forced group that no
  // longer exists falls through to normal allocation. No-op when unconfigured, so
  // v1/v2 stay byte-identical. Mirrors @shipeasy/core `classifyExperiment`.
  const forced = resolveForcedGroupLocal(exp, uid, evalGate);
  if (forced) {
    const g = exp.groups.find((x) => x.name === forced);
    if (g) {
      sticky?.set({ g: g.name, s: salt8 });
      return asGroup(g);
    }
  }

  if (sticky) {
    const entry = sticky.get();
    if (entry && entry.s === salt8) {
      const g = exp.groups.find((x) => x.name === entry.g);
      if (g) return asGroup(g);
    }
  }

  // Allocation. Pooled (hashVersion ≥ 2 with a slice) gives real mutual
  // exclusion: the unit's universe segment must fall in the claimed range. Legacy
  // falls back to an independent per-experiment salt so siblings overlap freely.
  const pooled =
    (exp.hashVersion ?? 1) >= 2 &&
    exp.poolOffsetBp != null &&
    exp.poolSizeBp != null &&
    exp.poolSizeBp > 0;
  if (pooled) {
    const lo = exp.poolOffsetBp as number;
    const hi = lo + (exp.poolSizeBp as number);
    if (universeSeg < lo || universeSeg >= hi) return { state: "out" };
  } else {
    if (murmur3(`${exp.salt}:alloc:${uid}`) % 10000 >= exp.allocationPct) return { state: "out" };
  }

  // Group split over `[0, usable)` where `usable = 10000 − reserved`; a unit in
  // the reserved tail is left unassigned so an appended variant can absorb it (§B5).
  const reserved = Math.max(0, Math.min(10000, exp.reservedHeadroomBp ?? 0));
  const usable = 10000 - reserved;
  const groupHash = murmur3(`${exp.salt}:group:${uid}`) % 10000;
  if (groupHash >= usable) return { state: "out" };
  let cumulative = 0;
  for (let i = 0; i < exp.groups.length; i++) {
    const g = exp.groups[i];
    cumulative += g.weight;
    if (groupHash < cumulative || i === exp.groups.length - 1) {
      sticky?.set({ g: g.name, s: salt8 });
      return asGroup(g);
    }
  }
  return { state: "out" };
}

/**
 * The result of `universe(name).assign(user)` — a user's standing in a universe.
 * A universe is a mutual-exclusion pool, so a unit lands in **at most one**
 * experiment. Never throws: an un-enrolled unit still resolves `get()` to the
 * universe defaults (or your fallback).
 *
 * Exposure is logged **on read** (spec step 7): the single exposure fires the
 * first time an enrolled unit's param is actually read via `get()`, not at
 * `assign()` time — so an assignment that is computed but never read logs
 * nothing. Deduped per process; the durable per-(unit, experiment, group) dedup
 * lives server-side. Pass `{ exposure: false }` to read without logging (peek).
 */
export interface Assignment {
  /** The experiment the unit landed in, or `null` when not enrolled. */
  readonly name: string | null;
  /** The assigned variant/group name, or `null` when not enrolled. */
  readonly group: string | null;
  /** True iff the unit is enrolled in an experiment in this universe. Reading it
   *  does NOT log an exposure (only `get()` of a param does). */
  readonly enrolled: boolean;
  /**
   * Read a resolved param: the assigned variant's override, else the universe
   * default, else `fallback`. Works even when not enrolled (variant layer is
   * absent, so you get `universeDefault ?? fallback`). The first enrolled read
   * logs the single exposure; pass `{ exposure: false }` to suppress it (peek).
   */
  get<T = unknown>(field: string, fallback?: T, opts?: { exposure?: boolean }): T | undefined;
}

class AssignmentImpl implements Assignment {
  private exposed = false;
  constructor(
    readonly name: string | null,
    readonly group: string | null,
    // Already merged (universeDefaults ⊕ variantOverride) when enrolled;
    // defaults-only (or {}) when not.
    private readonly params: Record<string, unknown>,
    // Fires the single exposure the first time an enrolled param is read.
    // Undefined when not enrolled (nothing to expose). Deduped downstream.
    private readonly onExpose?: () => void,
  ) {}
  get enrolled(): boolean {
    return this.group !== null;
  }
  get<T = unknown>(field: string, fallback?: T, opts?: { exposure?: boolean }): T | undefined {
    // On-read exposure: the first param read of an enrolled assignment logs one
    // exposure, unless the caller opted out with { exposure: false }.
    if (opts?.exposure !== false && !this.exposed && this.onExpose) {
      this.exposed = true;
      this.onExpose();
    }
    const v = this.params[field];
    return v === undefined ? fallback : (v as T);
  }
}

// ---- URL override helpers (for evaluate()) ----

const TRUE_RX = /^(true|on|1|yes)$/i;
const FALSE_RX = /^(false|off|0|no)$/i;

function parseOverrideBool(raw: string): boolean | null {
  if (TRUE_RX.test(raw)) return true;
  if (FALSE_RX.test(raw)) return false;
  return null;
}

function decodeOverrideConfigValue(raw: string): unknown {
  if (raw.startsWith("b64:")) {
    try {
      const json = atob(raw.slice(4).replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseOverrides(rawUrl: string): {
  gates: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, string>;
} {
  const gates: Record<string, boolean> = {};
  const configs: Record<string, unknown> = {};
  const experiments: Record<string, string> = {};
  try {
    const url = new URL(rawUrl, "http://localhost");
    for (const [k, v] of url.searchParams) {
      if (k.startsWith("se_ks_")) {
        const b = parseOverrideBool(v);
        if (b !== null) gates[k.slice(6)] = b;
      } else if (k.startsWith("se_cf_")) {
        configs[k.slice(6)] = decodeOverrideConfigValue(v);
      } else if (k.startsWith("se_config_")) {
        configs[k.slice(10)] = decodeOverrideConfigValue(v);
      } else if (k.startsWith("se_exp_")) {
        const name = k.slice(7);
        if (v && v !== "default" && v !== "none") experiments[name] = v;
      }
    }
  } catch {}
  return { gates, configs, experiments };
}

// ---- Engine ----

export type EngineEnv = "dev" | "staging" | "prod";

export interface EngineOptions {
  apiKey: string;
  baseUrl?: string;
  /** Which published env to read values from. Defaults to "prod". */
  env?: EngineEnv;
  /**
   * Preload the flags blob synchronously without a network fetch. Primarily
   * for tests; production callers should rely on init()/initOnce().
   */
  initialBlob?: FlagsBlob;
  /**
   * Master network switch — when `false`, the SDK makes NO outbound requests at
   * all: init()/initOnce() never fetch (getters read code defaults / overrides),
   * track() and exposure logging are no-ops, usage telemetry is off, and
   * SDK-internal error self-monitoring is off. Think of it as a production-safe
   * offline mode.
   *
   * DEFAULT is environment-derived (see {@link isProductionEnv}): ON in
   * production, OFF everywhere else — so a local/dev/CI run never phones home
   * unless you opt in. Production is inferred from `SHIPEASY_ENV`/`NODE_ENV`, or
   * (when neither is set, e.g. on Cloudflare Workers) from the `env` option
   * above, which defaults to `"prod"`. Pass an explicit value to override.
   */
  isNetworkEnabled?: boolean;
  /**
   * Per-evaluation usage telemetry ("tracking"/outside logging). Each
   * getFlag/getConfig/getExperiment/getKillswitch (and the per-key evaluate()
   * loop) fires one fire-and-forget beacon counted by Cloudflare's native
   * per-path analytics.
   *
   * DEFAULT is environment-derived: ON in production, OFF everywhere else (same
   * inference as {@link isNetworkEnabled}). Pass `true` to force it off, `false`
   * to force it on. NOTE: on Cloudflare Workers each beacon is an outbound
   * subrequest (cap 50 free / 1000 paid per invocation), so disable this on hot
   * request paths that evaluate many flags per request. Forced off whenever
   * `isNetworkEnabled` is false.
   */
  disableTelemetry?: boolean;
  /** Override the telemetry beacon host. Defaults to {@link DEFAULT_TELEMETRY_URL}. */
  telemetryUrl?: string;
  /**
   * How chatty the SDK is on `console` when it catches an error internally.
   * Every public runtime method (getFlag/getConfig/getExperiment/getKillswitch/
   * track/logExposure/see) fails silently — it returns a safe default rather
   * than throwing — and surfaces the swallowed error through this level so you
   * still find out. Ordering: `silent` < `error` < `warn` < `info` < `debug`.
   * Defaults to `"warn"` (prints `error` + `warn`). Pass `"silent"` to mute the
   * SDK entirely. See {@link LogLevel}.
   */
  logLevel?: LogLevel;
  /**
   * Opt out of SDK-internal error self-monitoring. When one of the SDK's own
   * last-resort guards catches an internal failure (an "on our end" bug), the
   * SDK reports it to Shipeasy's own project so we can track SDK bugs across
   * apps — never to your project. ON by default; forced off in test mode. Pass
   * `true` to disable.
   */
  disableInternalErrorReporting?: boolean;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). The server evaluates locally so private
   * attrs never leave for evaluation at all; the only egress is `/collect`, and
   * the listed keys are stripped from every outbound `track()` payload.
   */
  privateAttributes?: string[];
  /**
   * Sticky-bucketing store (doc 20 §2). When provided, `getExperiment` locks a
   * unit to its first-assigned variant — changing allocation % or weights won't
   * re-bucket enrolled units (changing the experiment salt is the reshuffle
   * lever). Absent ⇒ deterministic (fully backward compatible). Built-ins:
   * {@link createInMemoryStickyStore}, or a cookie-bridge over `__se_sticky`.
   */
  stickyStore?: StickyBucketStore;
  /**
   * Test mode — no network at all. init()/initOnce() are no-ops (never fetch),
   * track() is a no-op, telemetry is forced off, and the client starts
   * "initialized" with an empty blob. Prefer the {@link Engine.forTesting}
   * factory over passing this directly.
   */
  testMode?: boolean;
}

export class Engine {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly env: EngineEnv;
  private readonly privateAttributes: readonly string[];
  private readonly stickyStore: StickyBucketStore | undefined;
  // Master network gate — false ⇒ the SDK never touches the network (no fetch,
  // no track, no telemetry, no internal error reports). Defaults to
  // environment-derived (prod-on), forced false by testMode.
  private readonly networkEnabled: boolean;
  // Convenience inverse of networkEnabled — the "no network at all" state that
  // every fetch/track/init gate keys on. `testMode` implies offline.
  private readonly offline: boolean;
  private readonly telemetry: Telemetry;
  private readonly seeLimiter = new SeeLimiter();
  private flagsBlob: FlagsBlob | null = null;
  private expsBlob: ExpsBlob | null = null;
  private flagsEtag: string | null = null;
  private expsEtag: string | null = null;
  private pollInterval = 30;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  // Test mode: built by `Engine.forTesting()`. When set, init()/initOnce()
  // never fetch, track() is a no-op, and telemetry is off — the client is a
  // fully self-contained, network-free seam for unit tests.
  private readonly testMode: boolean;
  // Programmatic overrides (Statsig-style). Set on any client via
  // overrideFlag/overrideConfig/overrideExperiment; they win over the fetched
  // blob in getFlag/getConfig/getExperiment. Cleared by clearOverrides().
  private readonly flagOverrides = new Map<string, boolean>();
  private readonly configOverrides = new Map<string, unknown>();
  private readonly experimentOverrides = new Map<
    string,
    { group: string; params: Record<string, unknown> }
  >();
  // Bounded per-process exposure dedup (`uid:exp:group`) so auto-exposure from
  // repeated assign() calls doesn't spam /collect. Cleared past a soft cap.
  private readonly exposureSeen = new Set<string>();
  // Change listeners fired after a background poll returns NEW data (200, not
  // 304). Never fired in testMode/offline (no polling happens there).
  private readonly changeListeners = new Set<() => void>();

  constructor(opts: EngineOptions) {
    // Apply the log level first so anything the constructor (or an early
    // fire-and-forget fetch) logs already honours the caller's preference.
    setLogLevel(opts.logLevel);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://cdn.shipeasy.ai").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
    this.privateAttributes = opts.privateAttributes ?? [];
    this.stickyStore = opts.stickyStore;
    this.testMode = opts.testMode === true;
    // Environment-derived egress default: ON in prod, OFF elsewhere. `env` (the
    // SDK's published-env selector) is the fallback signal when no native
    // NODE_ENV/SHIPEASY_ENV is set (e.g. on Cloudflare Workers).
    const prod = isProductionEnv(this.env);
    // Master network gate. testMode always forces offline; otherwise honour an
    // explicit isNetworkEnabled, else default to prod-on.
    this.networkEnabled = this.testMode ? false : (opts.isNetworkEnabled ?? prod);
    this.offline = !this.networkEnabled;
    // Self-monitoring: SDK-internal errors caught by safeRun report to
    // Shipeasy's own project. Off whenever the network is disabled and when
    // opted out.
    setInternalReportContext({
      side: "server",
      sdkVersion: version,
      enabled: this.networkEnabled && opts.disableInternalErrorReporting !== true,
    });
    this.telemetry = new Telemetry({
      endpoint: opts.telemetryUrl ?? DEFAULT_TELEMETRY_URL,
      sdkKey: this.apiKey,
      side: "server",
      env: this.env,
      // Off when the network is disabled; otherwise honour an explicit
      // disableTelemetry, else default to prod-on (off outside production).
      disabled: this.offline || (opts.disableTelemetry ?? !prod),
    });
    if (opts.initialBlob || this.offline) {
      // Seed an empty blob when offline so getters read from overrides / code
      // defaults without any fetch having happened.
      this.flagsBlob =
        opts.initialBlob ?? { version: "test", plan: "free", gates: {}, configs: {}, killswitches: {} };
      this.expsBlob = this.expsBlob ?? { version: "test", universes: {}, experiments: {} };
      this.initialized = true;
    }
  }

  /**
   * Build a no-network, immediately-usable client for tests (Statsig-style).
   * init()/initOnce() are no-ops (never fetch), track() is a no-op, telemetry
   * is disabled, and the client is already "initialized" — seed every entity
   * with overrideFlag/overrideConfig/overrideExperiment. No SDK key required.
   *
   * ```ts
   * const client = Engine.forTesting();
   * client.overrideFlag("new_checkout", true);
   * client.getFlag("new_checkout", { user_id: "u1" }); // true
   * ```
   */
  static forTesting(opts?: Partial<EngineOptions>): Engine {
    return new Engine({ apiKey: "", ...opts, testMode: true });
  }

  /**
   * Build a fully OFFLINE client from a pre-captured snapshot — no network ever.
   * Reuses the test-mode plumbing (init()/initOnce()/track() are no-ops,
   * telemetry off) but, unlike forTesting(), seeds the REAL flags + experiments
   * blobs so evaluations run the canonical eval against the snapshot. Local
   * overrides still apply on top.
   *
   * Snapshot shape mirrors the wire bodies:
   * `{ flags: <GET /sdk/flags body>, experiments: <GET /sdk/experiments body> }`.
   */
  static fromSnapshot(snapshot: { flags: FlagsBlob; experiments: ExpsBlob }): Engine {
    const client = new Engine({ apiKey: "", testMode: true });
    client.flagsBlob = snapshot.flags;
    client.expsBlob = snapshot.experiments;
    client.initialized = true;
    return client;
  }

  /**
   * Build a fully OFFLINE client from a snapshot JSON file on disk (Node only —
   * not available in the browser entrypoint). The file must contain
   * `{ "flags": <GET /sdk/flags body>, "experiments": <GET /sdk/experiments body> }`.
   * See {@link Engine.fromSnapshot}.
   */
  static fromFile(path: string): Engine {
    // require() so the Node-only fs dependency never ends up in a browser bundle
    // of the server entry (this static is documented as Node/server-only).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(path, "utf8");
    const snapshot = JSON.parse(raw) as { flags: FlagsBlob; experiments: ExpsBlob };
    return Engine.fromSnapshot(snapshot);
  }

  async init(): Promise<void> {
    if (this.offline) {
      this.initialized = true;
      return;
    }
    await this.fetchAll();
    this.initialized = true;
    this.startPoll();
  }

  async initOnce(): Promise<void> {
    if (this.offline || this.initialized) return;
    await this.fetchAll();
    this.initialized = true;
  }

  // ---- Local overrides (Statsig-style) ----

  /** Force `getFlag(name, …)` to return `value`, ignoring the fetched gate. */
  overrideFlag(name: string, value: boolean): void {
    this.flagOverrides.set(name, value);
  }

  /** Force `getConfig(name)` to return `value`, ignoring the fetched config. */
  overrideConfig(name: string, value: unknown): void {
    this.configOverrides.set(name, value);
  }

  /**
   * Force `getExperiment(name, …)` to return `{ inExperiment: true, group, params }`,
   * ignoring allocation, holdouts, and targeting.
   */
  overrideExperiment(name: string, group: string, params: Record<string, unknown>): void {
    this.experimentOverrides.set(name, { group, params });
  }

  /** Remove every programmatic override set via the override* methods. */
  clearOverrides(): void {
    this.flagOverrides.clear();
    this.configOverrides.clear();
    this.experimentOverrides.clear();
  }

  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Subscribe to data-change notifications. The listener fires after a
   * background poll fetch returns NEW data (200, not 304) — i.e. after the
   * cached blob is updated. Never fires in testMode/offline (no polling).
   * Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch (err) {
        logger.warn("[shipeasy] onChange listener threw:", String(err));
      }
    }
  }

  private startPoll(): void {
    this.timer = setInterval(() => {
      this.fetchAll(true).catch((err) =>
        logger.warn("[shipeasy] background poll failed:", String(err)),
      );
    }, this.pollInterval * 1000);
  }

  private async fetchAll(fromPoll = false): Promise<void> {
    const [flagsRes, expsChanged] = await Promise.all([this.fetchFlags(), this.fetchExps()]);
    const { interval, changed: flagsChanged } = flagsRes;
    if (interval !== null && interval !== this.pollInterval) {
      this.pollInterval = interval;
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.startPoll();
      }
    }
    // Only fire on a background poll that brought NEW data (200, not 304) — the
    // initial init() fetch isn't a "change", and 304s leave the blob untouched.
    if (fromPoll && (flagsChanged || expsChanged)) this.notifyChange();
  }

  private async fetchFlags(): Promise<{ interval: number | null; changed: boolean }> {
    const headers: Record<string, string> = { "X-SDK-Key": this.apiKey };
    if (this.flagsEtag) headers["If-None-Match"] = this.flagsEtag;
    const res = await globalThis.fetch(`${this.baseUrl}/sdk/flags?env=${this.env}`, { headers });
    const interval = Number(res.headers.get("X-Poll-Interval") ?? "30") || 30;
    if (res.status === 304) return { interval, changed: false };
    if (!res.ok) throw new Error(`/sdk/flags returned ${res.status}`);
    const etag = res.headers.get("ETag");
    if (etag) this.flagsEtag = etag;
    this.flagsBlob = (await res.json()) as FlagsBlob;
    return { interval, changed: true };
  }

  private async fetchExps(): Promise<boolean> {
    const headers: Record<string, string> = { "X-SDK-Key": this.apiKey };
    if (this.expsEtag) headers["If-None-Match"] = this.expsEtag;
    const res = await globalThis.fetch(`${this.baseUrl}/sdk/experiments`, { headers });
    if (res.status === 304) return false;
    if (!res.ok) throw new Error(`/sdk/experiments returned ${res.status}`);
    const etag = res.headers.get("ETag");
    if (etag) this.expsEtag = etag;
    this.expsBlob = (await res.json()) as ExpsBlob;
    return true;
  }

  /**
   * Evaluate a gate and report WHY (LaunchDarkly variationDetail parity). The
   * reason is computed entirely at this boundary — the canonical eval
   * (evalGateInternal) is untouched. A local override short-circuits BEFORE
   * telemetry, exactly like getFlag's override path; otherwise exactly one
   * "gate" beacon is emitted.
   */
  getFlagDetail(name: string, user: User): FlagDetail {
    // 1. Local override wins and skips telemetry (mirrors the override path).
    const ov = this.flagOverrides.get(name);
    if (ov !== undefined) return { value: ov, reason: "OVERRIDE" };
    // Single telemetry emit for every non-override path (steps 2–5).
    this.telemetry.emit("gate", name);
    // 2. No rules blob loaded yet.
    if (!this.flagsBlob) return { value: false, reason: "CLIENT_NOT_READY" };
    // 3. Gate absent from the loaded blob.
    const gate = this.flagsBlob.gates[name];
    if (!gate) return { value: false, reason: "FLAG_NOT_FOUND" };
    // 4. Gate present but disabled / killed — read the same fields the canonical
    //    eval reads so the two never drift.
    if (isEnabled(gate.killswitch) || !isEnabled(gate.enabled)) {
      return { value: false, reason: "OFF" };
    }
    // 5. Real evaluation.
    const value = evalGateInternal(gate, user);
    return { value, reason: value ? "RULE_MATCH" : "DEFAULT" };
  }

  /**
   * Read a feature gate. Returns `defaultValue` ONLY when the gate cannot be
   * evaluated (client not initialized or flag not found) — never for a gate that
   * legitimately evaluates to false. Plain `getFlag(name, user)` keeps returning
   * false for a missing flag.
   */
  getFlag(name: string, user: User, defaultValue = false): boolean {
    const d = this.getFlagDetail(name, user);
    if (d.reason === "CLIENT_NOT_READY" || d.reason === "FLAG_NOT_FOUND") return defaultValue;
    return d.value;
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined;
  getConfig<T = unknown>(name: string, opts: GetConfigOptions<T>): T;
  getConfig<T = unknown>(
    name: string,
    decodeOrOpts?: ((raw: unknown) => T) | GetConfigOptions<T>,
  ): T | undefined {
    this.telemetry.emit("config", name);
    const opts: GetConfigOptions<T> =
      typeof decodeOrOpts === "function" ? { decode: decodeOrOpts } : (decodeOrOpts ?? {});
    const has = this.configOverrides.has(name);
    const raw = has ? this.configOverrides.get(name) : this.flagsBlob?.configs[name]?.value;
    // Config key absent (not overridden, not in the blob): return the supplied
    // default if any, else undefined — backward compatible.
    if (raw === undefined && !has) {
      return ("defaultValue" in opts ? opts.defaultValue : undefined) as T;
    }
    if (!opts.decode) return raw as T;
    // A user-supplied decode callback is the one place a plain getConfig can
    // throw — never let it into the caller; log and fall back to the default.
    try {
      return opts.decode(raw);
    } catch (err) {
      logger.warn(`[shipeasy] getConfig('${name}') decode failed:`, String(err));
      return ("defaultValue" in opts ? opts.defaultValue : undefined) as T;
    }
  }

  /**
   * Bind the per-experiment sticky seam over the configured {@link StickyBucketStore}
   * for one (unit, experiment). Absent store ⇒ deterministic (no sticky).
   */
  private bindSticky(name: string, uid: string): StickyContext | undefined {
    const store = this.stickyStore;
    if (!store) return undefined;
    return {
      get: () => store.get(uid)?.[name],
      set: (entry) => store.set(uid, name, entry),
    };
  }

  /**
   * Evaluate one experiment by name for `user` — override → full classify
   * pipeline (targeting → universe holdout → holdout gate → sticky → allocation
   * → group), merging the universe defaults under the assigned variant (§B2).
   * Internal: the public surface is `universe(name).assign(user)`. Reused by the
   * SSR `evaluate()` bootstrap (keyed by experiment name) and by `assignUniverse`.
   */
  private evalExperiment(name: string, exp: Experiment, user: User): ExpStanding {
    const paramDefaults = paramDefaultsFromSchema(
      this.expsBlob?.universes[exp.universe]?.param_schema,
    );
    const ov = this.experimentOverrides.get(name);
    if (ov) return { state: "group", group: ov.group, params: mergeParams(paramDefaults, ov.params) };
    if (!this.flagsBlob || !this.expsBlob) return { state: "out" };
    if (exp.status !== "running") return { state: "out" };

    const holdoutRange = this.expsBlob.universes[exp.universe]?.holdout_range ?? null;
    const evalGate = (gname: string): boolean => {
      const gate = this.flagsBlob?.gates[gname];
      return gate ? evalGateInternal(gate, user) : false;
    };
    const uid = pickIdentifier(user, exp.bucketBy);
    const sticky = uid ? this.bindSticky(name, uid) : undefined;
    return classifyExperimentLocal(exp, user, holdoutRange, paramDefaults, evalGate, sticky);
  }

  /**
   * Assign `user` within `universeName`. A universe is a mutual-exclusion pool,
   * so a unit lands in **at most one** experiment; the returned {@link Assignment}
   * exposes the variant + resolved params and auto-logs a single exposure when
   * enrolled. An un-enrolled unit still resolves `get()` to the universe defaults.
   * Never throws. This is the sole experiment read path (there is no
   * `getExperiment` — a caller asks a universe, not an experiment).
   */
  assignUniverse(universeName: string, user: User): Assignment {
    this.telemetry.emit("experiment", universeName);
    const paramDefaults = paramDefaultsFromSchema(
      this.expsBlob?.universes[universeName]?.param_schema,
    );
    const notEnrolled = (): Assignment => new AssignmentImpl(null, null, paramDefaults ?? {});
    if (!this.expsBlob) return notEnrolled();

    // Candidate running experiments in this universe. Deterministic order:
    // pool-slice offset asc (slices are disjoint so ≤1 matches under pooling),
    // then name. A universe-held-out or unallocated unit falls through to the
    // defaults-only handle.
    const candidates = Object.entries(this.expsBlob.experiments)
      .filter(([, e]) => e.universe === universeName && e.status === "running")
      .sort(
        (a, b) => (a[1].poolOffsetBp ?? 0) - (b[1].poolOffsetBp ?? 0) || a[0].localeCompare(b[0]),
      );

    for (const [name, exp] of candidates) {
      const c = this.evalExperiment(name, exp, user);
      if (c.state === "group") {
        const group = c.group as string;
        // On-read exposure (spec step 7): defer the single exposure to the first
        // param read via the callback, instead of firing it here at assign time.
        return new AssignmentImpl(name, group, c.params ?? {}, () =>
          this.postExposure(user, name, group),
        );
      }
      // "holdout"/"out": try the next candidate — under pooling only one slice
      // can match, so the loop naturally lands on the winner (or falls through).
    }
    return notEnrolled();
  }

  /**
   * The universe-first experiment read entry point:
   * `engine.universe("checkout").assign(user)`. Returns a reusable handle bound
   * to one universe; `assign(user)` picks the ≤1 experiment the unit is pooled
   * into and auto-logs a single exposure. See {@link assignUniverse}.
   */
  universe(name: string): { assign(user: User): Assignment } {
    return { assign: (user: User) => this.assignUniverse(name, user) };
  }

  /** Drop caller-marked private attributes from an outbound props bag. */
  private stripPrivate(
    props: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!props || this.privateAttributes.length === 0) return props;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!this.privateAttributes.includes(k)) out[k] = v;
    }
    return out;
  }

  track(userId: string, eventName: string, props?: Record<string, unknown>): void {
    if (this.offline) return; // no-op when the network is disabled
    const safeProps = this.stripPrivate(props);
    const body = JSON.stringify({
      events: [
        {
          type: "metric",
          event_name: eventName,
          user_id: userId,
          ts: Date.now(),
          ...(safeProps !== undefined ? { properties: safeProps } : {}),
        },
      ],
    });
    globalThis
      .fetch(`${this.baseUrl}/collect`, {
        method: "POST",
        headers: { "X-SDK-Key": this.apiKey, "Content-Type": "text/plain" },
        body,
      })
      .catch((err) => logger.warn("[shipeasy] track failed:", String(err)));
  }

  /**
   * POST a single exposure for an enrolled `(user, experiment, group)`. Deduped
   * per process (bounded set) so repeated `assign()` calls in one server don't
   * spam `/collect`. Fire-and-forget; no-op when the network is disabled. This
   * is how `assignUniverse` auto-logs — the browser's auto-exposure parity for SSR.
   */
  private postExposure(user: User, experiment: string, group: string): void {
    if (this.offline) return;
    const uid = user.user_id ?? user.anonymous_id;
    const dedupKey = `${uid ?? ""}:${experiment}:${group}`;
    if (this.exposureSeen.has(dedupKey)) return;
    if (this.exposureSeen.size > 5000) this.exposureSeen.clear();
    this.exposureSeen.add(dedupKey);
    const body = JSON.stringify({
      events: [
        {
          type: "exposure",
          experiment,
          group,
          ...(user.user_id !== undefined ? { user_id: user.user_id } : {}),
          ...(user.anonymous_id !== undefined ? { anonymous_id: user.anonymous_id } : {}),
          ts: Date.now(),
        },
      ],
    });
    globalThis
      .fetch(`${this.baseUrl}/collect`, {
        method: "POST",
        headers: { "X-SDK-Key": this.apiKey, "Content-Type": "text/plain" },
        body,
      })
      .catch((err) => logger.warn("[shipeasy] exposure send failed:", String(err)));
  }

  /**
   * Report a structured error into the errors primitive. Fire-and-forget —
   * never blocks or throws into the request path. Spam-guarded by a 30s
   * dedup window + per-process cap.
   */
  reportError(
    problem: unknown,
    consequence: Consequence,
    extras?: SeeExtras,
    kind?: SeeKind,
  ): void {
    if (this.offline) return; // no-op when the network is disabled
    try {
      // Ambient per-request correlation token (seeded by the safety-net hook).
      // Read here so `see()` stays vanilla — no caller ever passes an id.
      const correlationId = seeContext.getStore()?.correlationId;
      const ev = buildSeeEvent(problem, consequence, extras, {
        side: "server",
        sdkVersion: version,
        env: this.env,
      }, kind, correlationId);
      if (!this.seeLimiter.shouldSend(ev)) return;
      globalThis
        .fetch(`${this.baseUrl}/collect`, {
          method: "POST",
          headers: { "X-SDK-Key": this.apiKey, "Content-Type": "text/plain" },
          body: JSON.stringify({ events: [ev] }),
        })
        .catch((err) => logger.warn("[shipeasy] see() send failed:", String(err)));
    } catch {
      /* error reporting must never throw into product code */
    }
  }

  /**
   * Evaluate all flags, configs, and experiments for a user against the locally
   * cached blob (no network call). Applies ?se_ks_* / ?se_cf_* / ?se_exp_*
   * overrides from the request URL when provided.
   *
   * Intended for SSR: call on the server, inject the result as
   * `window.__SE_BOOTSTRAP` in the HTML, and the client SDK will read it
   * synchronously without waiting for identify() to resolve.
   */
  evaluate(user: User, rawUrl?: string): BootstrapPayload {
    const flags: Record<string, boolean> = {};
    const configs: Record<string, unknown> = {};
    const experiments: Record<string, ExperimentResult<Record<string, unknown>>> = {};
    const killswitches: Record<string, boolean | Record<string, boolean>> = {};

    for (const [name, gate] of Object.entries(this.flagsBlob?.gates ?? {})) {
      this.telemetry.emit("gate", name);
      flags[name] = evalGateInternal(gate, user);
    }

    for (const [name, entry] of Object.entries(this.flagsBlob?.configs ?? {})) {
      this.telemetry.emit("config", name);
      configs[name] = entry.value;
    }

    // Per-universe param defaults so the client can resolve `universe(name).get()`
    // to a default even when the unit is not enrolled anywhere in the universe.
    const universes: Record<string, { defaults: Record<string, unknown> }> = {};
    for (const [name, exp] of Object.entries(this.expsBlob?.experiments ?? {})) {
      this.telemetry.emit("experiment", exp.universe);
      const uniName = exp.universe;
      if (!(uniName in universes)) {
        universes[uniName] = {
          defaults: paramDefaultsFromSchema(this.expsBlob?.universes[uniName]?.param_schema) ?? {},
        };
      }
      const c = this.evalExperiment(name, exp, user);
      experiments[name] =
        c.state === "group"
          ? { inExperiment: true, group: c.group as string, params: c.params ?? {}, universe: uniName }
          : { inExperiment: false, group: "control", params: {}, universe: uniName };
    }

    for (const [name, ks] of Object.entries(this.flagsBlob?.killswitches ?? {})) {
      this.telemetry.emit("ks", name);
      if (ks.switches && Object.keys(ks.switches).length > 0) {
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(ks.switches)) out[k] = isEnabled(v);
        killswitches[name] = out;
      } else {
        killswitches[name] = isEnabled(ks.killed);
      }
    }

    if (rawUrl) {
      const ov = parseOverrides(rawUrl);
      Object.assign(flags, ov.gates);
      Object.assign(configs, ov.configs);
      for (const [name, group] of Object.entries(ov.experiments)) {
        const uni = this.expsBlob?.experiments[name]?.universe;
        experiments[name] = { inExperiment: true, group, params: {}, ...(uni ? { universe: uni } : {}) };
      }
    }

    return { flags, configs, experiments, killswitches, universes };
  }

  getKillswitch(name: string, switchKey?: string): boolean {
    this.telemetry.emit("ks", name);
    const ks = this.flagsBlob?.killswitches?.[name];
    if (!ks) return false;
    if (switchKey === undefined) return isEnabled(ks.killed);
    // Named-switch semantics (cross-SDK contract): a configured switch key wins;
    // an UNCONFIGURED key falls back to the kill switch's top-level `killed`
    // value (so `getKillswitch(name, variable)` is safe before any per-key
    // override is published).
    const switches = ks.switches ?? {};
    if (Object.prototype.hasOwnProperty.call(switches, switchKey)) {
      return isEnabled(switches[switchKey]);
    }
    return isEnabled(ks.killed);
  }
}

// ---- i18n SSR helpers ----
//
// The `i18n` facade fetches translation labels per-request and makes them
// available to `i18n.t()` calls inside "use client" components during SSR.
//
// Cross-bundle communication: the server module writes a getter into a shared
// Symbol.for global; the client module reads it. Symbol.for() is registry-global
// so it works even when server and client are separate JS bundles.
//
// AsyncLocalStorage (Node.js / CF Workers) provides per-request isolation so
// concurrent requests don't mix translation data.

const _I18N_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n");
const _EDIT_MODE_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode");

interface I18nStore {
  strings: Record<string, string>;
  locale: string;
}

const _i18nALS = new AsyncLocalStorage<I18nStore>();

// i18n strings are not request-specific — they're per-profile data shared by
// every visitor on the same locale. React Server Components each render in
// their own async context, so layout's `enterWith()` doesn't propagate to the
// page's renderer. To make the SSR strings reachable across components in the
// same request (and across module-instance boundaries between Next.js's RSC,
// SSR and edge layers), we also park them on a registry-shared globalThis Map
// keyed by profile. ALS is still the read fast path; the global Map is the
// fallback when an async resource boundary blanked the store.
//
// Each entry carries `fetchedAt` so the cache expires: without it, the first
// successful fetch pins the strings for the lifetime of the (potentially
// long-lived) worker isolate, so an admin edit to a label never becomes visible
// — the SSR bootstrap keeps embedding the stale value. The TTL mirrors the
// `next: { revalidate: 60 }` on the underlying fetch, so a published change
// propagates within ~60s instead of "never until the isolate recycles".
const _I18N_CACHE_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n-cache");
const I18N_CACHE_TTL_MS = 60_000;
type CachedI18n = I18nStore & { fetchedAt: number };
type I18nCache = Map<string, CachedI18n>;
const _i18nCache: I18nCache =
  ((globalThis as Record<symbol, unknown>)[_I18N_CACHE_SYM] as I18nCache | undefined) ??
  ((globalThis as Record<symbol, unknown>)[_I18N_CACHE_SYM] = new Map<string, CachedI18n>());

// Register i18n getter into global symbol so the client module can read it
// during SSR without importing this server module. Read order:
//   1. Current async-context's ALS store (set by this request's i18n.init)
//   2. Global per-profile cache populated by any earlier successful fetch
//      (lets sibling Server Components share strings even when their async
//      contexts were spawned independently and ALS doesn't propagate).
(globalThis as Record<symbol, unknown>)[_I18N_SSR_SYM] = () => {
  const fromALS = _i18nALS.getStore();
  if (fromALS && Object.keys(fromALS.strings).length > 0) return fromALS;
  // Fall back to the most-recently-populated profile entry. With a single
  // app-wide profile this is unambiguous; multi-profile apps should pass
  // i18nDefaultProfile per request and accept that this fallback is best-effort.
  for (const v of _i18nCache.values()) {
    if (Object.keys(v.strings).length > 0) return v;
  }
  return fromALS ?? null;
};

// Edit mode: per-request via AsyncLocalStorage to prevent one request's
// `?se_edit_labels=1` from poisoning every other concurrent request in the
// same isolate (CF Workers / Node SSR).
//
// Next.js bundles this module separately into RSC, SSR and edge layers, so
// each gets its own JS evaluation. To make all of them agree on ONE ALS
// instance (otherwise the setter in layer A writes to a different store than
// the getter in layer B reads from), the ALS itself is parked on globalThis
// under a registry-shared Symbol.for() key.
const _EDIT_MODE_ALS_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode-als");
type GlobalWithALS = Record<symbol, unknown> & {
  [_EDIT_MODE_ALS_SYM]?: AsyncLocalStorage<boolean>;
};
const _editModeALS: AsyncLocalStorage<boolean> =
  ((globalThis as GlobalWithALS)[_EDIT_MODE_ALS_SYM] as AsyncLocalStorage<boolean> | undefined) ??
  ((globalThis as GlobalWithALS)[_EDIT_MODE_ALS_SYM] = new AsyncLocalStorage<boolean>());

// Reads check ALS first (correct per-request value when async context still
// chains through to the renderer); fall back to a process-global last-write
// when React's render boundary spawned a fresh async resource that lost the
// ALS store. The fallback can be wrong under concurrent requests with
// different edit-modes — accepted because (a) edit mode is a dev-time
// flag rarely toggled per request and (b) ALS still wins when it has data.
const _EDIT_MODE_FALLBACK_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode-fallback");
type GlobalWithFallback = Record<symbol, unknown> & { [_EDIT_MODE_FALLBACK_SYM]?: boolean };
if ((globalThis as GlobalWithFallback)[_EDIT_MODE_FALLBACK_SYM] === undefined) {
  (globalThis as GlobalWithFallback)[_EDIT_MODE_FALLBACK_SYM] = false;
}
Object.defineProperty(globalThis, _EDIT_MODE_SSR_SYM, {
  get: () =>
    _editModeALS.getStore() ??
    ((globalThis as GlobalWithFallback)[_EDIT_MODE_FALLBACK_SYM] as boolean | undefined) ??
    false,
  set: (v: unknown) => {
    const b = Boolean(v);
    // workerd does not implement AsyncLocalStorage.enterWith() — every
    // assignment to the SSR symbol would crash the worker with
    // "asyncLocalStorage.enterWith() is not implemented". Swallow it; the
    // fallback global below still gives us a per-isolate value (correctness
    // only degrades under concurrent requests with mixed edit-mode, which
    // is dev-only and rare).
    try {
      _editModeALS.enterWith(b);
    } catch {
      /* workerd: enterWith unsupported, fall back to global below */
    }
    (globalThis as GlobalWithFallback)[_EDIT_MODE_FALLBACK_SYM] = b;
  },
  configurable: true,
});

// see() correlation: a per-request token (minted client-side, sent up on the
// `X-SE-Correlation` header) parked in ALS so every server `see()` in the
// request auto-attaches it — joining the client + server issues across the
// network boundary the in-process `.cause` chain can't cross (see core.ts
// `findCausedBy`). Parked on a registry-shared Symbol so all of Next's bundle
// layers (RSC / SSR / edge / instrumentation) share ONE instance: the
// safety-net hook seeds it via `seeContext.run(...)`, `reportError` reads it.
// `run()` is used (not `enterWith`, which workerd lacks).
interface SeeCorrelationStore {
  correlationId?: string;
}
const _SEE_CORR_ALS_SYM = Symbol.for("@shipeasy/sdk:see-correlation-als");
type GlobalWithSeeALS = Record<symbol, unknown> & {
  [_SEE_CORR_ALS_SYM]?: AsyncLocalStorage<SeeCorrelationStore>;
};
export const seeContext: AsyncLocalStorage<SeeCorrelationStore> =
  ((globalThis as GlobalWithSeeALS)[_SEE_CORR_ALS_SYM] as
    | AsyncLocalStorage<SeeCorrelationStore>
    | undefined) ??
  ((globalThis as GlobalWithSeeALS)[_SEE_CORR_ALS_SYM] = new AsyncLocalStorage<SeeCorrelationStore>());

// Re-exported so a server error boundary (e.g. Next's onRequestError) can skip
// errors a handler already reported + marked via see.ControlFlowException.
export { isExpected };

export interface I18nForRequest {
  strings: Record<string, string>;
  locale: string;
}

export const i18n = {
  /**
   * Fetch translation labels for the current request and store them in an
   * async-local context so `i18n.t()` / `i18n.tEl()` in SSR'd client
   * components return the real translated strings instead of the key.
   *
   * Call once per request in the root layout (or page). Failure is silent —
   * `i18n.t()` falls back to the hardcoded fallback arg when no labels are
   * loaded.
   *
   * @param key     SDK client key (NEXT_PUBLIC_SHIPEASY_CLIENT_KEY)
   * @param profile i18n profile identifier, e.g. "en:prod"
   * @param cdnBaseUrl Optional override for the i18n CDN (default: cdn.i18n.shipeasy.ai)
   */
  async init(key: string, profile: string, cdnBaseUrl?: string): Promise<void> {
    // Skip if THIS request's ALS already has loaded strings.
    const existingALS = _i18nALS.getStore();
    if (existingALS && Object.keys(existingALS.strings).length > 0) return;
    // Skip the fetch if the global cache has a *fresh* entry (any prior request,
    // or a sibling Server Component in this request that ran first with a good
    // key). Still call enterWith so this async ctx's getStore() works. Entries
    // older than the TTL fall through to a re-fetch so published edits surface.
    const cached = _i18nCache.get(profile);
    if (
      cached &&
      Object.keys(cached.strings).length > 0 &&
      Date.now() - cached.fetchedAt < I18N_CACHE_TTL_MS
    ) {
      _i18nALS.enterWith(cached);
      return;
    }
    const labels = await fetchLabelsForSSR({ key, profile, cdnBaseUrl }).catch(() => null);
    const locale = profile.split(":")[0] || "en";
    const store: I18nStore = { strings: labels?.strings ?? {}, locale };
    if (Object.keys(store.strings).length > 0) {
      _i18nCache.set(profile, { ...store, fetchedAt: Date.now() });
    } else if (cached && Object.keys(cached.strings).length > 0) {
      // Re-fetch failed (network blip / transient 5xx) but we still hold a stale
      // entry — keep serving it rather than regressing to key fallbacks. Leave
      // its timestamp so the next request retries instead of pinning the stale
      // copy for another full TTL.
      _i18nALS.enterWith(cached);
      return;
    }
    _i18nALS.enterWith(store);
  },

  /**
   * Return the translation strings loaded for the current request.
   * Use this to include i18n data in the SSR bootstrap payload so the
   * client doesn't need an extra network round-trip.
   */
  getForRequest(): I18nForRequest {
    return _i18nALS.getStore() ?? { strings: {}, locale: "en" };
  },
};

export interface LabelFile {
  v: number;
  profile: string;
  chunk: string;
  strings: Record<string, string>;
}

export interface FetchLabelsOptions {
  key: string;
  profile: string;
  chunk?: string;
  cdnBaseUrl?: string;
  timeoutMs?: number;
}

// The SDK ships a single CDN host. The historical "labels manifest" endpoint
// (`cdn.i18n.shipeasy.ai/labels/{key}/{profile}/manifest.json`) was never wired
// up in the worker, so SSR i18n always returned empty strings — and the page
// rendered raw `{{var}}` templates and key fallbacks. The actual production
// endpoint is `cdn.shipeasy.ai/sdk/i18n/strings`, the same one the client
// loader hits, returning `{ locale, strings }` for the requested profile.
const DEFAULT_I18N_CDN = "https://cdn.shipeasy.ai";

async function fetchJson<T>(
  url: string,
  timeoutMs = 2000,
  headers?: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers,
      next: { revalidate: 60 },
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLabelsForSSR(opts: FetchLabelsOptions): Promise<LabelFile | null> {
  const cdn = opts.cdnBaseUrl ?? DEFAULT_I18N_CDN;
  try {
    const body = await fetchJson<{ locale: string; strings: Record<string, string> }>(
      `${cdn}/sdk/i18n/strings?profile=${encodeURIComponent(opts.profile)}`,
      opts.timeoutMs,
      { "X-SDK-Key": opts.key },
    );
    return {
      v: 1,
      profile: opts.profile,
      chunk: opts.chunk ?? "default",
      strings: body.strings ?? {},
    };
  } catch {
    return null;
  }
}

// ---- Module-scope singleton ----
//
// Mirrors the client SDK pattern: configure once at app boot, then call
// the `flags` facade from any module without passing the Engine
// around. Methods return safe defaults when the singleton hasn't been
// configured (or after destroy()), so importing `flags` into a module
// that loads before the configure() call is harmless.

let _server: Engine | null = null;

export function configureShipeasyServer(opts: EngineOptions): Engine {
  if (_server) return _server;
  _server = new Engine(opts);
  return _server;
}

export function getShipeasyServerClient(): Engine | null {
  return _server;
}

export function _resetShipeasyServerForTests(): void {
  _server?.destroy();
  _server = null;
}

// ---- Unified top-level configure API ----

export interface ShipeasyServerConfig {
  /**
   * Server key — the ONLY key the server entrypoint accepts. Authenticates
   * flag/experiment fetches (requireKey("server")) AND SSR i18n string fetches
   * (the /sdk/i18n/strings route accepts the server key for server-side use).
   * Never embedded in browser output. The browser uses its own client key via
   * `shipeasy({ clientKey })` from `@shipeasy/sdk/client` — the server never
   * sees or forwards the client key. If omitted, flag/experiment/i18n loading
   * is skipped and an error is logged.
   */
  serverKey?: string;
  /** Raw URL or query string for applying ?se_ks_* / ?se_cf_* / ?se_exp_* overrides. */
  urlOverrides?: string;
  /** User attributes for flag and experiment evaluation. */
  user?: User;
  /** i18n profile to load for SSR translations, e.g. "en:prod". Defaults to "en:prod". */
  i18nDefaultProfile?: string;
  /** i18n behaviour toggles (shared process-wide with the browser `i18n.t()`). */
  i18n?: {
    /**
     * Render each i18n key verbatim instead of resolving its translated value,
     * so tests/snapshots assert against stable data. Defaults to `true` when the
     * runtime env is `"test"` (`SHIPEASY_ENV` / `NODE_ENV`), `false` otherwise.
     * Applies to `i18n.t()` calls in SSR'd "use client" components too.
     */
    renderKeysOnly?: boolean;
  };
  /**
   * How chatty the SDK is on `console` when it swallows an internal error.
   * `silent` < `error` < `warn` < `info` < `debug`; defaults to `"warn"`. Every
   * runtime read/track/see call fails silently to a safe default and reports the
   * cause at this level. See {@link EngineOptions.logLevel}.
   */
  logLevel?: LogLevel;
  /**
   * Master network switch — `false` puts the SDK fully offline (no fetch, no
   * track, no telemetry, no error self-monitoring). Defaults to
   * environment-derived: ON in production, OFF everywhere else. See
   * {@link EngineOptions.isNetworkEnabled}.
   */
  isNetworkEnabled?: boolean;
  /**
   * Disable per-evaluation usage telemetry ("tracking"). Defaults to
   * environment-derived: ON in production, OFF everywhere else. On Cloudflare
   * Workers each beacon is an outbound subrequest, so disable on hot SSR paths
   * that evaluate many flags per request. See {@link EngineOptions.disableTelemetry}.
   */
  disableTelemetry?: boolean;
  /**
   * Opt out of SDK-internal error self-monitoring. Internal SDK failures ("on
   * our end") are reported to Shipeasy's own project (never yours) so we can
   * track SDK bugs. ON by default. See
   * {@link EngineOptions.disableInternalErrorReporting}.
   */
  disableInternalErrorReporting?: boolean;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). Stripped from every outbound `track()`
   * payload. See {@link EngineOptions.privateAttributes}.
   */
  privateAttributes?: string[];
}

export interface ShipeasyServerHandle {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, ExperimentResult<Record<string, unknown>>>;
  /**
   * Structured `<script>` tag specs to drop into the document head: the
   * cross-platform `se-bootstrap.js` tag (hydrates window.__SE_BOOTSTRAP +
   * writes the anon cookie) and, when there are SSR strings or a client key,
   * the i18n loader tag. Use this in React: scripts inserted via
   * `dangerouslySetInnerHTML` do NOT execute, so render real `<script>`
   * elements from these specs (see apps/ui root layout).
   */
  getBootstrapData(emit?: BootstrapEmitOptions): BootstrapData;
  /**
   * The same tags rendered as an HTML string, for non-React SSR (Express, raw
   * templates) where the markup is emitted directly into the served HTML (and
   * therefore executes normally). This is the canonical cross-platform shape
   * every server SDK mirrors.
   */
  getBootstrapTags(emit?: BootstrapEmitOptions): string;
}

/**
 * Initialise the ShipEasy server SDK, evaluate flags for this request, and
 * return a handle. Call once per request in your root layout (or page for
 * URL-override support). Failure is non-fatal — evaluation returns empty
 * payloads and i18n falls back to hardcoded strings.
 */
export async function shipeasy(opts: ShipeasyServerConfig): Promise<ShipeasyServerHandle> {
  // The server entrypoint uses ONE key: the server key. It authenticates
  // /sdk/flags + /sdk/experiments (requireKey("server")) and SSR i18n
  // (/sdk/i18n/strings now accepts the server key for server-side use). The
  // client key never reaches the server — the browser configures itself with
  // its own client key via `shipeasy({ clientKey })` from @shipeasy/sdk/client.
  // If the server key is missing, skip every fetch and log a loud, actionable
  // error rather than firing a doomed request.
  const serverKey = opts.serverKey ?? "";
  if (!serverKey) {
    logger.error(
      "[shipeasy] No server key — flags, experiments and SSR i18n skipped. Pass " +
        "`serverKey` to shipeasy() from @shipeasy/sdk/server with your server key " +
        "(SHIPEASY_SERVER_KEY). Set it as a Worker secret with " +
        "`wrangler secret put SHIPEASY_SERVER_KEY` (or add it to .env for local dev). " +
        "Do not pass a client key here — the server entrypoint only accepts the server key.",
    );
  }
  const profile = opts.i18nDefaultProfile ?? "en:prod";
  // Honour an explicit renderKeysOnly override (else it defaults to env==test);
  // the flag is shared with the client-module i18n.t() used during SSR.
  setI18nRenderKeysOnly(opts.i18n?.renderKeysOnly);
  flags.configure({
    apiKey: serverKey,
    isNetworkEnabled: opts.isNetworkEnabled,
    disableTelemetry: opts.disableTelemetry,
    disableInternalErrorReporting: opts.disableInternalErrorReporting,
    privateAttributes: opts.privateAttributes,
    logLevel: opts.logLevel,
  });
  // Resolve URL overrides: explicit opts.urlOverrides wins; otherwise try
  // (a) the x-se-search header (injected by middleware when one is wired up)
  // and (b) the `se_edit_labels` cookie that the inline patcher sets on the
  // browser the first time it sees `?se_edit_labels=1`. The cookie is what
  // makes SSR aware of edit-mode in deployments without middleware (apps
  // running on opennext-cloudflare don't yet have a Node-runtime proxy).
  let resolvedUrlOverrides = opts.urlOverrides;
  if (!resolvedUrlOverrides) {
    try {
      // Dynamic import keeps Next.js out of the SDK's hard dependency graph.
      // Falls back silently in non-Next.js runtimes (Cloudflare Workers, etc.).
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — next/headers is an optional peer; absent in non-Next.js runtimes
      const { headers, cookies } = (await import("next/headers")) as {
        headers: () => Promise<Headers> | Headers;
        cookies: () => Promise<{ get: (n: string) => { value: string } | undefined }> | {
          get: (n: string) => { value: string } | undefined;
        };
      };
      const h = await Promise.resolve(headers());
      const search = h.get("x-se-search") ?? "";
      if (search) {
        resolvedUrlOverrides = search;
      } else {
        const c = await Promise.resolve(cookies());
        if (c.get?.("se_edit_labels")?.value === "1") {
          resolvedUrlOverrides = "se_edit_labels=1";
        }
      }
    } catch {}
  }
  // Set edit mode before i18n.init() idempotency check so the page's
  // ?se_edit_labels param always wins even when layout ran first.
  const editLabels = resolvedUrlOverrides
    ? new URLSearchParams(resolvedUrlOverrides).has("se_edit_labels")
    : false;
  (globalThis as Record<symbol, unknown>)[_EDIT_MODE_SSR_SYM] = editLabels;
  await Promise.allSettled([
    serverKey ? flags.initOnce() : Promise.resolve(),
    serverKey ? i18n.init(serverKey, profile) : Promise.resolve(),
  ]);

  // Resolve the stable anonymous bucketing unit. Precedence:
  //   1. an explicit user_id from the caller (authenticated) — no anon needed
  //   2. an explicit anonymous_id from the caller
  //   3. the `__se_anon_id` cookie — minted by edge middleware on the first
  //      request (and forwarded to this render via the request headers), or
  //      persisted by a previous response's bootstrap script
  //   4. a freshly minted id — defensive fallback for the first request on a
  //      route middleware doesn't cover; the bootstrap script then persists it
  // This is the SAME value the browser SDK adopts (cookie / bootstrap), so SSR
  // and client bucket identically at any rollout %. The cookie name + format are
  // a cross-SDK contract — see experiment-platform/18-identity-bucketing.md.
  let anonId: string | undefined;
  if (!opts.user?.user_id) {
    if (opts.user?.anonymous_id) {
      // Explicit caller value — trusted, used verbatim.
      anonId = opts.user.anonymous_id;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — next/headers is an optional peer; absent in non-Next.js runtimes
        const { cookies } = (await import("next/headers")) as {
          cookies: () =>
            | Promise<{ get: (n: string) => { value: string } | undefined }>
            | { get: (n: string) => { value: string } | undefined };
        };
        const c = await Promise.resolve(cookies());
        const raw = c.get?.(ANON_ID_COOKIE)?.value;
        if (raw && ANON_ID_RX.test(raw)) anonId = raw; // untrusted cookie — validated
      } catch {}
      if (!anonId) anonId = mintAnonId(); // no/invalid cookie → fresh id
    }
  }
  const effectiveUser: User = anonId
    ? { anonymous_id: anonId, ...opts.user }
    : { ...opts.user };

  const bootstrap = flags.evaluate(effectiveUser, resolvedUrlOverrides);
  const i18nData = i18n.getForRequest();

  return {
    flags: bootstrap.flags,
    configs: bootstrap.configs,
    experiments: bootstrap.experiments,
    getBootstrapData(emit?: BootstrapEmitOptions) {
      return getBootstrapData(bootstrap, i18nData, {
        i18nProfile: profile,
        anonId,
        ...emit,
      });
    },
    getBootstrapTags(emit?: BootstrapEmitOptions) {
      return getBootstrapTags(bootstrap, i18nData, {
        i18nProfile: profile,
        anonId,
        ...emit,
      });
    },
  };
}

// ---- Framework-agnostic bootstrap tag helpers ----
//
// The SSR payload now rides DECLARATIVE <script> tags carrying data-* attrs,
// not a server-generated inline JS blob. Two tags:
//   1. <script src=".../sdk/bootstrap.js" data-se-bootstrap data-flags=… …>
//      — the loader reads its own attrs, hydrates window.__SE_BOOTSTRAP (NO
//      key) and writes the __se_anon_id cookie pre-paint.
//   2. <script src=".../sdk/i18n/loader.js" data-profile data-strings …>
//      — installs SSR strings for first paint (no flash, no fetch); with a
//      client key it also revalidates at runtime.
// Because the data is declarative, EVERY server SDK emits the same markup —
// this TS helper is just the reference implementation.
//
// The old inline edit-labels shim moved to the devtools bundle (it owns the
// whole label-editing loop); the old inline i18n shim is replaced by the
// loader's data-strings path.

export interface BootstrapEmitOptions {
  /** i18n profile recorded on both tags so the client loader matches SSR. Defaults to "en:prod". */
  i18nProfile?: string;
  /**
   * Stable anonymous bucketing id the server evaluated against. Emitted as
   * `data-anon-id`; se-bootstrap.js exposes it on window.__SE_BOOTSTRAP and
   * persists it (pre-paint) to the first-party `__se_anon_id` cookie, so the
   * browser SDK buckets identically to SSR. Normally minted by edge
   * middleware; this is the fallback for routes it doesn't cover. See
   * experiment-platform/18-identity-bucketing.md.
   */
  anonId?: string;
  /**
   * Public client key. When provided, the i18n loader tag can revalidate
   * strings at runtime (`data-key`). Optional — the bootstrap tag NEVER carries
   * a key, and SSR first paint works keyless via `data-strings`.
   */
  clientKey?: string;
  /** CDN base for the tag `src`s. Defaults to https://cdn.shipeasy.ai. */
  baseUrl?: string;
}

export interface ScriptTagSpec {
  src: string;
  /** Attribute name → value. An empty-string value renders as a bare boolean attribute (e.g. `data-se-bootstrap`). */
  attrs: Record<string, string>;
}

export interface BootstrapData {
  /** se-bootstrap.js tag — always present. */
  bootstrap: ScriptTagSpec;
  /** i18n loader tag — null when there are no SSR strings and no client key. */
  i18nLoader: ScriptTagSpec | null;
}

const DEFAULT_CDN = "https://cdn.shipeasy.ai";

/**
 * Build the structured `<script>` tag specs for the SSR bootstrap. Render
 * these as REAL `<script>` elements (React: scripts set via innerHTML do not
 * execute). No SDK key is ever embedded in the bootstrap tag.
 */
export function getBootstrapData(
  bootstrap: BootstrapPayload | null,
  i18nData: I18nForRequest | null,
  opts: BootstrapEmitOptions,
): BootstrapData {
  const base = (opts.baseUrl ?? DEFAULT_CDN).replace(/\/$/, "");
  const profile = opts.i18nProfile ?? "en:prod";

  const attrs: Record<string, string> = {
    "data-se-bootstrap": "",
    "data-flags": JSON.stringify(bootstrap?.flags ?? {}),
    "data-configs": JSON.stringify(bootstrap?.configs ?? {}),
    "data-experiments": JSON.stringify(bootstrap?.experiments ?? {}),
    "data-killswitches": JSON.stringify(bootstrap?.killswitches ?? {}),
    "data-i18n-profile": profile,
    "data-api-url": base,
  };
  if (opts.anonId) attrs["data-anon-id"] = opts.anonId;
  const bootstrapTag: ScriptTagSpec = { src: `${base}/sdk/bootstrap.js`, attrs };

  let i18nLoader: ScriptTagSpec | null = null;
  const hasStrings = !!(i18nData?.strings && Object.keys(i18nData.strings).length > 0);
  if (hasStrings || opts.clientKey) {
    const i18nAttrs: Record<string, string> = { "data-profile": profile };
    if (opts.clientKey) i18nAttrs["data-key"] = opts.clientKey;
    if (hasStrings) {
      i18nAttrs["data-strings"] = JSON.stringify(i18nData!.strings);
      i18nAttrs["data-locale"] = i18nData!.locale;
    }
    i18nLoader = { src: `${base}/sdk/i18n/loader.js`, attrs: i18nAttrs };
  }

  return { bootstrap: bootstrapTag, i18nLoader };
}

/** Escape a value for safe inclusion in a double-quoted HTML attribute. */
function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderScriptTag(spec: ScriptTagSpec): string {
  const attrs = Object.entries(spec.attrs)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join("");
  return `<script src="${escapeAttr(spec.src)}"${attrs}></script>`;
}

/**
 * The bootstrap (and optional i18n loader) tags as an HTML string, for non-React
 * SSR (Express, raw templates) where the markup is emitted directly into the
 * served HTML and executes normally. React callers should use
 * {@link getBootstrapData} and render real `<script>` elements instead.
 */
export function getBootstrapTags(
  bootstrap: BootstrapPayload | null,
  i18nData: I18nForRequest | null,
  opts: BootstrapEmitOptions,
): string {
  const data = getBootstrapData(bootstrap, i18nData, opts);
  const tags = [data.bootstrap];
  if (data.i18nLoader) tags.push(data.i18nLoader);
  return tags.map(renderScriptTag).join("");
}

export const flags = {
  configure(opts: EngineOptions): void {
    configureShipeasyServer(opts);
  },
  /**
   * Long-running server: starts the background poll. Call once at app boot.
   * Throws if the initial fetch fails (caller decides whether to crash or degrade).
   */
  init(): Promise<void> {
    if (!_server) throw new Error("[shipeasy] flags.init called before configure()");
    return _server.init();
  },
  /** Serverless / edge: fetch rules once, no background timer. */
  initOnce(): Promise<void> {
    if (!_server) throw new Error("[shipeasy] flags.initOnce called before configure()");
    return _server.initOnce();
  },
  /** Stop background timers. Safe to call repeatedly. */
  destroy(): void {
    _server?.destroy();
  },
  get(name: string, user: User, defaultValue = false): boolean {
    return safeRun("flags.get", defaultValue, () => _server?.getFlag(name, user, defaultValue) ?? defaultValue);
  },
  /** Evaluate a gate and report why (value + reason). See {@link FlagDetail}. */
  getDetail(name: string, user: User): FlagDetail {
    return safeRun<FlagDetail>("flags.getDetail", { value: false, reason: "CLIENT_NOT_READY" }, () =>
      _server?.getFlagDetail(name, user) ?? { value: false, reason: "CLIENT_NOT_READY" },
    );
  },
  getConfig<T = unknown>(
    name: string,
    decodeOrOpts?: ((raw: unknown) => T) | GetConfigOptions<T>,
  ): T | undefined {
    // Forward the legacy decode callback OR the options object unchanged.
    return safeRun<T | undefined>("flags.getConfig", undefined, () =>
      _server?.getConfig(name, decodeOrOpts as GetConfigOptions<T>),
    );
  },
  /**
   * Assign `user` within a universe: `flags.universe("checkout").assign(user)`.
   * A universe is a mutual-exclusion pool, so the unit lands in ≤1 experiment;
   * the returned {@link Assignment} exposes `.group` / `.get(field, fallback)`
   * and auto-logs one exposure when enrolled. Before configure() (or on any
   * error) it returns a safe not-enrolled handle. This replaces the removed
   * `getExperiment` — read experiments by universe, never by name.
   */
  universe(name: string): { assign(user: User): Assignment } {
    return {
      assign: (user: User): Assignment =>
        safeRun<Assignment>("flags.universe.assign", new AssignmentImpl(null, null, {}), () =>
          _server?.assignUniverse(name, user) ?? new AssignmentImpl(null, null, {}),
        ),
    };
  },
  /**
   * Read a killswitch. Without `switchKey`, returns true when the whole
   * killswitch is killed. With `switchKey`, returns true when that specific
   * switch is on. Unknown killswitches / switches return false.
   */
  ks(name: string, switchKey?: string): boolean {
    return safeRun("flags.ks", false, () => _server?.getKillswitch(name, switchKey) ?? false);
  },
  track(userId: string, eventName: string, props?: Record<string, unknown>): void {
    safeRun("flags.track", undefined, () => _server?.track(userId, eventName, props));
  },
  /**
   * Evaluate all flags / configs / experiments for a user against the locally
   * cached blob. Pass the request URL to apply ?se_ks_* / ?se_cf_* / ?se_exp_*
   * overrides. Returns an empty payload when the blob hasn't been fetched yet.
   */
  evaluate(user: User, rawUrl?: string): BootstrapPayload {
    const empty: BootstrapPayload = { flags: {}, configs: {}, experiments: {}, killswitches: {} };
    return safeRun("flags.evaluate", empty, () => _server?.evaluate(user, rawUrl) ?? empty);
  },
};

// ---- Top-level user-bound API (configure once, then `new Client(user)`) ----
//
// The ergonomic front door: configure the SDK ONCE with the api key and an
// optional transform from your own user object to targeting attributes, then
// evaluate per user with `new Client(user)`. The Client is a cheap, user-bound
// handle over the single configured Engine — it never opens its own connection
// or poller.

/** Transform YOUR application's user object into Shipeasy targeting attributes. */
export type AttributesFn<U = unknown> = (user: U) => User;

const _identityAttributes: AttributesFn = (user) =>
  user && typeof user === "object" ? (user as User) : {};

let _attributes: AttributesFn = _identityAttributes;

export interface ConfigureOptions<U = unknown> extends Omit<EngineOptions, "apiKey"> {
  /** Server key — the single key the server side accepts (SHIPEASY_SERVER_KEY). */
  apiKey: string;
  /**
   * Map your own user object into the attribute bag every flag/experiment
   * evaluation sees. Runs once per `new Client(user)`. Omit when you already
   * pass a plain attribute object (identity transform — the object is used
   * verbatim, so it should carry `user_id`/`anonymous_id` + any targeting attrs).
   */
  attributes?: AttributesFn<U>;
  /**
   * Long-running server: start the **background poll** internally (initial fetch
   * + periodic refresh) so flags stay fresh without a redeploy. Default `false`.
   * With `poll: false` (default) a one-shot fetch is kicked off fire-and-forget
   * (serverless-friendly). You never need to call `engine.init()` yourself —
   * configuration owns the lifecycle.
   */
  poll?: boolean;
  /**
   * One-shot fetch on configure (fire-and-forget). Default `true`. Ignored when
   * `poll: true` (the poll does the initial fetch). Set `false` only if you want
   * to control the first fetch yourself.
   */
  init?: boolean;
}

/**
 * Configure the SDK once at app boot, then evaluate per user with
 * `new Client(user)`. Builds the process-wide {@link Engine} (polling + blob
 * cache + HTTP) and registers the `attributes` transform. The first call wins;
 * later calls return the existing engine (mirrors {@link configureShipeasyServer}).
 *
 * ```ts
 * import { configure, Client } from "@shipeasy/sdk/server";
 *
 * configure({
 *   apiKey: process.env.SHIPEASY_SERVER_KEY!,
 *   attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan, country: u.geo.country }),
 * });
 *
 * const flags = new Client(currentUser);
 * if (flags.getFlag("new_checkout")) { ... }
 * ```
 */
export function configure<U = unknown>(opts: ConfigureOptions<U>): Engine {
  const { attributes, poll = false, init = true, ...engineOpts } = opts;
  _attributes = (attributes as AttributesFn) ?? _identityAttributes;
  const engine = configureShipeasyServer(engineOpts);
  if (poll) {
    // Long-running server: initial fetch + periodic background refresh. The
    // poll lifecycle lives inside the engine — the docs never tell a user to
    // call engine.init() themselves.
    void engine.init().catch(() => {});
  } else if (init) {
    // Default: one-shot fire-and-forget fetch so the first
    // `new Client(user).getFlag(...)` resolves against real rules
    // (serverless-friendly). Mirrors the browser SDK's auto-fetch on configure.
    void engine.initOnce().catch(() => {});
  }
  return engine;
}

/** Test seam: reset the registered attribute transform. */
export function _resetConfigureForTests(): void {
  _attributes = _identityAttributes;
}

/**
 * Replace the process-wide engine + attribute transform. Unlike
 * {@link configure} (first-config-wins), the `configureFor*` siblings REPLACE so
 * a test suite can reconfigure between cases. Destroys any previous engine's
 * poll timer first.
 */
function _installGlobalEngine<U>(engine: Engine, attributes?: AttributesFn<U>): Engine {
  _server?.destroy();
  _server = engine;
  _attributes = (attributes as AttributesFn) ?? _identityAttributes;
  return engine;
}

function _applyOverrides(
  engine: Engine,
  flags?: Record<string, boolean>,
  configs?: Record<string, unknown>,
  experiments?: Record<string, [string, Record<string, unknown>]>,
): void {
  for (const [name, value] of Object.entries(flags ?? {})) engine.overrideFlag(name, value);
  for (const [name, value] of Object.entries(configs ?? {})) engine.overrideConfig(name, value);
  for (const [name, [group, params]] of Object.entries(experiments ?? {}))
    engine.overrideExperiment(name, group, params);
}

/** Seed shapes shared by {@link configureForTesting} / {@link configureForOffline}. */
export interface ConfigureTestOptions<U = unknown> {
  /** Same transform as {@link configure} (default identity). */
  attributes?: AttributesFn<U>;
  /** `{ name: bool }` — forced `getFlag` results. */
  flags?: Record<string, boolean>;
  /** `{ name: value }` — forced `getConfig` results. */
  configs?: Record<string, unknown>;
  /** `{ name: [group, params] }` — forced enrolments. */
  experiments?: Record<string, [string, Record<string, unknown>]>;
}

/**
 * Configure the SDK in **test mode** — a drop-in sibling of {@link configure}
 * with no network, ever (no api key needed). Seed what your code under test
 * should see, then read through the ordinary `new Client(user)`:
 *
 * ```ts
 * configureForTesting({ flags: { new_checkout: true } });
 * const flags = new Client({ user_id: "u_1" });
 * flags.getFlag("new_checkout"); // true
 * ```
 *
 * Replaces any previously-configured engine, so tests can reconfigure freely.
 */
export function configureForTesting<U = unknown>(opts: ConfigureTestOptions<U> = {}): Engine {
  const engine = Engine.forTesting();
  _applyOverrides(engine, opts.flags, opts.configs, opts.experiments);
  return _installGlobalEngine(engine, opts.attributes);
}

/** Options for {@link configureForOffline} — exactly one of `snapshot` / `path`. */
export interface ConfigureOfflineOptions<U = unknown> extends ConfigureTestOptions<U> {
  /** In-memory `{ flags: <body of /sdk/flags>, experiments: <body of /sdk/experiments> }`. */
  snapshot?: { flags: FlagsBlob; experiments: ExpsBlob };
  /** Path to a JSON file `{ flags, experiments }`. */
  path?: string;
}

/**
 * Configure the SDK **offline** — evaluate the REAL rules from an in-memory
 * snapshot or a JSON file, with no network. A drop-in sibling of
 * {@link configure} (no api key needed). Optional `flags`/`configs`/`experiments`
 * overrides are layered on top (same shapes as {@link configureForTesting}).
 * Replaces any previously-configured engine.
 */
export function configureForOffline<U = unknown>(opts: ConfigureOfflineOptions<U>): Engine {
  let engine: Engine;
  if (opts.path !== undefined) {
    engine = Engine.fromFile(opts.path);
  } else if (opts.snapshot !== undefined) {
    engine = Engine.fromSnapshot(opts.snapshot);
  } else {
    throw new Error("[shipeasy] configureForOffline requires either { snapshot } or { path }");
  }
  _applyOverrides(engine, opts.flags, opts.configs, opts.experiments);
  return _installGlobalEngine(engine, opts.attributes);
}

function _requireGlobal(fn: string): Engine {
  const engine = getShipeasyServerClient();
  if (!engine) {
    throw new Error(
      `[shipeasy] ${fn}(...) called before configure({ apiKey }) (or a configureFor* sibling).`,
    );
  }
  return engine;
}

/**
 * Force `getFlag(name)` → `value` on the spot, for the current config. A quick
 * in-test override layered on top of whatever {@link configureForTesting} /
 * {@link configureForOffline} (or {@link configure}) set up — wins over the blob
 * until {@link clearOverrides}.
 */
export function overrideFlag(name: string, value: boolean): void {
  _requireGlobal("overrideFlag").overrideFlag(name, value);
}

/** Force `getConfig(name)` → `value` on the spot (see {@link overrideFlag}). */
export function overrideConfig(name: string, value: unknown): void {
  _requireGlobal("overrideConfig").overrideConfig(name, value);
}

/**
 * Force `getExperiment(name)` to report enrolment in `group` with `params` on
 * the spot (see {@link overrideFlag}).
 */
export function overrideExperiment(name: string, group: string, params: Record<string, unknown>): void {
  _requireGlobal("overrideExperiment").overrideExperiment(name, group, params);
}

/**
 * Drop every on-the-spot flag/config/experiment override — INCLUDING the seed
 * from {@link configureForTesting} (test mode has no blob beneath, so everything
 * reverts to the empty-blob defaults). Under {@link configureForOffline} the
 * snapshot remains and evaluations revert to it.
 */
export function clearOverrides(): void {
  _requireGlobal("clearOverrides").clearOverrides();
}

/**
 * Register a listener fired after a background poll fetches NEW data (a 200, not
 * a 304). Returns an unsubscribe callable. Requires `configure({ poll: true })`
 * (no poll thread runs otherwise). Configuration owns the engine; you never
 * touch it.
 */
export function onChange(listener: () => void): () => void {
  return _requireGlobal("onChange").onChange(listener);
}

/**
 * A user-bound evaluation handle. Construct one per user/request — it's cheap
 * (it delegates to the {@link Engine} built by {@link configure}); it does NOT
 * open its own connection or poll. The configured `attributes` transform runs
 * once here, so every getFlag/getConfig/getExperiment reads the same bag.
 *
 * ```ts
 * const flags = new Client(req.user);
 * flags.getFlag("new_checkout");                  // no user arg — bound at construction
 * flags.getExperiment("price_test", { price: 9 });
 * ```
 */
export class Client<U = unknown> {
  private readonly engine: Engine;
  /** The resolved attribute bag this handle evaluates against. */
  readonly attributes: User;

  constructor(user: U) {
    const engine = getShipeasyServerClient();
    if (!engine) {
      throw new Error(
        "[shipeasy] new Client(user) called before configure({ apiKey }). " +
          "Call configure() once at app boot from @shipeasy/sdk/server.",
      );
    }
    this.engine = engine;
    this.attributes = _attributes(user);
  }

  getFlag(name: string, defaultValue = false): boolean {
    return safeRun("Client.getFlag", defaultValue, () =>
      this.engine.getFlag(name, this.attributes, defaultValue),
    );
  }

  getFlagDetail(name: string): FlagDetail {
    return safeRun<FlagDetail>("Client.getFlagDetail", { value: false, reason: "CLIENT_NOT_READY" }, () =>
      this.engine.getFlagDetail(name, this.attributes),
    );
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined;
  getConfig<T = unknown>(name: string, opts: GetConfigOptions<T>): T;
  getConfig<T = unknown>(
    name: string,
    decodeOrOpts?: ((raw: unknown) => T) | GetConfigOptions<T>,
  ): T | undefined {
    return safeRun<T | undefined>("Client.getConfig", undefined, () =>
      this.engine.getConfig(name, decodeOrOpts as GetConfigOptions<T>),
    );
  }

  /**
   * Assign the bound user within a universe: `client.universe("checkout").assign()`.
   * The user is already bound at construction, so `assign()` takes no arg. Returns
   * an {@link Assignment} (`.group` / `.get(field, fallback)`) and auto-logs one
   * exposure when enrolled. Replaces the removed `getExperiment`.
   */
  universe(name: string): { assign(): Assignment } {
    return {
      assign: (): Assignment =>
        safeRun<Assignment>("Client.universe.assign", new AssignmentImpl(null, null, {}), () =>
          this.engine.assignUniverse(name, this.attributes),
        ),
    };
  }

  /** Read a killswitch (not user-bound; mirrors {@link Engine.getKillswitch}). */
  getKillswitch(name: string, switchKey?: string): boolean {
    return safeRun("Client.getKillswitch", false, () => this.engine.getKillswitch(name, switchKey));
  }

  /**
   * Record a conversion/metric event for the bound user. Derives the unit from
   * the resolved attribute bag (`user_id`, else `anonymous_id`) and delegates to
   * {@link Engine.track} — so an experiment is end-to-end Client-only (no need to
   * drop down to the Engine to log a conversion). Fire-and-forget; no-op in test
   * mode.
   */
  track(eventName: string, props?: Record<string, unknown>): void {
    safeRun("Client.track", undefined, () => {
      const id = this.attributes.user_id ?? this.attributes.anonymous_id;
      if (id === undefined) return;
      this.engine.track(String(id), eventName, props);
    });
  }
}

// ---- see (structured error reporting) ----

export interface SeeApi {
  /**
   * Report a handled problem and its product consequence:
   *
   * ```ts
   * import { see } from "@shipeasy/sdk/server";
   *
   * try {
   *   await chargeCard(order);
   * } catch (e) {
   *   see(e).causes_the("payment").to("use the backup processor").extras({ order_id: order.id });
   *   await chargeViaBackup(order);
   * }
   * ```
   *
   * The chain dispatches on the next microtask — fire-and-forget into the
   * errors primitive (grouped by fingerprint, near-real-time timeseries).
   * If you don't know the consequence of an exception, don't catch it.
   */
  (problem: unknown): SeeChain;
  /**
   * Report a non-exception problem. Prefer passing a caught Error to `see()`
   * when one exists. The name is a stable identifier (it participates in the
   * issue fingerprint) — variable data goes in `.extras()`, never the name.
   *
   * ```ts
   * if (results.length > LIMIT) {
   *   see.Violation("large query")
   *      .causes_the("search results").to("be trimmed").extras({ rows: results.length });
   * }
   * ```
   */
  Violation(name: string): SeeViolationChain;
  /**
   * Mark an exception as expected control flow — documents the expectation and
   * reports nothing. Say why with `.because()` (reason should start with
   * "because"); attach optional debug context with `.extras()`.
   *
   * ```ts
   * see.ControlFlowException(e).because("because the metric may not exist yet");
   * ```
   */
  ControlFlowException(err: unknown): SeeControlFlowChain;
}

function dispatchSee(
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  kind?: SeeKind,
): void {
  if (!_server) {
    logger.warn("[shipeasy] see() called before shipeasy({ serverKey }) — error dropped");
    return;
  }
  _server.reportError(problem, consequence, extras, kind);
}

/**
 * Structured error reporter — the whole grammar hangs off this one import.
 * Safe to import anywhere; a call before `shipeasy({ serverKey })` warns and
 * drops (never throws).
 */
export const see: SeeApi = Object.assign(
  (problem: unknown): SeeChain => startSeeChain(() => problem, dispatchSee),
  {
    Violation: (name: string): SeeViolationChain => startSeeViolationChain(name, dispatchSee),
    ControlFlowException: (err: unknown): SeeControlFlowChain => startControlFlowChain(err),
  },
);
