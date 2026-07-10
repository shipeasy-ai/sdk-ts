import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../client";
import { i18nRenderKeysOnly, isTestEnv, setI18nRenderKeysOnly } from "../env";

// `renderKeysOnly` makes i18n.t()/rich()/tEl() return the KEY instead of
// resolving its translated value, so tests assert against stable data. It
// defaults ON under env==test and OFF otherwise; an explicit config wins.
//
// NB: the global setup (setup.ts) forces SHIPEASY_ENV="production", so the
// env-derived default is OFF in this suite unless a test opts in.

const RENDER_KEYS_SYM = Symbol.for("@shipeasy/sdk:i18n-render-keys");

describe("i18n renderKeysOnly", () => {
  const original = { se: process.env.SHIPEASY_ENV, node: process.env.NODE_ENV };
  afterEach(() => {
    // Clear the process-wide override + restore env so tests don't bleed.
    delete (globalThis as Record<symbol, unknown>)[RENDER_KEYS_SYM];
    process.env.SHIPEASY_ENV = original.se;
    process.env.NODE_ENV = original.node;
  });

  it("isTestEnv() reads the native SHIPEASY_ENV / NODE_ENV", () => {
    process.env.SHIPEASY_ENV = "test";
    expect(isTestEnv()).toBe(true);
    process.env.SHIPEASY_ENV = "production";
    expect(isTestEnv()).toBe(false); // SHIPEASY_ENV wins over NODE_ENV
    delete process.env.SHIPEASY_ENV;
    process.env.NODE_ENV = "test";
    expect(isTestEnv()).toBe(true);
  });

  it("defaults ON under env==test and renders the key verbatim", () => {
    delete process.env.SHIPEASY_ENV;
    process.env.NODE_ENV = "test";
    expect(i18nRenderKeysOnly()).toBe(true);
    expect(i18n.t("checkout.cta", "Place order")).toBe("checkout.cta");
    // interpolation is skipped too — the bare key comes back
    expect(i18n.t("cart.count", "{{count}} items", { count: 3 })).toBe("cart.count");
    // key-only form is unchanged (already returns the key)
    expect(i18n.t("checkout.cta")).toBe("checkout.cta");
  });

  it("defaults OFF outside test and resolves the fallback", () => {
    process.env.SHIPEASY_ENV = "production";
    expect(i18nRenderKeysOnly()).toBe(false);
    expect(i18n.t("checkout.cta", "Place order")).toBe("Place order");
    expect(i18n.t("cart.count", "{{count}} items", { count: 3 })).toBe("3 items");
  });

  it("an explicit override wins over the env default in both directions", () => {
    process.env.SHIPEASY_ENV = "production";
    setI18nRenderKeysOnly(true);
    expect(i18n.t("checkout.cta", "Place order")).toBe("checkout.cta");

    process.env.SHIPEASY_ENV = "test";
    setI18nRenderKeysOnly(false);
    expect(i18n.t("checkout.cta", "Place order")).toBe("Place order");
  });

  it("i18n.configure({ renderKeysOnly }) toggles it", () => {
    process.env.SHIPEASY_ENV = "production";
    i18n.configure({ renderKeysOnly: true });
    expect(i18n.t("hero.title", "Welcome")).toBe("hero.title");
  });

  it("rich() and tEl() render the key too", () => {
    setI18nRenderKeysOnly(true);
    expect(i18n.rich("terms.line", "Accept the <a>terms</a>", { a: (t) => `[${t}]` })).toBe(
      "terms.line",
    );
    expect(i18n.tEl("checkout.cta", "Place order")).toBe("checkout.cta");
  });
});
