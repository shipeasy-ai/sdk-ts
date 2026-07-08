// Internal self-monitoring channel — SDK bugs that are "on our end".
//
// When the SDK swallows one of its OWN internal errors (the `safeRun` last-
// resort guard in logger.ts, which keeps a getFlag/getConfig/… from throwing
// into product code even when an internal invariant is violated), it ALSO
// ships a structured see event here — to Shipeasy's OWN project, NOT the
// consumer's — so the SDK team can track SDK-internal failures across every
// app the SDK runs in.
//
// This is deliberately distinct from the customer-facing `see()` path
// (server/client `reportError`), which authenticates with the consumer's key
// and lands in the consumer's dashboard. Internal errors must never pollute a
// customer's Errors tab, and the SDK team must see them centrally — so this
// channel has its own baked-in destination + credential.
//
// Guarantees (identical to telemetry/see): fire-and-forget, never blocks, never
// throws into product code, deduped/rate-limited. A failed send is swallowed
// silently — it must never log (that would risk recursion through safeRun).

import { buildSeeEvent, causesThe, SeeLimiter } from "./see/core";

// ---- Baked-in destination ----
//
// The main Shipeasy project (`.shipeasy` project_id
// e976b15e-3ccc-44d3-821d-87f06d5a0e43). The credential is a PUBLIC client key
// — the same class of credential already embedded verbatim in every browser
// bundle that ships the client SDK, and mirroring how the CLI bakes Shipeasy's
// own public key for setup-bug self-reporting (see marketplace report-issue.ts)
// — so baking it into the published package is safe. `/collect` treats it as a
// write-only ingest key; it grants no read access. The canonical ingest host is
// api.shipeasy.ai (the SDK default baseUrl), which routes /collect to the edge
// worker.
const INGEST_URL = "https://api.shipeasy.ai/collect";

// Sentinel used until the real key is minted + baked. While `INGEST_KEY` is
// still the placeholder the channel stays fully inert (see `reportInternalError`),
// so a build that ships before the key is provisioned never fires doomed
// requests. Mint the key with:
//   shipeasy keys create --type client --env prod \
//     --name "SDK internal error self-reporting" --scopes events:write
// then replace the INGEST_KEY initializer below with the returned value.
const PLACEHOLDER_KEY = "sdk_client_REPLACE_WITH_SHIPEASY_INTERNAL_ERROR_KEY";
let INGEST_KEY = PLACEHOLDER_KEY;

/** True once a real key has been baked in (not the placeholder sentinel). */
function keyConfigured(): boolean {
  return !!INGEST_KEY && INGEST_KEY !== PLACEHOLDER_KEY;
}

// Stable consequence. The `label` (the safeRun operation name, e.g. "flags.get")
// is the subject; the outcome is fixed. Both are constant per operation — no
// variable data — so occurrences of the same internal bug fold into one issue
// on our dashboard (fingerprint = error_type + normalized message + top stack +
// subject|outcome). `sdk` marks which language SDK reported it.
const OUTCOME = "returned a safe default";
const SDK_ID = "ts";

interface InternalCtx {
  side: "client" | "server";
  sdkVersion: string;
  enabled: boolean;
}

// Module-level, set once per bundle from the Engine constructor — mirrors how
// setLogLevel carries the level. The server and client are separate bundles, so
// each keeps its own copy; there is no cross-talk. Null until configured (a
// report before configure is a no-op — nothing to attribute it to).
let ctx: InternalCtx | null = null;

// Bounds network chatter from a hot internal-error loop (30s dedup window + a
// hard per-process/session cap). The backend dedupes by fingerprint anyway.
let limiter = new SeeLimiter();

/**
 * Wire the self-monitoring channel. Called from the Engine constructor with the
 * bundle's side + version. `enabled` defaults on; it is forced off in test mode
 * (no network) and when the caller opts out via
 * `disableInternalErrorReporting`.
 */
export function setInternalReportContext(c: {
  side: "client" | "server";
  sdkVersion: string;
  enabled?: boolean;
}): void {
  ctx = { side: c.side, sdkVersion: c.sdkVersion, enabled: c.enabled !== false };
}

/**
 * Report an SDK-internal error to Shipeasy's own project. Called from
 * `safeRun`'s catch. `label` is the swallowed operation (e.g. "flags.get") and
 * becomes the stable issue subject. Never throws.
 */
export function reportInternalError(label: string, err: unknown): void {
  try {
    if (!ctx || !ctx.enabled || !keyConfigured()) return;
    const ev = buildSeeEvent(
      err,
      causesThe(label).to(OUTCOME),
      { sdk: SDK_ID },
      { side: ctx.side, sdkVersion: ctx.sdkVersion },
      "caught",
    );
    if (!limiter.shouldSend(ev)) return;
    send(INGEST_URL, INGEST_KEY, JSON.stringify({ events: [ev] }));
  } catch {
    /* self-reporting must never throw into product code */
  }
}

function send(url: string, key: string, body: string): void {
  try {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== "function") return;
    // text/plain avoids a CORS preflight in the browser; the worker's /collect
    // reads the raw body as JSON. keepalive lets it survive an unloading page.
    void f(url, {
      method: "POST",
      headers: { "X-SDK-Key": key, "Content-Type": "text/plain" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* self-reporting must never surface a network error */
  }
}

/** Test seam: reset module state (context + rate limiter + key) so a spec
 * starts from a clean, inert channel. */
export function __resetInternalReportForTest(): void {
  ctx = null;
  limiter = new SeeLimiter();
  INGEST_KEY = PLACEHOLDER_KEY;
}

/** Test seam: stand in a real-looking key so specs can exercise the send path
 * without the (deliberately inert) placeholder blocking it. */
export function __setInternalIngestKeyForTest(key: string): void {
  INGEST_KEY = key;
}

/** Test seam: the baked-in ingest destination + the inert sentinel, so specs
 * assert the wire target and the not-yet-provisioned behaviour. */
export const __INTERNAL_INGEST_URL = INGEST_URL;
export const __INTERNAL_PLACEHOLDER_KEY = PLACEHOLDER_KEY;
