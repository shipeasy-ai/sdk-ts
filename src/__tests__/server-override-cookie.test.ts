import { describe, it, expect } from "vitest";
import { Engine } from "../server";

// Canonical fixture (see src/overrides/__tests__/cookie.test.ts): a cookie for
// project "proj-fixture", keyId "k1", overriding gate `release_module` → true.
const ENCODED_KP = "syl3uiYI-YH2q50cnntIQ__y0aBfx18n7QtvgiSOHxE";
const COOKIE =
  "eyJ2IjoxLCJwaWQiOiJwcm9qLWZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXhlZC1ub25jZSIsImV4cCI6NDAwMDAwMDAwMCwib3YiOnsiZ2F0ZXMiOnsicmVsZWFzZV9tb2R1bGUiOnRydWV9LCJjb25maWdzIjp7fSwiZXhwcyI6e319fQ.HqQ7GuTuef3oJyn2Wwg89DOu7DMhay2NmRAk9-GTUmA";

function engineWithKey(key?: string) {
  return Engine.forTesting({
    initialBlob: {
      version: "t",
      plan: "free",
      gates: {},
      configs: {},
      killswitches: { release_module: { killed: 0 } },
      ...(key ? { overrideKey: key, overrideKeyId: "k1" } : {}),
    },
  });
}

describe("server SDK: signed override cookie apply", () => {
  it("verifies + applies a valid cookie to flags (and mirrors kill switches)", async () => {
    const e = engineWithKey(ENCODED_KP);
    const verified = await e.verifyOverrides(COOKIE);
    expect(verified).not.toBeNull();
    const boot = e.evaluate({ anonymous_id: "u" }, undefined, verified);
    expect(boot.flags.release_module).toBe(true);
    // `release_module` is also a known killswitch here → mirrored onto the ks map.
    expect(boot.killswitches.release_module).toBe(true);
  });

  it("accepts a full Cookie header string", async () => {
    const e = engineWithKey(ENCODED_KP);
    const verified = await e.verifyOverrides(`foo=1; se_ov=${COOKIE}; bar=2`);
    expect(verified?.gates.release_module).toBe(true);
  });

  it("ignores the cookie when no verify key is present (fail-closed)", async () => {
    const e = engineWithKey(undefined);
    const verified = await e.verifyOverrides(COOKIE);
    expect(verified).toBeNull();
    const boot = e.evaluate({ anonymous_id: "u" }, undefined, verified);
    expect(boot.flags.release_module).toBeUndefined();
  });

  it("ignores a forged cookie (wrong key)", async () => {
    const e = engineWithKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const verified = await e.verifyOverrides(COOKIE);
    expect(verified).toBeNull();
  });
});
