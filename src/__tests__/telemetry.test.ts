import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { Telemetry } from "../telemetry";
import { FlagsClient } from "../server/index";

// Flush the microtask + macrotask queue so the fire-and-forget beacon (which
// awaits the once-resolved keyHash promise before sending) has run. Only safe
// for asserting the ABSENCE of beacons; positive counts must use waitFor()
// below — keyHash is a crypto.subtle.digest promise that resolves off-thread
// in Node, so a single setTimeout(0) can lose the race on a slow CI runner
// (and the late beacon then leaks into the next test's spy).
const tick = () => new Promise((r) => setTimeout(r, 0));

// Deterministically wait until the expected number of beacons has fired.
const waitForBeacons = (beacon: ReturnType<typeof vi.fn>, n: number) =>
  vi.waitFor(() => expect(beacon).toHaveBeenCalledTimes(n));

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("Telemetry — per-evaluation beacons", () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    beacon = vi.fn().mockReturnValue(true);
    // Emulate a browser with sendBeacon available.
    vi.stubGlobal("navigator", { sendBeacon: beacon });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fires one sendBeacon per emit, with sha256(key) — not the raw key — and side/env in the path", async () => {
    const t = new Telemetry({
      endpoint: "https://t.example.com/",
      sdkKey: "sk_secret",
      side: "server",
      env: "prod",
    });
    t.emit("gate", "checkout_v2");
    await waitForBeacons(beacon, 1);

    const url = beacon.mock.calls[0][0] as string;
    expect(url).toBe(
      `https://t.example.com/t/${sha256Hex("sk_secret")}/server/prod/gate/checkout_v2`,
    );
    // The secret key must never appear in the beacon URL.
    expect(url).not.toContain("sk_secret");
  });

  it("percent-encodes resource names with slashes / spaces", async () => {
    const t = new Telemetry({ endpoint: "https://e.x", sdkKey: "k", side: "client", env: "prod" });
    t.emit("config", "billing/plan name");
    await waitForBeacons(beacon, 1);
    const url = beacon.mock.calls[0][0] as string;
    expect(url.endsWith("/config/billing%2Fplan%20name")).toBe(true);
  });

  it("emits nothing when disabled", async () => {
    const t = new Telemetry({
      endpoint: "https://e.x",
      sdkKey: "k",
      side: "server",
      env: "prod",
      disabled: true,
    });
    t.emit("gate", "g");
    t.emit("experiment", "e");
    await tick();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("emits nothing when the key or endpoint is empty", async () => {
    new Telemetry({ endpoint: "https://e.x", sdkKey: "", side: "server", env: "prod" }).emit("gate", "g");
    new Telemetry({ endpoint: "", sdkKey: "k", side: "server", env: "prod" }).emit("gate", "g");
    await tick();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("collapses repeated reads of the same key within the dedup window", async () => {
    const t = new Telemetry({ endpoint: "https://e.x", sdkKey: "k", side: "client", env: "prod" });
    for (let i = 0; i < 50; i++) t.emit("gate", "g"); // one render-storm
    t.emit("gate", "other"); // distinct key still fires
    await waitForBeacons(beacon, 2);
  });

  it("emits on every call when dedupeMs is 0", async () => {
    const t = new Telemetry({
      endpoint: "https://e.x",
      sdkKey: "k",
      side: "client",
      env: "prod",
      dedupeMs: 0,
    });
    t.emit("gate", "g");
    t.emit("gate", "g");
    await waitForBeacons(beacon, 2);
  });
});

describe("FlagsClient telemetry wiring", () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const blob = {
    version: "v1",
    plan: "free",
    gates: { g: { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 as const } },
    configs: { c: { value: 1 } },
    killswitches: {},
  };

  function make(disableTelemetry?: boolean): FlagsClient {
    const c = new FlagsClient({ apiKey: "srv", baseUrl: "https://e.x", disableTelemetry });
    (c as any).flagsBlob = blob;
    (c as any).expsBlob = { version: "v1", universes: {}, experiments: {} };
    (c as any).initialized = true;
    return c;
  }

  // 1) basic telemetry send works for each entity call, hitting the right URL.
  it("fires a beacon with the right feature path for every entity call (telemetry ON)", async () => {
    const c = make();
    c.getFlag("g", { user_id: "u" });
    c.getConfig("c");
    c.getExperiment("e", { user_id: "u" }, {});
    c.getKillswitch("k");
    await waitForBeacons(beacon, 4);
    const paths = beacon.mock.calls.map((c) => (c[0] as string).split("/t/")[1]);
    expect(paths.some((p) => p.endsWith("/gate/g"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/config/c"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/experiment/e"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/ks/k"))).toBe(true);
  });

  // 2) telemetry is not sent when disabled in settings.
  it("fires no beacon for any entity call when disableTelemetry is true", async () => {
    const c = make(true);
    c.getFlag("g", { user_id: "u" });
    c.getConfig("c");
    c.getExperiment("e", { user_id: "u" }, {});
    c.getKillswitch("k");
    await tick();
    expect(beacon).not.toHaveBeenCalled();
  });
});
