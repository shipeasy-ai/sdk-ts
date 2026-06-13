// @shipeasy/sdk/next — optional Next.js adapter.
//
// Mints the shared `__se_anon_id` bucketing cookie at the edge so flags AND
// experiments bucket identically on SSR and in the browser from the very first
// request — no flash, even for fractional rollouts. A Server Component can't set
// cookies during render, so this edge step is what makes the first request
// correct; the server/client SDK only *read* + client-persist it.
//
// Zero-config install (no existing middleware):
//   // middleware.ts
//   export { middleware, config } from "@shipeasy/sdk/next";
//
// Compose with an existing middleware:
//   export default withShipeasy(myMiddleware);
//
// Full control inside your own middleware (preserves your header forwarding):
//   const requestHeaders = new Headers(req.headers);
//   const anon = readOrMintAnonId(req, requestHeaders);
//   const res = NextResponse.next({ request: { headers: requestHeaders } });
//   return commitAnonId(res, anon, req);
//
// Cookie name + format are a cross-SDK contract — see
// experiment-platform/18-identity-bucketing.md.
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

/** The first-party cookie that carries the stable anonymous bucketing unit. */
export const ANON_ID_COOKIE = "__se_anon_id";

// Opaque token charset. The value is client-controllable and feeds bucketing, so
// a tampered cookie is treated as absent (we mint a fresh one).
const ANON_ID_RX = /^[A-Za-z0-9_-]{1,64}$/;
const ANON_ID_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function mint(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `anon_${Math.random().toString(36).slice(2)}`;
}

function appendCookie(headers: Headers, name: string, value: string): void {
  const existing = headers.get("cookie") ?? "";
  const parts = existing
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${name}=`));
  parts.push(`${name}=${value}`);
  headers.set("cookie", parts.join("; "));
}

export interface AnonIdResult {
  /** The stable bucketing id for this request (existing cookie, or freshly minted). */
  anonId: string;
  /** True when there was no valid cookie and we minted a new id (must be persisted). */
  minted: boolean;
}

/**
 * Read + validate the `__se_anon_id` cookie, minting one when absent/invalid.
 * When `requestHeaders` is supplied and we mint, the new id is appended to the
 * forwarded `cookie` header so THIS request's SSR (and any inner middleware)
 * already sees it. Pair with {@link commitAnonId} to persist a minted id.
 */
export function readOrMintAnonId(req: NextRequest, requestHeaders?: Headers): AnonIdResult {
  const raw = req.cookies.get(ANON_ID_COOKIE)?.value;
  const valid = !!raw && ANON_ID_RX.test(raw);
  const anonId = valid ? raw! : mint();
  const minted = !valid;
  if (minted && requestHeaders) appendCookie(requestHeaders, ANON_ID_COOKIE, anonId);
  return { anonId, minted };
}

/**
 * Persist a freshly-minted anon id as a first-party cookie on `res` (no-op when
 * `minted` is false). Non-httpOnly by contract — the browser SDK reads it via
 * `document.cookie` to bucket identically to SSR. Returns `res` for chaining.
 */
export function commitAnonId(
  res: NextResponse,
  result: AnonIdResult,
  req: NextRequest,
): NextResponse {
  if (result.minted) {
    res.cookies.set(ANON_ID_COOKIE, result.anonId, {
      httpOnly: false,
      secure: req.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: ANON_ID_MAX_AGE,
    });
  }
  return res;
}

export type ShipeasyMiddleware = (
  req: NextRequest,
  event: NextFetchEvent,
) =>
  | NextResponse
  | Response
  | undefined
  | null
  | void
  | Promise<NextResponse | Response | undefined | null | void>;

/**
 * Wrap an existing Next middleware so every matched request also mints the
 * shared `__se_anon_id` cookie. Your middleware runs against a request that
 * already carries the id (its own logic + SSR see it), and the cookie is set on
 * whatever response it returns. Called with no argument, returns a standalone
 * mint-only middleware (what the default {@link middleware} export uses).
 *
 * If your middleware forwards custom request headers via
 * `NextResponse.next({ request: { headers } })`, prefer composing the
 * {@link readOrMintAnonId} + {@link commitAnonId} primitives inside it — that
 * preserves your forwarding verbatim; this wrapper rebuilds the pass-through
 * `next()` and so would drop request-header forwarding the inner handler added.
 */
export function withShipeasy(handler?: ShipeasyMiddleware): ShipeasyMiddleware {
  return async (req, event) => {
    const requestHeaders = new Headers(req.headers);
    const anon = readOrMintAnonId(req, requestHeaders);
    // Let the inner handler observe the id this request, too.
    if (anon.minted) req.cookies.set(ANON_ID_COOKIE, anon.anonId);

    const userRes = handler ? await handler(req, event) : undefined;

    // Pass-through (continue to SSR): `NextResponse.next()` self-identifies via
    // the `x-middleware-next` header. Rebuild it carrying the forwarded headers
    // so SSR reads the minted id, copying over any cookies/headers the inner
    // handler set.
    const isPassThrough =
      !userRes ||
      (userRes instanceof NextResponse && userRes.headers.get("x-middleware-next") === "1");
    if (isPassThrough) {
      const res = NextResponse.next({ request: { headers: requestHeaders } });
      if (userRes instanceof NextResponse) {
        userRes.cookies.getAll().forEach((c) => res.cookies.set(c));
        userRes.headers.forEach((v, k) => {
          if (k !== "x-middleware-next") res.headers.set(k, v);
        });
      }
      return commitAnonId(res, anon, req);
    }

    // Terminal response (redirect / rewrite / json / a raw Response): persist
    // the cookie onto it so the browser keeps the id for the next navigation.
    const res =
      userRes instanceof NextResponse
        ? userRes
        : userRes instanceof Response
          ? new NextResponse(userRes.body, userRes)
          : NextResponse.next({ request: { headers: requestHeaders } });
    return commitAnonId(res, anon, req);
  };
}

/** Drop-in middleware: `export { middleware, config } from "@shipeasy/sdk/next";` */
export const middleware: ShipeasyMiddleware = withShipeasy();

/**
 * Matcher for the drop-in middleware: every HTML route (landing + app), skipping
 * Next internals, API routes, and static files (any path segment with a dot).
 * Define your own `config` if you need a narrower scope.
 */
export const config = {
  matcher: ["/((?!api/|_next/|.*\\..*).*)"],
};
