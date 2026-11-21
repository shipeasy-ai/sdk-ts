import { describe, it, expect, afterEach } from "vitest";
import { Engine, Client, withRequestOverrides, overrideFlag, clearOverrides, configureForOffline } from "../server";
import { verifyOverrideCookie, extractOverrideCookie } from "../overrides/cookie";

// Cross-impl fixture (se_ov_fixture.json) shared by every SDK.
const KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const KEY_ID = "k1";
const COOKIE =
  "eyJ2IjoxLCJwaWQiOiJwcm9qX2ZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXh0dXJlLW5vbmNlIiwiZXhwIjo0MTAyNDQ0ODAwLCJvdiI6eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX19.8qd-pHu1e96Th-jcu4BZOhLmZjwhKrgn-uI8IWBr5Og";
const EXPIRED =
  "eyJ2IjoxLCJwaWQiOiJwcm9qX2ZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXh0dXJlLW5vbmNlIiwiZXhwIjoxMDAwLCJvdiI6eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX19.fZEp7eGjZSdi5EvTB-5NZLbZpVXbcWbIaEYRmPvPbd8";
const TAMPERED =
  "eyJ2IjoxLCJwaWQiOiJwcm9qX2ZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXh0dXJlLW5vbmNlIiwiZXhwIjo0MTAyNDQ0ODAwLCJvdiI6eyJnYXRlcyI6eyJsb2JieV9ob2xkIjp0cnVlLCJvbGRfbmF2IjpmYWxzZX0sImNvbmZpZ3MiOnsiYmFubmVyIjp7InRleHQiOiJoaSJ9fSwiZXhwcyI6eyJjaGVja291dF9leHAiOiJ0cmVhdG1lbnQifX19.8qd-pHu1e96Th-jcu4BZOhLmZjwhKrgn-uI8IWBr5AA";

function setup(withKey = true) {
  configureForOffline({
    snapshot: {
      flags: {
        version: "t",
        plan: "free",
        gates: {
          lobby_hold: { enabled: 1, killswitch: 0, rolloutPct: 0, rules: [], salt: "s" },
          old_nav: { enabled: 1, killswitch: 0, rolloutPct: 10000, rules: [], salt: "s2" },
        },
        configs: { banner: { value: { text: "real" } } },
        killswitches: { lobby_hold: { killed: 0 } },
        ...(withKey ? { overrideKey: KEY, overrideKeyId: KEY_ID } : {}),
      },
      experiments: {
        version: "t",
        universes: { checkout: { holdout_range: null } },
        experiments: {
          checkout_exp: {
            universe: "checkout",
            allocationPct: 0,
            salt: "e",
            status: "running",
            groups: [
              { name: "control", weight: 5000, params: { color: "blue" } },
              { name: "treatment", weight: 5000, params: { color: "red" } },
            ],
          },
        },
      },
    },
  } as never);
}

afterEach(() => {
  try {
    clearOverrides();
  } catch {
    /* not configured */
  }
});

describe("se_ov fixture vectors", () => {
  it("verifies valid, rejects expired / tampered / wrong keyId", async () => {
    const ok = await verifyOverrideCookie(COOKIE, KEY, { keyId: KEY_ID });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.ov.gates).toEqual({ lobby_hold: true, old_nav: false });
      expect(ok.payload.ov.configs).toEqual({ banner: { text: "hi" } });
      expect(ok.payload.ov.exps).toEqual({ checkout_exp: "treatment" });
    }
    expect((await verifyOverrideCookie(EXPIRED, KEY, { keyId: KEY_ID })).ok).toBe(false);
    expect((await verifyOverrideCookie(TAMPERED, KEY, { keyId: KEY_ID })).ok).toBe(false);
    expect((await verifyOverrideCookie(COOKIE, KEY, { keyId: "k2" })).ok).toBe(false);
  });

  it("extracts from a Cookie header", () => {
    expect(extractOverrideCookie(`a=1; se_ov=${COOKIE}; b=2`)).toBe(COOKIE);
    expect(extractOverrideCookie(COOKIE)).toBe(COOKIE);
  });
});

describe("withRequestOverrides", () => {
  it("applies gates / killswitch / configs inside the scope only", async () => {
    setup();
    const c = new Client({ user_id: "u1" });
    expect(c.getFlag("lobby_hold")).toBe(false);
    await withRequestOverrides(`x=1; se_ov=${COOKIE}`, async () => {
      await Promise.resolve();
      expect(c.getFlag("lobby_hold")).toBe(true);
      expect(c.getFlagDetail("lobby_hold")).toEqual({ value: true, reason: "OVERRIDE" });
      expect(c.getFlag("old_nav")).toBe(false);
      expect(c.getKillswitch("lobby_hold")).toBe(true);
      expect(c.getConfig("banner")).toEqual({ text: "hi" });
      const a = c.universe<{ color: string }>("checkout").assign();
      expect(a.group).toBe("treatment");
      expect(a.get("color", "x")).toBe("red");
      expect(c.getConfig("banner", (r) => (r as { text: string }).text)).toBe("hi");
    });
    expect(c.getFlag("lobby_hold")).toBe(false);
    expect(c.getKillswitch("lobby_hold")).toBe(false);
    expect(c.getConfig("banner")).toEqual({ text: "real" });
    expect(c.universe("checkout").assign().group).not.toBe("treatment");
  });

  it("programmatic override wins over the cookie", async () => {
    setup();
    overrideFlag("lobby_hold", false);
    const c = new Client({ user_id: "u1" });
    await withRequestOverrides(COOKIE, () => {
      expect(c.getFlagDetail("lobby_hold")).toEqual({ value: false, reason: "OVERRIDE" });
    });
  });

  it("fails closed: expired, tampered, no key", async () => {
    setup();
    const c = new Client({ user_id: "u1" });
    for (const bad of [EXPIRED, TAMPERED, null, undefined, "junk"]) {
      await withRequestOverrides(bad, () => expect(c.getFlag("lobby_hold")).toBe(false));
    }
    setup(false);
    const c2 = new Client({ user_id: "u1" });
    await withRequestOverrides(COOKIE, () => expect(c2.getFlag("lobby_hold")).toBe(false));
  });

  it("returns fn's value and isolates concurrent scopes", async () => {
    setup();
    const c = new Client({ user_id: "u1" });
    const [a, b] = await Promise.all([
      withRequestOverrides(COOKIE, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return c.getFlag("lobby_hold");
      }),
      withRequestOverrides(null, async () => c.getFlag("lobby_hold")),
    ]);
    expect([a, b]).toEqual([true, false]);
  });
});
