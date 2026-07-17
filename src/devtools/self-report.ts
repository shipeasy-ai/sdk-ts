// Devtools self-monitoring — see() error reporting for the overlay itself.
//
// The devtools overlay is OUR code, shipped in se-devtools.js to every customer
// site. When it faults, WE need to know — but the overlay runs on the customer's
// origin and talks to the customer's admin API, so a plain see() would either
// vanish (no SDK configured on the page) or land in the CUSTOMER's Errors
// dashboard. Neither surfaces the overlay's own bugs to us.
//
// This module gives the overlay a `see()` bound to Shipeasy's OWN monitoring
// project. It reuses the shared see-core primitives (buildSeeEvent + the fluent
// chain + the SeeLimiter spam guard) so occurrences are wire-identical to every
// other see() event, and beacons them to the existing `/collect` ingestion
// endpoint authenticated with a HARDCODED monitoring-project public client key.
//
// Why a hardcoded client key is safe (and why it must be a SPECIFIC one):
//   • Client keys are designed to be embedded in shipped browser code — this
//     one can do nothing but file see() occurrences into Shipeasy's monitoring
//     project (rate-limited by the SeeLimiter here + the server's per-fingerprint
//     dedupe).
//   • /collect enforces an Origin check on client keys, so the key MUST be
//     minted with `allowed_origin: "*"` (explicit match-any) or the overlay's
//     cross-origin beacons from customer domains 403. See originAllowed() in
//     packages/worker/src/lib/auth.ts.
//   • The key MUST belong to the monitoring project (MONITORING_PROJECT_ID in
//     packages/worker/wrangler.toml) so occurrences land on OUR dashboard.
//
// Until a real key is baked, MONITOR_CLIENT_KEY stays the placeholder sentinel
// and the reporter is inert — it never fires a doomed request. Mirrors the CLI's
// baked report key (marketplace/cli/src/setup/report-issue.ts).

import {
  buildSeeEvent,
  SeeLimiter,
  startSeeChain,
  startSeeViolationChain,
  type Consequence,
  type SeeChain,
  type SeeExtras,
  type SeeKind,
  type SeeViolationChain,
} from "../see/core";
import { DEFAULT_EDGE_BASE_URL } from "./types";

/** Sentinel used before a real key is baked — keeps the reporter inert so a
 *  build without a key never fires doomed /collect requests. */
const PLACEHOLDER_KEY = "sdk_client_REPLACE_WITH_SHIPEASY_DEVTOOLS_MONITOR_KEY";

// Shipeasy's own PUBLIC client key for the MONITORING project, minted with
// `allowed_origin: "*"`. Replace the sentinel with the real key to arm the
// reporter (a one-line change — see the file header for the minting contract).
// Client keys are public by design, so baking it into the shipped bundle is
// safe: it can only file pending, rate-limited see() occurrences into our own
// monitoring project.
const MONITOR_CLIENT_KEY = PLACEHOLDER_KEY;

/** Version marker on every occurrence so overlay reports are distinguishable
 *  from the SDK's own client/server see() events on the dashboard. */
const SELF_REPORT_SDK_VERSION = "devtools-overlay";

interface SelfReportConfig {
  /** Edge origin hosting /collect. Defaults to production (api.shipeasy.ai). */
  edgeBaseUrl: string;
  /** The customer project whose overlay is running — rides on every report as
   *  `affected_project` so we can triage which deployment threw. */
  affectedProjectId?: string;
}

let config: SelfReportConfig = { edgeBaseUrl: DEFAULT_EDGE_BASE_URL };

// Bound once per overlay mount. Session-scoped spam guard so a hot error loop
// in one panel can't flood /collect (the server dedupes by fingerprint too).
const limiter = new SeeLimiter();

/**
 * Point the reporter at an edge origin + tag reports with the running project.
 * Called once from the overlay mount. Safe to call again on session swap.
 */
export function configureSelfReport(opts: {
  edgeBaseUrl?: string;
  affectedProjectId?: string;
}): void {
  config = {
    edgeBaseUrl: (opts.edgeBaseUrl ?? DEFAULT_EDGE_BASE_URL).replace(/\/$/, ""),
    affectedProjectId: opts.affectedProjectId,
  };
}

/** True once a real key is baked in — the reporter is a no-op otherwise. */
function armed(): boolean {
  return !!MONITOR_CLIENT_KEY && MONITOR_CLIENT_KEY !== PLACEHOLDER_KEY;
}

/** Beacon-first (unload-safe, no preflight), keepalive-fetch fallback. The key
 *  rides in the body as `k` for the beacon path (sendBeacon can't set headers)
 *  and in the X-SDK-Key header for the fetch path — /collect reads both. */
function post(events: unknown[]): void {
  const url = `${config.edgeBaseUrl}/collect`;
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const body = JSON.stringify({ k: MONITOR_CLIENT_KEY, events });
      if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
    } catch {
      /* fall through to fetch */
    }
  }
  try {
    void fetch(url, {
      method: "POST",
      headers: { "X-SDK-Key": MONITOR_CLIENT_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* error reporting must never throw into overlay code */
  }
}

/** Build a wire-compatible see() occurrence and ship it to the monitoring
 *  project. Never throws — a reporting failure must not compound the fault. */
function dispatch(
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  kind?: SeeKind,
): void {
  if (!armed()) return;
  try {
    const enriched: SeeExtras = {
      surface: "devtools",
      ...(config.affectedProjectId ? { affected_project: config.affectedProjectId } : {}),
      ...extras,
    };
    const ev = buildSeeEvent(problem, consequence, enriched, {
      side: "client",
      sdkVersion: SELF_REPORT_SDK_VERSION,
      url:
        typeof window !== "undefined" && window.location ? window.location.href : undefined,
    }, kind);
    if (!limiter.shouldSend(ev)) return;
    post([ev]);
  } catch {
    /* never throw into overlay code */
  }
}

/**
 * The overlay's own `see()` — same grammar as `@shipeasy/sdk`'s see():
 *
 *   see(err).causes_the("label draft").to("not be saved").extras({ profile_id });
 *   see.Violation("no profile").causes_the("label edit").to("have no anchor");
 *
 * Reports into Shipeasy's monitoring project, NOT the customer's. Import it in
 * overlay catch blocks that know the user-visible consequence of the fault.
 */
export function see(problem: unknown): SeeChain {
  return startSeeChain(() => problem, dispatch);
}
see.Violation = (name: string): SeeViolationChain =>
  startSeeViolationChain(name, dispatch);
