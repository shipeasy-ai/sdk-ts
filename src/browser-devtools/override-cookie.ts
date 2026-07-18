// Overlay side of signed override cookies: hold the per-session signing grant
// (issued by the admin app at devtools-auth) and write/clear the `se_ov` cookie
// so the SERVER honors overrides too — not just the client via URL params. The
// signing key `Ks` never leaves this module; without a grant (unauthenticated
// overlay) we write nothing and the server simply ignores overrides (fail-closed).

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

let grant: (OverrideSigningGrant & { projectId: string }) | null = null;

/** Store the grant received from the `se:devtools-auth` postMessage. */
export function setOverrideSigningGrant(
  g: OverrideSigningGrant | null | undefined,
  projectId: string,
): void {
  grant = g && projectId ? { ...g, projectId } : null;
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
