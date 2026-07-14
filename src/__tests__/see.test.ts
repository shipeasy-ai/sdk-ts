import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSeeEvent,
  causesThe,
  createObjectExtrasStore,
  findCausedBy,
  findCorrelation,
  isExpected,
  isViolation,
  markCorrelated,
  markExpected,
  markReported,
  mergeAmbientExtras,
  sanitizeExtras,
  SeeLimiter,
  SEE_MAX_EXTRA_KEYS,
  SEE_MAX_MESSAGE,
  SEE_MAX_STACK,
  startControlFlowChain,
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
  it("builds a branded violation from the name (no message — context goes in extras)", () => {
    const v = violation("large query");
    expect(v.__seViolation).toBe(true);
    expect(v.violationName).toBe("large query");
    expect((v as unknown as Record<string, unknown>).violationMessage).toBeUndefined();
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

  it("maps a violation to kind=violation; name becomes both error_type and message", () => {
    const ev = buildSeeEvent(
      violation("large query"),
      causesThe("results").to("be trimmed"),
      undefined,
      CTX,
    );
    expect(ev.kind).toBe("violation");
    expect(ev.error_type).toBe("large query");
    expect(ev.message).toBe("large query");
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

  it("attaches a correlation id when passed, omits it otherwise", () => {
    const withId = buildSeeEvent(
      new Error("x"),
      causesThe("a").to("b"),
      undefined,
      CTX,
      undefined,
      "corr-abc-123",
    );
    expect(withId.correlation_id).toBe("corr-abc-123");
    const withoutId = buildSeeEvent(new Error("x"), causesThe("a").to("b"), undefined, CTX);
    expect(withoutId.correlation_id).toBeUndefined();
  });
});

describe("caused-by linkage (findCausedBy / markReported / buildSeeEvent)", () => {
  const build = (problem: unknown) =>
    buildSeeEvent(problem, causesThe("checkout").to("use cached prices"), undefined, CTX);

  it("a first report has no caused_by", () => {
    expect(build(new Error("boom")).caused_by).toBeUndefined();
  });

  it("re-throw: reporting the SAME error twice links the second to the first", () => {
    const err = new TypeError("x is not a function");
    const first = buildSeeEvent(err, causesThe("friend request").to("not be sent"), undefined, CTX);
    expect(first.caused_by).toBeUndefined();
    // Same object caught + reported again at an outer boundary, different consequence.
    const second = buildSeeEvent(err, causesThe("checkout").to("fail to load"), undefined, CTX);
    expect(second.caused_by).toEqual({
      error_type: "TypeError",
      message: "x is not a function",
      stack: first.stack,
      subject: "friend request",
      outcome: "not be sent",
    });
  });

  it("wrap: an outer error carrying { cause } links to the reported inner cause", () => {
    const inner = new Error("db down");
    build(inner); // inner boundary reports + stamps it
    const outer = new Error("request failed", { cause: inner });
    const ev = build(outer);
    expect(ev.caused_by).toMatchObject({ error_type: "Error", message: "db down" });
  });

  it("does not link to an unreported inner cause (Example 4 wrap-without-see)", () => {
    const inner = new Error("db down"); // never see()'d
    const outer = new Error("request failed", { cause: inner });
    expect(build(outer).caused_by).toBeUndefined();
  });

  it("walks a multi-level cause chain to the nearest reported ancestor", () => {
    const root = new Error("root");
    build(root);
    const mid = new Error("mid", { cause: root });
    const top = new Error("top", { cause: mid });
    // mid was never reported; the link reaches root through it.
    expect(build(top).caused_by).toMatchObject({ message: "root" });
  });

  it("last-write-wins: each layer links to its nearest cause", () => {
    const err = new Error("e");
    const a = buildSeeEvent(err, causesThe("layer-a").to("x"), undefined, CTX); // stamp = a
    const b = buildSeeEvent(err, causesThe("layer-b").to("y"), undefined, CTX); // links a, stamp = b
    const c = buildSeeEvent(err, causesThe("layer-c").to("z"), undefined, CTX); // links b
    expect(a.caused_by).toBeUndefined();
    expect(b.caused_by).toMatchObject({ subject: "layer-a" });
    expect(c.caused_by).toMatchObject({ subject: "layer-b" });
  });

  it("tolerates a cyclic cause chain without hanging", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => findCausedBy(a)).not.toThrow();
    expect(findCausedBy(a)).toBeUndefined();
  });

  it("markReported stamps non-enumerably and skips non-Error problems", () => {
    const err = new Error("e");
    const ev = build(err);
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify(err)).toBe("{}");
    expect(findCausedBy(err)).toMatchObject({ subject: "checkout" });
    // non-Error problems leave no stamp (nothing to re-throw)
    expect(() => markReported("a string", ev)).not.toThrow();
    expect(findCausedBy("a string")).toBeUndefined();
  });

  it("does not link a violation to an unrelated reported error", () => {
    const ev = buildSeeEvent(violation("large query"), causesThe("a").to("b"), undefined, CTX);
    expect(ev.caused_by).toBeUndefined();
  });
});

describe("correlation linkage (findCorrelation / markCorrelated / buildSeeEvent)", () => {
  it("picks up a token stamped on the problem when none is passed", () => {
    const err = new Error("HTTP 500");
    markCorrelated(err, "corr-xyz");
    const ev = buildSeeEvent(err, causesThe("metric chart").to("show no data"), undefined, CTX);
    expect(ev.correlation_id).toBe("corr-xyz");
  });

  it("walks the .cause chain (the { cause: res } pattern)", () => {
    const res = {}; // stands in for a failing Response the fetch wrapper stamped
    markCorrelated(res, "corr-from-response");
    const err = new Error("HTTP 502", { cause: res });
    const ev = buildSeeEvent(err, causesThe("checkout").to("stall"), undefined, CTX);
    expect(ev.correlation_id).toBe("corr-from-response");
  });

  it("an explicit token wins over a stamped one", () => {
    const err = new Error("boom");
    markCorrelated(err, "stamped");
    const ev = buildSeeEvent(err, causesThe("a").to("b"), undefined, CTX, undefined, "explicit");
    expect(ev.correlation_id).toBe("explicit");
  });

  it("stamps non-enumerably and no-ops on non-objects", () => {
    const err = new Error("e");
    markCorrelated(err, "c");
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify(err)).toBe("{}");
    expect(() => markCorrelated("a string", "c")).not.toThrow();
    expect(findCorrelation("a string")).toBeUndefined();
    expect(findCorrelation(new Error("no stamp"))).toBeUndefined();
  });

  it("is cycle-safe on a self-referential cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(() => findCorrelation(a)).not.toThrow();
    expect(findCorrelation(a)).toBeUndefined();
  });

  it("walks axios-shape .request and .response.request (no .cause link)", () => {
    // XHR-based clients (axios) don't chain via `.cause` — the stamped
    // XMLHttpRequest hangs off `.request` and `.response.request` instead.
    const xhr1 = {}; // stands in for the XMLHttpRequest the XHR wrapper stamped
    markCorrelated(xhr1, "via-request");
    const e1 = Object.assign(new Error("Request failed with status code 502"), { request: xhr1 });
    expect(findCorrelation(e1)).toBe("via-request");

    const xhr2 = {};
    markCorrelated(xhr2, "via-response-request");
    const e2 = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, request: xhr2 },
    });
    const ev = buildSeeEvent(e2, causesThe("orders").to("be empty"), undefined, CTX);
    expect(ev.correlation_id).toBe("via-response-request");
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

  it("supports inline extras on .to(outcome, extras)", async () => {
    const { calls, dispatch } = collect();
    startSeeChain(() => "p", dispatch).causes_the("checkout").to("use cached prices", {
      order_id: "o1",
    });
    await tick();
    expect(calls[0].consequence.outcome).toBe("use cached prices");
    expect(calls[0].extras).toEqual({ order_id: "o1" });
  });

  it(".to(outcome, extras) merges with a trailing .extras() (later wins)", async () => {
    const { calls, dispatch } = collect();
    startSeeChain(() => "p", dispatch)
      .causes_the("a")
      .to("b", { x: 1, y: 2 })
      .extras({ y: 3, z: 4 });
    await tick();
    expect(calls[0].extras).toEqual({ x: 1, y: 3, z: 4 });
  });

  it("an abandoned chain still dispatches with default consequence", async () => {
    const { calls, dispatch } = collect();
    startSeeChain(() => "p", dispatch);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].consequence.subject).toBe("app");
    expect(calls[0].consequence.outcome).toBe("hit an error");
  });

  it("violation chain builds the violation lazily; context rides in extras", async () => {
    const { calls, dispatch } = collect();
    startSeeViolationChain("large query", dispatch)
      .causes_the("results")
      .to("be trimmed")
      .extras({ rows: 5000 });
    await tick();
    expect(calls).toHaveLength(1);
    const v = calls[0].problem;
    expect(isViolation(v)).toBe(true);
    expect((v as { violationName: string }).violationName).toBe("large query");
    expect(calls[0].consequence.subject).toBe("results");
    expect(calls[0].extras).toEqual({ rows: 5000 });
  });
});

describe("ambient extras (createObjectExtrasStore / mergeAmbientExtras)", () => {
  it("add() accumulates and current() snapshots; clear() empties", () => {
    const store = createObjectExtrasStore();
    expect(store.current()).toBeUndefined();
    store.add({ a: 1 });
    store.add({ b: 2, a: 3 }); // later wins on a collision
    expect(store.current()).toEqual({ a: 3, b: 2 });
    // current() returns a copy — mutating it doesn't corrupt the buffer
    const snap = store.current()!;
    (snap as Record<string, unknown>).a = 99;
    expect(store.current()).toEqual({ a: 3, b: 2 });
    store.clear();
    expect(store.current()).toBeUndefined();
  });

  it("mergeAmbientExtras folds ambient UNDER chain extras (chain wins)", () => {
    expect(mergeAmbientExtras({ a: 1, b: 2 }, { b: 9, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("mergeAmbientExtras returns the chain extras unchanged when ambient is empty", () => {
    const chain = { a: 1 };
    expect(mergeAmbientExtras(chain, undefined)).toBe(chain);
    expect(mergeAmbientExtras(chain, {})).toBe(chain);
  });

  it("mergeAmbientExtras returns ambient when the chain has none", () => {
    const ambient = { a: 1 };
    expect(mergeAmbientExtras(undefined, ambient)).toBe(ambient);
    expect(mergeAmbientExtras({}, ambient)).toBe(ambient);
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

  it("carries optional extras on the mark without enumerable side effects", () => {
    const err = new Error("x");
    markExpected(err, "because it wasn't a Foo", { tried: "Foo", bytes: 12 });
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

describe("startControlFlowChain", () => {
  it("because() marks the error expected; the chain stays non-enumerable", () => {
    const err = new Error("not really a problem");
    expect(isExpected(err)).toBe(false);
    startControlFlowChain(err).because("because it wasn't an encoded Foo");
    expect(isExpected(err)).toBe(true);
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify(err)).toBe("{}");
  });

  it("supports the optional .extras() tail and reports nothing", () => {
    const err = new Error("x");
    expect(() =>
      startControlFlowChain(err).because("because the blob wasn't a Foo").extras({ tried: "Foo" }),
    ).not.toThrow();
    expect(isExpected(err)).toBe(true);
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
    // The developer's own extras survive...
    expect(ev.extras).toMatchObject({ order_id: "o1" });
    // ...alongside the auto-collected, namespaced environment context.
    expect(ev.extras["env.device"]).toBe("desktop");
    expect(ev.extras["env.lang"]).toBe("en-US");
    expect(ev.side).toBe("client");
  });

  it("see.Violation() chain reports kind=violation; context rides in extras", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod.see
      .Violation("large query")
      .causes_the("results")
      .to("be trimmed")
      .extras({ rows: 5000 });
    await tick();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text());
    const ev = body.events[0];
    expect(ev.kind).toBe("violation");
    expect(ev.error_type).toBe("large query");
    expect(ev.message).toBe("large query");
    expect(ev.extras).toMatchObject({ rows: 5000 });
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

  it("addExtras merges into a later see() report and attaches to multiple reports", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod.addExtras({ route: "/checkout", cart_id: "c1" });
    mod.see(new Error("first")).causes_the("a").to("b");
    mod.see(new Error("second")).causes_the("c").to("d");
    await tick();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    for (const call of sendBeacon.mock.calls) {
      const ev = JSON.parse(await (call[1] as Blob).text()).events[0];
      expect(ev.extras).toMatchObject({ route: "/checkout", cart_id: "c1" });
    }
    mod.clearExtras();
  });

  it("a chained extra overrides an ambient key of the same name", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod.addExtras({ tenant: "ambient" });
    mod.see(new Error("boom")).causes_the("a").to("b").extras({ tenant: "chain" });
    await tick();
    const ev = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text()).events[0];
    expect(ev.extras.tenant).toBe("chain");
    mod.clearExtras();
  });

  it("clearExtras empties the ambient buffer", async () => {
    const { mod, sendBeacon } = await bootClient();
    mod.addExtras({ gone: "yes" });
    mod.clearExtras();
    mod.see(new Error("after-clear")).causes_the("a").to("b");
    await tick();
    const ev = JSON.parse(await (sendBeacon.mock.calls[0][1] as Blob).text()).events[0];
    expect(ev.extras?.gone).toBeUndefined();
  });

  it("auto-capture: leaves window.onerror untouched — no generic page-level capture", async () => {
    const { client, sendBeacon } = await bootClient();
    await client.identify({});
    const w = globalThis.window as unknown as { onerror: unknown };
    // The SDK no longer overrides window.onerror or wires an unhandledrejection
    // listener: those produced generic, consequence-less reports ("the page hit
    // an error"). Auto-capture is now limited to specific network failures and
    // explicit see() calls. window.onerror stays exactly as the host left it.
    expect(typeof w.onerror).not.toBe("function");
    await tick();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("auto-capture: a 5xx no longer auto-reports — the fetch is still wrapped and passes through", async () => {
    const { client, sendBeacon, fetchMock } = await bootClient();
    await client.identify({});
    const w = globalThis.window as unknown as { fetch: typeof fetch };
    expect(w.fetch).not.toBe(fetchMock); // wrapped

    // A 5xx fires NO beacon — the SDK no longer mints a transport-level issue.
    // Reporting a failed request is the caller's job (see() at the catch site).
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() });
    const res = await w.fetch("https://api.test/orders?id=123");
    await tick();
    expect(sendBeacon).not.toHaveBeenCalled();
    // The response is returned unchanged.
    expect((res as Response).status).toBe(503);
  });

  it("auto-capture: stamps the correlation token on a same-origin 5xx Response", async () => {
    const { client, sendBeacon, fetchMock } = await bootClient();
    await client.identify({});
    // Make the request same-origin (so a token is minted) and deterministic.
    vi.stubGlobal("location", { href: "https://app.test/x", origin: "https://app.test" });
    vi.stubGlobal("crypto", { randomUUID: () => "corr-fixed" });
    const w = globalThis.window as unknown as { fetch: typeof fetch };

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() });
    const res = await w.fetch("https://app.test/api/orders");
    await tick();
    // Still no auto-report...
    expect(sendBeacon).not.toHaveBeenCalled();
    // ...but the Response carries the token, so `see(new Error(msg, { cause: res }))`
    // links to the server-side issue for the same request.
    expect(findCorrelation(res)).toBe("corr-fixed");
  });
});

// ---- server facade ----

describe("client correlation helpers (sameOrigin / injectCorrelationHeader)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("sameOrigin: same-origin + relative URLs true, cross-origin + junk false", async () => {
    vi.stubGlobal("location", { href: "https://app.test/x", origin: "https://app.test" });
    const { sameOrigin } = await import("../client/index");
    expect(sameOrigin("/cli-auth")).toBe(true);
    expect(sameOrigin("https://app.test/api/orders")).toBe(true);
    expect(sameOrigin("https://evil.test/api")).toBe(false);
    expect(sameOrigin("//evil.test/api")).toBe(false); // protocol-relative cross-origin
  });

  it("injectCorrelationHeader preserves existing headers across arg shapes", async () => {
    const { injectCorrelationHeader } = await import("../client/index");
    // string + init shape
    const [, init] = injectCorrelationHeader(["/x", { headers: { "X-Existing": "1" } }], "corr-1");
    const h1 = new Headers((init as RequestInit).headers);
    expect(h1.get("X-SE-Correlation")).toBe("corr-1");
    expect(h1.get("X-Existing")).toBe("1");
    // Request shape — header added, original headers kept, original untouched.
    const original = new Request("https://app.test/x", { headers: { "X-Existing": "2" } });
    const reqArgs = injectCorrelationHeader([original], "corr-2");
    const req0 = reqArgs[0] as Request;
    expect(req0.headers.get("X-SE-Correlation")).toBe("corr-2");
    expect(req0.headers.get("X-Existing")).toBe("2");
    expect(original.headers.get("X-SE-Correlation")).toBeNull();
  });

  it("installXhrCorrelation: injects the header + stamps a 5xx XHR (axios path)", async () => {
    // Minimal XMLHttpRequest good enough to exercise open→send→loadend.
    class FakeXHR {
      status = 0;
      headers: Record<string, string> = {};
      private listeners: Record<string, Array<() => void>> = {};
      open(_method: string, _url: string | URL): void {}
      setRequestHeader(k: string, v: string): void {
        this.headers[k] = v;
      }
      send(_body?: unknown): void {}
      addEventListener(type: string, cb: () => void): void {
        (this.listeners[type] ??= []).push(cb);
      }
      _finish(status: number): void {
        this.status = status;
        for (const cb of this.listeners["loadend"] ?? []) cb();
      }
    }
    vi.stubGlobal("location", { href: "https://app.test/x", origin: "https://app.test" });
    vi.stubGlobal("crypto", { randomUUID: () => "xhr-corr-1" });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);

    const { installXhrCorrelation } = await import("../client/index");
    const { findCorrelation } = await import("../see/core");
    // The SDK's own collector prefix is ignored — never correlated.
    installXhrCorrelation(["https://edge.test/collect"]);

    // Same-origin request → header injected.
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open("GET", "/api/orders");
    xhr.send();
    expect(xhr.headers["X-SE-Correlation"]).toBe("xhr-corr-1");

    // 500 → the XHR is stamped, so an axios error wrapping it (.request === xhr)
    // links across the wire.
    xhr._finish(500);
    const axiosErr = Object.assign(new Error("Request failed with status code 500"), {
      request: xhr,
    });
    expect(findCorrelation(axiosErr)).toBe("xhr-corr-1");

    // Ignored (collector) + cross-origin requests get no header.
    const ignored = new XMLHttpRequest() as unknown as FakeXHR;
    ignored.open("POST", "https://edge.test/collect");
    ignored.send();
    expect(ignored.headers["X-SE-Correlation"]).toBeUndefined();

    const cross = new XMLHttpRequest() as unknown as FakeXHR;
    cross.open("GET", "https://evil.test/api");
    cross.send();
    expect(cross.headers["X-SE-Correlation"]).toBeUndefined();
  });
});

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
      subject: "app",
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

  it("auto-attaches the ambient seeContext correlation id; vanilla see() outside a scope omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({
      apiKey: "sk_test",
      baseUrl: "https://edge.test",
      disableTelemetry: true,
    });
    // Inside a seeContext.run scope — the id rides along via the ALS the SDK
    // reads in reportError, even though dispatch is deferred to a microtask.
    mod.seeContext.run({ correlationId: "corr-xyz-789" }, () => {
      mod
        .see(new Error("worker 502"))
        .causes_the("CLI authorization")
        .to("fail before the token is issued");
    });
    await tick();
    const inScope = JSON.parse(fetchMock.mock.calls[0][1].body).events[0];
    expect(inScope.correlation_id).toBe("corr-xyz-789");
    // Vanilla see() outside any scope — no correlation id. (Distinct
    // message/subject so the dedup limiter still lets it send.)
    mod.see(new Error("unrelated")).causes_the("report").to("render empty");
    await tick();
    const outScope = JSON.parse(fetchMock.mock.calls[1][1].body).events[0];
    expect(outScope.correlation_id).toBeUndefined();
    mod._resetShipeasyServerForTests();
  });

  it("addExtras merges into a later see() report and attaches to multiple reports", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({ apiKey: "sk_test", baseUrl: "https://edge.test", disableTelemetry: true });
    await mod.runWithExtras(async () => {
      mod.addExtras({ order_id: "o42", tenant: "acme" });
      mod.see(new Error("first")).causes_the("checkout").to("use cached prices");
      mod.see(new Error("second")).causes_the("search").to("be trimmed");
      await tick();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const ev = JSON.parse(call[1].body).events[0];
      expect(ev.extras).toMatchObject({ order_id: "o42", tenant: "acme" });
    }
    mod._resetShipeasyServerForTests();
  });

  it("a chained extra overrides an ambient key; clearExtras empties the buffer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({ apiKey: "sk_test", baseUrl: "https://edge.test", disableTelemetry: true });
    await mod.runWithExtras(async () => {
      mod.addExtras({ tenant: "ambient" });
      mod.see(new Error("override")).causes_the("a").to("b").extras({ tenant: "chain" });
      await tick();
      mod.clearExtras();
      mod.see(new Error("after-clear")).causes_the("c").to("d");
      await tick();
    });
    const overridden = JSON.parse(fetchMock.mock.calls[0][1].body).events[0];
    expect(overridden.extras.tenant).toBe("chain");
    const cleared = JSON.parse(fetchMock.mock.calls[1][1].body).events[0];
    expect(cleared.extras?.tenant).toBeUndefined();
    mod._resetShipeasyServerForTests();
  });

  it("concurrent runWithExtras ALS scopes do not bleed into each other", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../server/index");
    mod._resetShipeasyServerForTests();
    mod.flags.configure({ apiKey: "sk_test", baseUrl: "https://edge.test", disableTelemetry: true });

    // Two interleaved "requests", each in its own ALS scope. The buffers must
    // not leak across scopes even though they run concurrently.
    const reqA = mod.runWithExtras(async () => {
      mod.addExtras({ req: "A" });
      await Promise.resolve(); // yield so B interleaves
      mod.see(new Error("err-A")).causes_the("A").to("x");
      await tick();
    });
    const reqB = mod.runWithExtras(async () => {
      mod.addExtras({ req: "B" });
      await Promise.resolve();
      mod.see(new Error("err-B")).causes_the("B").to("y");
      await tick();
    });
    await Promise.all([reqA, reqB]);

    const bySubject: Record<string, Record<string, unknown>> = {};
    for (const call of fetchMock.mock.calls) {
      const ev = JSON.parse(call[1].body).events[0];
      bySubject[ev.subject] = ev.extras;
    }
    expect(bySubject.A).toMatchObject({ req: "A" });
    expect(bySubject.A.req).not.toBe("B");
    expect(bySubject.B).toMatchObject({ req: "B" });
    expect(bySubject.B.req).not.toBe("A");
    mod._resetShipeasyServerForTests();
  });
});
