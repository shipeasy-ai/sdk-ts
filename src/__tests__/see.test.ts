import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSeeEvent,
  causesThe,
  isExpected,
  isViolation,
  markExpected,
  sanitizeExtras,
  SeeLimiter,
  SEE_MAX_EXTRA_KEYS,
  SEE_MAX_MESSAGE,
  SEE_MAX_STACK,
  startSeeChain,
  startSeeViolationChain,
  violation,
  type Consequence,
  type SeeContext,
  type SeeExtras,
} from "../see/core";

/** Flush the microtask queue so scheduled see-chain dispatches run. */
const tick = () => Promise.resolve();

const CTX: SeeContext = { side: "client", sdkVersion: "4.0.0", env: "prod" };

describe("causesThe builder", () => {
  it("builds a branded consequence with subject + outcome", () => {
    const c = causesThe("checkout").to("use cached prices");
    expect(c.__seConsequence).toBe(true);
    expect(c.subject).toBe("checkout");
    expect(c.outcome).toBe("use cached prices");
  });

  it("truncates oversized subject/outcome", () => {
    const c = causesThe("x".repeat(500)).to("y".repeat(500));
    expect(c.subject.length).toBe(200);
    expect(c.outcome.length).toBe(200);
  });
});

describe("violation builder", () => {
  it("builds a branded violation; message() returns a new violation", () => {
    const v = violation("large query");
    expect(v.__seViolation).toBe(true);
    expect(v.violationName).toBe("large query");
    expect(v.violationMessage).toBeUndefined();
    const w = v.message("got 5000 rows");
    expect(w.violationName).toBe("large query");
    expect(w.violationMessage).toBe("got 5000 rows");
    // original unchanged (builder is immutable)
    expect(v.violationMessage).toBeUndefined();
  });
});

describe("sanitizeExtras", () => {
  it("drops nullish values and keeps string/number/boolean", () => {
    expect(
      sanitizeExtras({ a: "x", b: 1, c: true, d: null, e: undefined }),
    ).toEqual({ a: "x", b: 1, c: true });
  });

  it("truncates long string values", () => {
    const out = sanitizeExtras({ a: "x".repeat(1000) })!;
    expect((out.a as string).length).toBe(200);
  });

  it("drops non-finite numbers", () => {
    expect(sanitizeExtras({ a: Infinity, b: NaN, c: 2 })).toEqual({ c: 2 });
  });

  it("caps the key count", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = i;
    const out = sanitizeExtras(big)!;
    expect(Object.keys(out).length).toBe(SEE_MAX_EXTRA_KEYS);
  });

  it("returns undefined for empty/all-nullish input", () => {
    expect(sanitizeExtras(undefined)).toBeUndefined();
    expect(sanitizeExtras({})).toBeUndefined();
    expect(sanitizeExtras({ a: null })).toBeUndefined();
  });
});

describe("buildSeeEvent", () => {
  it("maps an Error to kind=caught with name/message/stack", () => {
    const err = new TypeError("x is not a function");
    const ev = buildSeeEvent(err, causesThe("checkout").to("fail to load"), undefined, CTX);
    expect(ev.type).toBe("error");
    expect(ev.kind).toBe("caught");
    expect(ev.error_type).toBe("TypeError");
    expect(ev.message).toBe("x is not a function");
    expect(ev.stack).toBeTruthy();
    expect(ev.subject).toBe("checkout");
    expect(ev.outcome).toBe("fail to load");
    expect(ev.side).toBe("client");
    expect(ev.env).toBe("prod");
    expect(ev.sdk_version).toBe("4.0.0");
    expect(typeof ev.ts).toBe("number");
  });

  it("maps a violation to kind=violation; name becomes error_type", () => {
    const ev = buildSeeEvent(
      violation("large query").message("got 5000 rows"),
      causesThe("results").to("be trimmed"),
      undefined,
      CTX,
    );
    expect(ev.kind).toBe("violation");
    expect(ev.error_type).toBe("large query");
    expect(ev.message).toBe("got 5000 rows");
  });

  it("violation without message falls back to the name", () => {
    const ev = buildSeeEvent(violation("oops"), causesThe("a").to("b"), undefined, CTX);
    expect(ev.message).toBe("oops");
  });

  it("handles thrown non-Errors (string)", () => {
    const ev = buildSeeEvent("plain string throw", causesThe("a").to("b"), undefined, CTX);
    expect(ev.error_type).toBe("Error");
    expect(ev.message).toBe("plain string throw");
  });

  it("kind override wins (auto-capture paths)", () => {
    const ev = buildSeeEvent(new Error("boom"), causesThe("a").to("b"), undefined, CTX, "uncaught");
    expect(ev.kind).toBe("uncaught");
  });

  it("clamps message and stack", () => {
    const err = new Error("m".repeat(10_000));
    err.stack = "s".repeat(100_000);
    const ev = buildSeeEvent(err, causesThe("a").to("b"), undefined, CTX);
    expect(ev.message.length).toBe(SEE_MAX_MESSAGE);
    expect(ev.stack!.length).toBe(SEE_MAX_STACK);
  });

  it("attaches sanitized extras and context fields", () => {
    const ev = buildSeeEvent(new Error("x"), causesThe("a").to("b"), { id: "1", skip: null }, {
      ...CTX,
      url: "https://app.example.com/checkout",
      userId: "u1",
      anonId: "anon1",
    });
    expect(ev.extras).toEqual({ id: "1" });
    expect(ev.url).toBe("https://app.example.com/checkout");
    expect(ev.user_id).toBe("u1");
    expect(ev.anonymous_id).toBe("anon1");
  });
});

describe("see chain (startSeeChain / startSeeViolationChain)", () => {
  type Dispatched = {
    problem: unknown;
    consequence: Consequence;
    extras: SeeExtras | undefined;
  };

  function collect() {
    const calls: Dispatched[] = [];
    const dispatch = (problem: unknown, consequence: Consequence, extras?: SeeExtras) => {
      calls.push({ problem, consequence, extras });
    };
    return { calls, dispatch };
  }

  it("dispatches once on the next microtask with subject/outcome/extras", async () => {
    const { calls, dispatch } = collect();
    const err = new Error("boom");
    startSeeChain(() => err, dispatch)
      .causes_the("checkout")
      .to("use cached prices")
      .extras({ order_id: "o1" });
    expect(calls).toHaveLength(0); // not yet — microtask
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].problem).toBe(err);
    expect(calls[0].consequence.subject).toBe("checkout");
    expect(calls[0].consequence.outcome).toBe("use cached prices");
    expect(calls[0].extras).toEqual({ order_id: "o1" });
  });

  it("supports the camelCase alias and merges repeated extras()", async () => {
    const { calls, dispatch } = collect();
    startSeeChain(() => "p", dispatch)
      .causesThe("a")
      .to("b")
      .extras({ x: 1 })
      .extras({ y: 2, x: 3 });
    await tick();
    expect(calls[0].extras).toEqual({ x: 3, y: 2 });
  });

  it("an abandoned chain still dispatches with default consequence", async () => {
    const { calls, dispatch } = collect();
    startSeeChain(() => "p", dispatch);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].consequence.subject).toBe("the app");
    expect(calls[0].consequence.outcome).toBe("hit an error");
  });

  it("violation chain builds the violation lazily with message()", async () => {
    const { calls, dispatch } = collect();
    startSeeViolationChain("large query", dispatch)
      .message("got 5000 rows")
      .causes_the("results")
      .to("be trimmed");
    await tick();
    expect(calls).toHaveLength(1);
    const v = calls[0].problem;
    expect(isViolation(v)).toBe(true);
    expect((v as { violationName: string }).violationName).toBe("large query");
    expect((v as { violationMessage?: string }).violationMessage).toBe("got 5000 rows");
    expect(calls[0].consequence.subject).toBe("results");
  });
});

describe("markExpected / isExpected", () => {
  it("marks an error as expected without enumerable side effects", () => {
    const err = new Error("not really a problem");
    expect(isExpected(err)).toBe(false);
    markExpected(err, "because it wasn't an encoded Foo");
    expect(isExpected(err)).toBe(true);
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify(err)).toBe("{}");
  });

  it("tolerates non-object reasons", () => {
    expect(() => markExpected("a string", "because")).not.toThrow();
    expect(isExpected("a string")).toBe(false);
    expect(isExpected(null)).toBe(false);
  });
});

describe("SeeLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function ev(message: string) {
    return buildSeeEvent(new Error(message), causesThe("a").to("b"), undefined, CTX);
  }

  it("dedupes identical errors within the window, allows after it", () => {
    const lim = new SeeLimiter();
    expect(lim.shouldSend(ev("same"))).toBe(true);
    expect(lim.shouldSend(ev("same"))).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(lim.shouldSend(ev("same"))).toBe(true);
  });

  it("distinct errors pass independently", () => {
    const lim = new SeeLimiter();
    expect(lim.shouldSend(ev("one"))).toBe(true);
    expect(lim.shouldSend(ev("two"))).toBe(true);
  });

  it("hard-caps total sends per session", () => {
    const lim = new SeeLimiter(3, 0);
    expect(lim.shouldSend(ev("a"))).toBe(true);
    expect(lim.shouldSend(ev("b"))).toBe(true);
    expect(lim.shouldSend(ev("c"))).toBe(true);
    expect(lim.shouldSend(ev("d"))).toBe(false);
  });
});

// ---- client facade + auto-capture wiring (browser-ish environment mocks) ----

describe("client see() wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function bootClient() {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ flags: {}, configs: {}, experiments: {} }),
    });
    vi.stubGlobal("navigator", { sendBeacon, language: "en-US" });
    vi.stubGlobal("fetch", fetchMock);
    // localStorage/sessionStorage minimal stubs
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal("localStorage", fakeStorage);
    vi.stubGlobal("sessionStorage", fakeStorage);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      visibilityState: "visible",
      referrer: "",
      readyState: "complete",
      head: null,
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      location: { pathname: "/x", search: "", href: "https://app.test/x" },
      onerror: null,
      fetch: fetchMock,
    });
    const mod = await import("../client/index");
    mod._resetShipeasyForTests();
    const client = mod.configureShipeasy({ sdkKey: "ck_test", baseUrl: "https://edge.test" });
    return { mod, client, sendBeacon, fetchMock };
  }

  it("see() chain sends a type:error event via beacon with body key", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod
      .see(new TypeError("boom"))
      .causes_the("checkout")
      .to("use cached prices")
      .extras({ order_id: "o1" });
    expect(sendBeacon).not.toHaveBeenCalled(); // dispatches on the next microtask
    await tick();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe("https://edge.test/collect");
    const body = JSON.parse(await (blob as Blob).text());
    expect(body.k).toBe("ck_test");
    expect(body.events).toHaveLength(1);
    const ev = body.events[0];
    expect(ev.type).toBe("error");
    expect(ev.kind).toBe("caught");
    expect(ev.error_type).toBe("TypeError");
    expect(ev.subject).toBe("checkout");
    expect(ev.outcome).toBe("use cached prices");
    expect(ev.extras).toEqual({ order_id: "o1" });
    expect(ev.side).toBe("client");
  });

  it("see.Violation() chain reports kind=violation", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod.see
      .Violation("large query")
      .message("got 5000 rows")
      .causes_the("results")
      .to("be trimmed");
    await tick();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text());
    const ev = body.events[0];
    expect(ev.kind).toBe("violation");
    expect(ev.error_type).toBe("large query");
    expect(ev.message).toBe("got 5000 rows");
  });

  it("see() before configure warns and drops", async () => {
    vi.stubGlobal("window", undefined);
    const mod = await import("../client/index");
    mod._resetShipeasyForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => mod.see(new Error("x")).causes_the("a").to("b")).not.toThrow();
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("see() called before"));
  });

  it("identical see() calls within the dedup window collapse to one send", async () => {
    const { mod, sendBeacon } = await bootClient();
    const err = new Error("repeat");
    mod.see(err).causes_the("a").to("b");
    mod.see(err).causes_the("a").to("b");
    await tick();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("auto-capture: window.onerror reports kind=uncaught and skips control-flow errors", async () => {
    const { mod, client, sendBeacon } = await bootClient();
    await client.identify({});
    const w = globalThis.window as unknown as {
      onerror: (m: unknown, s?: string, l?: number, c?: number, e?: Error) => boolean;
    };
    expect(typeof w.onerror).toBe("function");

    const expected = new Error("expected control flow");
    mod.see.ControlFlowException(expected, "because tests say so");
    w.onerror("msg", "app.js", 1, 1, expected);
    expect(sendBeacon).not.toHaveBeenCalled();

    w.onerror("Uncaught TypeError: nope", "app.js", 42, 1, new TypeError("nope"));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text());
    const ev = body.events[0];
    expect(ev.type).toBe("error");
    expect(ev.kind).toBe("uncaught");
    expect(ev.error_type).toBe("TypeError");
    expect(ev.subject).toBe("the page");
    expect(ev.extras).toMatchObject({ source: "app.js", line: 42 });
  });

  it("auto-capture: fetch 5xx reports kind=network but skips the collector itself", async () => {
    const { client, sendBeacon, fetchMock } = await bootClient();
    await client.identify({});
    const w = globalThis.window as unknown as { fetch: typeof fetch };
    expect(w.fetch).not.toBe(fetchMock); // wrapped

    // 5xx from a product URL → reported
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() });
    await w.fetch("https://api.test/orders?id=123");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text());
    const ev = body.events[0];
    expect(ev.kind).toBe("network");
    expect(ev.error_type).toBe("Http5xx");
    expect(ev.message).toContain("https://api.test/orders"); // querystring stripped
    expect(ev.message).not.toContain("id=123");
    expect(ev.extras).toMatchObject({ status: 503 });

    // 5xx from the SDK's own collector → ignored
    sendBeacon.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() });
    await w.fetch("https://edge.test/collect");
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

// ---- server facade ----

describe("server see() wiring", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("see() chain posts a single-event batch to /collect with the server key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({
      apiKey: "sk_test",
      baseUrl: "https://edge.test",
      disableTelemetry: true,
    });
    mod
      .see(new RangeError("out of range"))
      .causes_the("report")
      .to("render empty")
      .extras({ rows: 0 });
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://edge.test/collect");
    expect(init.headers["X-SDK-Key"]).toBe("sk_test");
    expect(init.headers["Content-Type"]).toBe("text/plain");
    const body = JSON.parse(init.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      type: "error",
      kind: "caught",
      error_type: "RangeError",
      subject: "report",
      outcome: "render empty",
      side: "server",
      extras: { rows: 0 },
    });
    mod._resetShipeasyServerForTests();
  });

  it("see.Violation() works without a consequence (defaults applied)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({
      apiKey: "sk_test",
      baseUrl: "https://edge.test",
      disableTelemetry: true,
    });
    mod.see.Violation("orphan rows");
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      kind: "violation",
      error_type: "orphan rows",
      subject: "the app",
      outcome: "hit an error",
    });
    mod._resetShipeasyServerForTests();
  });

  it("see() before configure warns and drops", async () => {
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => mod.see(new Error("x")).causes_the("a").to("b")).not.toThrow();
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("see() called before"));
  });
});
