// Signed DevTools override cookie (`se_ov`) — verify + sign. This is a VENDORED,
// byte-identical copy of the canonical implementation in the shipeasy monorepo
// (packages/core/src/overrides/cookie.ts). sdk-ts is a standalone published
// package and cannot import @shipeasy/core, so the format is duplicated here; the
// derivation formulas and cookie body signing MUST match core exactly (a
// cross-impl fixture test guards drift).
//
// Handshake (see the monorepo plan doc for the full contract):
//   • project key Kp = HMAC(SE_OVERRIDE_SECRET, "se-ov:v1:<projectId>:<keyId>")
//     — the SDK receives base64url(Kp) as `overrideKey` in the /sdk/flags or
//       /sdk/evaluate payload and uses it to VERIFY.
//   • session key Ks = HMAC(Kp, "se-ov-sess:v1:<nonce>:<exp>")
//     — the DevTools overlay receives base64url(Ks) after auth and SIGNS the
//       cookie with it. The SDK re-derives Ks from Kp + the cookie's nonce/exp.

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Cookie name carrying the signed override payload. */
export const OVERRIDE_COOKIE_NAME = "se_ov";
/** Format version — must match core's `OVERRIDE_FORMAT_VERSION`. */
export const OVERRIDE_FORMAT_VERSION = 1;

/** The four override kinds. `gates` covers feature flags AND kill switches. */
export interface OverrideMap {
  gates: Record<string, boolean>;
  configs: Record<string, unknown>;
  exps: Record<string, string>;
}

export interface OverridePayload {
  v: number;
  pid: string;
  keyId: string;
  nonce: string;
  exp: number;
  ov: OverrideMap;
}

function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, ENC.encode(msg));
  return new Uint8Array(mac);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** base64url of raw key bytes (wire form of Kp / Ks). */
export function encodeKey(keyBytes: Uint8Array): string {
  return b64uEncode(keyBytes);
}

/** Inverse of {@link encodeKey}. */
export function decodeKey(encoded: string): Uint8Array {
  return b64uDecode(encoded);
}

/** Ks = HMAC(Kp, "se-ov-sess:v1:<nonce>:<exp>"). MUST match core. */
export async function deriveSessionKey(
  projectKey: Uint8Array,
  nonce: string,
  exp: number,
): Promise<Uint8Array> {
  return hmac(projectKey, `se-ov-sess:v1:${nonce}:${exp}`);
}

/** Sign a payload with Ks → `body.sig`. Used by the DevTools overlay. */
export async function signOverrideCookie(
  payload: OverridePayload,
  sessionKey: Uint8Array,
): Promise<string> {
  const body = b64uEncode(ENC.encode(JSON.stringify(payload)));
  const sig = b64uEncode(await hmac(sessionKey, body));
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: OverridePayload }
  | { ok: false; reason: string };

/**
 * Verify a `se_ov` cookie value against the project key `Kp` (base64url as
 * received from the flags payload). Fails **closed** on any malformation — the
 * caller then resolves the real value. `nowSeconds` defaults to now.
 */
export async function verifyOverrideCookie(
  cookieValue: string,
  encodedProjectKey: string,
  opts: { projectId?: string; keyId: string; nowSeconds?: number },
): Promise<VerifyResult> {
  let projectKey: Uint8Array;
  try {
    projectKey = decodeKey(encodedProjectKey);
  } catch {
    return { ok: false, reason: "bad-key" };
  }
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot !== cookieValue.lastIndexOf(".")) {
    return { ok: false, reason: "malformed" };
  }
  const body = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);

  let payload: OverridePayload;
  try {
    payload = JSON.parse(DEC.decode(b64uDecode(body))) as OverridePayload;
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  if (
    !payload ||
    payload.v !== OVERRIDE_FORMAT_VERSION ||
    typeof payload.pid !== "string" ||
    typeof payload.keyId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number" ||
    !payload.ov
  ) {
    return { ok: false, reason: "bad-shape" };
  }
  // `projectId` is optional: the per-project `Kp` already binds the cookie to a
  // project (a cookie for another project won't verify against this Kp), so a
  // verifier that doesn't know its own project id (the SDK) can skip this check.
  if (opts.projectId !== undefined && payload.pid !== opts.projectId) {
    return { ok: false, reason: "wrong-project" };
  }
  if (payload.keyId !== opts.keyId) return { ok: false, reason: "wrong-key-id" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };

  const sessionKey = await deriveSessionKey(projectKey, payload.nonce, payload.exp);
  const expected = await hmac(sessionKey, body);
  if (!timingSafeEqual(expected, b64uDecode(sig))) return { ok: false, reason: "bad-sig" };

  payload.ov = {
    gates: payload.ov.gates ?? {},
    configs: payload.ov.configs ?? {},
    exps: payload.ov.exps ?? {},
  };
  return { ok: true, payload };
}

/**
 * Framework-general: extract the raw `se_ov` value from whatever the app passes —
 * the bare cookie value, or a full `Cookie:` header string (`a=1; se_ov=…; b=2`).
 * Returns null if not present. No framework import; the app reads the header its
 * own way (`next/headers`, `req.headers.cookie`, `c.req.header('cookie')`, …).
 */
export function extractOverrideCookie(input: string | null | undefined): string | null {
  if (!input) return null;
  // Already the bare value? A signed value is exactly `body.sig` (two b64url
  // segments, no `;` / `=` from cookie syntax). If it contains `;` or a
  // `name=value` pair, treat it as a Cookie header and parse.
  if (!input.includes(";") && !input.includes("se_ov=")) {
    return input.includes(".") ? input : null;
  }
  for (const part of input.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === OVERRIDE_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
