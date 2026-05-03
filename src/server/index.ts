// ShipEasy server SDK — polls /sdk/flags + /sdk/experiments, evaluates locally.

import { AsyncLocalStorage } from "node:async_hooks";

export const version = "1.0.0";

// ---- MurmurHash3_x86_32 (seed 0) — must match packages/core/src/eval/hash.ts ----

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

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
}

interface Universe {
  holdout_range: [number, number] | null;
}

interface FlagsBlob {
  version: string;
  plan: string;
  gates: Record<string, Gate>;
  configs: Record<string, { value: unknown }>;
}

interface ExpsBlob {
  version: string;
  universes: Record<string, Universe>;
  experiments: Record<string, Experiment>;
}

export interface BootstrapPayload {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, ExperimentResult<Record<string, unknown>>>;
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

function evalGateInternal(gate: Gate, user: User): boolean {
  if (isEnabled(gate.killswitch)) return false;
  if (!isEnabled(gate.enabled)) return false;
  for (const rule of gate.rules ?? []) {
    if (!matchRule(rule, user)) return false;
  }
  const uid = user.user_id ?? user.anonymous_id;
  if (!uid) return false;
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
}

export class FlagsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly env: FlagsClientEnv;
  private flagsBlob: FlagsBlob | null = null;
  private expsBlob: ExpsBlob | null = null;
  private flagsEtag: string | null = null;
  private expsEtag: string | null = null;
  private pollInterval = 30;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(opts: FlagsClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://cdn.shipeasy.ai").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
  }

  async init(): Promise<void> {
    await this.fetchAll();
    this.initialized = true;
    this.startPoll();
  }

  async initOnce(): Promise<void> {
    if (this.initialized) return;
    await this.fetchAll();
    this.initialized = true;
  }

  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startPoll(): void {
    this.timer = setInterval(() => {
      this.fetchAll().catch((err) =>
        console.warn("[shipeasy] background poll failed:", String(err)),
      );
    }, this.pollInterval * 1000);
  }

  private async fetchAll(): Promise<void> {
    const [interval] = await Promise.all([this.fetchFlags(), this.fetchExps()]);
    if (interval !== null && interval !== this.pollInterval) {
      this.pollInterval = interval;
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.startPoll();
      }
    }
  }

  private async fetchFlags(): Promise<number | null> {
    const headers: Record<string, string> = { "X-SDK-Key": this.apiKey };
    if (this.flagsEtag) headers["If-None-Match"] = this.flagsEtag;
    const res = await globalThis.fetch(`${this.baseUrl}/sdk/flags?env=${this.env}`, { headers });
    const interval = Number(res.headers.get("X-Poll-Interval") ?? "30") || 30;
    if (res.status === 304) return interval;
    if (!res.ok) throw new Error(`/sdk/flags returned ${res.status}`);
    const etag = res.headers.get("ETag");
    if (etag) this.flagsEtag = etag;
    this.flagsBlob = (await res.json()) as FlagsBlob;
    return interval;
  }

  private async fetchExps(): Promise<void> {
    const headers: Record<string, string> = { "X-SDK-Key": this.apiKey };
    if (this.expsEtag) headers["If-None-Match"] = this.expsEtag;
    const res = await globalThis.fetch(`${this.baseUrl}/sdk/experiments`, { headers });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`/sdk/experiments returned ${res.status}`);
    const etag = res.headers.get("ETag");
    if (etag) this.expsEtag = etag;
    this.expsBlob = (await res.json()) as ExpsBlob;
  }

  getFlag(name: string, user: User): boolean {
    const gate = this.flagsBlob?.gates[name];
    if (!gate) return false;
    return evalGateInternal(gate, user);
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    const entry = this.flagsBlob?.configs[name];
    if (!entry) return undefined;
    if (!decode) return entry.value as T;
    return decode(entry.value);
  }

  getExperiment<P extends Record<string, unknown>>(
    name: string,
    user: User,
    defaultParams: P,
    decode?: (raw: unknown) => P,
  ): ExperimentResult<P> {
    const notIn: ExperimentResult<P> = {
      inExperiment: false,
      group: "control",
      params: defaultParams,
    };
    if (!this.flagsBlob || !this.expsBlob) return notIn;

    const exp = this.expsBlob.experiments[name];
    if (!exp || exp.status !== "running") return notIn;

    if (exp.targetingGate) {
      const gate = this.flagsBlob.gates[exp.targetingGate];
      if (!gate || !evalGateInternal(gate, user)) return notIn;
    }

    const uid = user.user_id ?? user.anonymous_id;
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

  track(userId: string, eventName: string, props?: Record<string, unknown>): void {
    const body = JSON.stringify({
      events: [
        {
          type: "metric",
          event_name: eventName,
          user_id: userId,
          ts: Date.now(),
          ...(props !== undefined ? { properties: props } : {}),
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

    for (const [name, gate] of Object.entries(this.flagsBlob?.gates ?? {})) {
      flags[name] = evalGateInternal(gate, user);
    }

    for (const [name, entry] of Object.entries(this.flagsBlob?.configs ?? {})) {
      configs[name] = entry.value;
    }

    for (const [name] of Object.entries(this.expsBlob?.experiments ?? {})) {
      experiments[name] = this.getExperiment(name, user, {});
    }

    if (rawUrl) {
      const ov = parseOverrides(rawUrl);
      Object.assign(flags, ov.gates);
      Object.assign(configs, ov.configs);
      for (const [name, group] of Object.entries(ov.experiments)) {
        experiments[name] = { inExperiment: true, group, params: {} };
      }
    }

    return { flags, configs, experiments };
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
const _I18N_CACHE_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n-cache");
type I18nCache = Map<string, I18nStore>;
const _i18nCache: I18nCache =
  ((globalThis as Record<symbol, unknown>)[_I18N_CACHE_SYM] as I18nCache | undefined) ??
  ((globalThis as Record<symbol, unknown>)[_I18N_CACHE_SYM] = new Map<string, I18nStore>());

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
    _editModeALS.enterWith(b);
    (globalThis as GlobalWithFallback)[_EDIT_MODE_FALLBACK_SYM] = b;
  },
  configurable: true,
});

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
    // Skip the fetch if the global cache already has it (any prior request, or
    // a sibling Server Component in this request that ran first with a good
    // key). Still call enterWith so this async ctx's getStore() works.
    const cached = _i18nCache.get(profile);
    if (cached && Object.keys(cached.strings).length > 0) {
      _i18nALS.enterWith(cached);
      return;
    }
    const labels = await fetchLabelsForSSR({ key, profile, cdnBaseUrl }).catch(() => null);
    const locale = profile.split(":")[0] || "en";
    const store: I18nStore = { strings: labels?.strings ?? {}, locale };
    if (Object.keys(store.strings).length > 0) _i18nCache.set(profile, store);
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
// Remembered from the FIRST shipeasy() call, used as a default for later calls
// in the same request that omit `clientKey` (e.g. page.tsx after layout.tsx).
// Without this, a `shipeasy({ apiKey: SERVER_KEY })` in the page would call
// `i18n.init` with the server key, which the `/sdk/i18n/strings` endpoint
// rejects with 401 — and SSR translations silently disappear.
let _rememberedClientKey: string | null = null;

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
   * Server-side API key — authenticates flag/experiment fetches from the edge.
   * Never embedded in browser output. A warning is logged if omitted.
   */
  apiKey?: string;
  /**
   * Public client key — embedded in window.__SE_BOOTSTRAP and used by the
   * browser SDK. Safe to expose (e.g. NEXT_PUBLIC_ env vars).
   * Defaults to apiKey for single-key setups.
   */
  clientKey?: string;
  /** Raw URL or query string for applying ?se_ks_* / ?se_cf_* / ?se_exp_* overrides. */
  urlOverrides?: string;
  /** User attributes for flag and experiment evaluation. */
  user?: User;
  /** i18n profile to load for SSR translations, e.g. "en:prod". Defaults to "en:prod". */
  i18nDefaultProfile?: string;
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
  if (!opts.apiKey && !opts.clientKey) {
    console.warn("[shipeasy] apiKey is required — flag evaluation and i18n will not load.");
  } else if (!opts.apiKey) {
    console.warn("[shipeasy] apiKey not set — falling back to clientKey for server requests.");
  }
  const apiKey = opts.apiKey ?? opts.clientKey ?? "";
  // Resolution order: explicit opts.clientKey → remembered from first call →
  // apiKey (last-resort, will 401 against /sdk/i18n/strings but matches old
  // behaviour for non-i18n setups).
  const clientKey = opts.clientKey ?? _rememberedClientKey ?? opts.apiKey ?? "";
  if (opts.clientKey && !_rememberedClientKey) _rememberedClientKey = opts.clientKey;
  const profile = opts.i18nDefaultProfile ?? "en:prod";
  flags.configure({ apiKey });
  // Resolve URL overrides: explicit opts.urlOverrides wins; otherwise try to
  // read the x-se-search header injected by Next.js middleware so that
  // ?se_edit_labels (and other devtools params) are detected without the
  // caller having to forward searchParams manually.
  let resolvedUrlOverrides = opts.urlOverrides;
  if (!resolvedUrlOverrides) {
    try {
      // Dynamic import keeps Next.js out of the SDK's hard dependency graph.
      // Falls back silently in non-Next.js runtimes (Cloudflare Workers, etc.).
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — next/headers is an optional peer; absent in non-Next.js runtimes
      const { headers } = (await import("next/headers")) as {
        headers: () => Promise<Headers> | Headers;
      };
      const h = await Promise.resolve(headers());
      const search = h.get("x-se-search") ?? "";
      if (search) resolvedUrlOverrides = search;
    } catch {}
  }
  // Set edit mode before i18n.init() idempotency check so the page's
  // ?se_edit_labels param always wins even when layout ran first.
  const editLabels = resolvedUrlOverrides
    ? new URLSearchParams(resolvedUrlOverrides).has("se_edit_labels")
    : false;
  (globalThis as Record<symbol, unknown>)[_EDIT_MODE_SSR_SYM] = editLabels;
  await Promise.allSettled([flags.initOnce(), i18n.init(clientKey, profile)]);

  const bootstrap = flags.evaluate(opts.user ?? {}, resolvedUrlOverrides);
  const i18nData = i18n.getForRequest();

  return {
    flags: bootstrap.flags,
    configs: bootstrap.configs,
    experiments: bootstrap.experiments,
    getBootstrapHtml() {
      return getBootstrapHtml(bootstrap, i18nData, { apiKey: clientKey, editLabels });
    },
  };
}

// ---- Framework-agnostic bootstrap script helper ----

export interface BootstrapHtmlOptions {
  /** SDK client key */
  apiKey: string;
  /** i18n profile fed to the loader script. Defaults to "en:prod". */
  i18nProfile?: string;
  /** When true, tEl() embeds label markers so the devtools can highlight them. */
  editLabels?: boolean;
}

/**
 * Returns a vanilla-JS script string for a single <script> tag.
 * Handles everything the client needs at startup:
 *   - window.__se_devtools_config (when devtoolsAdminUrl is set)
 *   - window.__SE_BOOTSTRAP (flags + configs + experiments + i18n + apiKey for auto-init)
 *   - window.i18n shim from SSR strings (prevents hydration mismatches)
 *   - dynamic <script> injection for the i18n loader
 *
 * Framework-agnostic: set innerHTML on a <script> element, nothing else required.
 * Pass null for bootstrap on pages without flag evaluation — client still auto-inits.
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
    apiKey: opts.apiKey,
    apiUrl,
  };
  if (i18nData) payload.i18n = i18nData;
  if (opts.editLabels) payload.editLabels = true;
  parts.push(`window.__SE_BOOTSTRAP=${JSON.stringify(payload)};`);

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

  parts.push(
    `(function(){var s=document.createElement('script');` +
      `s.src=${JSON.stringify(`${apiUrl}/sdk/i18n/loader.js`)};` +
      `s.setAttribute('data-key',${JSON.stringify(opts.apiKey)});` +
      `s.setAttribute('data-profile',${JSON.stringify(profile)});` +
      `document.head.appendChild(s);})();`,
  );

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
  get(name: string, user: User): boolean {
    return _server?.getFlag(name, user) ?? false;
  },
  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    return _server?.getConfig(name, decode);
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
  track(userId: string, eventName: string, props?: Record<string, unknown>): void {
    _server?.track(userId, eventName, props);
  },
  /**
   * Evaluate all flags / configs / experiments for a user against the locally
   * cached blob. Pass the request URL to apply ?se_ks_* / ?se_cf_* / ?se_exp_*
   * overrides. Returns an empty payload when the blob hasn't been fetched yet.
   */
  evaluate(user: User, rawUrl?: string): BootstrapPayload {
    return _server?.evaluate(user, rawUrl) ?? { flags: {}, configs: {}, experiments: {} };
  },
};
