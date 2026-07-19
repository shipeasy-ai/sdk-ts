// @vitest-environment jsdom
//
// Regression guard: the devtools signing grant must survive the page reload
// that every override triggers. The grant (incl. Ks) lives in module memory but
// is mirrored to sessionStorage; on the next load the overlay rehydrates it, so
// a "connected" overlay keeps writing the server-trusted `se_ov` cookie instead
// of only mutating the URL. A reload is simulated with vi.resetModules() (fresh
// module memory) while sessionStorage — like the real browser — persists.

import { afterEach, describe, it, expect, vi } from "vitest";
import { encodeKey } from "../overrides/cookie";

const PID = "e976b15e-3ccc-44d3-821d-87f06d5a0e43";
const nowS = () => Math.floor(Date.now() / 1000);

function makeGrant(exp: number) {
  return { signKey: encodeKey(new Uint8Array(32).fill(7)), keyId: "k1", nonce: "n1", exp };
}

async function freshModule() {
  // A fresh import after resetModules() has grant === null — like a page reload.
  return await import("../browser-devtools/override-cookie");
}

afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  document.cookie = "se_ov=; path=/; max-age=0";
  vi.resetModules();
});

describe("devtools signing grant survives reloads", () => {
  it("persists on set and rehydrates into a fresh (post-reload) module", async () => {
    const m1 = await freshModule();
    m1.setOverrideSigningGrant(makeGrant(nowS() + 3600), PID);
    expect(m1.hasOverrideSigningGrant()).toBe(true);
    expect(sessionStorage.getItem("se_dt_grant")).toBeTruthy();

    vi.resetModules(); // reload: module memory wiped, sessionStorage kept
    const m2 = await freshModule();
    expect(m2.hasOverrideSigningGrant()).toBe(false); // memory gone
    m2.restoreOverrideSigningGrant(PID);
    expect(m2.hasOverrideSigningGrant()).toBe(true); // rehydrated from storage
  });

  it("a rehydrated grant writes the se_ov cookie", async () => {
    (await freshModule()).setOverrideSigningGrant(makeGrant(nowS() + 3600), PID);
    vi.resetModules();
    const m2 = await freshModule();
    m2.restoreOverrideSigningGrant(PID);
    await m2.writeSignedOverrideCookie({ gates: { release_module: true }, configs: {}, exps: {} });
    expect(document.cookie).toContain("se_ov=");
  });

  it("WITHOUT rehydration a fresh module cannot sign — this is the bug", async () => {
    (await freshModule()).setOverrideSigningGrant(makeGrant(nowS() + 3600), PID);
    vi.resetModules();
    const m2 = await freshModule(); // no restore call
    await m2.writeSignedOverrideCookie({ gates: { release_module: true }, configs: {}, exps: {} });
    expect(document.cookie).not.toContain("se_ov=");
  });

  it("does not rehydrate an expired grant (and evicts it)", async () => {
    (await freshModule()).setOverrideSigningGrant(makeGrant(nowS() - 10), PID);
    vi.resetModules();
    const m2 = await freshModule();
    m2.restoreOverrideSigningGrant(PID);
    expect(m2.hasOverrideSigningGrant()).toBe(false);
    expect(sessionStorage.getItem("se_dt_grant")).toBeNull();
  });

  it("does not rehydrate a grant minted for a different project", async () => {
    (await freshModule()).setOverrideSigningGrant(makeGrant(nowS() + 3600), PID);
    vi.resetModules();
    const m2 = await freshModule();
    m2.restoreOverrideSigningGrant("some-other-project");
    expect(m2.hasOverrideSigningGrant()).toBe(false);
  });

  it("clearing the grant wipes sessionStorage (sign-out)", async () => {
    const m1 = await freshModule();
    m1.setOverrideSigningGrant(makeGrant(nowS() + 3600), PID);
    expect(sessionStorage.getItem("se_dt_grant")).toBeTruthy();
    m1.setOverrideSigningGrant(null, "");
    expect(sessionStorage.getItem("se_dt_grant")).toBeNull();
    expect(m1.hasOverrideSigningGrant()).toBe(false);
  });
});
