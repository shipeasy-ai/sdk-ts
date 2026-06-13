import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  ANON_ID_COOKIE,
  readOrMintAnonId,
  commitAnonId,
  withShipeasy,
  middleware,
  config,
} from "../next/index";

const URL_ = "https://example.com/";
const req = (cookie?: string) =>
  new NextRequest(URL_, cookie ? { headers: { cookie } } : undefined);
const event = {} as never;

describe("readOrMintAnonId", () => {
  it("returns an existing valid cookie without minting or forwarding", () => {
    const headers = new Headers();
    const r = readOrMintAnonId(req(`${ANON_ID_COOKIE}=abc123_-XYZ`), headers);
    expect(r).toEqual({ anonId: "abc123_-XYZ", minted: false });
    expect(headers.get("cookie")).toBeNull(); // nothing forwarded
  });

  it("mints when the cookie is absent and forwards it to SSR", () => {
    const headers = new Headers({ cookie: "other=1" });
    const r = readOrMintAnonId(req(), headers);
    expect(r.minted).toBe(true);
    expect(r.anonId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(headers.get("cookie")).toContain(`${ANON_ID_COOKIE}=${r.anonId}`);
    expect(headers.get("cookie")).toContain("other=1"); // preserves existing
  });

  it("treats a tampered (out-of-charset) cookie as absent and mints fresh", () => {
    const r = readOrMintAnonId(req(`${ANON_ID_COOKIE}=' ;evil`));
    expect(r.minted).toBe(true);
    expect(r.anonId).not.toContain(" ");
    expect(r.anonId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("commitAnonId", () => {
  it("sets a non-httpOnly, lax, root cookie when minted", () => {
    const res = NextResponse.next();
    commitAnonId(res, { anonId: "id-1", minted: true }, req());
    const c = res.cookies.get(ANON_ID_COOKIE);
    expect(c?.value).toBe("id-1");
    expect(c?.httpOnly).toBe(false);
    expect(c?.sameSite).toBe("lax");
    expect(c?.path).toBe("/");
  });

  it("is a no-op when not minted", () => {
    const res = NextResponse.next();
    commitAnonId(res, { anonId: "id-1", minted: false }, req());
    expect(res.cookies.get(ANON_ID_COOKIE)).toBeUndefined();
  });
});

describe("withShipeasy (standalone middleware)", () => {
  it("mints + sets the cookie on a fresh request", async () => {
    const res = (await middleware(req(), event)) as NextResponse;
    const c = res.cookies.get(ANON_ID_COOKIE);
    expect(c?.value).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c?.httpOnly).toBe(false);
    // It's a pass-through to SSR.
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not re-set the cookie when one already exists", async () => {
    const res = (await middleware(req(`${ANON_ID_COOKIE}=keepme`), event)) as NextResponse;
    expect(res.cookies.get(ANON_ID_COOKIE)).toBeUndefined(); // no Set-Cookie
  });
});

describe("withShipeasy (composing an existing middleware)", () => {
  it("preserves a terminal redirect and still attaches the cookie", async () => {
    const inner = () => NextResponse.redirect("https://example.com/login");
    const res = (await withShipeasy(inner)(req(), event)) as NextResponse;
    expect(res.status).toBe(307); // redirect preserved
    expect(res.headers.get("location")).toBe("https://example.com/login");
    expect(res.cookies.get(ANON_ID_COOKIE)?.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries over cookies the inner middleware set on a pass-through", async () => {
    const inner = () => {
      const r = NextResponse.next();
      r.cookies.set("inner_flag", "1");
      return r;
    };
    const res = (await withShipeasy(inner)(req(), event)) as NextResponse;
    expect(res.cookies.get("inner_flag")?.value).toBe("1");
    expect(res.cookies.get(ANON_ID_COOKIE)?.value).toBeTruthy();
  });

  it("lets the inner middleware observe the freshly minted id", async () => {
    let seen: string | undefined;
    const inner = (r: NextRequest) => {
      seen = r.cookies.get(ANON_ID_COOKIE)?.value;
      return undefined;
    };
    const res = (await withShipeasy(inner)(req(), event)) as NextResponse;
    expect(seen).toBeTruthy();
    expect(res.cookies.get(ANON_ID_COOKIE)?.value).toBe(seen);
  });
});

describe("config", () => {
  it("exposes a matcher that excludes api + _next + static files", () => {
    expect(config.matcher).toEqual(["/((?!api/|_next/|.*\\..*).*)"]);
  });
});
