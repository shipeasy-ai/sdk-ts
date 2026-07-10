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

/** True when the host runtime looks like a test run — the native `SHIPEASY_ENV`
 * / `NODE_ENV` is exactly `"test"` (what jest/vitest set by default). Browsers
 * and edge runtimes with no `process.env` read as not-test. Used to default
 * i18n `renderKeysOnly` on under test. */
export function isTestEnv(): boolean {
  return readNativeEnv() === "test";
}

// ---- i18n renderKeysOnly toggle (shared across the server + client bundles) ----
//
// A process-wide test toggle: when on, `i18n.t()` renders the KEY instead of
// resolving its translated value, so snapshot/assertion tests run against
// stable data. Stored on a global symbol so the two separately-bundled
// entrypoints (@shipeasy/sdk/server and /client) observe one source of truth —
// e.g. a server `configure({ i18n: { renderKeysOnly } })` is honoured by the
// client-module `i18n.t()` that runs during SSR. Defaults to {@link isTestEnv}.

const _I18N_RENDER_KEYS_SYM = Symbol.for("@shipeasy/sdk:i18n-render-keys");

/** True when i18n should render keys instead of resolving values. Explicit
 * config (via `setI18nRenderKeysOnly`) wins; otherwise defaults to env==test. */
export function i18nRenderKeysOnly(): boolean {
  const override = (globalThis as Record<symbol, unknown>)[_I18N_RENDER_KEYS_SYM];
  if (typeof override === "boolean") return override;
  return isTestEnv();
}

/** Set (or, with `undefined`, leave at the env-derived default) the process-wide
 * i18n renderKeysOnly toggle. Called from the `configure()` / `shipeasy()`
 * entrypoints when the caller passes `i18n: { renderKeysOnly }`. */
export function setI18nRenderKeysOnly(value: boolean | undefined): void {
  if (value === undefined) return;
  (globalThis as Record<symbol, unknown>)[_I18N_RENDER_KEYS_SYM] = value;
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
