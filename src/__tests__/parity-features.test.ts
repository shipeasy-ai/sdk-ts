// Competitor-parity features: default values, flag evaluation detail (reason),
// server change listeners, and the offline file/snapshot data source. All
// additive + backward-compatible; these specs make NO network calls.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Engine } from "../server/index";
import type { FlagsBlob, ExpsBlob } from "../server/index";
import { Engine as BrowserEngine } from "../client/index";

// Any accidental network call should fail loudly.
const failingFetch = vi.fn(() => {
  throw new Error("network call in test");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A snapshot in the wire shape: a fully-rolled enabled gate, a disabled gate,
// and a config. user "u1" buckets in for the rolled gate (rolloutPct 10000).
function snapshot(): { flags: FlagsBlob; experiments: ExpsBlob } {
  const flags: FlagsBlob = {
    version: "v1",
    plan: "free",
    gates: {
      on_gate: { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 },
      off_gate: { rules: [], rolloutPct: 10000, salt: "s", enabled: 0 },
      denied_gate: { rules: [], rolloutPct: 0, salt: "s", enabled: 1 },
    },
    configs: { limits: { value: { max: 5 } } },
    killswitches: {},
  };
  const experiments: ExpsBlob = { version: "v1", universes: {}, experiments: {} };
  return { flags, experiments };
}

// ---- Feature A — default value (server) -------------------------------------

describe("Feature A — getFlag/getConfig default value (server)", () => {
  it("returns default when client not ready", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = new Engine({ apiKey: "k", baseUrl: "http://x", disableTelemetry: true });
    // No blob loaded → CLIENT_NOT_READY.
    expect(client.getFlag("anything", { user_id: "u1" })).toBe(false); // plain default
    expect(client.getFlag("anything", { user_id: "u1" }, true)).toBe(true);
  });

  it("returns default when flag not found", () => {
    const client = Engine.fromSnapshot(snapshot());
    expect(client.getFlag("missing", { user_id: "u1" }, true)).toBe(true);
    expect(client.getFlag("missing", { user_id: "u1" })).toBe(false); // plain default
  });

  it("does NOT return default on a real false (denied/disabled gate)", () => {
    const client = Engine.fromSnapshot(snapshot());
    // denied_gate evaluates to false (rollout 0%) — default must NOT kick in.
    expect(client.getFlag("denied_gate", { user_id: "u1" }, true)).toBe(false);
    // off_gate is disabled → reason OFF, value false — default must NOT kick in.
    expect(client.getFlag("off_gate", { user_id: "u1" }, true)).toBe(false);
  });

  it("getConfig returns defaultValue only when the key is absent", () => {
    const client = Engine.fromSnapshot(snapshot());
    expect(client.getConfig("limits")).toEqual({ max: 5 });
    expect(client.getConfig("missing", { defaultValue: { max: 99 } })).toEqual({ max: 99 });
    // Present key → never the default.
    expect(client.getConfig("limits", { defaultValue: { max: 99 } })).toEqual({ max: 5 });
    // Legacy decode-callback signature still works.
    expect(client.getConfig<number>("limits", (raw) => (raw as { max: number }).max)).toBe(5);
  });
});

// ---- Feature A — default value (browser) ------------------------------------

describe("Feature A — getFlag/getConfig default value (browser)", () => {
  it("returns default when not ready / not found, not on a real false", () => {
    vi.stubGlobal("fetch", failingFetch);
    const notReady = new BrowserEngine({ sdkKey: "", autoGuardrails: false });
    expect(notReady.getFlag("x", true)).toBe(true); // CLIENT_NOT_READY

    const client = BrowserEngine.forTesting();
    client.initFromBootstrap({
      flags: { real_false: false, real_true: true },
      configs: { c: 1 },
      experiments: {},
      killswitches: {},
    });
    expect(client.getFlag("missing", true)).toBe(true); // FLAG_NOT_FOUND
    expect(client.getFlag("real_false", true)).toBe(false); // real false, no default
    expect(client.getFlag("real_true", false)).toBe(true);
  });

  it("getConfig returns defaultValue only when the key is absent", () => {
    const client = BrowserEngine.forTesting();
    client.initFromBootstrap({ flags: {}, configs: { c: 1 }, experiments: {}, killswitches: {} });
    expect(client.getConfig("c")).toBe(1);
    expect(client.getConfig("missing", { defaultValue: 42 })).toBe(42);
    expect(client.getConfig("c", { defaultValue: 42 })).toBe(1);
  });
});

// ---- Feature B — flag detail / reason ---------------------------------------

describe("Feature B — getFlagDetail reasons (server)", () => {
  it("OVERRIDE short-circuits before telemetry", () => {
    const client = Engine.fromSnapshot(snapshot());
    client.overrideFlag("on_gate", false);
    expect(client.getFlagDetail("on_gate", { user_id: "u1" })).toEqual({
      value: false,
      reason: "OVERRIDE",
    });
  });

  it("CLIENT_NOT_READY when no blob is loaded", () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = new Engine({ apiKey: "k", baseUrl: "http://x", disableTelemetry: true });
    expect(client.getFlagDetail("g", { user_id: "u1" })).toEqual({
      value: false,
      reason: "CLIENT_NOT_READY",
    });
  });

  it("FLAG_NOT_FOUND / OFF / RULE_MATCH / DEFAULT", () => {
    const client = Engine.fromSnapshot(snapshot());
    expect(client.getFlagDetail("missing", { user_id: "u1" }).reason).toBe("FLAG_NOT_FOUND");
    expect(client.getFlagDetail("off_gate", { user_id: "u1" }).reason).toBe("OFF");
    expect(client.getFlagDetail("on_gate", { user_id: "u1" })).toEqual({
      value: true,
      reason: "RULE_MATCH",
    });
    expect(client.getFlagDetail("denied_gate", { user_id: "u1" })).toEqual({
      value: false,
      reason: "DEFAULT",
    });
  });

  it("getFlag delegates to getFlagDetail (single emit, no drift)", () => {
    const client = Engine.fromSnapshot(snapshot());
    expect(client.getFlag("on_gate", { user_id: "u1" })).toBe(true);
    expect(client.getFlag("denied_gate", { user_id: "u1" })).toBe(false);
  });
});

describe("Feature B — getFlagDetail reasons (browser)", () => {
  it("OVERRIDE / CLIENT_NOT_READY / FLAG_NOT_FOUND / RULE_MATCH / DEFAULT", () => {
    vi.stubGlobal("fetch", failingFetch);
    const notReady = new BrowserEngine({ sdkKey: "", autoGuardrails: false });
    expect(notReady.getFlagDetail("g").reason).toBe("CLIENT_NOT_READY");

    const client = BrowserEngine.forTesting();
    client.initFromBootstrap({
      flags: { on: true, off: false },
      configs: {},
      experiments: {},
      killswitches: {},
    });
    client.overrideFlag("on", false);
    expect(client.getFlagDetail("on")).toEqual({ value: false, reason: "OVERRIDE" });
    client.clearOverrides();
    expect(client.getFlagDetail("on")).toEqual({ value: true, reason: "RULE_MATCH" });
    expect(client.getFlagDetail("off")).toEqual({ value: false, reason: "DEFAULT" });
    expect(client.getFlagDetail("missing").reason).toBe("FLAG_NOT_FOUND");
  });

  it("a partial bootstrap without a flags map reads as FLAG_NOT_FOUND, not a crash", () => {
    const client = BrowserEngine.forTesting();
    // Embedders hand initFromBootstrap arbitrary JSON — a payload missing the
    // flags map used to crash the `in` lookup ("Cannot use 'in' operator …").
    client.initFromBootstrap({} as never);
    expect(client.getFlagDetail("anything")).toEqual({ value: false, reason: "FLAG_NOT_FOUND" });
    expect(client.getFlag("anything", true)).toBe(true);
  });
});

// ---- Feature C — change listeners (server) ----------------------------------

describe("Feature C — onChange (server)", () => {
  // Build a fetch mock that serves flags/experiments, switching the flags body
  // and ETag between calls so the second poll sees NEW data (200, not 304).
  function makeMockFetch() {
    let flagsCall = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const ifNoneMatch = (init?.headers as Record<string, string>)?.["If-None-Match"];
      if (url.includes("/sdk/flags")) {
        flagsCall++;
        const etag = `"flags-${flagsCall}"`;
        // First poll re-fetch reuses etag flags-1 → return 304; we instead make
        // each call advance the etag so 200 with new data is served.
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { "X-Poll-Interval": "30" } });
        }
        const body = JSON.stringify({
          version: `v${flagsCall}`,
          plan: "free",
          gates: {},
          configs: {},
          killswitches: {},
        });
        return new Response(body, {
          status: 200,
          headers: { ETag: etag, "X-Poll-Interval": "30" },
        });
      }
      // experiments: always 304 after the first 200 so only flags drive change.
      if (ifNoneMatch) {
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({ version: "v1", universes: {}, experiments: {} }), {
        status: 200,
        headers: { ETag: '"exps-1"' },
      });
    });
  }

  it("fires after a poll returns NEW data; unsubscribe stops it", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", makeMockFetch());
      const client = new Engine({ apiKey: "k", baseUrl: "http://x", disableTelemetry: true });
      const calls: number[] = [];
      const unsub = client.onChange(() => calls.push(1));
      await client.init(); // initial fetch — NOT a change
      expect(calls.length).toBe(0);

      // Advance to the first poll → flags etag advances → 200 → fires once.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.length).toBe(1);

      // Unsubscribe, then poll again — must not fire.
      unsub();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.length).toBe(1);

      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fires in offline/snapshot mode", () => {
    const client = Engine.fromSnapshot(snapshot());
    const seen: number[] = [];
    client.onChange(() => seen.push(1));
    // No poll happens offline; nothing fires.
    expect(seen.length).toBe(0);
  });
});

// ---- Feature D — offline snapshot / file ------------------------------------

describe("Feature D — fromSnapshot / fromFile (server)", () => {
  it("evaluates against the snapshot with no network", async () => {
    vi.stubGlobal("fetch", failingFetch);
    const client = Engine.fromSnapshot(snapshot());
    // init/initOnce/track are no-ops (test-mode plumbing reused).
    await client.init();
    await client.initOnce();
    client.track("u1", "evt");
    expect(failingFetch).not.toHaveBeenCalled();

    // Real eval against the snapshot.
    expect(client.getFlag("on_gate", { user_id: "u1" })).toBe(true);
    expect(client.getFlag("denied_gate", { user_id: "u1" })).toBe(false);
    expect(client.getConfig("limits")).toEqual({ max: 5 });

    // Overrides still apply on top.
    client.overrideFlag("on_gate", false);
    expect(client.getFlag("on_gate", { user_id: "u1" })).toBe(false);
  });

  it("fromFile loads a snapshot JSON off disk", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const file = path.join(os.tmpdir(), `se-snapshot-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot()), "utf8");
    try {
      const client = Engine.fromFile(file);
      expect(client.getFlag("on_gate", { user_id: "u1" })).toBe(true);
      expect(client.getConfig("limits")).toEqual({ max: 5 });
    } finally {
      fs.unlinkSync(file);
    }
  });
});
