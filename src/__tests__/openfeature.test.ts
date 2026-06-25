import { afterEach, describe, expect, it } from "vitest";
import { OpenFeature as ServerOF } from "@openfeature/server-sdk";
import { OpenFeature as WebOF } from "@openfeature/web-sdk";

import { Engine } from "../server/index";
import { Engine as BrowserEngine } from "../client/index";
import { ShipeasyProvider as ServerProvider } from "../openfeature-server/index";
import { ShipeasyProvider as WebProvider } from "../openfeature-web/index";
import { mapFlagReason, resolveConfigValue, toUser } from "../openfeature/shared";

// A snapshot with a 100% gate (RULE_MATCH), a disabled gate (OFF), a 0% gate
// (DEFAULT), and typed configs — exercises the full reason map without network.
const SNAPSHOT = {
  flags: {
    version: "t",
    plan: "free",
    gates: {
      on: { rules: [], rolloutPct: 10000, salt: "s", enabled: 1 },
      off: { rules: [], rolloutPct: 10000, salt: "s", enabled: 0 },
      zero: { rules: [], rolloutPct: 0, salt: "s", enabled: 1 },
    },
    configs: {
      theme: { value: "dark" },
      limit: { value: 42 },
      payload: { value: { a: 1 } },
    },
    killswitches: {},
  },
  experiments: { version: "t", universes: {}, experiments: {} },
} as const;

describe("openfeature/shared — reason + value mapping", () => {
  it("maps every Shipeasy flag reason to the OpenFeature reason/errorCode", () => {
    expect(mapFlagReason("RULE_MATCH")).toEqual({ reason: "TARGETING_MATCH" });
    expect(mapFlagReason("DEFAULT")).toEqual({ reason: "DEFAULT" });
    expect(mapFlagReason("OFF")).toEqual({ reason: "DISABLED" });
    expect(mapFlagReason("OVERRIDE")).toEqual({ reason: "STATIC" });
    expect(mapFlagReason("FLAG_NOT_FOUND")).toEqual({
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(mapFlagReason("CLIENT_NOT_READY")).toEqual({
      reason: "ERROR",
      errorCode: "PROVIDER_NOT_READY",
    });
  });

  it("toUser maps targetingKey → user_id and carries attributes", () => {
    expect(toUser({ targetingKey: "u1", plan: "pro" })).toEqual({ user_id: "u1", plan: "pro" });
    expect(toUser(undefined)).toEqual({});
    expect(toUser({ plan: "pro" })).toEqual({ plan: "pro" });
  });

  it("resolveConfigValue distinguishes default / match / type_mismatch", () => {
    expect(resolveConfigValue(undefined, "string")).toEqual({ kind: "default" });
    expect(resolveConfigValue("x", "string")).toEqual({ kind: "match", value: "x" });
    expect(resolveConfigValue(5, "string").kind).toBe("type_mismatch");
    expect(resolveConfigValue({ a: 1 }, "object")).toEqual({ kind: "match", value: { a: 1 } });
    expect(resolveConfigValue(null, "object").kind).toBe("type_mismatch");
  });
});

describe("ShipeasyProvider — server (OpenFeature server-sdk)", () => {
  afterEach(async () => {
    await ServerOF.close();
  });

  it("resolves booleans with the mapped reason for each gate state", async () => {
    const client = Engine.fromSnapshot(SNAPSHOT as never);
    await ServerOF.setProviderAndWait(new ServerProvider(client));
    const of = ServerOF.getClient();
    const ctx = { targetingKey: "u1" };

    const on = await of.getBooleanDetails("on", false, ctx);
    expect(on.value).toBe(true);
    expect(on.reason).toBe("TARGETING_MATCH");

    const off = await of.getBooleanDetails("off", true, ctx);
    expect(off.value).toBe(false);
    expect(off.reason).toBe("DISABLED");

    const zero = await of.getBooleanDetails("zero", true, ctx);
    expect(zero.value).toBe(false);
    expect(zero.reason).toBe("DEFAULT");
  });

  it("returns FLAG_NOT_FOUND + default for an unknown flag", async () => {
    const client = Engine.fromSnapshot(SNAPSHOT as never);
    await ServerOF.setProviderAndWait(new ServerProvider(client));
    const d = await ServerOF.getClient().getBooleanDetails("missing", false, {});
    expect(d.value).toBe(false);
    expect(d.reason).toBe("ERROR");
    expect(d.errorCode).toBe("FLAG_NOT_FOUND");
  });

  it("reports OVERRIDE as STATIC", async () => {
    const client = Engine.fromSnapshot(SNAPSHOT as never);
    client.overrideFlag("on", false);
    await ServerOF.setProviderAndWait(new ServerProvider(client));
    const d = await ServerOF.getClient().getBooleanDetails("on", true, { targetingKey: "u1" });
    expect(d.value).toBe(false);
    expect(d.reason).toBe("STATIC");
  });

  it("resolves string/number/object configs and flags type mismatches", async () => {
    const client = Engine.fromSnapshot(SNAPSHOT as never);
    await ServerOF.setProviderAndWait(new ServerProvider(client));
    const of = ServerOF.getClient();

    expect(await of.getStringValue("theme", "light", {})).toBe("dark");
    expect(await of.getNumberValue("limit", 0, {})).toBe(42);
    expect(await of.getObjectValue("payload", {}, {})).toEqual({ a: 1 });
    expect(await of.getStringValue("absent", "fallback", {})).toBe("fallback");

    const tm = await of.getNumberDetails("theme", 7, {});
    expect(tm.value).toBe(7);
    expect(tm.errorCode).toBe("TYPE_MISMATCH");
  });
});

describe("ShipeasyProvider — web (OpenFeature web-sdk)", () => {
  afterEach(async () => {
    await WebOF.close();
    await WebOF.setContext({});
  });

  it("resolves overrides as STATIC and reads sync", async () => {
    const client = BrowserEngine.forTesting();
    client.overrideFlag("new_checkout", true);
    client.overrideConfig("theme", "dark");
    await WebOF.setContext({ targetingKey: "u1" });
    await WebOF.setProviderAndWait(new WebProvider(client));
    const of = WebOF.getClient();

    expect(of.getBooleanValue("new_checkout", false)).toBe(true);
    const d = of.getBooleanDetails("new_checkout", false);
    expect(d.reason).toBe("STATIC");
    expect(of.getStringValue("theme", "light")).toBe("dark");
  });

  it("maps a ready-but-missing flag to FLAG_NOT_FOUND", async () => {
    const client = BrowserEngine.forTesting();
    await WebOF.setProviderAndWait(new WebProvider(client));
    const d = WebOF.getClient().getBooleanDetails("anything", false);
    expect(d.value).toBe(false);
    expect(d.reason).toBe("ERROR");
    expect(d.errorCode).toBe("FLAG_NOT_FOUND");
  });

  it("maps an unloaded client (CLIENT_NOT_READY) to PROVIDER_NOT_READY", () => {
    // A client whose eval result hasn't loaded yet returns CLIENT_NOT_READY.
    const notReady = {
      getFlagDetail: () => ({ value: false, reason: "CLIENT_NOT_READY" as const }),
    } as unknown as BrowserEngine;
    const d = new WebProvider(notReady).resolveBooleanEvaluation("x", false, {});
    expect(d.value).toBe(false);
    expect(d.reason).toBe("ERROR");
    expect(d.errorCode).toBe("PROVIDER_NOT_READY");
  });

  it("reconciles a context change into identify()", async () => {
    const client = BrowserEngine.forTesting();
    await WebOF.setProviderAndWait(new WebProvider(client));
    await WebOF.setContext({ targetingKey: "u2" });
    expect((client as unknown as { userId?: string }).userId).toBe("u2");
  });

  it("flags a config type mismatch", async () => {
    const client = BrowserEngine.forTesting();
    client.overrideConfig("theme", "dark");
    await WebOF.setProviderAndWait(new WebProvider(client));
    const tm = WebOF.getClient().getNumberDetails("theme", 9);
    expect(tm.value).toBe(9);
    expect(tm.errorCode).toBe("TYPE_MISMATCH");
  });
});
