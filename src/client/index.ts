// ShipEasy browser SDK — calls /sdk/evaluate on identify(), logs exposures + events via /collect.

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

export const version = "1.0.0";

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
    const body = JSON.stringify({ events: batch });
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      // text/plain avoids CORS preflight on mobile Safari
      navigator.sendBeacon(this.collectUrl, new Blob([body], { type: "text/plain" }));
      return;
    }
    fetch(this.collectUrl, {
      method: "POST",
      headers: { "X-SDK-Key": this.sdkKey, "Content-Type": "application/json" },
      body,
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

// Cap on errors recorded per session — prevents one bad page from spamming
// /collect with thousands of events while still letting us see >1 distinct error.
const MAX_ERRORS_PER_SESSION = 5;

function installAutoGuardrails(buffer: EventBuffer, userId: string, anonId: string): void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;

  let lcp: number | null = null;
  let inp: number | null = null;
  let clsBad = false;
  let jsErrorCount = 0;
  let netErrorCount = 0;
  let navTimingFlushed = false;

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

  // ---- Errors: split client (JS exception) vs request (HTTP failure). ----
  const origOnError = window.onerror;
  window.onerror = (msg, source, lineno, _colno, err) => {
    if (jsErrorCount < MAX_ERRORS_PER_SESSION) {
      jsErrorCount += 1;
      buffer.pushMetric("__auto_js_error", userId, anonId, {
        value: 1,
        kind: "exception",
        message: typeof msg === "string" ? msg.slice(0, 200) : String(err ?? "").slice(0, 200),
        source: typeof source === "string" ? source.slice(0, 200) : "",
        line: lineno ?? 0,
      });
    }
    if (typeof origOnError === "function") return origOnError(msg, source, lineno, _colno, err);
    return false;
  };

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    if (jsErrorCount < MAX_ERRORS_PER_SESSION) {
      jsErrorCount += 1;
      const reason = (e as PromiseRejectionEvent).reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : String(reason);
      buffer.pushMetric("__auto_js_error", userId, anonId, {
        value: 1,
        kind: "unhandled_rejection",
        message: message.slice(0, 200),
      });
    }
  });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const url = typeof args[0] === "string" ? args[0] : (args[0] as Request | URL).toString();
    let res: Response;
    try {
      res = await origFetch.apply(this, args);
    } catch (err) {
      // Network-level failure (DNS, offline, CORS, abort) — never reaches a status.
      if (netErrorCount < MAX_ERRORS_PER_SESSION) {
        netErrorCount += 1;
        buffer.pushMetric("__auto_network_error", userId, anonId, {
          value: 1,
          kind: "network",
          status: 0,
          url: url.slice(0, 200),
        });
      }
      throw err;
    }
    if (res.status >= 500 && netErrorCount < MAX_ERRORS_PER_SESSION) {
      netErrorCount += 1;
      const elapsed = typeof performance !== "undefined" ? performance.now() - startedAt : 0;
      buffer.pushMetric("__auto_network_error", userId, anonId, {
        value: 1,
        kind: "5xx",
        status: res.status,
        url: url.slice(0, 200),
        duration_ms: Math.round(elapsed),
      });
    }
    return res;
  };

  // ---- Navigation timing & paint (page_load, ttfb, fp, fcp, dom_ready). ----
  // These are available at the `load` event; we delay one tick so
  // `loadEventEnd` is populated. Safe to call multiple times — guarded.
  const flushNavTiming = () => {
    if (navTimingFlushed) return;
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

  if (document.readyState === "complete") {
    // Page already finished loading — capture on next tick so loadEventEnd is set.
    setTimeout(flushNavTiming, 0);
  } else {
    window.addEventListener(
      "load",
      () => {
        // Defer one tick: the load event handler runs *before* loadEventEnd
        // is finalised on the navigation entry.
        setTimeout(flushNavTiming, 0);
      },
      { once: true },
    );
  }

  const flushOnHide = () => {
    flushNavTiming();
    if (lcp !== null) buffer.pushMetric("__auto_lcp", userId, anonId, { value: lcp });
    if (inp !== null) buffer.pushMetric("__auto_inp", userId, anonId, { value: inp });
    if (clsBad) buffer.pushMetric("__auto_cls_binary", userId, anonId, { value: 1 });
    const abandoned = lcp === null ? 1 : 0;
    buffer.pushMetric("__auto_abandoned", userId, anonId, { value: abandoned });
    buffer.flush(true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
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
  /** Which published env to read values from. Defaults to "prod". */
  env?: FlagsClientBrowserEnv;
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
  private readonly env: FlagsClientBrowserEnv;
  private evalResult: EvalResponse | null = null;
  private anonId: string;
  private userId = "";
  private buffer: EventBuffer;
  private guardrailsInstalled = false;
  private listeners = new Set<() => void>();
  private overrideListenerInstalled = false;
  private onOverrideChange = () => {
    this.installBridge();
    this.notify();
  };

  constructor(opts: FlagsClientBrowserOptions) {
    this.sdkKey = opts.sdkKey;
    this.baseUrl = (opts.baseUrl ?? "https://edge.shipeasy.dev").replace(/\/$/, "");
    this.env = opts.env ?? "prod";
    this.autoGuardrails = opts.autoGuardrails !== false;
    this.anonId = getOrCreateAnonId();
    this.buffer = new EventBuffer(`${this.baseUrl}/collect`, this.sdkKey);
    void this.buffer.flushPendingAlias();
  }

  async identify(user: User): Promise<void> {
    const prevUserId = this.userId;
    this.userId = user.user_id ?? "";

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
    this.evalResult = (await res.json()) as EvalResponse;

    if (this.autoGuardrails && !this.guardrailsInstalled) {
      this.guardrailsInstalled = true;
      installAutoGuardrails(this.buffer, this.userId, this.anonId);
    }
    this.notify();
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
    if (this.evalResult === null) return false;
    const ov = readGateOverride(name);
    if (ov !== null) return ov;
    return this.evalResult.flags[name] ?? false;
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
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
  /** SDK key — same value used on the server via shipeasy(). */
  apiKey: string;
  /** Override the ShipEasy CDN/edge base URL. Defaults to https://cdn.shipeasy.ai. */
  baseUrl?: string;
  /** Override the admin URL for the devtools overlay (dev use). */
  adminUrl?: string;
}

/**
 * Initialise the ShipEasy client SDK and wire up lazy devtools.
 * Call this once at app startup (e.g. in a useEffect in your root layout).
 * Returns a cleanup function — call it on unmount to remove event listeners.
 */
export function shipeasy(opts: ShipeasyClientConfig): () => void {
  const client = configureShipeasy({
    sdkKey: opts.apiKey,
    baseUrl: opts.baseUrl ?? "https://cdn.shipeasy.ai",
  });
  flags.notifyMounted();
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
  /** Set by getBootstrapHtml() for auto-init. Not part of evaluate() output. */
  apiKey?: string;
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

// ---- i18n label helpers (formerly @shipeasy/i18n-core) ----

export const LABEL_MARKER_START = "￹";
export const LABEL_MARKER_SEP = "￺";
export const LABEL_MARKER_END = "￻";
export const LABEL_MARKER_RE = /￹([^￺￻]+)￺([^￻]*)￻/g;

export function encodeLabelMarker(key: string, value: string): string {
  return `${LABEL_MARKER_START}${key}${LABEL_MARKER_SEP}${value}${LABEL_MARKER_END}`;
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

const _I18N_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-i18n");
const _EDIT_MODE_SSR_SYM = Symbol.for("@shipeasy/sdk:ssr-edit-mode");

function getSSRI18nStore(): { strings: Record<string, string>; locale: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any)[_I18N_SSR_SYM]?.() ?? null;
}

function isEditLabelsMode(): boolean {
  if (typeof window !== "undefined") {
    // Client: check bootstrap payload (set by server) or live URL param.
     
    return (
      !!(window as any).__SE_BOOTSTRAP?.editLabels ||
      new URLSearchParams(location.search).has("se_edit_labels")
    );
  }
  // SSR: read directly from globalThis where the server SDK writes it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (globalThis as any)[_EDIT_MODE_SSR_SYM];
  return typeof val === "boolean" ? val : typeof val === "function" ? val() : false;
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
      : (text: string) =>
          tag === "br" || tag === "hr" ? `<${tag}>` : `<${tag}>${text}</${tag}>`;
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
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return interpolate(fallback, variables);
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
      return encodeLabelMarker(key, text) as F;
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

// Auto-init from window.__SE_BOOTSTRAP.apiKey when the bundle loads.
// The inline bootstrap script (written by getBootstrapHtml) always runs before
// deferred/module JS bundles, so __SE_BOOTSTRAP is present by the time this runs.
if (typeof window !== "undefined") {
  const _initBs = (window as unknown as { __SE_BOOTSTRAP?: BootstrapPayload }).__SE_BOOTSTRAP;
  if (_initBs?.apiKey && !_client) {
    shipeasy({ apiKey: _initBs.apiKey, baseUrl: _initBs.apiUrl });
  }
}
