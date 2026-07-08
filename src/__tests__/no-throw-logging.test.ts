// The hard contract: the SDK's public runtime methods NEVER throw into product
// code — a broken decode callback, a bad argument, anything — they log at the
// configured level and return a documented safe default. Plus the `logLevel`
// config option gates that logging (default "warn").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Client,
  flags,
  configure,
  configureForTesting,
  _resetShipeasyServerForTests,
  _resetConfigureForTests,
} from "../server/index";
import { logger, setLogLevel, getLogLevel, LOG_LEVELS } from "../logger";

beforeEach(() => {
  _resetShipeasyServerForTests();
  _resetConfigureForTests();
  setLogLevel("warn"); // reset to the documented default between cases
});
afterEach(() => {
  _resetShipeasyServerForTests();
  _resetConfigureForTests();
  vi.restoreAllMocks();
});

const boom = () => {
  throw new Error("boom");
};

describe("runtime methods never throw", () => {
  it("getConfig with a throwing decode returns the default and does not throw", () => {
    configureForTesting({ configs: { theme: { color: "blue" } } });
    const c = new Client({ user_id: "u_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let out: unknown;
    expect(() => {
      out = c.getConfig("theme", boom);
    }).not.toThrow();
    expect(out).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("decode failed");
  });

  it("universe().assign() on an unknown universe returns a safe not-enrolled handle, never throws", () => {
    configureForTesting({});
    const c = new Client({ user_id: "u_1" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let r: ReturnType<ReturnType<Client["universe"]>["assign"]> | undefined;
    expect(() => {
      r = c.universe("missing_universe").assign();
    }).not.toThrow();
    expect(r?.enrolled).toBe(false);
    expect(r?.group).toBeNull();
    expect(r?.get("price", 0)).toBe(0);
  });

  it("the flags facade swallows a throwing decode too", () => {
    configureForTesting({ configs: { theme: 1 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => flags.getConfig("theme", boom)).not.toThrow();
    expect(flags.getConfig("theme", boom)).toBeUndefined();
  });
});

describe("logLevel gating", () => {
  it("defaults to warn", () => {
    setLogLevel(undefined as never);
    // default is warn unless a valid level was set; an invalid value is ignored
    expect(getLogLevel()).toBe("warn");
  });

  it("exposes the ordered level set", () => {
    expect(LOG_LEVELS).toEqual(["silent", "error", "warn", "info", "debug"]);
  });

  it("silent mutes warn + error", () => {
    setLogLevel("silent");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.warn("nope");
    logger.error("nope");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("warn (default) prints warn + error but not info/debug", () => {
    setLogLevel("warn");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    expect(error).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("an invalid level value is ignored (keeps the current level)", () => {
    setLogLevel("info");
    setLogLevel("bogus" as never);
    expect(getLogLevel()).toBe("info");
  });

  it("configure({ logLevel }) applies the level", () => {
    // configure() threads logLevel → Engine ctor → setLogLevel. Engine is built
    // fresh here (beforeEach reset the singleton), so first-config-wins applies.
    configure({ apiKey: "srv_key", logLevel: "silent", init: false });
    expect(getLogLevel()).toBe("silent");
  });
});
