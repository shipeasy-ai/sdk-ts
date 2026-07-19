// Overlay side of signed override cookies: hold the per-session signing grant
// (issued by the admin app at devtools-auth) and write/clear the `se_ov` cookie
// so the SERVER honors overrides too — not just the client via URL params.
// Without a grant (unauthenticated overlay) we write nothing and the server
// simply ignores overrides (fail-closed).
//
// The grant (incl. signing key `Ks`) is mirrored into `sessionStorage` next to
// the devtools session token: every override reloads the page, which wipes
// module memory, and the session token is likewise persisted — so without this
// the overlay would look "connected" after any reload yet silently fail to sign
// cookies. `Ks` is tab-scoped, expires with the grant, and sits inside the same
// trust boundary as the already-persisted session token (which authorizes the
// strictly more powerful admin devtools API), so co-locating it adds no
// meaningful attack surface.

import {
  signOverrideCookie,
  decodeKey,
  OVERRIDE_COOKIE_NAME,
  OVERRIDE_FORMAT_VERSION,
  type OverrideMap,
  type OverridePayload,
} from "../overrides/cookie";

/** Fields the admin app posts back after devtools-auth (see approveDevtoolsAuthAction). */
export interface OverrideSigningGrant {
  signKey: string; // base64url(Ks)
  keyId: string;
  nonce: string;
  exp: number; // unix seconds
}

type StoredGrant = OverrideSigningGrant & { projectId: string };

let grant: StoredGrant | null = null;

/** sessionStorage slot for the grant — sibling of the `se_dt_session` token. */
const GRANT_STORAGE_KEY = "se_dt_grant";

function persistGrant(g: StoredGrant | null): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (g) sessionStorage.setItem(GRANT_STORAGE_KEY, JSON.stringify(g));
    else sessionStorage.removeItem(GRANT_STORAGE_KEY);
  } catch {
    /* storage blocked — the in-memory grant still works for this page load */
  }
}

/** Store the grant received from the `se:devtools-auth` postMessage (and mirror
 *  it to sessionStorage so it survives the reload every override triggers). */
export function setOverrideSigningGrant(
  g: OverrideSigningGrant | null | undefined,
  projectId: string,
): void {
  grant = g && projectId ? { ...g, projectId } : null;
  persistGrant(grant);
}

/**
 * Rehydrate the in-memory grant from sessionStorage after a reload. The overlay
 * calls this on init once it has restored the devtools session, passing that
 * session's project. Adopts a stored grant only when it is unexpired AND matches
 * the active project; drops an expired one. No-op if a grant is already held or
 * none is stored. Without this, a "connected" overlay (persisted session token)
 * silently no-ops every cookie write because the grant lived only in memory.
 */
export function restoreOverrideSigningGrant(projectId: string): void {
  if (grant || !projectId || typeof sessionStorage === "undefined") return;
  try {
    const raw = sessionStorage.getItem(GRANT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredGrant | null;
    if (!parsed || parsed.projectId !== projectId || typeof parsed.exp !== "number") return;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      persistGrant(null); // expired — evict
      return;
    }
    grant = parsed;
  } catch {
    /* malformed — ignore, overlay stays unable to sign until re-auth */
  }
}

export function hasOverrideSigningGrant(): boolean {
  return grant !== null;
}

function isEmpty(map: OverrideMap): boolean {
  return (
    Object.keys(map.gates).length === 0 &&
    Object.keys(map.configs).length === 0 &&
    Object.keys(map.exps).length === 0
  );
}

/**
 * Sign `map` with the current grant and write it to the `se_ov` cookie (or clear
 * the cookie when the map is empty). No-op without a grant. Async (Web Crypto) —
 * callers must await before reloading so the cookie is set first.
 */
export async function writeSignedOverrideCookie(map: OverrideMap): Promise<void> {
  if (typeof document === "undefined") return;
  if (!grant) return; // unauthenticated overlay → no server-trusted cookie
  if (isEmpty(map)) {
    clearSignedOverrideCookie();
    return;
  }
  const payload: OverridePayload = {
    v: OVERRIDE_FORMAT_VERSION,
    pid: grant.projectId,
    keyId: grant.keyId,
    nonce: grant.nonce,
    exp: grant.exp,
    ov: map,
  };
  const value = await signOverrideCookie(payload, decodeKey(grant.signKey));
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; secure" : "";
  const maxAge = Math.max(0, grant.exp - Math.floor(Date.now() / 1000));
  document.cookie = `${OVERRIDE_COOKIE_NAME}=${value}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

/** Delete the `se_ov` cookie (used on clear-all). */
export function clearSignedOverrideCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${OVERRIDE_COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
}
