// ShipEasy browser SDK — calls /sdk/evaluate on identify(), logs exposures + events via /collect.

import { Telemetry, DEFAULT_TELEMETRY_URL } from "../telemetry";
import {
  buildSeeEvent,
  causesThe,
  isExpected,
  SeeLimiter,
  startControlFlowChain,
  startSeeChain,
  startSeeViolationChain,
  violation,
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

/** Options object form of `getExperiment` — the legacy `decode`/`variants`
 *  positional args plus per-call exposure control. */
export interface GetExperimentOptions<P> {
  /** Decode the raw stored params into the typed shape callers want. */
  decode?: (raw: unknown) => P;
  /** Variant-specific param overrides merged on top of group params. */
  variants?: Record<string, Partial<P>>;
  /**
   * Override automatic exposure logging for this read. Defaults to the client's
   * setting (`disableAutoExposure` flips it). `false` reads the variant without
   * logging an exposure — pair with `logExposure(name)` at render time.
   */
  logExposure?: boolean;
}

/**
 * Why a flag evaluated the way it did (LaunchDarkly variationDetail parity).
 * Computed at the client boundary:
 *   - CLIENT_NOT_READY — no eval result yet (identify() hasn't resolved)
 *   - FLAG_NOT_FOUND   — the gate name isn't present in the eval result
 *   - OFF              — folded into DEFAULT here (the server pre-evaluates the
 *     gate's enabled/killed state into a plain boolean, so the browser can't
 *     distinguish a disabled gate from one a rule denied)
 *   - OVERRIDE         — a local override or a ?se_gate_/?se_ks_ URL override
 *     decided the value
 *   - RULE_MATCH       — the gate evaluated true
 *   - DEFAULT          — the gate evaluated false
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
  /** Returned when the config key is absent (not overridden, not in the eval result). */
  defaultValue?: T;
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
  /**
   * Newly-assigned sticky entries (doc 20 §2). The worker returns these so the
   * browser can merge them into the `__se_sticky` cookie. Present only when
   * sticky bucketing is on and at least one assignment was made/refreshed.
   */
  sticky?: Record<string, StickyCookieEntry>;
}

/** One persisted sticky assignment: group + 8-char salt prefix (reshuffle key). */
interface StickyCookieEntry {
  g: string;
  s: string;
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
  correlationId?: string,
) => void;

/**
 * Collapse a URL to a stable, low-cardinality endpoint template for network
 * consequence subjects: drop query/hash, drop a same-origin host, and replace
 * id-like path segments (numbers, uuids, hex runs) with ":id" — so the issue
 * title names the endpoint ("request to /api/orders/:id") without minting one
 * issue per id. The consequence feeds the issue fingerprint RAW (only the
 * message is normalized server-side), so this must never embed variable data.
 */
function endpointTemplate(rawUrl: string): string {
  const isIdSegment = (seg: string) =>
    /^\d+$/.test(seg) ||
    /^0x[0-9a-f]+$/i.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{8,}$/i.test(seg) ||
    (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg));
  let u: URL;
  try {
    u = new URL(rawUrl, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    return (rawUrl.split(/[?#]/)[0] ?? "").slice(0, 120);
  }
  const path = u.pathname
    .split("/")
    .map((seg) => (seg && isIdSegment(seg) ? ":id" : seg))
    .join("/");
  const sameOrigin = typeof location !== "undefined" && u.origin === location.origin;
  return ((sameOrigin ? "" : u.host) + path).slice(0, 120);
}

/** True when `rawUrl` resolves to the page's own origin (relative URLs included). */
export function sameOrigin(rawUrl: string): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URL(rawUrl, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Return a new `fetch` args tuple with `X-SE-Correlation` added, preserving any
 * existing headers across all three arg shapes (string / URL / Request). Never
 * mutates the caller's objects. Best-effort: on any failure the original args
 * pass through unchanged (correlation is optional, never breaks the fetch).
 */
export function injectCorrelationHeader(
  args: Parameters<typeof fetch>,
  corr: string,
): Parameters<typeof fetch> {
  try {
    const input = args[0];
    if (typeof Request !== "undefined" && input instanceof Request) {
      const headers = new Headers(input.headers);
      headers.set("X-SE-Correlation", corr);
      return [new Request(input, { headers }), ...args.slice(1)] as Parameters<typeof fetch>;
    }
    const init = { ...(args[1] ?? {}) };
    const headers = new Headers(init.headers ?? undefined);
    headers.set("X-SE-Correlation", corr);
    init.headers = headers;
    return [input, init] as Parameters<typeof fetch>;
  } catch {
    return args;
  }
}

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
  // exceptions (see.ControlFlowException(err).because("because …")) are skipped.
  //
  // Auto-capture only reports problems with a SPECIFIC subject and a SPECIFIC
  // outcome — here, a named endpoint failing with a server error / no response.
  // It deliberately does NOT blanket-report uncaught errors or unhandled
  // promise rejections: those carry no actionable consequence ("the page hit an
  // error" names the plumbing, not the feature), so they would mint one
  // unactionable, double-counted issue for every unrelated failure. Code that
  // knows the consequence reports it explicitly with see() at the catch site.
  if (groups.errors) {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
      const url = typeof args[0] === "string" ? args[0] : (args[0] as Request | URL).toString();
      // Never report the SDK's own collector/telemetry requests — a failing
      // collector would otherwise feed errors back into itself.
      const ignored = ignoreUrlPrefixes.some((p) => p && url.startsWith(p));
      // Per-request correlation token, SAME-ORIGIN ONLY. Sent up on the request
      // header so a server boundary that reports the matching uncaught error
      // can echo it; the backend joins the two issues by it. Cross-origin is
      // skipped on purpose — a custom header would force a CORS preflight on
      // otherwise-simple third-party fetches and break them.
      let corr: string | undefined;
      if (!ignored && sameOrigin(url) && typeof crypto !== "undefined" && crypto.randomUUID) {
        corr = crypto.randomUUID();
        args = injectCorrelationHeader(args, corr);
      }
      let res: Response;
      try {
        res = await origFetch.apply(this, args);
      } catch (err) {
        // Network-level failure (DNS, offline, CORS, abort) — never reaches a status.
        if (!ignored && !isExpected(err)) {
          // Endpoint template in the subject (not the raw URL — the consequence
          // is fingerprinted raw, so it must stay id-free): the issue title
          // names what's broken ("request to /api/orders/:id") instead of the
          // unactionable "a network request".
          reportSee(
            violation("NetworkError"),
            causesThe(`request to ${endpointTemplate(url)}`).to("get no response"),
            { status: 0, url: url.slice(0, 200) },
            "network",
          );
        }
        throw err;
      }
      if (!ignored && res.status >= 500) {
        const elapsed = typeof performance !== "undefined" ? performance.now() - startedAt : 0;
        // Status code stays OUT of the outcome (it rides in extras): interpolating
        // it minted a separate issue per status (500/502/503…). The endpoint
        // template in the subject keeps per-endpoint grouping; the full URL is
        // in extras for debugging.
        reportSee(
          violation("Http5xx"),
          causesThe(`request to ${endpointTemplate(url)}`).to("fail with a server error"),
          { status: res.status, url: url.slice(0, 200), duration_ms: Math.round(elapsed) },
          "network",
          corr,
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

function readAnonCookie(): string | null {
  try {
    const m = ("; " + document.cookie).match(/; __se_anon_id=([^;]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

function writeAnonCookie(id: string): void {
  try {
    const secure = location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${ANON_ID_KEY}=${id};path=/;max-age=31536000;samesite=lax${secure}`;
  } catch {}
}

// ---- Sticky bucketing cookie (doc 20 §2) ----
// First-party cookie so SSR server eval and the browser agree on one sticky
// state (same rationale as __se_anon_id). Value is compact JSON
// { "<exp>": { "g": "<group>", "s": "<salt8>" } }; 1y, Lax, Secure on HTTPS,
// NOT HttpOnly (the browser SDK reads it). ~4 KB ceiling ⇒ ≈50-experiment soft
// cap; over-cap we keep what we have (the server simply sees fewer entries).
const STICKY_COOKIE = "__se_sticky";
const STICKY_MAX_BYTES = 3800;

function readStickyCookie(): Record<string, StickyCookieEntry> {
  try {
    const m = ("; " + document.cookie).match(/; __se_sticky=([^;]+)/);
    if (!m) return {};
    const parsed = JSON.parse(decodeURIComponent(m[1]!)) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StickyCookieEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as StickyCookieEntry).g === "string") {
        out[k] = { g: (v as StickyCookieEntry).g, s: String((v as StickyCookieEntry).s ?? "") };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStickyCookie(map: Record<string, StickyCookieEntry>): void {
  try {
    let json = JSON.stringify(map);
    // Stay under the byte ceiling: drop entries until it fits (oldest-insertion
    // first via key order). Over-cap the server reads fewer entries — accepted.
    if (json.length > STICKY_MAX_BYTES) {
      const entries = Object.entries(map);
      while (entries.length > 0 && JSON.stringify(Object.fromEntries(entries)).length > STICKY_MAX_BYTES) {
        entries.shift();
      }
      json = JSON.stringify(Object.fromEntries(entries));
    }
    const secure = location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${STICKY_COOKIE}=${encodeURIComponent(json)};path=/;max-age=31536000;samesite=lax${secure}`;
  } catch {}
}

function getOrCreateAnonId(): string {
  // Precedence is deliberate. The cookie is the id the SERVER bucketed against
  // this request (set by edge middleware or the SSR bootstrap script), so
  // adopting it makes the browser bucket identically at any rollout %. The
  // bootstrap payload carries the same id as a belt-and-suspenders fallback;
  // localStorage is the legacy store. We mirror the resolved id into BOTH the
  // cookie and localStorage so every future read — and the server — agree.
  // Cookie name + format are a cross-SDK contract: experiment-platform/18-identity-bucketing.md.
  let id: string | null = readAnonCookie();
  if (!id && typeof window !== "undefined") {
    // getBootstrap() also reads the se-bootstrap.js tag attributes directly, so
    // the anon id is available even before the external loader runs / sets the
    // cookie.
    id = (getBootstrap() as { anonId?: string } | null)?.anonId ?? null;
  }
  if (!id) {
    try {
      id = localStorage.getItem(ANON_ID_KEY);
    } catch {}
  }
  if (!id) {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `anon_${Math.random().toString(36).slice(2)}`;
  }
  try {
    localStorage.setItem(ANON_ID_KEY, id);
  } catch {}
  writeAnonCookie(id);
  return id;
}

// ---- Engine ----

export type EngineEnv = "dev" | "staging" | "prod";

export interface EngineOptions {
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
  env?: EngineEnv;
  /**
   * Per-evaluation usage telemetry. ON by default — each getFlag/getConfig/
   * getExperiment/getKillswitch call fires one fire-and-forget sendBeacon so
   * usage is counted by Cloudflare's native per-path analytics. Pass `true` to
   * disable entirely.
   */
  disableTelemetry?: boolean;
  /** Override the telemetry beacon host. Defaults to {@link DEFAULT_TELEMETRY_URL}. */
  telemetryUrl?: string;
  /**
   * Suppress automatic exposure logging in `getExperiment` (Statsig's
   * `disableExposureLogging`). Default false — reading an enrolled variant
   * auto-logs a deduped exposure. When true, no exposure fires unless you call
   * `logExposure(name)` yourself, or pass `{ logExposure: true }` per call.
   */
  disableAutoExposure?: boolean;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). They are sent to `/sdk/evaluate` under
   * `private_attributes` so the edge can evaluate with them (unavoidable —
   * the edge evaluates), but the worker never stores them, and the listed keys
   * are stripped from any `track(props)` payload.
   */
  privateAttributes?: string[];
  /**
   * Sticky bucketing (doc 20 §2). ON by default in the browser: a unit's
   * first-assigned variant is locked in the `__se_sticky` cookie so changing an
   * experiment's allocation % or group weights never silently re-buckets
   * enrolled users. Changing the experiment salt is the deliberate reshuffle
   * lever. Pass `false` to opt out (pure deterministic eval).
   */
  stickyBucketing?: boolean;
  /**
   * Test mode — no network at all. identify()/init are no-ops (never call
   * /sdk/evaluate), track() is a no-op, telemetry is forced off, and the client
   * starts "ready" with an empty eval result. Prefer the
   * {@link Engine.forTesting} factory over passing this directly.
   */
  testMode?: boolean;
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
 * Auto-collected debugging environment for see() error reports — a curated,
 * non-PII snapshot of the browser/OS/device that ships under namespaced
 * `env.*` keys in the report's extras (merged below the developer's own keys).
 *
 * Deliberately bounded: derived browser/OS *names*, device class, viewport,
 * screen, language, timezone, connection class, online flag, and coarse
 * hardware (cores, GB memory). NO raw UA string, canvas/font fingerprint,
 * plugin list, or precise identifiers — enough to debug, not to track.
 */
function collectSeeEnv(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof navigator === "undefined") return out;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string };
    userAgentData?: { mobile?: boolean; platform?: string };
  };
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";

  const browser = parseUaBrowser(ua);
  if (browser) out["env.browser"] = browser;
  const os = parseUaOs(ua) ?? nav.userAgentData?.platform;
  if (os) out["env.os"] = os;
  out["env.device"] =
    typeof nav.userAgentData?.mobile === "boolean"
      ? nav.userAgentData.mobile
        ? "mobile"
        : "desktop"
      : /iPad|Tablet/.test(ua)
        ? "tablet"
        : /Mobi|iPhone|Android.*Mobile/.test(ua)
          ? "mobile"
          : "desktop";

  try {
    if (nav.language) out["env.lang"] = nav.language;
  } catch {}
  try {
    if (typeof nav.onLine === "boolean") out["env.online"] = nav.onLine;
  } catch {}
  try {
    if (typeof nav.hardwareConcurrency === "number") out["env.cores"] = nav.hardwareConcurrency;
  } catch {}
  try {
    if (typeof nav.deviceMemory === "number") out["env.memory_gb"] = nav.deviceMemory;
  } catch {}
  try {
    const et = nav.connection?.effectiveType;
    if (et) out["env.connection"] = et;
  } catch {}
  try {
    if (typeof window !== "undefined" && window.innerWidth && window.innerHeight) {
      out["env.viewport"] = `${window.innerWidth}×${window.innerHeight}`;
    }
    if (typeof window !== "undefined" && typeof window.devicePixelRatio === "number") {
      out["env.dpr"] = window.devicePixelRatio;
    }
    if (typeof screen !== "undefined" && screen.width && screen.height) {
      out["env.screen"] = `${screen.width}×${screen.height}`;
    }
  } catch {}
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) out["env.tz"] = tz;
  } catch {}
  return out;
}

/** Best-effort "<Name> <major>" from a UA string. Order matters (Edge before Chrome). */
function parseUaBrowser(ua: string): string | undefined {
  const tests: Array<[RegExp, string]> = [
    [/Edg(?:A|iOS)?\/(\d+)/, "Edge"],
    [/(?:OPR|Opera)\/(\d+)/, "Opera"],
    [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
    [/(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[.\d]* (?:Mobile.*)?Safari/, "Safari"],
  ];
  for (const [re, name] of tests) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return undefined;
}

/** Best-effort OS name (+ major version where cheap) from a UA string. */
function parseUaOs(ua: string): string | undefined {
  if (/Windows NT 10/.test(ua)) return "Windows 10/11";
  if (/Windows NT/.test(ua)) return "Windows";
  let m = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (m) return `macOS ${m[1]}.${m[2]}`;
  if (/Macintosh/.test(ua)) return "macOS";
  m = /Android (\d+)/.exec(ua);
  if (m) return `Android ${m[1]}`;
  m = /(?:iPhone|iPad)[^)]* OS (\d+)/.exec(ua);
  if (m) return `iOS ${m[1]}`;
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
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

export class Engine {
  private readonly sdkKey: string;
  private readonly baseUrl: string;
  private readonly autoGuardrails: boolean;
  private readonly autoGuardrailGroups: AutoCollectGroups;
  private readonly autoCollectAlways: boolean;
  private readonly disableAutoExposure: boolean;
  private readonly privateAttributes: readonly string[];
  private readonly stickyBucketing: boolean;
  private readonly env: EngineEnv;
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
  // Test mode: built by `Engine.forTesting()`. When set, identify()
  // never fetches, track() is a no-op, telemetry is off, and the client is
  // already ready with an empty eval result.
  private readonly testMode: boolean;
  // Programmatic overrides (Statsig-style). Set on any client via
  // overrideFlag/overrideConfig/overrideExperiment; they win over BOTH the URL
  // overrides and the fetched eval result. Cleared by clearOverrides().
  private readonly flagOverrides = new Map<string, boolean>();
  private readonly configOverrides = new Map<string, unknown>();
  private readonly experimentOverrides = new Map<
    string,
    { group: string; params: Record<string, unknown> }
  >();
  private onOverrideChange = () => {
    this.installBridge();
    this.notify();
  };

  constructor(opts: EngineOptions) {
    this.sdkKey = opts.sdkKey;
    this.baseUrl = (opts.baseUrl ?? "https://edge.shipeasy.dev").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
    this.testMode = opts.testMode === true;
    // Auto web vitals + error capture defaults ON. Vitals/engagement emit
    // `__auto_*` metric events (the worker bypasses event-catalog validation
    // for those names); errors report into the errors primitive via the see()
    // path. Callers opt out by passing `autoGuardrails: false` or by
    // narrowing per-group via `autoGuardrailGroups`.
    this.autoGuardrails = opts.autoGuardrails !== false;
    this.autoCollectAlways = opts.autoCollectAlways === true;
    this.disableAutoExposure = opts.disableAutoExposure === true;
    this.privateAttributes = opts.privateAttributes ?? [];
    this.stickyBucketing = opts.stickyBucketing !== false;
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
      // Test mode never talks to the network — telemetry off regardless of opt.
      disabled: this.testMode || opts.disableTelemetry,
    });
    if (this.testMode) {
      // Start "ready" with an empty eval result so getters read from overrides
      // without any /sdk/evaluate having happened.
      this.evalResult = { flags: {}, configs: {}, experiments: {}, killswitches: {} };
    } else {
      void this.buffer.flushPendingAlias();
    }
  }

  /**
   * Build a no-network, immediately-usable browser client for tests
   * (Statsig-style). identify() is a no-op (never calls /sdk/evaluate), track()
   * is a no-op, telemetry is disabled, and the client is already ready — seed
   * every entity with overrideFlag/overrideConfig/overrideExperiment. No SDK
   * key required.
   *
   * ```ts
   * const client = Engine.forTesting();
   * client.overrideFlag("new_checkout", true);
   * client.getFlag("new_checkout"); // true
   * ```
   */
  static forTesting(opts?: Partial<EngineOptions>): Engine {
    return new Engine({
      sdkKey: "",
      autoGuardrails: false,
      ...opts,
      testMode: true,
    });
  }

  async identify(user: User): Promise<void> {
    if (this.testMode) {
      // No-op — capture user_id for track()/exposure attribution, but never
      // hit /sdk/evaluate. Notify so subscribers settle.
      if (user.user_id !== undefined) this.userId = user.user_id;
      this.notify();
      return;
    }
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
        // Private attributes still reach the edge for evaluation (unavoidable —
        // the edge evaluates), but the worker never persists them. See doc 20 §5.
        ...(this.privateAttributes.length > 0
          ? { private_attributes: [...this.privateAttributes] }
          : {}),
        // Sticky state round-trip: send the current cookie map; the worker
        // applies the sticky short-circuit and returns any new assignments.
        ...(this.stickyBucketing ? { sticky: readStickyCookie() } : {}),
      }),
    });
    if (!res.ok) throw new Error(`/sdk/evaluate returned ${res.status}`);
    const data = (await res.json()) as EvalResponse;
    // Drop stale responses: a newer identify() has already started and its
    // result will replace ours. Don't notify or install guardrails either,
    // so a single later identify never gets shadowed.
    if (seq !== this.identifySeq) return;
    this.evalResult = data;

    // Persist any new sticky assignments the worker made back to the cookie so
    // the next request (and SSR server eval) sees the same locked variants.
    if (this.stickyBucketing && data.sticky && Object.keys(data.sticky).length > 0) {
      writeStickyCookie({ ...readStickyCookie(), ...data.sticky });
    }

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
        (problem, consequence, extras, kind, correlationId) =>
          this.reportError(problem, consequence, extras, kind, correlationId),
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
    correlationId?: string,
  ): void {
    try {
      // Auto-collected env (env.* keys) goes first; the developer's own
      // .extras({…}) win on any collision and take priority in the key budget.
      const enriched: SeeExtras = { ...collectSeeEnv(), ...extras };
      const ev = buildSeeEvent(problem, consequence, enriched, {
        side: "client",
        sdkVersion: version,
        env: this.env,
        url: typeof window !== "undefined" && window.location ? window.location.href : undefined,
        userId: this.userId || undefined,
        anonId: this.anonId,
      }, kind, correlationId);
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

  // ---- Local overrides (Statsig-style) ----
  //
  // Precedence (highest first): programmatic override (these methods) > URL
  // override (?se_gate_/?se_config_/?se_exp_) > fetched eval result. A
  // programmatic override is an explicit in-code decision, so it wins over the
  // ad-hoc URL/devtools overrides as well as the server's evaluation.

  /** Force `getFlag(name)` to return `value`, ignoring URL overrides + eval. */
  overrideFlag(name: string, value: boolean): void {
    this.flagOverrides.set(name, value);
  }

  /** Force `getConfig(name)` to return `value`, ignoring URL overrides + eval. */
  overrideConfig(name: string, value: unknown): void {
    this.configOverrides.set(name, value);
  }

  /**
   * Force `getExperiment(name, …)` to return `{ inExperiment: true, group, params }`,
   * ignoring URL overrides, the eval result, and exposure logging.
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

  /**
   * Evaluate a gate and report WHY (LaunchDarkly variationDetail parity). A
   * local override OR a ?se_gate_/?se_ks_ URL override short-circuits BEFORE
   * telemetry; otherwise exactly one "gate" beacon is emitted. The server
   * pre-evaluates a gate's enabled/killed state into a plain boolean, so OFF
   * folds into DEFAULT here (the browser can't tell "disabled" from "rule
   * denied").
   */
  getFlagDetail(name: string): FlagDetail {
    // 1. Local override wins and skips telemetry (mirrors the override path).
    const pov = this.flagOverrides.get(name);
    if (pov !== undefined) return { value: pov, reason: "OVERRIDE" };
    // A URL override is likewise a forced value — short-circuit before telemetry.
    const urlOv = readGateOverride(name);
    if (urlOv !== null) return { value: urlOv, reason: "OVERRIDE" };
    // Single telemetry emit for every non-override path.
    this.telemetry.emit("gate", name);
    // 2. No eval result yet.
    if (this.evalResult === null) return { value: false, reason: "CLIENT_NOT_READY" };
    // 3. Gate absent from the eval result.
    if (!(name in this.evalResult.flags)) return { value: false, reason: "FLAG_NOT_FOUND" };
    // 5. (OFF folds into DEFAULT — see doc comment.)
    const value = this.evalResult.flags[name] ?? false;
    return { value, reason: value ? "RULE_MATCH" : "DEFAULT" };
  }

  /**
   * Read a feature gate. Returns `defaultValue` ONLY when the gate cannot be
   * evaluated (not ready or flag not found) — never for a gate that legitimately
   * evaluates to false. Plain `getFlag(name)` keeps returning false for a
   * missing flag.
   */
  getFlag(name: string, defaultValue = false): boolean {
    const d = this.getFlagDetail(name);
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
    const fallback = ("defaultValue" in opts ? opts.defaultValue : undefined) as T | undefined;
    const hasProgrammatic = this.configOverrides.has(name);
    if (!hasProgrammatic && this.evalResult === null) return fallback;
    const urlOv = hasProgrammatic ? undefined : readConfigOverride(name);
    const raw = hasProgrammatic
      ? this.configOverrides.get(name)
      : urlOv !== undefined
        ? urlOv
        : this.evalResult?.configs?.[name];
    if (raw === undefined) return fallback;
    if (!opts.decode) return raw as T;
    try {
      return opts.decode(raw);
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
  ): ExperimentResult<P>;
  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
    opts: GetExperimentOptions<P>,
  ): ExperimentResult<P>;
  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
    decodeOrOpts?: ((raw: unknown) => P) | GetExperimentOptions<P>,
    variantsArg?: Record<string, Partial<P>>,
  ): ExperimentResult<P> {
    // Discriminate the positional (decode, variants) form from the options form.
    const opts: GetExperimentOptions<P> =
      typeof decodeOrOpts === "function"
        ? { decode: decodeOrOpts, variants: variantsArg }
        : (decodeOrOpts ?? {});
    const { decode, variants } = opts;

    this.telemetry.emit("experiment", name);
    const notIn: ExperimentResult<P> = {
      inExperiment: false,
      group: "control",
      params: defaultParams,
    };

    // Programmatic override wins over URL overrides + the eval result, and
    // skips exposure logging (it's an explicit in-code decision, not a real
    // enrolment). Caller `variants` still merge on top of defaults.
    const pov = this.experimentOverrides.get(name);
    if (pov) {
      const variantParams = variants?.[pov.group];
      const params = { ...defaultParams, ...pov.params, ...(variantParams ?? {}) };
      return { inExperiment: true, group: pov.group, params };
    }

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
    // Auto-log exposure (deduped within session) unless suppressed. Per-call
    // `logExposure` wins; otherwise the client-level `disableAutoExposure`
    // setting decides. The dedup set makes auto + manual never double-count.
    const shouldLog = opts.logExposure ?? !this.disableAutoExposure;
    if (shouldLog) this.buffer.pushExposure(name, entry.group, this.userId, this.anonId);
    if (!decode) return { inExperiment: true, group: entry.group, params: entry.params as P };
    try {
      return { inExperiment: true, group: entry.group, params: decode(entry.params) };
    } catch (err) {
      console.warn(`[shipeasy] getExperiment('${name}') decode failed:`, String(err));
      return notIn;
    }
  }

  /**
   * Manually log an exposure for an enrolled experiment (Statsig's
   * `manuallyLogExposure`). Reads the cached eval result; if the visitor is in
   * the experiment, pushes the session-deduped exposure. Pair this with the
   * render of the treatment when reading with `{ logExposure: false }` (or
   * `disableAutoExposure: true`). No-op if the visitor isn't enrolled.
   */
  logExposure(name: string): void {
    const entry = this.evalResult?.experiments[name];
    if (!entry || !entry.inExperiment) return;
    this.buffer.pushExposure(name, entry.group, this.userId, this.anonId);
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
    if (this.testMode) return; // no-op in test mode — never touch the network
    this.buffer.pushMetric(eventName, this.userId, this.anonId, this.stripPrivate(props));
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
  client: Engine,
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
// pass a `Engine` instance around, expose a configurable
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

let _client: Engine | null = null;

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
  /**
   * Suppress automatic exposure logging in `flags.getExperiment` (Statsig's
   * `disableExposureLogging`). Default false. When true, call
   * `flags.logExposure(name)` at the treatment's render to log the exposure.
   */
  disableAutoExposure?: boolean;
  /**
   * Attribute names usable for targeting but never persisted in analytics
   * (LD/Statsig `privateAttributes`). Sent to the edge for evaluation, never
   * stored, and stripped from `flags.track(props)`. See
   * {@link EngineOptions.privateAttributes}.
   */
  privateAttributes?: string[];
  /**
   * Sticky bucketing (doc 20 §2). ON by default — locks each enrolled unit to
   * its first-assigned variant via the `__se_sticky` cookie. Pass `false` to
   * opt out. See {@link EngineOptions.stickyBucketing}.
   */
  stickyBucketing?: boolean;
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
    disableAutoExposure: opts.disableAutoExposure,
    privateAttributes: opts.privateAttributes,
    stickyBucketing: opts.stickyBucketing,
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

export function configureShipeasy(opts: EngineOptions): Engine {
  if (_client) return _client;
  _client = new Engine(opts);
  return _client;
}

/** Returns the configured singleton, or null if configureShipeasy() hasn't run yet. */
export function getShipeasyClient(): Engine | null {
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
  // The server SDK now emits the loader tag (with SSR strings + the public
  // client key) directly into the SSR HTML. If a keyed loader is already
  // present, it owns runtime revalidation — don't inject a duplicate.
  try {
    if (document.querySelector?.('script[src*="/sdk/i18n/loader.js"][data-key]')) {
      _i18nLoaderInjected = true;
      return;
    }
  } catch {
    /* querySelector unavailable — fall through and inject */
  }
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
  /** Stable anonymous bucketing id the server evaluated against (cross-SDK contract). */
  anonId?: string;
}

// Parsed once from the bootstrap tag and reused. The tag is static SSR markup,
// so a found payload never goes stale within a page.
let _bootstrapFromTag: BootstrapPayload | null = null;

/**
 * Read the SSR payload straight off the se-bootstrap.js tag's data-* attributes.
 * The external loader normally hydrates window.__SE_BOOTSTRAP, but it may not
 * have executed yet (or 404 in local dev) — the attributes are in the DOM from
 * first paint, so this keeps synchronous first-render flag reads correct.
 */
function readBootstrapTag(): BootstrapPayload | null {
  if (_bootstrapFromTag) return _bootstrapFromTag;
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
  const el = document.querySelector("script[data-se-bootstrap]");
  if (!el) return null;
  const J = (name: string): Record<string, unknown> => {
    try {
      return JSON.parse(el.getAttribute(name) || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const bs = {
    flags: J("data-flags") as Record<string, boolean>,
    configs: J("data-configs"),
    experiments: J("data-experiments") as BootstrapPayload["experiments"],
    killswitches: J("data-killswitches") as BootstrapPayload["killswitches"],
    i18nProfile: el.getAttribute("data-i18n-profile") || undefined,
    apiUrl: el.getAttribute("data-api-url") || undefined,
    anonId: el.getAttribute("data-anon-id") || undefined,
  } as BootstrapPayload & { anonId?: string };
  _bootstrapFromTag = bs;
  return bs;
}

function getBootstrap(): BootstrapPayload | null {
  if (typeof window === "undefined") return null;
  const g = (window as unknown as { __SE_BOOTSTRAP?: BootstrapPayload }).__SE_BOOTSTRAP;
  if (g) return g;
  return readBootstrapTag();
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
  configure(opts: EngineOptions): void {
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
  get(name: string, defaultValue = false): boolean {
    const bs = getBootstrap();
    if (bs !== null && name in bs.flags) return bs.flags[name];
    if (!_mountedAndReady) return defaultValue;
    if (_client) return _client.getFlag(name, defaultValue); // includes URL overrides + evalResult
    return readGateOverride(name) ?? defaultValue;
  },
  /** Evaluate a gate and report why (value + reason). See {@link FlagDetail}. */
  getDetail(name: string): FlagDetail {
    if (_client) return _client.getFlagDetail(name);
    const ov = readGateOverride(name);
    if (ov !== null) return { value: ov, reason: "OVERRIDE" };
    return { value: false, reason: "CLIENT_NOT_READY" };
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
    decodeOrOpts?: ((raw: unknown) => P) | GetExperimentOptions<P>,
    variants?: Record<string, Partial<P>>,
  ): ExperimentResult<P> {
    const fallback: ExperimentResult<P> = {
      inExperiment: false,
      group: "control",
      params: defaultParams,
    };
    if (!_client) return fallback;
    return typeof decodeOrOpts === "function"
      ? _client.getExperiment(name, defaultParams, decodeOrOpts, variants)
      : _client.getExperiment(name, defaultParams, decodeOrOpts ?? {});
  },
  /** Manually log an exposure for an enrolled experiment. See
   *  {@link Engine.logExposure}. No-op before configure(). */
  logExposure(name: string): void {
    _client?.logExposure(name);
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

// ---- Top-level user-bound API (configure once, then `new Client(user)`) ----
//
// The ergonomic front door, mirroring the server entry. Configure the SDK ONCE
// with the public client key and an optional transform from YOUR user object to
// targeting attributes, then evaluate per user with `new Client(user)`.
//
// The browser is single-user: there is one configured Engine and one identified
// visitor at a time. `new Client(user)` therefore runs the configured
// `attributes` transform and calls `engine.identify()` under the hood
// (fire-and-forget — identify is async). getFlag/getConfig/etc. then read the
// engine's latest eval result. Await `client.ready()` (or `flags.ready`) when
// you need the first /sdk/evaluate round-trip to have resolved.

/** Transform YOUR application's user object into Shipeasy targeting attributes. */
export type AttributesFn<U = unknown> = (user: U) => User;

const _identityAttributes: AttributesFn = (user) =>
  user && typeof user === "object" ? (user as User) : {};

let _attributes: AttributesFn = _identityAttributes;

export interface ConfigureOptions<U = unknown> extends Omit<ShipeasyClientConfig, "clientKey"> {
  /** Public client key — the single key the browser side accepts (NEXT_PUBLIC_SHIPEASY_CLIENT_KEY). */
  clientKey: string;
  /**
   * Map your own user object into the attribute bag every flag/experiment
   * evaluation sees. Runs once per `new Client(user)`. Omit when you already
   * pass a plain attribute object (identity transform — the object is used
   * verbatim, so it should carry `user_id` + any targeting attrs).
   */
  attributes?: AttributesFn<U>;
}

/**
 * Configure the SDK once at app boot, then evaluate per user with
 * `new Client(user)`. Builds the process-wide {@link Engine} (the
 * /sdk/evaluate-backed browser client) and registers the `attributes`
 * transform. The first call wins; later calls reuse the existing engine
 * (mirrors {@link shipeasy}).
 *
 * ```ts
 * import { configure, Client } from "@shipeasy/sdk/client";
 *
 * configure({
 *   clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!,
 *   attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
 * });
 *
 * const flags = new Client(currentUser);
 * await flags.ready();
 * if (flags.getFlag("new_checkout")) { ... }
 * ```
 *
 * Returns a cleanup function (same as {@link shipeasy}) that removes the
 * devtools listeners — call it on teardown.
 */
export function configure<U = unknown>(opts: ConfigureOptions<U>): () => void {
  const { attributes, ...clientConfig } = opts;
  _attributes = (attributes as AttributesFn) ?? _identityAttributes;
  // Don't auto-identify the anonymous visitor here — `new Client(user)` drives
  // identify with the bound, transformed attributes. (autoIdentify can still be
  // forced on via opts for the bare anon case.)
  return shipeasy({ autoIdentify: false, ...clientConfig });
}

/** Test seam: reset the registered attribute transform. */
export function _resetConfigureForTests(): void {
  _attributes = _identityAttributes;
}

/**
 * A user-bound evaluation handle for the browser. Construct one for the current
 * visitor — it's cheap (it delegates to the single {@link Engine} built by
 * {@link configure}); it does NOT open its own connection. The configured
 * `attributes` transform runs once here and the result is `identify()`-ed into
 * the engine (fire-and-forget, since identify is async).
 *
 * Because the browser is single-user, all bound handles share the engine's
 * latest eval result. Use {@link Client.ready} to await the first evaluation.
 *
 * ```ts
 * const flags = new Client(currentUser);
 * await flags.ready();
 * flags.getFlag("new_checkout");                  // no user arg — bound at construction
 * flags.getExperiment("price_test", { price: 9 });
 * ```
 */
export class Client<U = unknown> {
  private readonly engine: Engine;
  /** The resolved attribute bag this handle evaluates against. */
  readonly attributes: User;
  private readonly _identify: Promise<void>;

  constructor(user: U) {
    const engine = getShipeasyClient();
    if (!engine) {
      throw new Error(
        "[shipeasy] new Client(user) called before configure({ clientKey }). " +
          "Call configure() once at app boot from @shipeasy/sdk/client.",
      );
    }
    this.engine = engine;
    this.attributes = _attributes(user);
    // Kick off identify with the bound attributes (fire-and-forget — identify
    // is async, getFlag reflects the latest resolved eval). Callers who need the
    // first round-trip can `await client.ready()`.
    this._identify = this.engine.identify(this.attributes).catch((err) => {
      console.warn("[shipeasy] Client identify failed:", String(err));
    });
  }

  /** Resolves once the engine's identify() for this user has completed. */
  ready(): Promise<void> {
    return this._identify;
  }

  getFlag(name: string, defaultValue = false): boolean {
    return this.engine.getFlag(name, defaultValue);
  }

  getFlagDetail(name: string): FlagDetail {
    return this.engine.getFlagDetail(name);
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined;
  getConfig<T = unknown>(name: string, opts: GetConfigOptions<T>): T;
  getConfig<T = unknown>(
    name: string,
    decodeOrOpts?: ((raw: unknown) => T) | GetConfigOptions<T>,
  ): T | undefined {
    return this.engine.getConfig(name, decodeOrOpts as GetConfigOptions<T>);
  }

  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
    decode?: (raw: unknown) => P,
  ): ExperimentResult<P> {
    return this.engine.getExperiment(name, defaultParams, decode);
  }

  /** Read a killswitch (not user-bound; mirrors {@link Engine.getKillswitch}). */
  getKillswitch(name: string, switchKey?: string): boolean {
    return this.engine.getKillswitch(name, switchKey);
  }

  /**
   * Record a conversion/metric event for the bound (identified) user. Delegates
   * to {@link Engine.track} — so an experiment is end-to-end Client-only (no need
   * to drop down to the Engine to log a conversion). Fire-and-forget; no-op in
   * test mode.
   */
  track(eventName: string, props?: Record<string, unknown>): void {
    this.engine.track(eventName, props);
  }

  /**
   * Log an exposure for `name` at the treatment's render for the bound user.
   * Delegates to {@link Engine.logExposure} (no-op when the visitor isn't
   * enrolled). Pair with `getExperiment(name, …, { logExposure: false })` /
   * `disableAutoExposure` to log exposure exactly when you render.
   */
  logExposure(name: string): void {
    this.engine.logExposure(name);
  }
}

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
   * issue fingerprint) — variable data goes in `.extras()`, never the name.
   *
   * ```ts
   * if (rows.length > LIMIT) {
   *   see.Violation("large query")
   *      .causes_the("search results").to("be trimmed").extras({ rows: rows.length });
   * }
   * ```
   */
  Violation(name: string): SeeViolationChain;
  /**
   * Mark an exception as expected control flow — auto-capture skips it and
   * nothing is reported. Say why with `.because()` (reason should start with
   * "because"); attach optional debug context with `.extras()`.
   *
   * ```ts
   * } catch (e) {
   *   see.ControlFlowException(e).because("because the blob wasn't an encoded Foo");
   *   return decodeAsBar(blob);
   * }
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
    ControlFlowException: (err: unknown): SeeControlFlowChain => startControlFlowChain(err),
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
    // Client: live URL param OR the persisted se_edit_labels cookie. The cookie
    // is what keeps edit mode (and marker emission) alive across navigations
    // after the first ?se_edit_labels=1 visit — matching the server resolution
    // and the devtools detection, so SSR and client agree without the payload
    // carrying an editLabels flag.
    return (
      new URLSearchParams(location.search).has("se_edit_labels") ||
      /(?:^|;\s*)se_edit_labels=1(?:;|$)/.test(document.cookie)
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
