// ShipEasy server SDK — polls /sdk/flags + /sdk/experiments, evaluates locally.

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
    this.baseUrl = (opts.baseUrl ?? "https://edge.shipeasy.dev").replace(/\/$/, "");
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
}
