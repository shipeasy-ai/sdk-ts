// Self-monitoring channel: when the SDK swallows an internal ("on our end")
// error via safeRun, it also ships a structured see event to Shipeasy's OWN
// project — a baked-in destination + public client key, distinct from the
// consumer's see() path. These tests pin the wire shape, the enable gating, the
// dedup, and the no-throw guarantee.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reportInternalError,
  setInternalReportContext,
  __resetInternalReportForTest,
  __setInternalIngestKeyForTest,
  __INTERNAL_INGEST_URL,
  __INTERNAL_PLACEHOLDER_KEY,
} from "../internal-report";
import { safeRun } from "../logger";

// A real-looking client key to exercise the send path (the baked default is an
// inert placeholder until the real key is minted).
const FAKE_KEY = "sdk_client_testfakekey00000000000000000000";

interface CapturedSend {
  url: string;
  init: RequestInit;
  body: { events: Array<Record<string, unknown>> };
}

function stubFetch(): { calls: CapturedSend[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: CapturedSend[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

beforeEach(() => {
  __resetInternalReportForTest();
  __setInternalIngestKeyForTest(FAKE_KEY);
});
afterEach(() => {
  __resetInternalReportForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reportInternalError destination + wire shape", () => {
  it("posts to the baked-in Shipeasy ingest with the public client key", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });

    reportInternalError("flags.get", new TypeError("cannot read foo"));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(__INTERNAL_INGEST_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-SDK-Key"]).toBe(FAKE_KEY);
  });

  it("builds a stable consequence: subject=label, fixed outcome, sdk marker", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "client", sdkVersion: "9.9.9" });

    reportInternalError("Client.getExperiment", new Error("boom"));
    await Promise.resolve();

    const ev = calls[0].body.events[0];
    expect(ev.type).toBe("error");
    expect(ev.subject).toBe("Client.getExperiment");
    expect(ev.outcome).toBe("returned a safe default");
    expect(ev.error_type).toBe("Error");
    expect(ev.message).toBe("boom");
    expect(ev.side).toBe("client");
    expect(ev.sdk_version).toBe("9.9.9");
    expect((ev.extras as Record<string, unknown>).sdk).toBe("ts");
  });

  it("does NOT attach a consumer env or url (only the SDK-side context)", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });

    reportInternalError("flags.ks", new Error("x"));
    await Promise.resolve();

    const ev = calls[0].body.events[0];
    expect(ev.env).toBeUndefined();
    expect(ev.url).toBeUndefined();
  });
});

describe("enable gating", () => {
  it("is a no-op before a context is set", async () => {
    const { calls } = stubFetch();
    reportInternalError("flags.get", new Error("boom"));
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when disabled (enabled:false)", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9", enabled: false });
    reportInternalError("flags.get", new Error("boom"));
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("stays inert while the ingest key is the unprovisioned placeholder", async () => {
    const { calls } = stubFetch();
    __setInternalIngestKeyForTest(__INTERNAL_PLACEHOLDER_KEY);
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });
    reportInternalError("flags.get", new Error("boom"));
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});

describe("resilience", () => {
  it("dedupes identical internal errors within the window to one send", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });

    // Same error object => same top stack frame => one fingerprint (mirrors a
    // hot loop re-throwing from the same line).
    const err = new Error("same");
    reportInternalError("flags.get", err);
    reportInternalError("flags.get", err);
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  it("never throws even when fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network down");
      }),
    );
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });
    expect(() => reportInternalError("flags.get", new Error("boom"))).not.toThrow();
  });
});

describe("safeRun integration", () => {
  it("reports the swallowed internal error and still returns the fallback", async () => {
    const { calls } = stubFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });

    const out = safeRun("flags.getConfig", "fallback", () => {
      throw new Error("internal invariant");
    });
    await Promise.resolve();

    expect(out).toBe("fallback");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events[0].subject).toBe("flags.getConfig");
    expect(calls[0].body.events[0].message).toBe("internal invariant");
  });

  it("does not report when safeRun's body succeeds", async () => {
    const { calls } = stubFetch();
    setInternalReportContext({ side: "server", sdkVersion: "9.9.9" });

    const out = safeRun("flags.get", false, () => true);
    await Promise.resolve();

    expect(out).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
