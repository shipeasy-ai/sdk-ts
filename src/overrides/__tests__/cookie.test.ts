import { describe, it, expect } from "vitest";
import {
  deriveSessionKey,
  signOverrideCookie,
  verifyOverrideCookie,
  encodeKey,
  extractOverrideCookie,
  OVERRIDE_FORMAT_VERSION,
  type OverridePayload,
} from "../cookie";

// Canonical cross-impl fixture — MUST match packages/core/src/overrides. If this
// fails, the sdk-ts vendored copy has drifted from core's byte format.
const ENCODED_KP = "syl3uiYI-YH2q50cnntIQ__y0aBfx18n7QtvgiSOHxE";
const COOKIE =
  "eyJ2IjoxLCJwaWQiOiJwcm9qLWZpeHR1cmUiLCJrZXlJZCI6ImsxIiwibm9uY2UiOiJmaXhlZC1ub25jZSIsImV4cCI6NDAwMDAwMDAwMCwib3YiOnsiZ2F0ZXMiOnsicmVsZWFzZV9tb2R1bGUiOnRydWV9LCJjb25maWdzIjp7fSwiZXhwcyI6e319fQ.HqQ7GuTuef3oJyn2Wwg89DOu7DMhay2NmRAk9-GTUmA";

describe("sdk-ts override cookie (vendored)", () => {
  it("accepts the canonical fixture from core", async () => {
    const res = await verifyOverrideCookie(COOKIE, ENCODED_KP, {
      projectId: "proj-fixture",
      keyId: "k1",
      nowSeconds: 1_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload.ov.gates.release_module).toBe(true);
  });

  it("rejects the fixture for the wrong project / expired / tampered", async () => {
    const wrongProj = await verifyOverrideCookie(COOKIE, ENCODED_KP, {
      projectId: "other",
      keyId: "k1",
      nowSeconds: 1_000,
    });
    expect(wrongProj.ok).toBe(false);
    const expired = await verifyOverrideCookie(COOKIE, ENCODED_KP, {
      projectId: "proj-fixture",
      keyId: "k1",
      nowSeconds: 5_000_000_000,
    });
    expect(expired.ok).toBe(false);
    const tampered = await verifyOverrideCookie(`${COOKIE}x`, ENCODED_KP, {
      projectId: "proj-fixture",
      keyId: "k1",
      nowSeconds: 1_000,
    });
    expect(tampered.ok).toBe(false);
  });

  it("round-trips a locally-signed cookie", async () => {
    // Simulate the overlay: derive Ks from Kp, sign, then verify.
    const kp = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])));
    const nonce = "n1";
    const exp = 4_000_000_000;
    const ks = await deriveSessionKey(kp, nonce, exp);
    const payload: OverridePayload = {
      v: OVERRIDE_FORMAT_VERSION,
      pid: "p",
      keyId: "k1",
      nonce,
      exp,
      ov: { gates: { a: true }, configs: { c: 1 }, exps: { e: "b" } },
    };
    const cookie = await signOverrideCookie(payload, ks);
    const res = await verifyOverrideCookie(cookie, encodeKey(kp), {
      projectId: "p",
      keyId: "k1",
      nowSeconds: 1_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.ov.gates.a).toBe(true);
      expect(res.payload.ov.configs.c).toBe(1);
      expect(res.payload.ov.exps.e).toBe("b");
    }
  });

  it("extractOverrideCookie handles bare value and Cookie header", () => {
    expect(extractOverrideCookie(COOKIE)).toBe(COOKIE);
    expect(extractOverrideCookie(`foo=1; se_ov=${COOKIE}; bar=2`)).toBe(COOKIE);
    expect(extractOverrideCookie("foo=1; bar=2")).toBeNull();
    expect(extractOverrideCookie("")).toBeNull();
    expect(extractOverrideCookie(null)).toBeNull();
  });
});
