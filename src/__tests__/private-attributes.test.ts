import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Private attributes (doc 20 §5). Usable for targeting, never persisted.
// - Client: sent to /sdk/evaluate under `private_attributes`; stripped from track props.
// - Server: never leave for evaluation (local eval); stripped from track props.

describe("private attributes — server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("strips private keys from track() props but keeps the rest", async () => {
    vi.resetModules();
    const { Engine } = await import("../server/index");
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/collect") && init?.body) bodies.push(init.body as string);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
      }),
    );
    const client = new Engine({
      apiKey: "k",
      baseUrl: "http://x",
      disableTelemetry: true,
      privateAttributes: ["email", "ssn"],
    });
    client.track("u1", "purchase", { amount: 9, email: "a@b.com", ssn: "123" });
    expect(bodies).toHaveLength(1);
    const props = (JSON.parse(bodies[0]) as { events: { properties: Record<string, unknown> }[] })
      .events[0].properties;
    expect(props).toEqual({ amount: 9 });
    expect(props.email).toBeUndefined();
    expect(props.ssn).toBeUndefined();
  });
});

describe("private attributes — browser", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });
    vi.stubGlobal("crypto", { randomUUID: () => "test-anon-id" });
    vi.stubGlobal("setInterval", () => 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends private_attributes to /sdk/evaluate", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const evalBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/sdk/evaluate") && init?.body) evalBodies.push(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ flags: {}, configs: {}, experiments: {} }),
        } as Response);
      }),
    );
    const client = new BrowserEngine({
      sdkKey: "k",
      baseUrl: "http://x",
      privateAttributes: ["plan", "email"],
    });
    await client.identify({ user_id: "u1", plan: "pro", email: "a@b.com" });
    expect(evalBodies).toHaveLength(1);
    const body = JSON.parse(evalBodies[0]) as {
      user: Record<string, unknown>;
      private_attributes?: string[];
    };
    // The attrs DO reach the edge (it evaluates) ...
    expect(body.user.plan).toBe("pro");
    // ... flagged as private so the worker won't persist them.
    expect(body.private_attributes).toEqual(["plan", "email"]);
  });

  it("strips private keys from track() props", async () => {
    vi.resetModules();
    const { Engine: BrowserEngine } = await import("../client/index");
    const collectBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/collect") && init?.body) collectBodies.push(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ flags: {}, configs: {}, experiments: {} }),
        } as Response);
      }),
    );
    const client = new BrowserEngine({
      sdkKey: "k",
      baseUrl: "http://x",
      privateAttributes: ["email"],
    });
    await client.identify({ user_id: "u1" });
    client.track("signup", { source: "hero", email: "a@b.com" });
    await client.flush();
    const metricBody = collectBodies
      .map((b) => JSON.parse(b) as { events: { type: string; properties?: Record<string, unknown> }[] })
      .flatMap((b) => b.events)
      .find((e) => e.type === "metric" && e.properties && "source" in e.properties);
    expect(metricBody?.properties).toEqual({ source: "hero" });
    expect(metricBody?.properties?.email).toBeUndefined();
  });
});
