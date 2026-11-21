import { describe, it, expect, afterEach, vi } from "vitest";
import * as server from "../server";
import * as client from "../client/index";

// Shared vector: {gates:{lobby_hold:true,old_nav:false}, configs:{banner:{text:"hi"}},
// exps:{checkout_exp:"treatment"}} as compact JSON -> base64url.
const DEV =
  "eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX0";
const KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const SIGNED =
  "eyJ2IjoxLCJwaWQiOiJwcm9qX2ZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXh0dXJlLW5vbmNlIiwiZXhwIjo0MTAyNDQ0ODAwLCJvdiI6eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX19.8qd-pHu1e96Th-jcu4BZOhLmZjwhKrgn-uI8IWBr5Og";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function gateBlob(extra: Record<string, unknown> = {}): never {
  return {
    version: "t",
    plan: "free",
    gates: {
      lobby_hold: { enabled: 1, killswitch: 0, rolloutPct: 0, rules: [], salt: "s" },
      old_nav: { enabled: 1, killswitch: 0, rolloutPct: 10000, rules: [], salt: "s2" },
    },
    configs: {},
    killswitches: {},
    ...extra,
  } as never;
}

describe("decodeDevOverrideCookie", () => {
  it("decodes the vector bare, in a header, and URL-encoded", () => {
    for (const input of [DEV, `a=1; se_ov_dev=${DEV}; b=2`, `se_ov_dev=${encodeURIComponent(DEV)}`]) {
      const o = server.decodeDevOverrideCookie(input);
      expect(o?.gates).toEqual({ lobby_hold: true, old_nav: false });
      expect(o?.configs).toEqual({ banner: { text: "hi" } });
      expect(o?.exps).toEqual({ checkout_exp: "treatment" });
    }
  });
  it("ignores malformed input", () => {
    for (const bad of ["", "!!!", "e30x", "bnVsbA", "WzFd", null, undefined, "a=1"]) {
      const o = server.decodeDevOverrideCookie(bad as string);
      expect(o === null || (Object.keys(o.gates).length === 0)).toBe(true);
    }
  });
});

describe("server devOverrides opt-in", () => {
  it("is ignored when the option is off", async () => {
    server.configureForOffline({
      snapshot: { flags: gateBlob(), experiments: { version: "t", universes: {}, experiments: {} } },
    } as never);
    expect(server.getShipeasyServerClient()?.devOverridesActive).toBe(false);
    const c = new server.Client({ user_id: "u" });
    await server.withRequestOverrides(`se_ov_dev=${DEV}`, () => {
      expect(c.getFlag("lobby_hold")).toBe(false);
    });
  });

  it("is honored in non-prod with the option (configureForOffline counts as test mode)", async () => {
    const e = server.Engine.fromSnapshot({
      flags: gateBlob(),
      experiments: { version: "t", universes: {}, experiments: {} },
    });
    expect(e.devOverridesActive).toBe(false);
    // Engine built with the option in a non-production process:
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHIPEASY_ENV", "development");
    const on = new server.Engine({ apiKey: "k", devOverrides: true, isNetworkEnabled: false } as never);
    expect(on.devOverridesActive).toBe(true);
    const testOn = server.Engine.forTesting({ devOverrides: true } as never);
    expect(testOn.devOverridesActive).toBe(true);
  });

  it("is ignored in production with ONE warning, and the cookie is not read", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHIPEASY_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = new server.Engine({ apiKey: "k", devOverrides: true, isNetworkEnabled: false } as never);
    expect(e.devOverridesActive).toBe(false);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("se_ov_dev through withRequestOverrides", () => {
  async function scoped(cookie: string, signedKey: boolean) {
    // Build a global engine with the option on by replacing it through configure.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHIPEASY_ENV", "development");
    server._resetShipeasyServerForTests();
    server._resetConfigureForTests();
    const eng = server.configure({
      apiKey: "k",
      devOverrides: true,
      init: false,
      isNetworkEnabled: false,
    } as never);
    (eng as unknown as { flagsBlob: unknown }).flagsBlob = gateBlob(
      signedKey ? { overrideKey: KEY, overrideKeyId: "k1" } : {},
    );
    const c = new server.Client({ user_id: "u" });
    return server.withRequestOverrides(cookie, () => ({
      lobby: c.getFlagDetail("lobby_hold"),
      nav: c.getFlag("old_nav"),
    }));
  }

  it("applies the dev cookie when opted in (non-prod)", async () => {
    const r = await scoped(`se_ov_dev=${DEV}`, false);
    expect(r.lobby).toEqual({ value: true, reason: "OVERRIDE" });
    expect(r.nav).toBe(false);
  });

  it("signed se_ov beats se_ov_dev on the same name", async () => {
    const devFlip = btoa(JSON.stringify({ gates: { lobby_hold: false }, configs: {}, exps: {} }))
      .replace(/=+$/, "");
    const r = await scoped(`se_ov_dev=${devFlip}; se_ov=${SIGNED}`, true);
    expect(r.lobby.value).toBe(true);
  });
});

describe("browser se_ov_dev writer", () => {
  function fakeBrowser(search: string, protocol = "http:") {
    const jar: { v: string } = { v: "" };
    const doc = {
      get cookie() {
        return jar.v;
      },
      set cookie(x: string) {
        // Track only the override cookie (the client also writes its anon-id cookie).
        if (x.startsWith("se_ov_dev=")) jar.v = x;
      },
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { location: { search, protocol } });
    vi.stubGlobal("location", { search, protocol, hostname: "localhost" });
    return jar;
  }
  function boot() {
    client._resetShipeasyForTests();
    client.configureShipeasy({ sdkKey: "", testMode: true, autoGuardrails: false } as never);
  }

  it("writes the cookie from URL overrides in non-prod", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHIPEASY_ENV", "development");
    const jar = fakeBrowser("?se_gate_lobby_hold=true&se_gate_old_nav=false&se_exp_checkout_exp=treatment&se_config_banner=%7B%22text%22%3A%22hi%22%7D");
    boot();
    expect(jar.v).toBe(`se_ov_dev=${DEV}; path=/; samesite=lax`);
  });

  it("adds secure on https and deletes the cookie when no override params", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHIPEASY_ENV", "development");
    let jar = fakeBrowser("?se_gate_x=true", "https:");
    boot();
    expect(jar.v).toContain("; secure");
    jar = fakeBrowser("?other=1");
    boot();
    expect(jar.v).toMatch(/^se_ov_dev=; path=\/; max-age=0/);
  });

  it("is a no-op when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHIPEASY_ENV", "production");
    const jar = fakeBrowser("?se_gate_x=true");
    boot();
    expect(jar.v).toBe("");
  });
});
