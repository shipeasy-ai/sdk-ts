// @vitest-environment jsdom
//
// Browser devtools — the URL-only override store (the codec the web overlay
// and the client SDK read the same params through) and the DevtoolsApi shim's
// window-event 401 contract over the shared core.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOverrideUrl,
  getConfigOverride,
  getExpOverride,
  getGateOverride,
  isDevtoolsRequested,
  snapshotOverridesFromStorage,
} from "../browser-devtools/overrides";
import { AuthError, DevtoolsApi, DEVTOOLS_UNAUTHED_EVENT } from "../browser-devtools/api";
import { scriptTagOrigin } from "../browser-devtools/index";

function setSearch(search: string): void {
  window.history.replaceState({}, "", `${window.location.pathname}${search}`);
}

function addScript(src: string): HTMLScriptElement {
  const s = document.createElement("script");
  s.src = src;
  document.head.appendChild(s);
  return s;
}

afterEach(() => {
  setSearch("");
  document.querySelectorAll("script[src]").forEach((s) => s.remove());
});

describe("URL override codec", () => {
  it("buildOverrideUrl composes params and strips stale se_* from the base", () => {
    const url = new URL(
      buildOverrideUrl(
        {
          gates: { new_checkout: true, legacy_flow: false },
          experiments: { pricing_test: "treatment" },
          configs: { "pricing.tiers": { tier: "pro" } },
          i18nProfile: "fr:prod",
          openDevtools: true,
        },
        "https://app.example.com/checkout?se_ks_old=true&keep=1",
      ),
    );
    expect(url.searchParams.get("se_ks_old")).toBeNull(); // stale override stripped
    expect(url.searchParams.get("keep")).toBe("1"); // non-se params survive
    expect(url.searchParams.get("se")).toBe("1");
    expect(url.searchParams.get("se_ks_new_checkout")).toBe("true");
    expect(url.searchParams.get("se_ks_legacy_flow")).toBe("false");
    expect(url.searchParams.get("se_exp_pricing_test")).toBe("treatment");
    expect(url.searchParams.get("se_config_pricing.tiers")).toBe('{"tier":"pro"}');
    expect(url.searchParams.get("se_i18n")).toBe("fr:prod");
  });

  it("round-trips large config values through the b64 encoding", () => {
    const big = { items: Array.from({ length: 10 }, (_, i) => `value-${i}`) };
    const url = new URL(buildOverrideUrl({ configs: { "big.config": big } }, "https://x.test/"));
    expect(url.searchParams.get("se_config_big.config")).toMatch(/^b64:/);

    setSearch(`?${url.searchParams.toString()}`);
    expect(getConfigOverride("big.config")).toEqual(big);
    expect(snapshotOverridesFromStorage().configs).toEqual({ "big.config": big });
  });

  it("readers accept canonical and legacy param spellings", () => {
    setSearch("?se_ks_a=true&se_gate_b=off&se-gate-c=1&se_exp_x=variant_b&se_exp_y=default");
    expect(getGateOverride("a")).toBe(true);
    expect(getGateOverride("b")).toBe(false);
    expect(getGateOverride("c")).toBe(true);
    expect(getGateOverride("missing")).toBeNull();
    expect(getExpOverride("x")).toBe("variant_b");
    expect(getExpOverride("y")).toBeNull(); // literal "default" clears
  });

  it("snapshot → buildOverrideUrl round-trips a whole session", () => {
    setSearch("?se_ks_a=true&se_exp_x=treatment&se_i18n=de:prod&se_i18n_label_hero.title=Hallo");
    const snap = snapshotOverridesFromStorage();
    expect(snap).toMatchObject({
      gates: { a: true },
      experiments: { x: "treatment" },
      i18nProfile: "de:prod",
      i18nLabels: { "hero.title": "Hallo" },
    });
    const rebuilt = new URL(buildOverrideUrl(snap, "https://other.test/page"));
    expect(rebuilt.searchParams.get("se_ks_a")).toBe("true");
    expect(rebuilt.searchParams.get("se_i18n_label_hero.title")).toBe("Hallo");
  });

  it("isDevtoolsRequested covers ?se, ?se-devtools and edit-labels mode", () => {
    expect(isDevtoolsRequested()).toBe(false);
    setSearch("?se=1");
    expect(isDevtoolsRequested()).toBe(true);
    setSearch("?se_edit_labels=1");
    expect(isDevtoolsRequested()).toBe(true);
  });
});

describe("scriptTagOrigin — default adminUrl resolution", () => {
  it("falls back to prod admin (not the CDN) when the bundle loads from cdn.shipeasy.ai", () => {
    // The overlay is served from the edge Worker's CDN, but /devtools-auth
    // lives only on the admin app. The CDN origin must not become the adminUrl.
    addScript("https://cdn.shipeasy.ai/se-devtools.js");
    expect(scriptTagOrigin()).toBe("https://shipeasy.ai");
  });

  it("uses a genuine non-local, non-CDN admin origin as-is (staging/self-host)", () => {
    addScript("https://admin.staging.example.com/se-devtools.js");
    expect(scriptTagOrigin()).toBe("https://admin.staging.example.com");
  });

  it("falls back to prod admin when the bundle loads from a local dev origin", () => {
    addScript("http://localhost:3000/se-devtools.js");
    expect(scriptTagOrigin()).toBe("https://shipeasy.ai");
  });
});

describe("DevtoolsApi shim", () => {
  it("dispatches the unauthed window event and rejects with AuthError on 401", async () => {
    const onEvent = vi.fn();
    window.addEventListener(DEVTOOLS_UNAUTHED_EVENT, onEvent);
    const api = new DevtoolsApi("https://admin.test", "stale", "proj_1");
    // Route every transport through a stub 401 — the generated client calls
    // fetch(Request), the raw helpers call fetch(url, init); both land here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 })),
    );
    try {
      await expect(api.gates()).rejects.toBeInstanceOf(AuthError);
      expect(onEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      window.removeEventListener(DEVTOOLS_UNAUTHED_EVENT, onEvent);
    }
  });

  it("keeps the overlay's constructor contract (adminUrl, token, hideAdminLinks)", () => {
    const api = new DevtoolsApi("https://admin.test/", "sdk_admin_x", "proj_1", true);
    expect(api.adminUrl).toBe("https://admin.test");
    expect(api.token).toBe("sdk_admin_x");
    expect(api.projectId).toBe("proj_1");
    expect(api.hideAdminLinks).toBe(true);
    api.hideAdminLinks = false; // mutable — the overlay refreshes the kill-switch flag
    expect(api.hideAdminLinks).toBe(false);
  });
});
