// ShipEasy browser SDK — calls /sdk/evaluate on identify(), logs exposures + events via /collect.

import { Telemetry, DEFAULT_TELEMETRY_URL } from "../telemetry";
import {
  buildSeeEvent,
  causesThe,
  isExpected,
  markExpected,
  SeeLimiter,
  startSeeChain,
  startSeeViolationChain,
  violation,
  type Consequence,
  type SeeChain,
  type SeeErrorEvent,
  type SeeExtras,
  type SeeKind,
  type SeeViolationChain,
  type Violation,
} from "../see/core";

export type {
  Consequence,
  SeeChain,
  SeeErrorEvent,
  SeeExtras,
  SeeKind,
  SeeViolationChain,
  Violation,
};

declare global {
  interface Window {
    i18n?: {
      t: (key: string, vars?: Record<string, string | number>) => string;
      ready: (cb: () => void) => void;
      on: (event: "update", cb: () => void) => () => void;
      locale: string | null;
    };
  }
}

export const version = "4.0.0";

// ---- Types ----

export interface User {
  user_id?: string;
  [attr: string]: unknown;
}

export interface ExperimentResult<P> {
  inExperiment: boolean;
  group: string;
  params: P;
}

interface EvalExpResult {
  inExperiment: boolean;
  group: string;
  params: Record<string, unknown>;
}

interface EvalResponse {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<string, EvalExpResult>;
  /**
   * Killswitch state, flattened by the server. A boolean means the killswitch
   * is whole-killed; an object means it's not whole-killed and carries per-
   * switch booleans.
   */
  killswitches?: Record<string, boolean | Record<string, boolean>>;
}

// ---- EventBuffer ----

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER = 100;
const ANON_ID_KEY = "__se_anon_id";
const SEEN_KEY = "__se_seen";
const PENDING_ALIAS_KEY = "__se_pending_alias";

interface RawEvent {
  type: "exposure" | "metric" | "identify";
  experiment?: string;
  group?: string;
  user_id?: string;
  anonymous_id?: string;
  event_name?: string;
  value?: number;
  properties?: Record<string, unknown>;
  ts: number;
}

class EventBuffer {
  private queue: RawEvent[] = [];
  private exposureSeen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly collectUrl: string,
    private readonly sdkKey: string,
  ) {
    if (typeof window !== "undefined") {
      this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      window.addEventListener("beforeunload", () => this.flush());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flush(true);
      });
      // Reload dedup set from sessionStorage on init
      try {
        const stored = sessionStorage.getItem(SEEN_KEY);
        if (stored) this.exposureSeen = new Set(JSON.parse(stored) as string[]);
      } catch {}
    }
  }

  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True once this visitor has been exposed to ≥1 experiment (this tab or a
   *  prior page in the session — the dedup set persists in sessionStorage).
   *  Gates auto-metric emission: vitals from non-participants are never read
   *  by the analysis pipeline and would be pure AE write cost (see cost.md). */
  hasExposures(): boolean {
    return this.exposureSeen.size > 0;
  }

  pushExposure(experiment: string, group: string, userId: string, anonId: string): void {
    const key = `${userId || anonId}:${experiment}`;
    if (this.exposureSeen.has(key)) return;
    this.exposureSeen.add(key);
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...this.exposureSeen]));
    } catch {}
    this.enqueue({
      type: "exposure",
      experiment,
      group,
      user_id: userId,
      anonymous_id: anonId,
      ts: Date.now(),
    });
  }

  pushMetric(
    eventName: string,
    userId: string,
    anonId: string,
    props?: Record<string, unknown>,
  ): void {
    this.enqueue({
      type: "metric",
      event_name: eventName,
      user_id: userId,
      anonymous_id: anonId,
      ts: Date.now(),
      ...(props ? { properties: props } : {}),
    });
  }

  async alias(anonymousId: string, userId: string): Promise<void> {
    const record = { anonymousId, userId, ts: Date.now() };
    try {
      localStorage.setItem(PENDING_ALIAS_KEY, JSON.stringify(record));
    } catch {}
    await this.flushAsync();
    await this._sendAlias(anonymousId, userId);
    try {
      localStorage.removeItem(PENDING_ALIAS_KEY);
    } catch {}
  }

  async flushPendingAlias(): Promise<void> {
    try {
      const raw = localStorage.getItem(PENDING_ALIAS_KEY);
      if (!raw) return;
      const record = JSON.parse(raw) as { anonymousId: string; userId: string; ts: number };
      if (Date.now() - record.ts > 7 * 86_400_000) {
        localStorage.removeItem(PENDING_ALIAS_KEY);
        return;
      }
      await this._sendAlias(record.anonymousId, record.userId);
      localStorage.removeItem(PENDING_ALIAS_KEY);
    } catch {}
  }

  private async _sendAlias(anonymousId: string, userId: string): Promise<void> {
    this.enqueue({ type: "identify", anonymous_id: anonymousId, user_id: userId, ts: Date.now() });
    await this.flushAsync();
  }

  private enqueue(ev: RawEvent): void {
    this.queue.push(ev);
    if (this.queue.length >= MAX_BUFFER) this.flush();
  }

  flush(useBeacon = false): void {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    this.send(batch, useBeacon);
  }

  /**
   * Bypass the 5s queue and ship events immediately — used by see() error
   * reporting so occurrences land near-real-time and survive page unload.
   * Beacon-first (fire-and-forget, unload-safe), keepalive fetch fallback.
   */
  sendNow(events: Array<RawEvent | SeeErrorEvent>): void {
    this.send(events, true);
  }

  private send(batch: Array<RawEvent | SeeErrorEvent>, useBeacon: boolean): void {
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      // text/plain avoids CORS preflight on mobile Safari. sendBeacon can't set
      // the X-SDK-Key header, so carry the key in the body as `k` — the
      // /collect endpoint reads it as a fallback when the header is absent.
      const beaconBody = JSON.stringify({ k: this.sdkKey, events: batch });
      try {
        if (navigator.sendBeacon(this.collectUrl, new Blob([beaconBody], { type: "text/plain" })))
          return;
      } catch {
        /* fall through to fetch */
      }
    }
    fetch(this.collectUrl, {
      method: "POST",
      headers: { "X-SDK-Key": this.sdkKey, "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    }).catch(() => {});
  }

  async flushAsync(): Promise<void> {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    const body = JSON.stringify({ events: batch });
    await fetch(this.collectUrl, {
      method: "POST",
      headers: { "X-SDK-Key": this.sdkKey, "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  }
}

// ---- Auto-guardrails ----

export interface AutoCollectGroups {
  vitals: boolean;
  errors: boolean;
  engagement: boolean;
}

/** Callback the auto-capture handlers report through — bound to the client's see() path. */
type SeeReporter = (
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  kind: SeeKind,
) => void;

function installAutoGuardrails(
  buffer: EventBuffer,
  userId: string,
  anonId: string,
  groups: AutoCollectGroups,
  reportSee: SeeReporter,
  ignoreUrlPrefixes: string[],
  always = false,
): void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;

  // Cost gate (cost.md §auto-guardrails — mandatory): only emit `__auto_*`
  // metric events for experiment participants. Non-participant vitals are
  // never read by the analysis pipeline and at scale are ~60% of AE write
  // cost. `autoCollect: { always: true }` opts into site-wide collection.
  // EXCEPTION: `__auto_abandoned` stays unconditional — it fires precisely
  // when the user leaves before exposures could be recorded; the analysis
  // post-exposure filter attributes it correctly.
  const shouldEmit = () => always || buffer.hasExposures();

  let lcp: number | null = null;
  let inp: number | null = null;
  let clsBad = false;
  let navTimingFlushed = false;

  if (groups.vitals) {
    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length)
          lcp = (entries[entries.length - 1] as PerformanceEntry & { startTime: number }).startTime;
      });
      lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    try {
      const inpObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const dur = (e as PerformanceEntry & { duration: number }).duration ?? 0;
          if (inp === null || dur > inp) inp = dur;
        }
      });
      inpObs.observe({
        type: "event",
        buffered: true,
        durationThreshold: 16,
      } as PerformanceObserverInit);
    } catch {}

    try {
      const clsObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if ((e as PerformanceEntry & { value: number }).value > 0.1) clsBad = true;
        }
      });
      clsObs.observe({ type: "layout-shift", buffered: true });
    } catch {}
  }

  // ---- Errors: report into the errors primitive via the see() path. ----
  // Caps + 30s dedup live in the client's SeeLimiter; expected control-flow
  // exceptions (see.expected(err, "because …")) are skipped.
  if (groups.errors) {
    const origOnError = window.onerror;
    window.onerror = (msg, source, lineno, _colno, err) => {
      if (!isExpected(err)) {
        const problem =
          err ?? (typeof msg === "string" && msg ? msg : "Unknown error");
        reportSee(
          problem,
          causesThe("the page").to("hit an unhandled error"),
          {
            source: typeof source === "string" ? source : undefined,
            line: lineno ?? undefined,
          },
          "uncaught",
        );
      }
      if (typeof origOnError === "function") return origOnError(msg, source, lineno, _colno, err);
      return false;
    };

    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      const reason = (e as PromiseRejectionEvent).reason;
      if (isExpected(reason)) return;
      reportSee(
        reason ?? "Unhandled promise rejection",
        causesThe("the page").to("hit an unhandled promise rejection"),
        undefined,
        "unhandled_rejection",
      );
    });

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
      const url = typeof args[0] === "string" ? args[0] : (args[0] as Request | URL).toString();
      // Never report the SDK's own collector/telemetry requests — a failing
      // collector would otherwise feed errors back into itself.
      const ignored = ignoreUrlPrefixes.some((p) => p && url.startsWith(p));
      // Querystring-free URL for the message (it feeds the issue fingerprint);
      // the full URL still travels in extras for debugging.
      const bareUrl = url.split("?")[0].slice(0, 200);
      let res: Response;
      try {
        res = await origFetch.apply(this, args);
      } catch (err) {
        // Network-level failure (DNS, offline, CORS, abort) — never reaches a status.
        if (!ignored && !isExpected(err)) {
          reportSee(
            violation("NetworkError").message(`request to ${bareUrl} failed`),
            causesThe("a network request").to("fail without a response"),
            { status: 0, url: url.slice(0, 200) },
            "network",
          );
        }
        throw err;
      }
      if (!ignored && res.status >= 500) {
        const elapsed = typeof performance !== "undefined" ? performance.now() - startedAt : 0;
        reportSee(
          violation("Http5xx").message(`request to ${bareUrl} returned ${res.status}`),
          causesThe("a network request").to(`fail with HTTP ${res.status}`),
          { status: res.status, url: url.slice(0, 200), duration_ms: Math.round(elapsed) },
          "network",
        );
      }
      return res;
    };
  }

  // ---- Navigation timing & paint (page_load, ttfb, fp, fcp, dom_ready). ----
  // These are part of the vitals group. Available at the `load` event; we
  // delay one tick so `loadEventEnd` is populated. Safe to call multiple
  // times — guarded.
  const flushNavTiming = () => {
    if (navTimingFlushed) return;
    if (!groups.vitals) {
      navTimingFlushed = true;
      return;
    }
    // Not in an experiment (yet): don't mark flushed — exposure may land
    // before the next flush point (route change / hide) and we still want
    // one nav-timing emission for the page.
    if (!shouldEmit()) return;
    navTimingFlushed = true;
    try {
      const navList = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const nav = navList[0];
      if (nav) {
        const start = nav.startTime ?? 0;
        if (nav.loadEventEnd > 0) {
          buffer.pushMetric("__auto_page_load", userId, anonId, {
            value: nav.loadEventEnd - start,
          });
        }
        if (nav.responseStart > 0) {
          buffer.pushMetric("__auto_ttfb", userId, anonId, {
            value: nav.responseStart - start,
          });
        }
        if (nav.domContentLoadedEventEnd > 0) {
          buffer.pushMetric("__auto_dom_ready", userId, anonId, {
            value: nav.domContentLoadedEventEnd - start,
          });
        }
      }
      const paints = performance.getEntriesByType("paint");
      for (const p of paints) {
        if (p.name === "first-paint") {
          buffer.pushMetric("__auto_fp", userId, anonId, { value: p.startTime });
        } else if (p.name === "first-contentful-paint") {
          buffer.pushMetric("__auto_fcp", userId, anonId, { value: p.startTime });
        }
      }
    } catch {}
  };

  // Session activity heartbeat — emits once per page load and again every
  // time the tab returns to the foreground after being hidden long enough
  // to look like a separate session. Drives D1/D7/D30 retention metrics.
  // Per-event, not per-tab: the dashboard counts unique users per day,
  // so even one emit per session is enough to mark the user active.
  if (groups.engagement) {
    try {
      if (shouldEmit()) buffer.pushMetric("__auto_session_active", userId, anonId, { value: 1 });
    } catch {}
    let lastEmit = Date.now();
    const SESSION_GAP_MS = 30 * 60 * 1000; // 30m of hidden → new session
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastEmit < SESSION_GAP_MS) return;
      if (!shouldEmit()) return;
      try {
        buffer.pushMetric("__auto_session_active", userId, anonId, { value: 1 });
        lastEmit = Date.now();
      } catch {}
    });
  }

  // Need a hide handler if any group emits something on hide. Vitals emit
  // LCP/INP/CLS/nav-timing; engagement emits the abandonment binary.
  const needHide = groups.vitals || groups.engagement;
  if (needHide) {
    if (document.readyState === "complete") {
      setTimeout(flushNavTiming, 0);
    } else {
      window.addEventListener(
        "load",
        () => {
          setTimeout(flushNavTiming, 0);
        },
        { once: true },
      );
    }

    const flushOnHide = () => {
      flushNavTiming();
      if (groups.vitals && shouldEmit()) {
        if (lcp !== null) buffer.pushMetric("__auto_lcp", userId, anonId, { value: lcp });
        if (inp !== null) buffer.pushMetric("__auto_inp", userId, anonId, { value: inp });
        if (clsBad) buffer.pushMetric("__auto_cls_binary", userId, anonId, { value: 1 });
      }
      if (groups.engagement) {
        // Unconditional by design — abandonment happens before exposures can
        // land; the analysis-side post-exposure filter handles attribution.
        const abandoned = lcp === null ? 1 : 0;
        buffer.pushMetric("__auto_abandoned", userId, anonId, { value: abandoned });
      }
      buffer.flush(true);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushOnHide();
    });
  }
}

// ---- Anonymous ID ----

function getOrCreateAnonId(): string {
  try {
    const stored = localStorage.getItem(ANON_ID_KEY);
    if (stored) return stored;
  } catch {}
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `anon_${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(ANON_ID_KEY, id);
  } catch {}
  return id;
}

// ---- FlagsClientBrowser ----

export type FlagsClientBrowserEnv = "dev" | "staging" | "prod";

export interface FlagsClientBrowserOptions {
  sdkKey: string;
  baseUrl?: string;
  autoGuardrails?: boolean;
  /**
   * Per-group enablement for auto-collected metrics. When set, overrides the
   * blanket `autoGuardrails` flag for the specific groups listed. Any group
   * not present in the object falls back to `autoGuardrails` (defaulting to
   * true when `autoGuardrails` is true).
   */
  autoGuardrailGroups?: Partial<AutoCollectGroups>;
  /**
   * Emit `__auto_*` metric events for ALL visitors, not just experiment
   * participants. Default false: auto-metrics are gated on the visitor having
   * seen ≥1 experiment exposure (the only data the analysis pipeline reads;
   * ungated emission is pure AE write cost at scale — see cost.md).
   */
  autoCollectAlways?: boolean;
  /** Which published env to read values from. Defaults to "prod". */
  env?: FlagsClientBrowserEnv;
  /**
   * Per-evaluation usage telemetry. ON by default — each getFlag/getConfig/
   * getExperiment/getKillswitch call fires one fire-and-forget sendBeacon so
   * usage is counted by Cloudflare's native per-path analytics. Pass `true` to
   * disable entirely.
   */
  disableTelemetry?: boolean;
  /** Override the telemetry beacon host. Defaults to {@link DEFAULT_TELEMETRY_URL}. */
  telemetryUrl?: string;
}

/**
 * Browser context auto-collected on every identify() so gate rules can
 * target by locale, timezone, path, etc. without callers having to wire
 * each attribute manually. Caller-supplied attrs always win — these are
 * spread first.
 */
function collectBrowserAttrs(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const attrs: Record<string, unknown> = {};
  try {
    if (typeof navigator !== "undefined" && navigator.language) attrs.locale = navigator.language;
  } catch {}
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) attrs.timezone = tz;
  } catch {}
  try {
    if (document.referrer) attrs.referrer = document.referrer;
  } catch {}
  try {
    attrs.path = window.location.pathname;
  } catch {}
  try {
    if (window.screen) {
      attrs.screen_width = window.screen.width;
      attrs.screen_height = window.screen.height;
    }
  } catch {}
  try {
    if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
      attrs.user_agent = navigator.userAgent;
    }
  } catch {}
  return attrs;
}

/**
 * Read `?se_exp_<name>=<group>` (and legacy `?se-exp-<name>=…`) URL params
 * and project them into the wire shape `/sdk/evaluate` expects. The worker
 * trusts these and bypasses normal allocation for the named experiments.
 */
function readExperimentOverridesFromUrl(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const out: Record<string, string> = {};
  try {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of params) {
      if (!v || v === "default" || v === "none") continue;
      if (k.startsWith("se_exp_")) out[k.slice("se_exp_".length)] = v;
      else if (k.startsWith("se-exp-")) out[k.slice("se-exp-".length)] = v;
    }
  } catch {}
  return out;
}

export class FlagsClientBrowser {
  private readonly sdkKey: string;
  private readonly baseUrl: string;
  private readonly autoGuardrails: boolean;
  private readonly autoGuardrailGroups: AutoCollectGroups;
  private readonly autoCollectAlways: boolean;
  private readonly env: FlagsClientBrowserEnv;
  private evalResult: EvalResponse | null = null;
  private anonId: string;
  private userId = "";
  private buffer: EventBuffer;
  private telemetry: Telemetry;
  private seeLimiter = new SeeLimiter();
  private guardrailsInstalled = false;
  private listeners = new Set<() => void>();
  private overrideListenerInstalled = false;
  // Monotonic counter so a later identify() always wins even if its /sdk/evaluate
  // response races and lands before an earlier in-flight call's response.
  private identifySeq = 0;
  private onOverrideChange = () => {
    this.installBridge();
    this.notify();
  };

  constructor(opts: FlagsClientBrowserOptions) {
    this.sdkKey = opts.sdkKey;
    this.baseUrl = (opts.baseUrl ?? "https://edge.shipeasy.dev").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
    // Auto web vitals + error capture defaults ON. Vitals/engagement emit
    // `__auto_*` metric events (the worker bypasses event-catalog validation
    // for those names); errors report into the errors primitive via the see()
    // path. Callers opt out by passing `autoGuardrails: false` or by
    // narrowing per-group via `autoGuardrailGroups`.
    this.autoGuardrails = opts.autoGuardrails !== false;
    this.autoCollectAlways = opts.autoCollectAlways === true;
    const g = opts.autoGuardrailGroups ?? {};
    this.autoGuardrailGroups = {
      vitals: g.vitals ?? this.autoGuardrails,
      errors: g.errors ?? this.autoGuardrails,
      engagement: g.engagement ?? this.autoGuardrails,
    };
    this.anonId = getOrCreateAnonId();
    this.buffer = new EventBuffer(`${this.baseUrl}/collect`, this.sdkKey);
    this.telemetry = new Telemetry({
      endpoint: opts.telemetryUrl ?? DEFAULT_TELEMETRY_URL,
      sdkKey: this.sdkKey,
      side: "client",
      env: this.env,
      disabled: opts.disableTelemetry,
    });
    void this.buffer.flushPendingAlias();
  }

  async identify(user: User): Promise<void> {
    const seq = ++this.identifySeq;
    const prevUserId = this.userId;
    // Override caller-supplied user fields onto whatever was set by previous
    // identify()s — last call wins. anonId is held separately and never
    // touched by this path, so it stays stable for the lifetime of the tab.
    if (user.user_id !== undefined) this.userId = user.user_id;

    // Stitch anonymous → identified user in analysis
    if (this.anonId && this.userId && this.userId !== prevUserId) {
      await this.buffer.alias(this.anonId, this.userId);
    }

    // Always include anonymous_id so the worker can hash users into rollouts /
    // universes even when the caller hasn't identified yet. Auto-collected
    // browser attrs (locale, timezone, path, screen, referrer, user_agent)
    // populate before caller-supplied fields, so callers always win.
    const userPayload: User = {
      ...collectBrowserAttrs(),
      anonymous_id: this.anonId,
      ...user,
    };
    const res = await fetch(`${this.baseUrl}/sdk/evaluate?env=${this.env}`, {
      method: "POST",
      headers: { "X-SDK-Key": this.sdkKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        user: userPayload,
        experiment_overrides: readExperimentOverridesFromUrl(),
      }),
    });
    if (!res.ok) throw new Error(`/sdk/evaluate returned ${res.status}`);
    const data = (await res.json()) as EvalResponse;
    // Drop stale responses: a newer identify() has already started and its
    // result will replace ours. Don't notify or install guardrails either,
    // so a single later identify never gets shadowed.
    if (seq !== this.identifySeq) return;
    this.evalResult = data;

    const anyGroupOn =
      this.autoGuardrailGroups.vitals ||
      this.autoGuardrailGroups.errors ||
      this.autoGuardrailGroups.engagement;
    if (anyGroupOn && !this.guardrailsInstalled) {
      this.guardrailsInstalled = true;
      installAutoGuardrails(
        this.buffer,
        this.userId,
        this.anonId,
        this.autoGuardrailGroups,
        (problem, consequence, extras, kind) =>
          this.reportError(problem, consequence, extras, kind),
        [`${this.baseUrl}/`, DEFAULT_TELEMETRY_URL],
        this.autoCollectAlways,
      );
    }
    this.notify();
  }

  /**
   * Report a structured error into the errors primitive. Flushes immediately
   * (beacon-first) — error occurrences are near-real-time, never queued behind
   * the 5s metric batch. Spam-guarded by a 30s dedup window + per-session cap.
   */
  reportError(
    problem: unknown,
    consequence: Consequence,
    extras?: SeeExtras,
    kind?: SeeKind,
  ): void {
    try {
      const ev = buildSeeEvent(problem, consequence, extras, {
        side: "client",
        sdkVersion: version,
        env: this.env,
        url: typeof window !== "undefined" && window.location ? window.location.href : undefined,
        userId: this.userId || undefined,
        anonId: this.anonId,
      }, kind);
      if (!this.seeLimiter.shouldSend(ev)) return;
      this.buffer.sendNow([ev]);
    } catch {
      /* error reporting must never throw into product code */
    }
  }

  get ready(): boolean {
    return this.evalResult !== null;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.warn("[shipeasy] subscriber threw:", String(err));
      }
    }
  }

  initFromBootstrap(data: EvalResponse): void {
    this.evalResult = data;
  }

  getFlag(name: string): boolean {
    this.telemetry.emit("gate", name);
    if (this.evalResult === null) return false;
    const ov = readGateOverride(name);
    if (ov !== null) return ov;
    return this.evalResult.flags[name] ?? false;
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    this.telemetry.emit("config", name);
    if (this.evalResult === null) return undefined;
    const ov = readConfigOverride(name);
    const raw = ov !== undefined ? ov : this.evalResult.configs?.[name];
    if (raw === undefined) return undefined;
    if (!decode) return raw as T;
    try {
      return decode(raw);
    } catch (err) {
      console.warn(`[shipeasy] getConfig('${name}') decode failed:`, String(err));
      return undefined;
    }
  }

  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
    decode?: (raw: unknown) => P,
    variants?: Record<string, Partial<P>>,
  ): ExperimentResult<P> {
    this.telemetry.emit("experiment", name);
    const notIn: ExperimentResult<P> = {
      inExperiment: false,
      group: "control",
      params: defaultParams,
    };

    // URL-forced variant short-circuits the server response so the demo
    // works synchronously before identify() resolves. Caller can supply a
    // `variants` map to merge variant-specific params on top of defaults.
    const ov = readExpOverride(name);
    if (ov !== null) {
      const variantParams = variants?.[ov];
      const params = variantParams ? { ...defaultParams, ...variantParams } : defaultParams;
      return { inExperiment: true, group: ov, params };
    }

    const entry = this.evalResult?.experiments[name];
    if (!entry || !entry.inExperiment) return notIn;
    // Auto-log exposure (deduped within session)
    this.buffer.pushExposure(name, entry.group, this.userId, this.anonId);
    if (!decode) return { inExperiment: true, group: entry.group, params: entry.params as P };
    try {
      return { inExperiment: true, group: entry.group, params: decode(entry.params) };
    } catch (err) {
      console.warn(`[shipeasy] getExperiment('${name}') decode failed:`, String(err));
      return notIn;
    }
  }

  /**
   * Subscribe to state changes — fires after identify() completes and on
   * `se:override:change` events from the devtools overlay. Returns an
   * unsubscribe function. Used by framework adapters to trigger re-renders.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.overrideListenerInstalled && typeof window !== "undefined") {
      this.overrideListenerInstalled = true;
      window.addEventListener("se:override:change", this.onOverrideChange);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Publishes the SDK to `window.__shipeasy` so the devtools overlay can read
   * current values. Idempotent. Returns the bridge object for tests.
   */
  installBridge(): ShipeasySdkBridge | null {
    if (typeof window === "undefined") return null;
    const bridge: ShipeasySdkBridge = {
      getFlag: (n) => this.getFlag(n),
      getExperiment: (n) => {
        const r = this.getExperiment(n, {});
        return { inExperiment: r.inExperiment, group: r.group };
      },
      getConfig: (n) => this.getConfig(n),
    };
    (window as unknown as { __shipeasy?: ShipeasySdkBridge }).__shipeasy = bridge;
    window.dispatchEvent(new CustomEvent("se:state:update"));
    return bridge;
  }

  track(eventName: string, props?: Record<string, unknown>): void {
    this.buffer.pushMetric(eventName, this.userId, this.anonId, props);
  }

  /**
   * Read a killswitch from the server's evaluated state. Without `switchKey`,
   * returns true when the killswitch is whole-killed. With `switchKey`, returns
   * the per-switch state. Returns false for unknown killswitches / switches.
   */
  getKillswitch(name: string, switchKey?: string): boolean {
    this.telemetry.emit("ks", name);
    if (this.evalResult === null) return false;
    const ks = this.evalResult.killswitches?.[name];
    if (ks === undefined) return false;
    if (typeof ks === "boolean") return switchKey === undefined ? ks : false;
    if (switchKey === undefined) return false;
    return ks[switchKey] === true;
  }

  async flush(): Promise<void> {
    await this.buffer.flushAsync();
  }

  destroy(): void {
    this.buffer.flush();
    this.buffer.destroy();
    this.listeners.clear();
    if (this.overrideListenerInstalled && typeof window !== "undefined") {
      window.removeEventListener("se:override:change", this.onOverrideChange);
      this.overrideListenerInstalled = false;
    }
  }
}

// ---- URL overrides ----
//
// Single source of truth for ?se_ks_, ?se_config_, ?se_exp_ params. Mirrored
// (but not duplicated) by packages/devtools/src/overrides.ts which writes them.

const TRUE_RX = /^(true|on|1|yes)$/i;
const FALSE_RX = /^(false|off|0|no)$/i;

function parseBool(raw: string): boolean | null {
  if (TRUE_RX.test(raw)) return true;
  if (FALSE_RX.test(raw)) return false;
  return null;
}

function decodeConfigValue(raw: string): unknown {
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

function readParam(canonical: string, legacy?: string): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const params = new URLSearchParams(window.location.search);
  const direct = params.get(canonical);
  if (direct !== null) return direct;
  if (legacy) {
    const legacyVal = params.get(legacy);
    if (legacyVal !== null) return legacyVal;
  }
  return null;
}

export function readGateOverride(name: string): boolean | null {
  const v =
    readParam(`se_ks_${name}`) ?? readParam(`se_gate_${name}`) ?? readParam(`se-gate-${name}`);
  return v === null ? null : parseBool(v);
}

export function readConfigOverride(name: string): unknown {
  const v = readParam(`se_config_${name}`, `se-config-${name}`);
  if (v === null) return undefined;
  return decodeConfigValue(v);
}

export function readExpOverride(name: string): string | null {
  const v = readParam(`se_exp_${name}`, `se-exp-${name}`);
  if (v === null || v === "" || v === "default" || v === "none") return null;
  return v;
}

export function isDevtoolsRequested(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  const p = new URLSearchParams(window.location.search);
  return p.has("se") || p.has("se_devtools") || p.has("se-devtools");
}

// ---- Devtools bridge + loader ----

/** Bridge written to window.__shipeasy — mirrors @shipeasy/devtools' contract. */
export interface ShipeasySdkBridge {
  getFlag(name: string): boolean;
  getExperiment(name: string): { inExperiment: boolean; group: string } | undefined;
  getConfig(name: string): unknown;
}

interface DevtoolsMod {
  init(opts: { adminUrl?: string; edgeUrl?: string }): void;
  destroy(): void;
}

/**
 * If the host page already mounted the standalone devtools IIFE bundle (which
 * exposes `window.__shipeasy_devtools_global`), call its init() and wire up a
 * toggle handle at `window.__shipeasy_devtools`. No-op when the bundle is
 * absent — the customer is responsible for mounting it themselves.
 */
export function loadDevtools(opts: { adminUrl?: string; edgeUrl?: string } = {}): void {
  if (typeof window === "undefined") return;
  const wGlobal = window as unknown as { __shipeasy_devtools_global?: DevtoolsMod };
  const mod = wGlobal.__shipeasy_devtools_global;
  if (!mod) return;
  mod.init(opts);

  const w = window as unknown as { __shipeasy_devtools?: { toggle: () => void } };
  if (!w.__shipeasy_devtools) {
    let visible = true;
    w.__shipeasy_devtools = {
      toggle() {
        if (visible) {
          mod.destroy();
          visible = false;
        } else {
          mod.init(opts);
          visible = true;
        }
      },
    };
  }
}

interface AttachDevtoolsOptions {
  /** Hotkey string in the form "Shift+Alt+S". */
  hotkey?: string;
  adminUrl?: string;
  edgeUrl?: string;
}

/**
 * One-call bootstrap for the devtools overlay. Installs the bridge, optionally
 * auto-loads the overlay if the page was opened with `?se`, registers a hotkey
 * listener for opening/toggling the overlay, and re-publishes the bridge after
 * each `identify()`/override change. Returns an unsubscribe function for
 * cleanup (e.g. React effect teardown).
 */
export function attachDevtools(
  client: FlagsClientBrowser,
  opts: AttachDevtoolsOptions = {},
): () => void {
  if (typeof window === "undefined") return () => {};

  const hotkey = opts.hotkey ?? "Shift+Alt+S";
  const parts = hotkey.split("+");
  const key = parts[parts.length - 1];
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  const ctrl = parts.includes("Ctrl") || parts.includes("Control");
  const meta = parts.includes("Meta") || parts.includes("Cmd");

  client.installBridge();
  if (isDevtoolsRequested()) loadDevtools({ adminUrl: opts.adminUrl, edgeUrl: opts.edgeUrl });

  let loaded = isDevtoolsRequested();
  function onKeyDown(e: KeyboardEvent) {
    if (
      e.key === key &&
      e.shiftKey === shift &&
      e.altKey === alt &&
      e.ctrlKey === ctrl &&
      e.metaKey === meta
    ) {
      if (!loaded) {
        loaded = true;
        loadDevtools({ adminUrl: opts.adminUrl, edgeUrl: opts.edgeUrl });
      } else {
        (
          window as unknown as { __shipeasy_devtools?: { toggle: () => void } }
        ).__shipeasy_devtools?.toggle();
      }
    }
  }
  window.addEventListener("keydown", onKeyDown);
  const unsubBridge = client.subscribe(() => client.installBridge());

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    unsubBridge();
  };
}

// ---- Module-scope singletons ----
//
// Most apps want one client per page. Rather than ask every callsite to
// pass a `FlagsClientBrowser` instance around, expose a configurable
// singleton plus two facade objects (`flags`, `i18n`) that any module —
// React component, event handler, util fn, plain JS — can import directly:
//
//   import { configureShipeasy, flags, i18n } from "@shipeasy/sdk/client";
//   configureShipeasy({ sdkKey: "...", baseUrl: "..." });
//   await flags.identify({ user_id });
//   flags.get("new_checkout");
//   i18n.t("hero.title", "Welcome, {{name}}", { name });
//
// The React adapter wraps the same singletons and adds a re-render
// subscription — it does not re-export them, so customers consistently
// reach for the central import.

let _client: FlagsClientBrowser | null = null;

/** Configure the singleton. Idempotent — re-calling with the same opts is a no-op. */
// ---- Unified top-level configure API ----

export interface ShipeasyClientConfig {
  /**
   * Public client key — the ONLY key the browser entrypoint accepts. Authenticates
   * /sdk/evaluate, /collect and the runtime i18n loader (/sdk/i18n/strings). Safe to
   * expose (e.g. NEXT_PUBLIC_ env vars). This is a different key from the server key
   * passed to `shipeasy({ serverKey })` in @shipeasy/sdk/server — never use the
   * server key here.
   */
  clientKey: string;
  /** Override the ShipEasy CDN/edge base URL. Defaults to https://cdn.shipeasy.ai. */
  baseUrl?: string;
  /** Override the admin URL for the devtools overlay (dev use). */
  adminUrl?: string;
  /**
   * i18n profile for the runtime string loader, e.g. "en:prod". Defaults to the
   * profile the server recorded in window.__SE_BOOTSTRAP, then "en:prod".
   */
  i18nProfile?: string;
  /**
   * Skip the lazy auto-identify({}) at boot. Defaults to true (auto-identify on).
   * Turn off when the host has its own identify orchestration and wants to
   * avoid the initial anon /sdk/evaluate round-trip.
   */
  autoIdentify?: boolean;
  /**
   * Capture web vitals (LCP, CLS, INP, TTFB, FCP, navigation timing) and
   * engagement signals (abandonment) as `__auto_*` metric events, plus JS /
   * network errors as structured error events in the errors primitive (same
   * pipeline as `see()` — grouped by fingerprint, near-real-time). Defaults
   * to `true`.
   *
   * Pass `false` to disable everything, or a per-group object to narrow:
   *
   * ```ts
   * shipeasy({ clientKey, autoCollect: false });               // off
   * shipeasy({ clientKey, autoCollect: { errors: false } });   // vitals + engagement only
   * shipeasy({ clientKey });                                   // all groups on
   * ```
   *
   * Since 4.1.0, `__auto_*` metric events are only emitted for visitors who
   * are in ≥1 active experiment (the analysis pipeline reads nothing else;
   * gating cuts the dominant Analytics Engine write cost at scale). Pass
   * `{ always: true }` to collect site-wide vitals regardless of experiment
   * participation:
   *
   * ```ts
   * shipeasy({ clientKey, autoCollect: { always: true } });    // site-wide vitals
   * ```
   *
   * `__auto_abandoned` is always emitted (it fires when the user leaves
   * before exposures could land) and error capture is unaffected.
   */
  autoCollect?: boolean | (Partial<AutoCollectGroups> & { always?: boolean });
  /**
   * Disable per-evaluation usage telemetry. Telemetry is ON by default — every
   * flag/config/experiment/killswitch read fires one fire-and-forget beacon
   * counted by Cloudflare's native per-path analytics. Pass `true` to opt out.
   */
  disableTelemetry?: boolean;
}

/**
 * Initialise the ShipEasy client SDK and wire up lazy devtools.
 * Call this once at app startup (e.g. in a useEffect in your root layout).
 * Returns a cleanup function — call it on unmount to remove event listeners.
 *
 * Lazy-identifies the visitor under the hood with a stable anonId + auto-collected
 * browser attrs (locale, timezone, path, screen, referrer, user_agent), so flags
 * and experiments are warm without callers having to wire identify() manually.
 * A later flags.identify({ user_id }) overrides this in place; anonId stays stable.
 */
export function shipeasy(opts: ShipeasyClientConfig): () => void {
  const ac = opts.autoCollect;
  const blanket = ac === false ? false : true;
  const acObj = ac && typeof ac === "object" ? ac : undefined;
  const groups: Partial<AutoCollectGroups> | undefined = acObj
    ? { vitals: acObj.vitals, errors: acObj.errors, engagement: acObj.engagement }
    : undefined;
  const baseUrl = opts.baseUrl ?? "https://cdn.shipeasy.ai";
  const client = configureShipeasy({
    sdkKey: opts.clientKey,
    baseUrl,
    autoGuardrails: blanket,
    autoGuardrailGroups: groups,
    autoCollectAlways: acObj?.always === true,
    disableTelemetry: opts.disableTelemetry,
  });
  // Inject the runtime i18n loader with the client key. The server no longer
  // does this (it doesn't hold the client key); the SSR shim in __SE_BOOTSTRAP
  // covers first paint, then this loader fetches fresh strings client-side.
  injectI18nLoader(opts.clientKey, baseUrl, opts.i18nProfile);
  flags.notifyMounted();
  if (opts.autoIdentify !== false) {
    void client.identify({}).catch((err) => {
      console.warn("[shipeasy] auto-identify failed:", String(err));
    });
  }
  return attachDevtools(client, { adminUrl: opts.adminUrl });
}

export function configureShipeasy(opts: FlagsClientBrowserOptions): FlagsClientBrowser {
  if (_client) return _client;
  _client = new FlagsClientBrowser(opts);
  return _client;
}

/** Returns the configured singleton, or null if configureShipeasy() hasn't run yet. */
export function getShipeasyClient(): FlagsClientBrowser | null {
  return _client;
}

/**
 * Test helper — drop the singleton so the next configureShipeasy() builds fresh.
 * Not part of the documented surface; production code should never call this.
 */
export function _resetShipeasyForTests(): void {
  _client?.destroy();
  _client = null;
  _i18nLoaderInjected = false;
}

let _i18nLoaderInjected = false;

/**
 * Inject the CDN i18n loader (<script src=.../sdk/i18n/loader.js data-key data-profile>)
 * which fetches profile strings at runtime and installs window.i18n. Owned by the
 * client entrypoint because it carries the client key; the server never injects it.
 * Idempotent — only the first call per page wins.
 */
function injectI18nLoader(clientKey: string, baseUrl: string, profileOpt?: string): void {
  if (_i18nLoaderInjected || typeof document === "undefined") return;
  if (!clientKey || typeof document.createElement !== "function" || !document.head) return;
  _i18nLoaderInjected = true;
  try {
    const bs = getBootstrap();
    const profile = profileOpt ?? bs?.i18nProfile ?? "en:prod";
    const s = document.createElement("script");
    s.src = `${baseUrl}/sdk/i18n/loader.js`;
    s.setAttribute("data-key", clientKey);
    s.setAttribute("data-profile", profile);
    document.head.appendChild(s);
  } catch {
    /* non-DOM runtime or partial document — i18n loader is optional */
  }
}

// Bootstrap payload injected by the server via `window.__SE_BOOTSTRAP`.
// Allows flags.get/getConfig to return real values synchronously on first
// render when the server has pre-evaluated them, without hitting _mountedAndReady.
export interface BootstrapPayload {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  experiments: Record<
    string,
    { inExperiment: boolean; group: string; params: Record<string, unknown> }
  >;
  /**
   * Killswitch state, flattened by the server. A value of `boolean` means the
   * killswitch is killed as a whole (no per-switch detail); a `Record` means
   * the killswitch is not whole-killed and the map carries per-switch state.
   */
  killswitches?: Record<string, boolean | Record<string, boolean>>;
  /** i18n profile the server rendered with, so the client loader matches. No key is embedded. */
  i18nProfile?: string;
  apiUrl?: string;
  /** When true, tEl() returns marker-wrapped strings for devtools label editing. */
  editLabels?: boolean;
}

function getBootstrap(): BootstrapPayload | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __SE_BOOTSTRAP?: BootstrapPayload }).__SE_BOOTSTRAP ?? null;
}

// One-way latch set by FlagsBoundary after React hydration completes.
// flags.get/getConfig return safe SSR defaults until this is true, which
// prevents hydration mismatches on force-static pages when ?se_ks_* params
// are present in the URL.
let _mountedAndReady = false;

// Listener set for the no-client case: lets FlagsBoundary subscribe to
// se:override:change events (dispatched by devtools on URL param changes).
const _standaloneListeners = new Set<() => void>();
let _standaloneOverrideWired = false;

function wireStandaloneOverride(): void {
  if (_standaloneOverrideWired || typeof window === "undefined") return;
  _standaloneOverrideWired = true;
  window.addEventListener("se:override:change", () => {
    for (const cb of _standaloneListeners) cb();
  });
}

/**
 * Universal flags facade. Methods return safe defaults when the singleton
 * hasn't been configured yet (false / undefined / `notIn` experiment), so
 * importing this in a module that loads before app boot is harmless.
 */
export const flags = {
  configure(opts: FlagsClientBrowserOptions): void {
    configureShipeasy(opts);
  },
  identify(user: User): Promise<void> {
    if (!_client) {
      console.warn("[shipeasy] flags.identify called before configureShipeasy()");
      return Promise.resolve();
    }
    return _client.identify(user);
  },
  /**
   * Read a feature gate.
   * Priority: bootstrap → CDN/URL-override (post-mount) → false.
   * Bootstrap is safe before mount because the server rendered with the same values.
   * Everything else gates on _mountedAndReady to prevent hydration mismatches on
   * force-static pages where SSR has no flag data.
   */
  get(name: string): boolean {
    const bs = getBootstrap();
    if (bs !== null && name in bs.flags) return bs.flags[name];
    if (!_mountedAndReady) return false;
    if (_client) return _client.getFlag(name); // includes URL overrides + evalResult
    return readGateOverride(name) ?? false;
  },
  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    const bs = getBootstrap();
    if (bs !== null && name in bs.configs) {
      const raw = bs.configs[name];
      if (!decode) return raw as T;
      try {
        return decode(raw);
      } catch {
        return undefined;
      }
    }
    if (!_mountedAndReady) return undefined;
    if (_client) return _client.getConfig(name, decode);
    const ov = readConfigOverride(name);
    if (ov === undefined) return undefined;
    if (!decode) return ov as T;
    try {
      return decode(ov);
    } catch {
      return undefined;
    }
  },
  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
    decode?: (raw: unknown) => P,
    variants?: Record<string, Partial<P>>,
  ): ExperimentResult<P> {
    return (
      _client?.getExperiment(name, defaultParams, decode, variants) ?? {
        inExperiment: false,
        group: "control",
        params: defaultParams,
      }
    );
  },
  track(eventName: string, props?: Record<string, unknown>): void {
    _client?.track(eventName, props);
  },
  /**
   * Read a killswitch. Without `switchKey`, returns true when the killswitch is
   * killed as a whole. With `switchKey`, returns true when that specific switch
   * is on. Unknown killswitches / switches return false.
   *
   * Priority: bootstrap → CDN evalResult (post-mount) → false. Matches the
   * pattern used by `flags.get` / `flags.getConfig` so SSR-hydrated values are
   * available synchronously on first render.
   */
  ks(name: string, switchKey?: string): boolean {
    const bs = getBootstrap();
    if (bs !== null && bs.killswitches && name in bs.killswitches) {
      const ks = bs.killswitches[name];
      if (typeof ks === "boolean") return switchKey === undefined ? ks : false;
      if (switchKey === undefined) return false;
      return ks[switchKey] === true;
    }
    if (!_mountedAndReady) return false;
    return _client?.getKillswitch(name, switchKey) ?? false;
  },
  flush(): Promise<void> {
    return _client?.flush() ?? Promise.resolve();
  },
  /**
   * Called by FlagsBoundary after React hydration to unlock flag reads.
   * Dispatches se:override:change so subscribers (FlagsBoundary) re-render
   * once with real values — URL overrides and CDN-loaded flags.
   *
   * Always dispatches even if already mounted: in React hydration-recovery
   * renders the latch is already true so the early-return guard would swallow
   * the event, leaving the re-mounted subtree stuck with stale (empty) values.
   */
  notifyMounted(): void {
    _mountedAndReady = true;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("se:override:change"));
    }
  },
  /** Subscribe for change notifications (identify/override). Used by framework adapters. */
  subscribe(listener: () => void): () => void {
    if (_client) return _client.subscribe(listener);
    // No client configured — still wire se:override:change so devtools can trigger re-renders.
    _standaloneListeners.add(listener);
    wireStandaloneOverride();
    return () => _standaloneListeners.delete(listener);
  },
  /** True once identify() has completed and flags are available. */
  get ready(): boolean {
    return _client?.ready ?? false;
  },
};

// ---- see (structured error reporting) ----

export interface SeeApi {
  /**
   * Report a handled problem and its product consequence:
   *
   * ```ts
   * import { see } from "@shipeasy/sdk/client";
   *
   * try {
   *   await submitOrder(order);
   * } catch (e) {
   *   see(e).causes_the("checkout").to("use cached prices").extras({ order_id: order.id });
   * }
   * ```
   *
   * The chain dispatches on the next microtask, so the report ships
   * immediately after the statement (no `.send()` needed) into the errors
   * primitive — grouped by fingerprint, near-real-time timeseries. If you
   * don't know the consequence of an exception, don't catch it.
   */
  (problem: unknown): SeeChain;
  /**
   * Report a non-exception problem. Prefer passing a caught Error to `see()`
   * when one exists. The name is a stable identifier (it participates in the
   * issue fingerprint) — variable data goes in `.message()` or `.extras()`.
   *
   * ```ts
   * if (rows.length > LIMIT) {
   *   see.Violation("large query").message(`got ${rows.length} rows`)
   *      .causes_the("search results").to("be trimmed");
   * }
   * ```
   */
  Violation(name: string): SeeViolationChain;
  /**
   * Mark an exception as expected control flow — auto-capture skips it and
   * nothing is reported. The reason must start with "because".
   *
   * ```ts
   * } catch (e) {
   *   see.ControlFlowException(e, "because the blob wasn't an encoded Foo");
   *   return decodeAsBar(blob);
   * }
   * ```
   */
  ControlFlowException(err: unknown, because: string): void;
}

function dispatchSee(
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  kind?: SeeKind,
): void {
  if (!_client) {
    console.warn("[shipeasy] see() called before shipeasy({ clientKey }) — error dropped");
    return;
  }
  _client.reportError(problem, consequence, extras, kind);
}

/**
 * Structured error reporter — the whole grammar hangs off this one import.
 * Safe to import anywhere; a call before `shipeasy({ clientKey })` warns and
 * drops (never throws).
 */
export const see: SeeApi = Object.assign(
  (problem: unknown): SeeChain => startSeeChain(() => problem, dispatchSee),
  {
    Violation: (name: string): SeeViolationChain => startSeeViolationChain(name, dispatchSee),
    ControlFlowException: markExpected,
  },
);

// ---- i18n label helpers (formerly @shipeasy/i18n-core) ----

export const LABEL_MARKER_START = "￹";
export const LABEL_MARKER_SEP = "￺";
export const LABEL_MARKER_END = "￻";
// 3-section format: ￹key￺varsJson￺value￻ — varsJson is "" when no vars,
// otherwise JSON.stringify(vars). Devtools picks up vars without diffing
// template against value.
export const LABEL_MARKER_RE = /￹([^￺￻]+)￺([^￺￻]*)￺([^￻]*)￻/g;

export function encodeLabelMarker(
  key: string,
  value: string,
  variables?: I18nVariables,
): string {
  const varsJson = variables && Object.keys(variables).length > 0 ? JSON.stringify(variables) : "";
  return `${LABEL_MARKER_START}${key}${LABEL_MARKER_SEP}${varsJson}${LABEL_MARKER_SEP}${value}${LABEL_MARKER_END}`;
}

export interface LabelAttrs {
  "data-label": string;
  "data-variables"?: string;
  "data-label-desc"?: string;
}

export function labelAttrs(
  key: string,
  variables?: Record<string, string | number>,
  desc?: string,
): LabelAttrs {
  const attrs: LabelAttrs = { "data-label": key };
  if (variables) attrs["data-variables"] = JSON.stringify(variables);
  if (desc) attrs["data-label-desc"] = desc;
  return attrs;
}

// Legacy hook — kept so existing callers of `i18n.configure({ createElement })`
// don't break, but no longer consumed by tEl/rich. New code should use
// `configure({ components })` to override rich-text tag rendering.
let _createElement: ((tag: string, props: object, children: string) => unknown) | null = null;
// Touched only to silence unused-variable warnings under strict tsconfigs.
void _createElement;

// ---- SSR i18n store -----------------------------------------------------------
//
// The server SDK (@shipeasy/sdk/server) populates an AsyncLocalStorage-backed
// store per request and registers a getter under a shared Symbol so this client
// module can reach it without a direct import (the two are separate bundles).
//
// In the browser the symbol is never set, so getSSRI18nStore() returns null and
// all paths fall back to window.i18n (populated by the CDN loader script) or to
// the hardcoded fallback string in tEl().
//
// Next.js compiles RSC and the SSR-of-client-components pass into separate
// module graphs. Server Components import @shipeasy/sdk/server, which installs
// the getter; "use client" components only import this module, so the SSR pass
// for them can run in a graph where the server module never evaluated and the
// getter is missing. To keep SSR strings reachable in that case, fall back to
// reading the shared cache Map directly — the server SDK parks it on globalThis
// under the same registry-shared Symbol.for() key, so it's visible across
// module instances.

const _I18N_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n");
const _I18N_CACHE_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n-cache");
const _EDIT_MODE_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode");

type _SSRI18nStore = { strings: Record<string, string>; locale: string };

function getSSRI18nStore(): _SSRI18nStore | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromGetter = (globalThis as any)[_I18N_SSR_SYM]?.() as _SSRI18nStore | null | undefined;
  if (fromGetter && Object.keys(fromGetter.strings).length > 0) return fromGetter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (globalThis as any)[_I18N_CACHE_SYM] as Map<string, _SSRI18nStore> | undefined;
  if (cache) {
    for (const v of cache.values()) {
      if (Object.keys(v.strings).length > 0) return v;
    }
  }
  return fromGetter ?? null;
}

// Server-side fallback symbol kept in lockstep with server/index.ts so the
// client module can read edit-mode without depending on server/index.ts having
// installed its property getter on globalThis. Next.js bundles RSC, SSR and
// Edge layers separately — the layer that runs t() may not be the one that
// imported `@shipeasy/sdk/server`, so the getter side-effect can't be relied
// on. Reading the fallback symbol directly works regardless of import order.
const _EDIT_MODE_FALLBACK_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode-fallback");

function isEditLabelsMode(): boolean {
  if (typeof window !== "undefined") {
    // Client: check bootstrap payload (set by server) or live URL param.

    return (
      !!(window as any).__SE_BOOTSTRAP?.editLabels ||
      new URLSearchParams(location.search).has("se_edit_labels")
    );
  }
  // SSR: read directly from globalThis where the server SDK writes it.
  // Try the property getter first (more accurate via ALS), then fall back to
  // the plain global so we still get the right answer when only one of the
  // two SDK module instances was loaded in this RSC/SSR layer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (globalThis as any)[_EDIT_MODE_SSR_SYM];
  if (typeof val === "boolean") return val;
  if (typeof val === "function") return (val as () => boolean)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fb = (globalThis as any)[_EDIT_MODE_FALLBACK_SYM];
  return typeof fb === "boolean" ? fb : false;
}

export type I18nVariables = Record<string, string | number | null | undefined>;
export type I18nTagRenderer = (content: string) => unknown;
export type I18nRichComponents = Record<string, I18nTagRenderer>;

// ---- Branded string types ----
//
// Both brands are optional phantom properties so plain string literals are
// assignable in either direction:
//   - any `string` flows into a parameter typed `I18nKey` (the brand widens
//     out), so callers don't need to cast every key literal.
//   - the result of `i18n.t()` (`I18nString`) is also a `string` and can be
//     passed anywhere a string is expected, while still being narrowable in
//     APIs that want to enforce "this came from i18n".
//
// Use `I18nKey` to type config maps / catalogs of translation keys. Use
// `I18nString` for component props / fn args that should only accept
// translated text (e.g. `title: I18nString`) — TS will then nudge callers
// toward `i18n.t(...)` instead of hardcoded literals via a lint rule.

declare const __i18nKeyBrand: unique symbol;
declare const __i18nStringBrand: unique symbol;

export type I18nKey = string & { readonly [__i18nKeyBrand]?: never };
export type I18nString = string & { readonly [__i18nStringBrand]?: never };

function interpolate(raw: string, variables?: I18nVariables): string {
  if (!variables) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (placeholder, k) => {
    const v = variables[k];
    return v != null ? String(v) : placeholder;
  });
}

// ---- Built-in HTML tag renderers for i18n.rich() ----
//
// Default renderers for common inline HTML tags. In the browser they return
// real DOM nodes via `document.createElement`. In Node/SSR they return the
// equivalent HTML string. Detected once at module load so callers don't have
// to pay the typeof check per call.

const _IS_BROWSER = typeof document !== "undefined";
const _RICH_HTML_TAGS = [
  "b",
  "i",
  "u",
  "s",
  "em",
  "strong",
  "del",
  "ins",
  "mark",
  "small",
  "code",
  "pre",
  "kbd",
  "sub",
  "sup",
  "span",
  "a",
  "p",
  "br",
  "hr",
] as const;

function _makeBuiltinTags(): I18nRichComponents {
  const tags: I18nRichComponents = {};
  for (const tag of _RICH_HTML_TAGS) {
    tags[tag] = _IS_BROWSER
      ? (text: string) => {
          const el = document.createElement(tag);
          if (tag !== "br" && tag !== "hr") el.textContent = text;
          return el;
        }
      : (text: string) => (tag === "br" || tag === "hr" ? `<${tag}>` : `<${tag}>${text}</${tag}>`);
  }
  return tags;
}

const _builtinTags: I18nRichComponents = _makeBuiltinTags();
let _configuredComponents: I18nRichComponents = {};

// Match either <tag>content</tag> or self-closing <tag/>. Tag names are
// limited to ASCII identifier characters — we don't try to support arbitrary
// XML names, which keeps the regex safe and the AST shallow.
const _RICH_TAG_RE = /<(\w+)(?:\s*\/>|>([\s\S]*?)<\/\1>)/g;

function _parseRichText(text: string, components: I18nRichComponents): unknown {
  const parts: unknown[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let allStrings = true;

  _RICH_TAG_RE.lastIndex = 0;
  while ((match = _RICH_TAG_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const tag = match[1];
    const content = match[2] ?? "";
    const renderer = components[tag] ?? _configuredComponents[tag] ?? _builtinTags[tag];
    if (renderer) {
      const rendered = renderer(content);
      if (typeof rendered !== "string") allStrings = false;
      parts.push(rendered);
    } else {
      // No renderer — fall back to passthrough text content.
      parts.push(content);
    }
    lastIndex = _RICH_TAG_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  if (allStrings) return parts.join("");
  return parts;
}

/**
 * Universal i18n facade. Backed by the `window.i18n` global the loader
 * script installs. Returns the key itself when the loader hasn't run
 * (SSR, missing script tag, before profile fetch completes), so call
 * sites never need to null-check.
 */
function _resolveTranslation(key: string, variables?: I18nVariables): string | undefined {
  if (typeof window !== "undefined" && window.i18n) {
    const v = window.i18n.t(key, variables as Record<string, string | number> | undefined);
    return v === key ? undefined : v;
  }
  const store = getSSRI18nStore();
  if (store?.strings[key]) return interpolate(store.strings[key], variables);
  return undefined;
}

export interface I18nFacade {
  t<F extends string>(key: I18nKey, fallback: F, variables?: I18nVariables): F & I18nString;
  t(key: I18nKey, variables?: I18nVariables): I18nString;
  rich(
    key: I18nKey,
    fallback: string,
    components?: I18nRichComponents,
    variables?: I18nVariables,
  ): unknown;
  tEl<F extends string>(
    key: I18nKey,
    fallback: F,
    variables?: I18nVariables,
    desc?: string,
  ): F & I18nString;
  configure(opts: {
    components?: I18nRichComponents;
    createElement?: (tag: string, props: object, children: string) => unknown;
  }): void;
  readonly locale: string | null;
  readonly ready: boolean;
  whenReady(): Promise<void>;
  onUpdate(cb: () => void): () => void;
}

export const i18n: I18nFacade = {
  t(key: string, fallbackOrVars?: string | I18nVariables, maybeVars?: I18nVariables): string {
    let fallback: string | undefined;
    let variables: I18nVariables | undefined;
    if (typeof fallbackOrVars === "string") {
      fallback = fallbackOrVars;
      variables = maybeVars;
    } else {
      variables = fallbackOrVars;
    }
    const resolved = _resolveTranslation(key, variables);
    if (resolved !== undefined) {
      // SSR + edit-labels: wrap with marker so devtools can pick up the key
      // and variable values without reverse-lookups. On the client the patched
      // window.i18n.t already wraps the string for us, so resolved comes back
      // marker-wrapped — no double-wrap here.
      if (typeof window === "undefined" && isEditLabelsMode()) {
        return encodeLabelMarker(key, resolved, variables);
      }
      return resolved;
    }
    if (fallback !== undefined) {
      const text = interpolate(fallback, variables);
      if (typeof window === "undefined" && isEditLabelsMode()) {
        return encodeLabelMarker(key, text, variables);
      }
      return text;
    }
    return key;
  },
  /**
   * Translate a key whose value contains `<tag>content</tag>` segments and
   * render the tagged segments via per-call `components`, `configure()`-supplied
   * components, or the built-in HTML tag renderers.
   *
   * Return shape:
   *   - all renderers return strings → returns a concatenated `string`
   *   - any renderer returns a non-string (e.g. JSX, DOM node) → returns
   *     `Array<string | T>` and the caller is responsible for rendering
   *
   * Framework-agnostic: this method does pure string parsing + callback
   * execution. No React / DOM dependency in the SDK itself.
   */
  rich(
    key: string,
    fallback: string,
    components?: I18nRichComponents,
    variables?: I18nVariables,
  ): unknown {
    const resolved = _resolveTranslation(key, variables);
    const raw = resolved ?? interpolate(fallback, variables);
    return _parseRichText(raw, components ?? {});
  },
  /**
   * Translate a key and return a framework element (e.g. React <span>)
   * carrying `data-label` / `data-variables` attributes so the ShipEasy
   * devtools "Edit labels" overlay can highlight and edit it in place.
   *
   * Requires a one-time setup call: `i18n.configure({ createElement })`.
   * The returned value is whatever `createElement` returns — pass React's
   * `createElement`, Vue's `h`, Solid's `createSignal`-based factory, etc.
   *
   * Falls back to a plain translated string if `createElement` was not
   * configured (e.g. server-side or in non-JSX contexts).
   */

  /**
   * @deprecated Use `t(key, fallback, variables)` instead. tEl() now delegates
   * to t() and returns the translated string. Prior behaviour (createElement
   * wrapping + edit-mode markers) was a devtools feature that conflicted with
   * type-safe usage and has been removed.
   */
  tEl<F extends string>(key: string, fallback: F, variables?: I18nVariables, _desc?: string): F {
    if (isEditLabelsMode()) {
      const resolved = _resolveTranslation(key, variables);
      const text = resolved ?? interpolate(fallback, variables);
      return encodeLabelMarker(key, text, variables) as F;
    }
    return (this as I18nFacade).t<F>(key, fallback, variables);
  },
  /**
   * Configure global rich-text component overrides and (legacy) the createElement
   * factory. `components` registers default renderers used by `rich()` when no
   * per-call override is supplied (e.g. swap `<a>` for a framework Link).
   */
  configure(opts: {
    components?: I18nRichComponents;
    createElement?: (tag: string, props: object, children: string) => unknown;
  }): void {
    if (opts.components) {
      _configuredComponents = { ..._configuredComponents, ...opts.components };
    }
    if (opts.createElement) _createElement = opts.createElement;
  },
  get locale(): string | null {
    if (typeof window !== "undefined" && window.i18n) return window.i18n.locale;
    return null;
  },
  get ready(): boolean {
    if (typeof window !== "undefined" && window.i18n) return Boolean(window.i18n.locale);
    return false;
  },
  /** Resolves when the loader has installed window.i18n and fetched a profile. */
  whenReady(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    if (window.i18n?.locale) return Promise.resolve();
    // window.i18n not yet installed — wait for the se:i18n:ready DOM event.
    return new Promise((resolve) => {
      const handler = () => resolve();
      window.addEventListener("se:i18n:ready", handler, { once: true });
    });
  },
  /** Subscribe to locale/profile updates. Returns an unsubscribe fn. */
  onUpdate(cb: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    if (window.i18n) return window.i18n.on("update", cb);
    // window.i18n not yet installed — subscribe once ready, then forward to on("update").
    let unsub = () => {};
    const handler = () => {
      if (window.i18n) unsub = window.i18n.on("update", cb);
    };
    window.addEventListener("se:i18n:ready", handler, { once: true });
    return () => {
      window.removeEventListener("se:i18n:ready", handler);
      unsub();
    };
  },
};

// No key-based auto-init: the server no longer embeds a key in __SE_BOOTSTRAP
// (it only holds the server key, which must stay server-side). The browser must
// initialise explicitly with its own client key:
//   import { shipeasy } from "@shipeasy/sdk/client";
//   shipeasy({ clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY ?? "" });
// __SE_BOOTSTRAP still provides flags/configs/experiments/i18n DATA for first
// paint; readers fall back to safe defaults until shipeasy({ clientKey }) runs.
