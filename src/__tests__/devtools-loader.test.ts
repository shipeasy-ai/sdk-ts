// attachDevtools / loadDevtools — the client SDK loads the hosted
// `se-devtools.js` overlay on demand (hotkey or ?se) when the page has not
// mounted it, instead of silently doing nothing (shipeasy #715).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Engine,
  attachDevtools,
  loadDevtools,
  _resetShipeasyForTests,
} from "../client";

type Listener = (e: Partial<KeyboardEvent>) => void;

interface FakeScript {
  src: string;
  async?: boolean;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
}

let keydown: Listener[];
let appended: FakeScript[];
let preMounted: boolean;
let win: Record<string, unknown>;

function setup(search = "") {
  keydown = [];
  appended = [];
  win = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === "keydown") keydown.push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type === "keydown") keydown = keydown.filter((f) => f !== fn);
    },
    dispatchEvent: () => true,
    location: { search, pathname: "/" },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    head: { appendChild: (s: FakeScript) => appended.push(s) },
    createElement: (): FakeScript => ({
      src: "",
      attrs: {},
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    }),
    querySelector: (sel: string) =>
      sel.includes("se-devtools.js") && (preMounted || appended.length > 0)
        ? {}
        : null,
    addEventListener: () => {},
  });
}

const press = (e: Partial<KeyboardEvent>) => keydown.forEach((fn) => fn(e));
// macOS: Option+Shift+S reports e.key "Í" — only e.code is reliable.
const hotkey = {
  key: "Í",
  code: "KeyS",
  shiftKey: true,
  altKey: true,
  ctrlKey: false,
  metaKey: false,
};

beforeEach(() => {
  preMounted = false;
  _resetShipeasyForTests();
});

afterEach(() => {
  _resetShipeasyForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("devtools overlay loader", () => {
  it("injects se-devtools.js with the client key on the hotkey when the page has not mounted it", () => {
    setup();
    const engine = Engine.forTesting();
    const detach = attachDevtools(engine, {
      clientKey: "sdk_client_x",
      baseUrl: "https://cdn.example.test/",
    });
    expect(appended).toHaveLength(0);

    press(hotkey);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe("https://cdn.example.test/se-devtools.js");
    expect(appended[0].attrs["data-client-api-key"]).toBe("sdk_client_x");
    expect(appended[0].attrs["data-open"]).toBe("1");

    // A second press while it loads (or once it started) is the bundle's to handle.
    press(hotkey);
    expect(appended).toHaveLength(1);
    detach();
  });

  it("injects on ?se at attach time", () => {
    setup("?se=1");
    attachDevtools(Engine.forTesting(), { clientKey: "sdk_client_x" });
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe("https://cdn.shipeasy.ai/se-devtools.js");
  });

  it("does not inject a second copy when the layout already mounted the bundle", () => {
    preMounted = true;
    setup("?se=1");
    attachDevtools(Engine.forTesting(), { clientKey: "sdk_client_x" });
    press(hotkey);
    expect(appended).toHaveLength(0);
  });

  it("hands adminUrl to the bundle via __se_devtools_config", () => {
    setup();
    loadDevtools({
      clientKey: "sdk_client_x",
      adminUrl: "https://admin.example.test",
    });
    expect(win.__se_devtools_config).toEqual({
      adminUrl: "https://admin.example.test",
    });
  });

  it("warns instead of silently no-oping when there is no client key", () => {
    setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadDevtools({});
    expect(appended).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("se-devtools.js");
  });
});
