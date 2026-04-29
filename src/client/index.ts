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
    const ov = readGateOverride(name);
    if (ov !== null) return ov;
    return this.evalResult?.flags[name] ?? false;
  }

  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    const ov = readConfigOverride(name);
    const raw = ov !== undefined ? ov : this.evalResult?.configs?.[name];
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
//   i18n.t("hero.title", { name });
//
// The React adapter wraps the same singletons and adds a re-render
// subscription — it does not re-export them, so customers consistently
// reach for the central import.

let _client: FlagsClientBrowser | null = null;

/** Configure the singleton. Idempotent — re-calling with the same opts is a no-op. */
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
  /** Read a feature gate. Returns false until identify() resolves. */
  get(name: string): boolean {
    return _client?.getFlag(name) ?? false;
  },
  getConfig<T = unknown>(name: string, decode?: (raw: unknown) => T): T | undefined {
    return _client?.getConfig(name, decode);
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
  /** Subscribe for change notifications (identify/override). Used by framework adapters. */
  subscribe(listener: () => void): () => void {
    if (!_client) return () => {};
    return _client.subscribe(listener);
  },
  /** True once identify() has completed and flags are available. */
  get ready(): boolean {
    return _client?.ready ?? false;
  },
};

// Framework-specific element creator — injected once via i18n.configure().
// Kept outside the object so tree-shakers can drop tEl entirely when not used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createElement: ((tag: string, props: object, children: string) => any) | null = null;

/**
 * Universal i18n facade. Backed by the `window.i18n` global the loader
 * script installs. Returns the key itself when the loader hasn't run
 * (SSR, missing script tag, before profile fetch completes), so call
 * sites never need to null-check.
 */
export const i18n = {
  t(key: string, variables?: Record<string, string | number>): string {
    if (typeof window !== "undefined" && window.i18n) return window.i18n.t(key, variables);
    return key;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tEl(key: string, variables?: Record<string, string | number>, desc?: string): any {
    const text = this.t(key, variables);
    if (!_createElement) return text;
    // Build data-* attribute bag inline to avoid importing @shipeasy/i18n-core
    // into every bundle that pulls in this singleton.
    const props: Record<string, string> = { "data-label": key };
    if (variables) props["data-variables"] = JSON.stringify(variables);
    if (desc) props["data-label-desc"] = desc;
    return _createElement("span", props, text);
  },
  /** Wire up the element creator once at app startup (call before any tEl use). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configure(opts: { createElement: (tag: string, props: object, children: string) => any }): void {
    _createElement = opts.createElement;
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
