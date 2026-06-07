// Per-evaluation usage telemetry.
//
// Fires ONE fire-and-forget HTTP beacon per evaluation — gate, config,
// killswitch, experiment, event — so usage can be counted by Cloudflare's
// native per-path request analytics (`httpRequestsAdaptiveGroups` grouped by
// `clientRequestPath`) with zero per-request storage on our side. The daily
// rollup reads those counts out of the Cloudflare GraphQL Analytics API.
//
// Why HTTP and not UDP: browsers cannot send UDP at all (no API exists, by
// design), Cloudflare Workers have no outbound UDP (`connect()` is TCP-only),
// and Cloudflare's native request analytics only counts HTTP — a UDP datagram
// would never appear in the dataset we read. `navigator.sendBeacon` (browser)
// and a non-awaited `fetch` (server) are the fire-and-forget, never-block-the-
// caller equivalents, and they ARE counted by the edge.
//
// The path carries `sha256(sdkKey)` — NOT the raw key — so even the secret
// server key never lands in edge/access logs, while still mapping 1:1 to a
// project (it equals `sdk_keys.key_hash`, the column the backend already
// indexes keys by). Resource names are percent-encoded.

export type TelemetryFeature = "gate" | "config" | "ks" | "experiment" | "event";

/** Hex SHA-256 — matches `packages/core/src/auth/crypto.ts` so the path hash
 * equals the stored `sdk_keys.key_hash`, making the rollup join trivial. */
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Default beacon host. MUST be a hostname that is NOT routed to the edge
 * Worker — a Pages static deploy (or a zone path with a Cloudflare static-
 * response rule) so the request is counted by Cloudflare's native per-path
 * analytics for free, with zero Worker compute. Pointing this at the Worker
 * host (cdn/edge) would bill one paid request per evaluation — the opposite of
 * the design intent. Override with `telemetryUrl`. */
export const DEFAULT_TELEMETRY_URL = "https://t.shipeasy.ai";

export interface TelemetryOptions {
  /** Beacon base URL — a Function-less static host (see DEFAULT_TELEMETRY_URL). */
  endpoint: string;
  /** Raw SDK key — hashed once at construction; never sent in the clear. */
  sdkKey: string;
  /** Which SDK fired the beacon — splits server vs client in the readout. */
  side: "server" | "client";
  /** Published env the values were read from (prod/staging/...). */
  env: string;
  /** When true, no beacons are emitted. Telemetry is ON by default. */
  disabled?: boolean;
  /**
   * Dedup window in ms. Within this window, repeated reads of the same
   * (feature, resource) fire at most one beacon — so a flag read on every React
   * render emits once per window, not once per render. The counted metric is
   * therefore "key used at least once per window". Defaults to 2000ms; set 0 to
   * emit on every call.
   */
  dedupeMs?: number;
}

export class Telemetry {
  private readonly prefix: string;
  private readonly disabled: boolean;
  private readonly dedupeMs: number;
  // Last-emit timestamp per `feature/resource`, for the dedup window. Bounded by
  // the number of distinct keys the app reads.
  private readonly lastEmit = new Map<string, number>();
  // Resolved once at construction and reused by every emit(), so the per-eval
  // cost is a Map-free microtask, not a hash.
  private readonly keyHash: Promise<string> | null;

  constructor(opts: TelemetryOptions) {
    const endpoint = (opts.endpoint ?? "").replace(/\/$/, "");
    this.disabled = opts.disabled === true || !opts.sdkKey || !endpoint;
    this.dedupeMs = opts.dedupeMs ?? 2000;
    // Path layout: /t/<sha256(key)>/<side>/<env>/<feature>/<resource>. side and
    // env are low-cardinality so they don't blow up the per-path grouping.
    this.prefix = `${endpoint}/t`;
    this.keyHash = this.disabled
      ? null
      : sha256Hex(opts.sdkKey)
          .then((h) => `${h}/${opts.side}/${encodeURIComponent(opts.env)}`)
          .catch(() => "");
  }

  /**
   * Emit a single best-effort usage beacon for one evaluation. Never blocks the
   * caller (the hash is already resolved) and never throws — a failed beacon
   * must never affect the evaluation it measures.
   */
  emit(feature: TelemetryFeature, resource: string): void {
    if (this.disabled || !this.keyHash) return;
    // Dedup window: collapse repeated reads of the same key (e.g. one flag read
    // on every React render) to one beacon per window. Checked synchronously so
    // suppressed calls cost nothing.
    if (this.dedupeMs > 0) {
      const dedupeKey = `${feature}/${resource}`;
      const now = Date.now();
      const last = this.lastEmit.get(dedupeKey);
      if (last !== undefined && now - last < this.dedupeMs) return;
      this.lastEmit.set(dedupeKey, now);
    }
    void this.keyHash.then((suffix) => {
      if (!suffix) return;
      send(`${this.prefix}/${suffix}/${feature}/${encodeURIComponent(resource)}`);
    });
  }
}

function send(url: string): void {
  try {
    // Browser: sendBeacon is the purpose-built fire-and-forget telemetry
    // primitive — non-blocking, survives page unload, no response to await.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url);
      return;
    }
    // Server (Node / Cloudflare Workers): non-awaited keepalive fetch, errors
    // swallowed. NOTE: on Cloudflare Workers each beacon is an outbound
    // subrequest (cap 50 free / 1000 paid per invocation), so a single request
    // that evaluates many flags can hit that ceiling — pass
    // `disableTelemetry: true` for hot, many-eval server paths on Workers.
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f === "function") {
      void f(url, { method: "GET", keepalive: true }).catch(() => {});
    }
  } catch {
    // Telemetry must never surface an error into the evaluation path.
  }
}
