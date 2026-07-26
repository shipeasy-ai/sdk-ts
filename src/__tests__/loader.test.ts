/**
 * @vitest-environment jsdom
 *
 * The drop-in <script>-tag loader (src/loader.ts) — the integration path for
 * customers with no build step. These specs lock the shape of the
 * `window.shipeasy` global and, more importantly, the wiring underneath it.
 *
 * The loader must configure through `shipeasy({ clientKey })`, NOT
 * `new Engine(...)`: `see()` reports through the module singleton that only the
 * former sets, so a directly-constructed Engine leaves every error report
 * warning "see() called before shipeasy({ clientKey })" and silently dropped.
 * That failure is invisible at runtime — nothing throws, the errors just never
 * arrive — so it gets a test.
 */

import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from "vitest";

import type { Assignment } from "../client";

const KEY = "sdk_client_loader_test";

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Boot a fresh loader against a tag carrying `attrs`, and hand back the client
 * module *from the same registry the loader just used*. `vi.resetModules()`
 * gives the dynamic import its own copy of ../client — asserting on a
 * statically-imported `getShipeasyClient` would read a different singleton and
 * always see null.
 */
async function bootLoader(attrs: Record<string, string> = {}) {
  const script = document.createElement("script");
  script.dataset.sdkKey = KEY;
  script.dataset.baseUrl = "https://edge.test";
  for (const [k, v] of Object.entries(attrs)) script.dataset[k] = v;
  document.head.appendChild(script);

  vi.resetModules();
  await import("../loader");
  return await import("../client");
}

beforeEach(() => {
  // Every read resolves from an empty-but-valid evaluate payload.
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ flags: {}, configs: {}, experiments: {}, killswitches: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete (window as { shipeasy?: unknown }).shipeasy;
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("loader.js — window.shipeasy surface", () => {
  it("exposes the full read surface, including getKillswitch and see", async () => {
    await bootLoader();

    const g = window.shipeasy!;
    expect(typeof g.getFlag).toBe("function");
    expect(typeof g.getConfig).toBe("function");
    expect(typeof g.getKillswitch).toBe("function");
    expect(typeof g.universe).toBe("function");
    expect(typeof g.identify).toBe("function");
    expect(typeof g.track).toBe("function");
    expect(g.ready).toBeInstanceOf(Promise);
  });

  it("exposes the whole see() grammar, not just the callable", async () => {
    await bootLoader();

    const { see } = window.shipeasy!;
    expect(typeof see).toBe("function");
    expect(typeof see.Violation).toBe("function");
    expect(typeof see.ControlFlowException).toBe("function");
  });

  // The regression that motivated routing through shipeasy(): see() dispatches
  // through the module singleton. `new Engine(...)` never sets it, so this is
  // the assertion that would fail if the loader went back to constructing one.
  it("configures the singleton so see() has a client to report through", async () => {
    const { getShipeasyClient } = await bootLoader();

    expect(getShipeasyClient()).not.toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.shipeasy!.see(new Error("boom")).causes_the("checkout").to("fail");
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("see() called before shipeasy({ clientKey })"),
    );
    warn.mockRestore();
  });

  it("reads the user off the tag's data-* attributes", async () => {
    await bootLoader({ userId: "u-1", userPlan: "pro", attrs: JSON.stringify({ country: "US" }) });
    await window.shipeasy!.ready;

    const evaluateCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/sdk/evaluate"),
    );
    const body = JSON.parse((evaluateCall![1] as RequestInit).body as string) as {
      user?: Record<string, unknown>;
    };
    expect(body.user).toMatchObject({ user_id: "u-1", plan: "pro", country: "US" });
  });

  it("bails with a warning when data-sdk-key is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const script = document.createElement("script");
    document.head.appendChild(script);

    vi.resetModules();
    await import("../loader");

    expect(window.shipeasy).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing data-sdk-key"));
    warn.mockRestore();
  });
});

describe("universe<P>() — typed param shape", () => {
  it("types .get() from the supplied shape and still allows an untyped read", async () => {
    await bootLoader();

    interface CheckoutParams {
      button_color: string;
      discount: number;
    }

    const typed = window.shipeasy!.universe<CheckoutParams>("checkout").assign();
    expectTypeOf(typed.get("button_color")).toEqualTypeOf<string | undefined>();
    expectTypeOf(typed.get("discount")).toEqualTypeOf<number | undefined>();
    // @ts-expect-error — "colour" is not a field of CheckoutParams
    typed.get("colour");

    // No shape supplied: any field name, value stays unknown (pre-existing behaviour).
    const untyped = window.shipeasy!.universe("checkout").assign();
    expectTypeOf(untyped).toEqualTypeOf<Assignment<Record<string, unknown>>>();
    expectTypeOf(untyped.get("anything")).toEqualTypeOf<unknown>();
  });
});
