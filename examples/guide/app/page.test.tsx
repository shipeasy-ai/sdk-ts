import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  clearOverrides,
  configureForTesting,
} from "@shipeasy/sdk/server";

import Page from "./page";

/*
 * This test drives the example through the SDK's TESTING setup — no network,
 * no SDK key. `configureForTesting()` seeds every value Shipeasy would return,
 * so the three entity kinds the testing API supports are fully mocked:
 *
 *   - feature flag   `new_checkout`     → true
 *   - dynamic config `billing_copy`     → { headline, cta }
 *   - experiment     `checkout_button`  → ["treatment", { color, label }]
 *
 * The config/experiment values below are DISTINCTIVE sentinels that do NOT
 * appear anywhere in the current placeholder page (app/entities.ts). That is
 * deliberate: it makes the page-render assertions a genuine test of "the
 * rendered HTML reflects what shipeasy returned", instead of coincidentally
 * matching a hardcoded placeholder string.
 *
 * NOTE: the example page (app/page.tsx) currently renders placeholder constants
 * from app/entities.ts and is NOT wired to the SDK, so these seeded values do
 * NOT appear in the HTML yet. The page-render value-containment assertions are
 * therefore EXPECTED to FAIL until the example is wired up. Everything else —
 * the network-free testing setup, the seeded reads (proven by the independent
 * Client read-back case, which passes), and rendering the server component to
 * an HTML string — works today.
 */

const MOCK_FLAG_NEW_CHECKOUT = true;

const MOCK_CONFIG_BILLING_COPY = {
  headline: "Welcome aboard 🚀",
  cta: "Start free trial",
};

const MOCK_EXPERIMENT_CHECKOUT_BUTTON: [string, Record<string, unknown>] = [
  "treatment",
  { color: "#0ea5e9", label: "Checkout now" },
];

afterEach(() => {
  // Reset every seeded override back to the empty-blob default between cases.
  clearOverrides();
});

describe("guide page rendered with mocked Shipeasy values", () => {
  it("seeds the SDK with no network and reads the mocked values back", () => {
    configureForTesting({
      flags: { new_checkout: MOCK_FLAG_NEW_CHECKOUT },
      configs: { billing_copy: MOCK_CONFIG_BILLING_COPY },
      experiments: { checkout_button: MOCK_EXPERIMENT_CHECKOUT_BUTTON },
    });

    // Sanity-check the testing seam itself: the seeded values come back through
    // the ordinary user-bound Client, entirely in-process.
    const client = new Client({ user_id: "u_123" });
    expect(client.getFlag("new_checkout")).toBe(true);
    expect(client.getConfig("billing_copy")).toEqual(MOCK_CONFIG_BILLING_COPY);
    expect(client.getExperiment("checkout_button", { color: "#888", label: "Buy" })).toEqual({
      inExperiment: true,
      group: "treatment",
      params: { color: "#0ea5e9", label: "Checkout now" },
    });
  });

  it("renders the page to HTML and contains each mocked value", async () => {
    configureForTesting({
      flags: { new_checkout: MOCK_FLAG_NEW_CHECKOUT },
      configs: { billing_copy: MOCK_CONFIG_BILLING_COPY },
      experiments: { checkout_button: MOCK_EXPERIMENT_CHECKOUT_BUTTON },
    });

    // page.tsx default export is an async server component returning JSX —
    // await it, then render the element tree to a static HTML string.
    const html = renderToStaticMarkup(await Page());

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);

    // The mocked feature flag value.
    expect(html).toContain("new_checkout");

    // The mocked dynamic config values.
    expect(html).toContain(MOCK_CONFIG_BILLING_COPY.headline);
    expect(html).toContain(MOCK_CONFIG_BILLING_COPY.cta);

    // The mocked experiment group + params.
    expect(html).toContain(MOCK_EXPERIMENT_CHECKOUT_BUTTON[0]); // "treatment"
    expect(html).toContain(MOCK_EXPERIMENT_CHECKOUT_BUTTON[1].color as string);
    expect(html).toContain(MOCK_EXPERIMENT_CHECKOUT_BUTTON[1].label as string);
  });
});
