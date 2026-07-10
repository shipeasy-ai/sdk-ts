/**
 * @vitest-environment node
 *
 * End-to-end confirmation that the XHR correlation patch works with the REAL
 * axios library (not a hand-rolled error shape). axios's default adapter is
 * `XMLHttpRequest`; we patch that transport, drive an actual `axios.get`
 * through a minimal fake XHR, and assert that the resulting real `AxiosError`
 * carries the correlation token our patch stamped — the exact path an app on
 * axios hits, so `see(err)` links across the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// NOTE: axios is imported dynamically INSIDE the test, after the XHR global is
// stubbed — axios latches xhr-adapter support at module-eval time, so a static
// top-level import (before the stub) would resolve the adapter as unsupported.

/**
 * The slice of `XMLHttpRequest` axios 1.x's xhr adapter drives, plus a
 * `_finish()` test hook that emulates the server responding. Fires BOTH the
 * `onloadend` property (how axios listens) and any `addEventListener("loadend")`
 * listeners (how the SDK patch listens).
 */
class FakeXHR {
  readyState = 0;
  status = 0;
  statusText = "";
  response: unknown = "";
  responseText = "";
  responseType = "";
  responseURL = "";
  timeout = 0;
  withCredentials = false;
  upload = { addEventListener() {} };
  onloadend: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  readonly requestHeaders: Record<string, string> = {};
  private readonly listeners: Record<string, Array<() => void>> = {};
  private url = "";

  open(_method: string, url: string): void {
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(k: string, v: string): void {
    this.requestHeaders[k.toLowerCase()] = v;
  }
  getAllResponseHeaders(): string {
    return "content-type: application/json\r\n";
  }
  getResponseHeader(): string | null {
    return null;
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(): void {}
  abort(): void {}
  send(_body?: unknown): void {}

  /** Emulate the server completing the request with a status + body. */
  _finish(status: number, body = ""): void {
    this.readyState = 4;
    this.status = status;
    this.statusText = status >= 500 ? "Internal Server Error" : "OK";
    this.responseText = body;
    this.response = body;
    this.responseURL = this.url;
    for (const cb of this.listeners["loadend"] ?? []) cb(); // SDK patch
    this.onloadend?.(); // axios adapter
  }
}

describe("real axios integration — XHR correlation stamp", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("stamps a 5xx driven by real axios so findCorrelation links across the wire", async () => {
    vi.stubGlobal("location", { href: "https://app.test/x", origin: "https://app.test" });
    vi.stubGlobal("crypto", { randomUUID: () => "axios-corr-1" });

    let lastXhr: FakeXHR | undefined;
    class TrackedXHR extends FakeXHR {
      constructor() {
        super();
        lastXhr = this;
      }
    }
    vi.stubGlobal("XMLHttpRequest", TrackedXHR);

    // Import axios AFTER the stub so its xhr adapter registers as supported.
    const axios = (await import("axios")).default;
    const { installXhrCorrelation } = await import("../client/index");
    const { findCorrelation } = await import("../see/core");
    installXhrCorrelation([]);

    // Real axios, forced onto the xhr adapter (the transport we patched).
    const pending = axios.get("https://app.test/api/orders", { adapter: "xhr" });

    // The adapter opens + sends synchronously in its Promise executor, but the
    // axios interceptor chain may defer it a microtask — wait for the instance.
    await vi.waitFor(() => expect(lastXhr).toBeDefined());

    // Our patch injected the token on the real request axios built.
    expect(lastXhr!.requestHeaders["x-se-correlation"]).toBe("axios-corr-1");

    // Server 500s → axios rejects with a real AxiosError.
    lastXhr!._finish(500, JSON.stringify({ error: "boom" }));
    const err = await pending.catch((e: unknown) => e);

    // Sanity: it's genuinely an axios error exposing the XHR we stamped.
    expect((err as { isAxiosError?: boolean }).isAxiosError).toBe(true);
    expect((err as { request?: unknown }).request).toBe(lastXhr);

    // The whole point: see(err) would auto-carry the token, no manual wiring.
    expect(findCorrelation(err)).toBe("axios-corr-1");
  });
});
