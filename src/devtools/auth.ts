// Device-auth (PKCE code-exchange) core — framework-agnostic.
//
// Flow (RFC 8252 native-app auth against the shipeasy edge + admin web):
//  1. Mint a PKCE verifier + S256 challenge.
//  2. POST {edge}/auth/device/start { code_challenge } → { state }.
//  3. Open the web /cli-auth page in an auth session with the HOST APP's own
//     deep-link redirect_uri (any custom scheme — e.g. `acme://se-auth`). The
//     user logs in + picks a project; the page 302s back to
//     `{redirect_uri}?state=…` carrying ONLY the one-time state — never the
//     token (an app squatting the scheme intercepts nothing usable).
//  4. Exchange state + code_verifier at POST {edge}/auth/device/token for the
//     minted admin key.
//
// Platform specifics (browser opening, secure storage, crypto digest) are
// injected via `DeviceAuthAdapters`, so this module has no React Native (or
// DOM) imports — the RN entry wires expo-web-browser/expo-crypto in.

import type { DevtoolsSession } from "./types";
import { DEFAULT_ADMIN_BASE_URL, DEFAULT_EDGE_BASE_URL } from "./types";

/** Thrown when the user dismisses the auth browser without completing login. */
export class LoginCancelled extends Error {
  constructor() {
    super("Login cancelled");
    this.name = "LoginCancelled";
  }
}

/** Result contract of an auth-session opener (mirrors expo-web-browser's
 *  `openAuthSessionAsync`): resolves when the browser deep-links back to
 *  `redirectUri` (type "success", `url` = the full deep link) or the user
 *  dismisses it. */
export interface AuthSessionResult {
  type: "success" | "cancel" | "dismiss" | string;
  url?: string;
}

export interface DeviceAuthAdapters {
  /** Open `url` in an auth browser session and resolve when it redirects to
   *  `redirectUri` (or the user cancels). RN: `WebBrowser.openAuthSessionAsync`. */
  openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult>;
  /** base64url(SHA-256(input)) — the PKCE S256 transform. Defaults to
   *  `crypto.subtle` where available; RN injects expo-crypto. */
  sha256Base64Url?(input: string): Promise<string>;
  /** UUID source for the verifier. Defaults to `crypto.randomUUID`. */
  randomUUID?(): string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface DeviceAuthOptions {
  /** The HOST APP's deep-link redirect URI (its own scheme), e.g.
   *  `acme://se-auth`. Must match a scheme the app registered with the OS. */
  redirectUri: string;
  /** Edge worker origin (`/auth/device/*`). Defaults to production. */
  edgeBaseUrl?: string;
  /** Admin web origin (the `/cli-auth` page). Defaults to production. */
  adminBaseUrl?: string;
  /** Pre-select a project on the /cli-auth page (skips the picker when the
   *  user has access). */
  projectId?: string;
}

function defaultRandomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Last-resort non-crypto fallback (test environments only — real platforms
  // all expose crypto.randomUUID or inject an adapter).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function defaultSha256Base64Url(input: string): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "No crypto.subtle available — pass adapters.sha256Base64Url (e.g. expo-crypto's digestStringAsync).",
    );
  }
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(hash);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier of unreserved chars (two hyphen-stripped UUIDs = 64 hex
 *  chars — inside RFC 7636's 43–128 bounds). */
function makeVerifier(randomUUID: () => string): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

/** Parse a deep link's query params without relying on the host's URL
 *  implementation (React Native's URL polyfill is historically incomplete). */
export function parseDeepLinkQuery(url: string): Record<string, string> {
  const q = url.indexOf("?");
  if (q < 0) return {};
  const out: Record<string, string> = {};
  // Strip any #fragment, then split the query.
  const query = url.slice(q + 1).split("#")[0];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Run the full device-auth flow and return the session. Throws
 * {@link LoginCancelled} if the user dismisses the browser, or `Error` on a
 * protocol failure (state mismatch, exchange rejection).
 *
 * The caller persists the returned session (RN: SecureStore/Keychain) — this
 * core deliberately does no storage of its own.
 */
export async function startDeviceAuth(
  opts: DeviceAuthOptions,
  adapters: DeviceAuthAdapters,
): Promise<DevtoolsSession> {
  const edge = (opts.edgeBaseUrl ?? DEFAULT_EDGE_BASE_URL).replace(/\/$/, "");
  const admin = (opts.adminBaseUrl ?? DEFAULT_ADMIN_BASE_URL).replace(/\/$/, "");
  const fetchImpl = adapters.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const randomUUID = adapters.randomUUID ?? defaultRandomUUID;
  const digest = adapters.sha256Base64Url ?? defaultSha256Base64Url;

  const verifier = makeVerifier(randomUUID);
  const challenge = await digest(verifier);

  // 1. Register the session (binds the challenge server-side).
  const startRes = await fetchImpl(`${edge}/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code_challenge: challenge }),
  });
  if (!startRes.ok) {
    throw new Error(`Login could not start (HTTP ${startRes.status}). Please try again.`);
  }
  const { state } = (await startRes.json()) as { state: string };
  if (!state) throw new Error("Login could not start (no state). Please try again.");

  // 2. Send the user to the web auth page; it deep-links back with state only.
  const authUrl =
    `${admin}/cli-auth?state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&redirect_uri=${encodeURIComponent(opts.redirectUri)}` +
    (opts.projectId ? `&project_id=${encodeURIComponent(opts.projectId)}` : "");
  const result = await adapters.openAuthSession(authUrl, opts.redirectUri);
  if (result.type !== "success" || !result.url) throw new LoginCancelled();

  const params = parseDeepLinkQuery(result.url);
  // CSRF: the state echoed back must match the one we started with.
  if (!params.state || params.state !== state) throw new Error("Auth state mismatch");

  // 3. PKCE code-exchange: prove possession of the verifier, get the token.
  const tokenRes = await fetchImpl(`${edge}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, code_verifier: verifier }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Login did not complete (HTTP ${tokenRes.status}). Please try again.`);
  }
  const data = (await tokenRes.json()) as {
    token?: string;
    project_id?: string;
    user_email?: string;
    project_name?: string;
  };
  if (!data.token || !data.project_id) throw new Error("Login did not return a token");

  return {
    token: data.token,
    projectId: data.project_id,
    userEmail: data.user_email ?? null,
    projectName: data.project_name ?? null,
  };
}
