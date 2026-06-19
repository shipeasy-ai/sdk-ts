// ShipEasy server SDK — polls /sdk/flags + /sdk/experiments, evaluates locally.

import { AsyncLocalStorage } from "node:async_hooks";

import { Telemetry, DEFAULT_TELEMETRY_URL } from "../telemetry";
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
  allocationPct: number;
  salt: string;
  groups: ExperimentGroup[];
  status: "draft" | "running" | "stopped" | "archived";
  /** Attribute to bucket on (e.g. company_id); defaults to user_id/anonymous_id. */
  bucketBy?: string | null;
}

interface Universe {
  holdout_range: [number, number] | null;
}

interface Killswitch {
  killed: 0 | 1 | boolean;
  switches?: Record<string, 0 | 1 | boolean>;
}

/** Body of `GET /sdk/flags` — the snapshot's `flags` field. See {@link FlagsClient.fromSnapshot}. */
export interface FlagsBlob {
  version: string;
  plan: string;
  gates: Record<string, Gate>;
  configs: Record<string, { value: unknown }>;
  killswitches: Record<string, Killswitch>;
}

/** Body of `GET /sdk/experiments` — the snapshot's `experiments` field. See {@link FlagsClient.fromSnapshot}. */
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

// ---- FlagsClient ----

export type FlagsClientEnv = "dev" | "staging" | "prod";

export interface FlagsClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Which published env to read values from. Defaults to "prod". */
  env?: FlagsClientEnv;
  /**
   * Preload the flags blob synchronously without a network fetch. Primarily
   * for tests; production callers should rely on init()/initOnce().
   */
  initialBlob?: FlagsBlob;
  /**
   * Per-evaluation usage telemetry. ON by default — each getFlag/getConfig/
   * getExperiment/getKillswitch (and the per-key evaluate() loop) fires one
   * fire-and-forget beacon counted by Cloudflare's native per-path analytics.
   * Pass `true` to disable. NOTE: on Cloudflare Workers each beacon is an
   * outbound subrequest (cap 50 free / 1000 paid per invocation), so disable
   * this on hot request paths that evaluate many flags per request.
   */
  disableTelemetry?: boolean;
  /** Override the telemetry beacon host. Defaults to {@link DEFAULT_TELEMETRY_URL}. */
  telemetryUrl?: string;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). The server evaluates locally so private
   * attrs never leave for evaluation at all; the only egress is `/collect`, and
   * the listed keys are stripped from every outbound `track()` payload.
   */
  privateAttributes?: string[];
  /**
   * Test mode — no network at all. init()/initOnce() are no-ops (never fetch),
   * track() is a no-op, telemetry is forced off, and the client starts
   * "initialized" with an empty blob. Prefer the {@link FlagsClient.forTesting}
   * factory over passing this directly.
   */
  testMode?: boolean;
}

export class FlagsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly env: FlagsClientEnv;
  private readonly privateAttributes: readonly string[];
  private readonly telemetry: Telemetry;
  private readonly seeLimiter = new SeeLimiter();
  private flagsBlob: FlagsBlob | null = null;
  private expsBlob: ExpsBlob | null = null;
  private flagsEtag: string | null = null;
  private expsEtag: string | null = null;
  private pollInterval = 30;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  // Test mode: built by `FlagsClient.forTesting()`. When set, init()/initOnce()
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
  // Change listeners fired after a background poll returns NEW data (200, not
  // 304). Never fired in testMode/offline (no polling happens there).
  private readonly changeListeners = new Set<() => void>();

  constructor(opts: FlagsClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://cdn.shipeasy.ai").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
    this.privateAttributes = opts.privateAttributes ?? [];
    this.testMode = opts.testMode === true;
    this.telemetry = new Telemetry({
      endpoint: opts.telemetryUrl ?? DEFAULT_TELEMETRY_URL,
      sdkKey: this.apiKey,
      side: "server",
      env: this.env,
      // Test mode never talks to the network — telemetry off regardless of opt.
      disabled: this.testMode || opts.disableTelemetry,
    });
    if (opts.initialBlob || this.testMode) {
      // Seed an empty blob in test mode so getters read from overrides without
      // any fetch having happened.
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
   * const client = FlagsClient.forTesting();
   * client.overrideFlag("new_checkout", true);
   * client.getFlag("new_checkout", { user_id: "u1" }); // true
   * ```
   */
  static forTesting(opts?: Partial<FlagsClientOptions>): FlagsClient {
    return new FlagsClient({ apiKey: "", ...opts, testMode: true });
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
  static fromSnapshot(snapshot: { flags: FlagsBlob; experiments: ExpsBlob }): FlagsClient {
    const client = new FlagsClient({ apiKey: "", testMode: true });
    client.flagsBlob = snapshot.flags;
    client.expsBlob = snapshot.experiments;
    client.initialized = true;
    return client;
  }

  /**
   * Build a fully OFFLINE client from a snapshot JSON file on disk (Node only —
   * not available in the browser entrypoint). The file must contain
   * `{ "flags": <GET /sdk/flags body>, "experiments": <GET /sdk/experiments body> }`.
   * See {@link FlagsClient.fromSnapshot}.
   */
  static fromFile(path: string): FlagsClient {
    // require() so the Node-only fs dependency never ends up in a browser bundle
    // of the server entry (this static is documented as Node/server-only).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(path, "utf8");
    const snapshot = JSON.parse(raw) as { flags: FlagsBlob; experiments: ExpsBlob };
    return FlagsClient.fromSnapshot(snapshot);
  }

  async init(): Promise<void> {
    if (this.testMode) {
      this.initialized = true;
      return;
    }
    await this.fetchAll();
    this.initialized = true;
    this.startPoll();
  }

  async initOnce(): Promise<void> {
    if (this.testMode || this.initialized) return;
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
        console.warn("[shipeasy] onChange listener threw:", String(err));
      }
    }
  }

  private startPoll(): void {
    this.timer = setInterval(() => {
      this.fetchAll(true).catch((err) =>
        console.warn("[shipeasy] background poll failed:", String(err)),
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
    return opts.decode(raw);
  }

  getExperiment<P extends Record<string, unknown>>(
    name: string,
    user: User,
    defaultParams: P,
    decode?: (raw: unknown) => P,
  ): ExperimentResult<P> {
    this.telemetry.emit("experiment", name);
    const notIn: ExperimentResult<P> = {
      inExperiment: false,
      group: "control",
      params: defaultParams,
    };
    const ov = this.experimentOverrides.get(name);
    if (ov) {
      if (!decode) return { inExperiment: true, group: ov.group, params: ov.params as P };
      try {
        return { inExperiment: true, group: ov.group, params: decode(ov.params) };
      } catch (err) {
        console.warn(`[shipeasy] getExperiment('${name}') override decode failed:`, String(err));
        return notIn;
      }
    }
    if (!this.flagsBlob || !this.expsBlob) return notIn;

    const exp = this.expsBlob.experiments[name];
    if (!exp || exp.status !== "running") return notIn;

    if (exp.targetingGate) {
      const gate = this.flagsBlob.gates[exp.targetingGate];
      if (!gate || !evalGateInternal(gate, user)) return notIn;
    }

    // Bucket on exp.bucketBy (e.g. company_id) when set, else user_id/anon —
    // holdout, allocation, and group all hash on the same unit (doc 20 §4).
    const uid = pickIdentifier(user, exp.bucketBy);
    if (!uid) return notIn;

    const universe = this.expsBlob.universes[exp.universe];
    const holdoutRange = universe?.holdout_range ?? null;

    if (holdoutRange) {
      const seg = murmur3(`${exp.universe}:${uid}`) % 10000;
      const [lo, hi] = holdoutRange;
      if (seg >= lo && seg <= hi) return notIn;
    }

    if (murmur3(`${exp.salt}:alloc:${uid}`) % 10000 >= exp.allocationPct) return notIn;

    const groupHash = murmur3(`${exp.salt}:group:${uid}`) % 10000;
    let cumulative = 0;
    for (let i = 0; i < exp.groups.length; i++) {
      const g = exp.groups[i];
      cumulative += g.weight;
      if (groupHash < cumulative || i === exp.groups.length - 1) {
        if (!decode) {
          return { inExperiment: true, group: g.name, params: g.params as P };
        }
        try {
          return { inExperiment: true, group: g.name, params: decode(g.params) };
        } catch (err) {
          console.warn(`[shipeasy] getExperiment('${name}') decode failed:`, String(err));
          return notIn;
        }
      }
    }

    return notIn;
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
    if (this.testMode) return; // no-op in test mode — never touch the network
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
      .catch((err) => console.warn("[shipeasy] track failed:", String(err)));
  }

  /**
   * Emit an exposure event for an experiment at the server-side decision point
   * (parity with the browser's auto-exposure). The server is stateless and
   * never auto-logs, so call this when you actually present the treatment.
   * Re-evaluates the experiment for `user` (a bare `user_id` string is wrapped
   * as `{ user_id }`); if the user is enrolled, POSTs a single exposure to
   * `/collect`. No-op in test mode or when the user isn't enrolled.
   */
  logExposure(user: string | User, name: string): void {
    if (this.testMode) return;
    const u: User = typeof user === "string" ? { user_id: user } : user;
    const result = this.getExperiment(name, u, {} as Record<string, unknown>);
    if (!result.inExperiment) return;
    const body = JSON.stringify({
      events: [
        {
          type: "exposure",
          experiment: name,
          group: result.group,
          ...(u.user_id !== undefined ? { user_id: u.user_id } : {}),
          ...(u.anonymous_id !== undefined ? { anonymous_id: u.anonymous_id } : {}),
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
      .catch((err) => console.warn("[shipeasy] logExposure failed:", String(err)));
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
        .catch((err) => console.warn("[shipeasy] see() send failed:", String(err)));
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

    for (const [name] of Object.entries(this.expsBlob?.experiments ?? {})) {
      experiments[name] = this.getExperiment(name, user, {});
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
        experiments[name] = { inExperiment: true, group, params: {} };
      }
    }

    return { flags, configs, experiments, killswitches };
  }

  getKillswitch(name: string, switchKey?: string): boolean {
    this.telemetry.emit("ks", name);
    const ks = this.flagsBlob?.killswitches?.[name];
    if (!ks) return false;
    if (switchKey === undefined) return isEnabled(ks.killed);
    return isEnabled(ks.switches?.[switchKey]);
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
// the `flags` facade from any module without passing the FlagsClient
// around. Methods return safe defaults when the singleton hasn't been
// configured (or after destroy()), so importing `flags` into a module
// that loads before the configure() call is harmless.

let _server: FlagsClient | null = null;

export function configureShipeasyServer(opts: FlagsClientOptions): FlagsClient {
  if (_server) return _server;
  _server = new FlagsClient(opts);
  return _server;
}

export function getShipeasyServerClient(): FlagsClient | null {
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
  /**
   * Disable per-evaluation usage telemetry. ON by default. On Cloudflare
   * Workers each beacon is an outbound subrequest, so disable on hot SSR paths
   * that evaluate many flags per request. See {@link FlagsClientOptions.disableTelemetry}.
   */
  disableTelemetry?: boolean;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). Stripped from every outbound `track()`
   * payload. See {@link FlagsClientOptions.privateAttributes}.
   */
  privateAttributes?: string[];
}

export interface ShipeasyServerHandle {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, ExperimentResult<Record<string, unknown>>>;
  /** Returns a vanilla-JS string for a single inline <script> tag. */
  getBootstrapHtml(): string;
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
    console.error(
      "[shipeasy] No server key — flags, experiments and SSR i18n skipped. Pass " +
        "`serverKey` to shipeasy() from @shipeasy/sdk/server with your server key " +
        "(SHIPEASY_SERVER_KEY). Set it as a Worker secret with " +
        "`wrangler secret put SHIPEASY_SERVER_KEY` (or add it to .env for local dev). " +
        "Do not pass a client key here — the server entrypoint only accepts the server key.",
    );
  }
  const profile = opts.i18nDefaultProfile ?? "en:prod";
  flags.configure({
    apiKey: serverKey,
    disableTelemetry: opts.disableTelemetry,
    privateAttributes: opts.privateAttributes,
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
    getBootstrapHtml() {
      return getBootstrapHtml(bootstrap, i18nData, {
        editLabels,
        i18nProfile: profile,
        anonId,
      });
    },
  };
}

// ---- Framework-agnostic bootstrap script helper ----

export interface BootstrapHtmlOptions {
  /** i18n profile recorded in the bootstrap so the client loader matches SSR. Defaults to "en:prod". */
  i18nProfile?: string;
  /** When true, tEl() embeds label markers so the devtools can highlight them. */
  editLabels?: boolean;
  /**
   * Stable anonymous bucketing id the server evaluated against. Emitted into
   * window.__SE_BOOTSTRAP and persisted (pre-paint) to the first-party
   * `__se_anon_id` cookie, so the browser SDK buckets identically to SSR.
   * Normally minted by edge middleware; this write is the fallback for routes
   * middleware doesn't cover. See experiment-platform/18-identity-bucketing.md.
   */
  anonId?: string;
}

/**
 * Returns a vanilla-JS string for a single inline <script> tag. Handles
 * everything the client needs at startup EXCEPT the key — no SDK key is ever
 * embedded here (the server only knows the server key, which must stay
 * server-side). The browser supplies its own client key via
 * `shipeasy({ clientKey })` from @shipeasy/sdk/client, which also injects the
 * runtime i18n loader. This script emits:
 *   - window.__se_devtools_config (when devtoolsAdminUrl is set)
 *   - window.__SE_BOOTSTRAP (flags + configs + experiments + i18n DATA + i18nProfile, NO key)
 *   - window.i18n shim from SSR strings (prevents hydration mismatches / FOUC)
 *   - devtools overlay loader when ?se / ?se_devtools is present
 *
 * Framework-agnostic: set innerHTML on a <script> element, nothing else required.
 */
export function getBootstrapHtml(
  bootstrap: BootstrapPayload | null,
  i18nData: I18nForRequest | null,
  opts: BootstrapHtmlOptions,
): string {
  const parts: string[] = [];
  const apiUrl = "https://cdn.shipeasy.ai";
  const profile = opts.i18nProfile ?? "en:prod";

  const payload: Record<string, unknown> = {
    flags: bootstrap?.flags ?? {},
    configs: bootstrap?.configs ?? {},
    experiments: bootstrap?.experiments ?? {},
    // No key here — the server only knows the server key, which must never reach
    // the browser. The client supplies its own client key via shipeasy({ clientKey }).
    i18nProfile: profile,
    apiUrl,
  };
  if (i18nData) payload.i18n = i18nData;
  if (opts.editLabels) payload.editLabels = true;
  if (opts.anonId) payload.anonId = opts.anonId;

  // Edit-labels shim. With ?se_edit_labels=1 the devtools overlay needs every
  // translated string to render as `￹key￺value￻` so it can scan
  // the DOM and enable in-place editing. We define a setter on window.i18n
  // that intercepts the inline shim's assignment (a few lines below) AND any
  // later assignment from the CDN loader, wrapping .t() in both cases. Must
  // be the first statement so neither assignment slips past unwrapped.
  //
  // Detection mirrors the server: URL param OR persisted cookie. The cookie is
  // what allows SSR to keep rendering markers across navigations after the
  // first ?se_edit_labels=1 visit. If the client only checked the URL, the
  // server would emit marker-wrapped text (cookie still set) while the client
  // rendered plain text — a hydration mismatch on every navigation in the 24h
  // cookie window.
  parts.push(
    `(function(){` +
      `var Q=new URLSearchParams(location.search).has('se_edit_labels');` +
      `var C=/(?:^|;\\s*)se_edit_labels=1(?:;|$)/.test(document.cookie);` +
      `if(!Q&&!C)return;` +
      // Refresh the cookie on every URL-param visit so testers stay in edit
      // mode for the next 24h without re-typing the param. Cookie-only visits
      // skip the write — already set, no need to re-stamp.
      `if(Q){try{document.cookie='se_edit_labels=1;path=/;max-age=86400;samesite=lax';}catch(_){}}` +
      `var R;` +
      `function P(v){` +
      `if(!v||typeof v.t!=='function'||v.__sePatched)return;` +
      `var O=v.t.bind(v);` +
      `v.__sePatched=true;` +
      `window._sei18n_t=O;` +
      `v.t=function(k,vars){` +
      `var r=O(k,vars);` +
      `if(r===k)return k;` +
      // 3-section marker: key | varsJson | value. varsJson is "" when no vars.
      // Stringification is wrapped in try/catch so circular vars never break the page.
      `var V='';try{if(vars&&typeof vars==='object'){var hasKey=false;for(var _k in vars){hasKey=true;break;}if(hasKey)V=JSON.stringify(vars);}}catch(_){V='';}` +
      `return '\\uFFF9'+k+'\\uFFFA'+V+'\\uFFFA'+r+'\\uFFFB';` +
      `};` +
      `}` +
      `Object.defineProperty(window,'i18n',{configurable:true,` +
      `get:function(){return R;},` +
      `set:function(v){P(v);R=v;}});` +
      `})();`,
  );

  parts.push(`window.__SE_BOOTSTRAP=${JSON.stringify(payload)};`);

  // Persist the SSR bucketing id to a first-party cookie when edge middleware
  // didn't already set it (routes outside the middleware matcher). Pre-paint and
  // JS-readable (no httpOnly) so the browser SDK adopts the exact id SSR bucketed
  // against. Skips the write when the cookie is already present.
  if (opts.anonId) {
    parts.push(
      `(function(){try{var k=${JSON.stringify(ANON_ID_COOKIE)},v=${JSON.stringify(opts.anonId)};` +
        `if(('; '+document.cookie).indexOf('; '+k+'=')===-1){` +
        `document.cookie=k+'='+v+';path=/;max-age=31536000;samesite=lax'+` +
        `(location.protocol==='https:'?';secure':'');}` +
        `}catch(_){}})();`,
    );
  }

  if (i18nData?.strings && Object.keys(i18nData.strings).length > 0) {
    parts.push(
      `(function(){var d=window.__SE_BOOTSTRAP.i18n;if(!d)return;` +
        `window.i18n={locale:d.locale,` +
        `t:function(k,v){var r=d.strings[k];if(!r)return k;` +
        `return v?r.replace(/\\{\\{(\\w+)\\}\\}/g,function(_,p){return v[p]!==undefined?String(v[p]):'{{'+p+'}}'}):r;},` +
        `on:function(){return function(){};}};` +
        `})();`,
    );
  }

  // NOTE: the runtime i18n loader (<script src=.../sdk/i18n/loader.js data-key>)
  // is NO LONGER injected here. It needs the client key, which the server does
  // not hold. The client entrypoint (`shipeasy({ clientKey })` in
  // @shipeasy/sdk/client) injects the loader with its own client key. The SSR
  // i18n shim above already populates window.i18n for first paint, so there is
  // no untranslated flash before the client loader takes over.

  // Load devtools overlay when ?se (or ?se_devtools) is present in the URL.
  parts.push(
    `(function(){` +
      `var p=new URLSearchParams(location.search);` +
      `if(p.has('se')||p.has('se_devtools')){` +
      `var d=document.createElement('script');` +
      `d.src='https://shipeasy.ai/se-devtools.js';` +
      `document.head.appendChild(d);}` +
      `})();`,
  );

  return parts.join("");
}

export const flags = {
  configure(opts: FlagsClientOptions): void {
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
    return _server?.getFlag(name, user, defaultValue) ?? defaultValue;
  },
  /** Evaluate a gate and report why (value + reason). See {@link FlagDetail}. */
  getDetail(name: string, user: User): FlagDetail {
    return _server?.getFlagDetail(name, user) ?? { value: false, reason: "CLIENT_NOT_READY" };
  },
  getConfig<T = unknown>(
    name: string,
    decodeOrOpts?: ((raw: unknown) => T) | GetConfigOptions<T>,
  ): T | undefined {
    // Forward the legacy decode callback OR the options object unchanged.
    return _server?.getConfig(name, decodeOrOpts as GetConfigOptions<T>);
  },
  getExperiment<P extends Record<string, unknown>>(
    name: string,
    user: User,
    defaultParams: P,
    decode?: (raw: unknown) => P,
  ): ExperimentResult<P> {
    return (
      _server?.getExperiment(name, user, defaultParams, decode) ?? {
        inExperiment: false,
        group: "control",
        params: defaultParams,
      }
    );
  },
  /**
   * Read a killswitch. Without `switchKey`, returns true when the whole
   * killswitch is killed. With `switchKey`, returns true when that specific
   * switch is on. Unknown killswitches / switches return false.
   */
  ks(name: string, switchKey?: string): boolean {
    return _server?.getKillswitch(name, switchKey) ?? false;
  },
  track(userId: string, eventName: string, props?: Record<string, unknown>): void {
    _server?.track(userId, eventName, props);
  },
  /** Emit an exposure for an enrolled experiment at the decision point. See
   *  {@link FlagsClient.logExposure}. No-op before configure(). */
  logExposure(user: string | User, name: string): void {
    _server?.logExposure(user, name);
  },
  /**
   * Evaluate all flags / configs / experiments for a user against the locally
   * cached blob. Pass the request URL to apply ?se_ks_* / ?se_cf_* / ?se_exp_*
   * overrides. Returns an empty payload when the blob hasn't been fetched yet.
   */
  evaluate(user: User, rawUrl?: string): BootstrapPayload {
    return (
      _server?.evaluate(user, rawUrl) ?? {
        flags: {},
        configs: {},
        experiments: {},
        killswitches: {},
      }
    );
  },
};

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
    console.warn("[shipeasy] see() called before shipeasy({ serverKey }) — error dropped");
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
