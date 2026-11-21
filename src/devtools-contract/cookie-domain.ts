// Cookie Domain scoping for the override cookies (`se_ov`, `se_ov_dev`).
//
// A frontend on `app.example.com` and an API on `api.example.com` only share a
// cookie when it is written with `Domain=.example.com`. One zero-dependency
// helper used by BOTH writers (the client's `se_ov_dev` writer and the DevTools
// overlay's `se_ov` writer) so they always agree. Leaf code: no third-party
// imports, no Engine reference.
//
// Resolution: explicit `overrideCookieDomain` (published on globalThis by the
// client `configure()`), else none for localhost / IP literals / single-label
// hosts (host-only, as before), else the broadest domain the browser accepts —
// probed shortest-first (skipping the bare TLD) by writing a probe cookie and
// reading it back. Browsers reject public suffixes, so this lands on the
// registrable domain.

/** globalThis key the client publishes its `overrideCookieDomain` option on. */
export const OVERRIDE_COOKIE_DOMAIN_KEY = "__SE_OV_COOKIE_DOMAIN__";

const PROBE_NAME = "se_ov_probe";

/** Publish (or clear, with undefined) the explicit cookie domain for the overlay. */
export function setConfiguredCookieDomain(domain: string | undefined): void {
  try {
    (globalThis as Record<string, unknown>)[OVERRIDE_COOKIE_DOMAIN_KEY] = domain || undefined;
  } catch {
    /* ignore */
  }
}

let cache: { host: string; explicit: string; domain: string | null } | null = null;

/** Test seam. */
export function _resetCookieDomainCache(): void {
  cache = null;
}

function isIpOrSingleLabel(host: string): boolean {
  if (host.includes(":")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  return !host.includes(".");
}

/** The Domain attribute value to use, or null for a host-only cookie. */
export function resolveOverrideCookieDomain(): string | null {
  if (typeof document === "undefined" || typeof location === "undefined") return null;
  const explicit =
    ((globalThis as Record<string, unknown>)[OVERRIDE_COOKIE_DOMAIN_KEY] as string | undefined) ?? "";
  const host = (location.hostname || "").toLowerCase();
  if (cache && cache.host === host && cache.explicit === explicit) return cache.domain;
  let domain: string | null = null;
  if (explicit) {
    domain = explicit;
  } else if (host && host !== "localhost" && !isIpOrSingleLabel(host)) {
    const labels = host.split(".");
    // Shortest first, skipping the bare TLD: a.b.example.com -> example.com, b.example.com, ...
    for (let i = labels.length - 2; i >= 0; i--) {
      const cand = `.${labels.slice(i).join(".")}`;
      try {
        document.cookie = `${PROBE_NAME}=1; path=/; domain=${cand}; max-age=60; samesite=lax`;
        const ok = new RegExp(`(?:^|;\\s*)${PROBE_NAME}=1(?:;|$)`).test(document.cookie);
        document.cookie = `${PROBE_NAME}=; path=/; domain=${cand}; max-age=0; samesite=lax`;
        if (ok) {
          domain = cand;
          break;
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  cache = { host, explicit, domain };
  return domain;
}

/**
 * Write an override cookie. `attrs` are extra attributes (e.g. `max-age=60;
 * samesite=lax; secure`). Adds `path=/` and the resolved `Domain`. Also drops any
 * stale host-only copy (older SDKs) so it cannot shadow the domain-scoped one.
 */
export function writeOverrideCookie(name: string, value: string, attrs: string): void {
  if (typeof document === "undefined") return;
  const domain = resolveOverrideCookieDomain();
  if (domain) {
    document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
    document.cookie = `${name}=${value}; path=/; domain=${domain}; ${attrs}`;
  } else {
    document.cookie = `${name}=${value}; path=/; ${attrs}`;
  }
}

/** Delete an override cookie: BOTH the domain-scoped copy and any host-only copy. */
export function clearOverrideCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
  const domain = resolveOverrideCookieDomain();
  if (domain) document.cookie = `${name}=; path=/; domain=${domain}; max-age=0; samesite=lax`;
}
