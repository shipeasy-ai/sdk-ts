import { describe, it, expect, afterEach, vi } from "vitest";
import * as server from "../server";
import * as client from "../client/index";
import {
  resolveOverrideCookieDomain,
  writeOverrideCookie,
  clearOverrideCookie,
  setConfiguredCookieDomain,
  _resetCookieDomainCache,
} from "../devtools-contract/cookie-domain";

const KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const SIGNED =
  "eyJ2IjoxLCJwaWQiOiJwcm9qX2ZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXh0dXJlLW5vbmNlIiwiZXhwIjo0MTAyNDQ0ODAwLCJvdiI6eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX19.8qd-pHu1e96Th-jcu4BZOhLmZjwhKrgn-uI8IWBr5Og";
const DEV =
  "eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX0";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setConfiguredCookieDomain(undefined);
  _resetCookieDomainCache();
});

/** Fake document that models Domain acceptance: only `.example.com` (a
 *  registrable domain) and the host itself are settable; `.com` is a public suffix. */
function fakeBrowser(hostname: string) {
  const writes: string[] = [];
  const jar = new Map<string, string>();
  vi.stubGlobal("location", { hostname, protocol: "https:", search: "" });
  vi.stubGlobal("window", { location: { hostname, protocol: "https:", search: "" } });
  vi.stubGlobal("document", {
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k.split("|")[0]}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      writes.push(raw);
      const attrs = raw.split(";").map((x) => x.trim());
      const [name, ...v] = attrs[0]!.split("=");
      const value = v.join("=");
      const dom = attrs.find((a) => a.startsWith("domain="))?.slice(7) ?? "";
      const bare = dom.replace(/^\./, "");
      if (dom && (bare === "com" || !hostname.endsWith(bare))) return; // rejected
      const key = `${name}|${dom}`;
      if (/max-age=0/.test(raw) || value === "") jar.delete(key);
      else jar.set(key, value);
    },
  });
  return { writes, jar };
}

describe("cookie domain scoping", () => {
  it("localhost / IP / single label -> no Domain (host-only)", () => {
    for (const h of ["localhost", "127.0.0.1", "intranet"]) {
      _resetCookieDomainCache();
      const { writes } = fakeBrowser(h);
      expect(resolveOverrideCookieDomain()).toBeNull();
      writeOverrideCookie("se_ov_dev", "v", "samesite=lax");
      expect(writes.at(-1)).toBe("se_ov_dev=v; path=/; samesite=lax");
    }
  });

  it("multi-label host -> broadest settable domain; writes use it", () => {
    const { writes, jar } = fakeBrowser("app.eu.example.com");
    expect(resolveOverrideCookieDomain()).toBe(".example.com");
    expect(jar.size).toBe(0); // probe cleaned up
    writeOverrideCookie("se_ov_dev", "v", "samesite=lax; secure");
    expect(writes.at(-1)).toBe("se_ov_dev=v; path=/; domain=.example.com; samesite=lax; secure");
  });

  it("explicit option wins", () => {
    fakeBrowser("app.example.com");
    setConfiguredCookieDomain(".custom.test");
    expect(resolveOverrideCookieDomain()).toBe(".custom.test");
  });

  it("delete clears both the domain-scoped and the host-only copy", () => {
    const { writes } = fakeBrowser("app.example.com");
    clearOverrideCookie("se_ov");
    expect(writes).toContain("se_ov=; path=/; max-age=0; samesite=lax");
    expect(writes).toContain("se_ov=; path=/; domain=.example.com; max-age=0; samesite=lax");
  });

  it("client exposes overrideCookieDomain to the overlay via globalThis", () => {
    vi.stubEnv("NODE_ENV", "production");
    client._resetShipeasyForTests();
    client.configureShipeasy({
      sdkKey: "",
      testMode: true,
      autoGuardrails: false,
      overrideCookieDomain: ".example.org",
    } as never);
    expect((globalThis as Record<string, unknown>).__SE_OV_COOKIE_DOMAIN__).toBe(".example.org");
  });
});

describe("extractOverrideCookie bare-vs-header", () => {
  it("does not take an unrelated single cookie as a bare value", async () => {
    const { extractOverrideCookie } = await import("../overrides/cookie");
    expect(extractOverrideCookie("theme=a.b")).toBeNull();
    expect(extractOverrideCookie(`theme=a.b; se_ov=${SIGNED}`)).toBe(SIGNED);
    expect(extractOverrideCookie(SIGNED)).toBe(SIGNED);
  });
  it("an unrelated Cookie header no longer blocks the header fallback", async () => {
    const e = server.Engine.forTesting({
      initialBlob: { version: "t", plan: "free", gates: {}, configs: {}, killswitches: {}, overrideKey: KEY, overrideKeyId: "k1" } as never,
    });
    expect((await e.verifyOverrides("theme=a.b"))).toBeNull();
    expect((await e.verifyOverrides(`se_ov=${SIGNED}`))?.gates.lobby_hold).toBe(true);
  });
});

describe("getOverrideHeaders", () => {
  it("builds the header from document.cookie, {} when absent", () => {
    vi.stubGlobal("document", { cookie: `a=1; se_ov=${SIGNED}; se_ov_dev=${DEV}` });
    expect(client.getOverrideHeaders()).toEqual({
      "X-Shipeasy-Overrides": `se_ov=${SIGNED}; se_ov_dev=${DEV}`,
    });
    vi.stubGlobal("document", { cookie: "a=1" });
    expect(client.getOverrideHeaders()).toEqual({});
  });
});

describe("X-Shipeasy-Overrides on the server", () => {
  function boot(devOverrides: boolean) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHIPEASY_ENV", "development");
    server._resetShipeasyServerForTests();
    server._resetConfigureForTests();
    const eng = server.configure({ apiKey: "k", devOverrides, init: false, isNetworkEnabled: false } as never);
    (eng as unknown as { flagsBlob: unknown }).flagsBlob = {
      version: "t",
      plan: "free",
      gates: {
        lobby_hold: { enabled: 1, killswitch: 0, rolloutPct: 0, rules: [], salt: "s" },
      },
      configs: {},
      killswitches: {},
      overrideKey: KEY,
      overrideKeyId: "k1",
    };
    return new server.Client({ user_id: "u" });
  }
  const flip = (v: boolean) =>
    btoa(JSON.stringify({ gates: { lobby_hold: v }, configs: {}, exps: {} })).replace(/=+$/, "");

  it("header-only signed cookie applies", async () => {
    const c = boot(false);
    await server.withRequestOverrides(null, () => expect(c.getFlag("lobby_hold")).toBe(true), `se_ov=${SIGNED}`);
  });

  it("header-only dev cookie applies only under the guards", async () => {
    let c = boot(true);
    await server.withRequestOverrides(undefined, () => expect(c.getFlag("lobby_hold")).toBe(true), `se_ov_dev=${DEV}`);
    c = boot(false);
    await server.withRequestOverrides(undefined, () => expect(c.getFlag("lobby_hold")).toBe(false), `se_ov_dev=${DEV}`);
  });

  it("the Cookie header beats the custom header for the same name", async () => {
    const c = boot(true);
    await server.withRequestOverrides(
      `se_ov_dev=${flip(false)}`,
      () => expect(c.getFlag("lobby_hold")).toBe(false),
      `se_ov_dev=${flip(true)}`,
    );
    await server.withRequestOverrides(
      "foo=bar",
      () => expect(c.getFlag("lobby_hold")).toBe(true),
      `se_ov_dev=${flip(true)}`,
    );
  });
});
