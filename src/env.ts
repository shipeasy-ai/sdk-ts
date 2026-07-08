// Native runtime-environment detection.
//
// Used ONLY to pick the DEFAULT for outbound egress when the caller does not set
// it explicitly:
//   - is the SDK allowed to make network requests at all (`isNetworkEnabled`)?
//   - is per-evaluation usage telemetry / logging allowed (`disableTelemetry`)?
//
// Both default to ON in production and OFF everywhere else, so a local/dev/CI run
// of an app that embeds the SDK never phones home unless it explicitly opts in.
//
// Precedence for the production decision:
//   1. A native runtime env var — `SHIPEASY_ENV`, then `NODE_ENV`. A value of
//      "production"/"prod" ⇒ prod; anything else ("development"/"staging"/"test"/…)
//      ⇒ not prod.
//   2. When no native env var is set (e.g. a Cloudflare Worker, where `NODE_ENV`
//      is absent), fall back to the SDK's own configured `env` option, which the
//      caller sets and which itself defaults to "prod". This keeps a real
//      production deploy "on" by default while a `env: "dev"` config stays quiet.
//
// The env option is always present (it defaults to "prod"), so the production
// decision is always inferrable — the SDK never has to make the fields required.

/** True when the host runtime looks like a production deployment. `configuredEnv`
 * is the SDK's own `env` option (dev/staging/prod); it is consulted only when no
 * native runtime env var is set. */
export function isProductionEnv(configuredEnv?: string): boolean {
  const native = readNativeEnv();
  if (native !== null) return native === "production" || native === "prod";
  return (configuredEnv ?? "prod").toLowerCase() === "prod";
}

/** Read the native runtime environment string, lowercased, or null when the host
 * exposes no `process.env` (browsers, some edge runtimes) or the vars are unset. */
function readNativeEnv(): string | null {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const raw = proc?.env?.SHIPEASY_ENV ?? proc?.env?.NODE_ENV;
    if (typeof raw !== "string") return null;
    const v = raw.trim().toLowerCase();
    return v.length ? v : null;
  } catch {
    return null;
  }
}
