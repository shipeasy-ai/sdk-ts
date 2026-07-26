// Drop-in <script>-tag loader. Built to dist/loader/loader.global.js and
// served at cdn.shipeasy.ai/sdk/loader.js so non-React customers can integrate
// by pasting one tag into <head>:
//
//   <script
//     src="https://cdn.shipeasy.ai/sdk/loader.js"
//     data-sdk-key="sdk_client_..."
//     data-user-id="user-123"          // optional
//     data-user-email="u@x.com"        // optional
//     data-user-plan="pro"             // optional
//     data-user-project-id="proj_..."  // optional
//     data-attrs='{"country":"US"}'    // optional JSON of extra attrs
//     defer
//   ></script>
//
// The loader reads its own dataset, configures the SDK through the same
// `shipeasy({ clientKey })` entry npm consumers use, auto-identifies, and
// exposes a global API on `window.shipeasy`:
//
//   window.shipeasy.getFlag("my_gate")
//   window.shipeasy.getConfig("my_config")
//   window.shipeasy.getKillswitch("payments")
//   window.shipeasy.universe("checkout").assign().get("button_color")
//   window.shipeasy.identify({ user_id: "u-1", plan: "pro" })
//   window.shipeasy.track("checkout_started", { value: 49 })
//   window.shipeasy.see(err).causes_the("checkout to fail")
//
// React consumers should use @shipeasy/sdk-react's <ShipeasyProvider>
// instead — this loader is the easy onboarding path for vanilla HTML,
// Vue, Svelte, Rails ERB, etc.

import {
  shipeasy,
  getShipeasyClient,
  see,
  type Assignment,
  type SeeApi,
  type User,
} from "./client";

interface ShipeasyGlobal {
  getFlag(name: string): boolean;
  getConfig<T = unknown>(name: string): T | undefined;
  /** Read a killswitch. Without `switchKey`, true when the killswitch is killed
   *  as a whole; with it, the state of that one switch. Unknown names → false. */
  getKillswitch(name: string, switchKey?: string): boolean;
  /** Assign the identified visitor within a universe (mutual-exclusion pool);
   *  the handle exposes `.group` / `.get(field, fallback)` and auto-logs one
   *  exposure when enrolled.
   *
   *  Pass the universe's param shape to type `.get()`:
   *  `universe<{ button_color: string }>("checkout").assign().get("button_color")`. */
  universe<P = Record<string, unknown>>(
    name: string,
  ): { assign(opts?: { logExposure?: boolean }): Assignment<P> };
  identify(user: User): Promise<void>;
  track(event: string, props?: Record<string, unknown>): void;
  /** Structured error reporting — `see(err).causes_the("checkout to fail")`,
   *  plus `see.Violation(...)` / `see.ControlFlowException(...)`. */
  see: SeeApi;
  ready: Promise<void>;
}

declare global {
  interface Window {
    shipeasy?: ShipeasyGlobal;
  }
}

function readScriptDataset(): {
  sdkKey: string | null;
  baseUrl?: string;
  user: User;
} {
  // Find ourselves: the most recent <script data-sdk-key> wins.
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-sdk-key]"));
  const self = scripts[scripts.length - 1];
  if (!self) return { sdkKey: null, user: {} };

  const ds = self.dataset;
  const user: User = {};
  if (ds.userId) user.user_id = ds.userId;
  if (ds.userEmail) user.email = ds.userEmail;
  if (ds.userName) user.name = ds.userName;
  if (ds.userPlan) user.plan = ds.userPlan;
  if (ds.userProjectId) user.project_id = ds.userProjectId;

  // `data-attrs` is a JSON blob for arbitrary extra targeting attributes.
  if (ds.attrs) {
    try {
      const extra = JSON.parse(ds.attrs) as Record<string, unknown>;
      Object.assign(user, extra);
    } catch (err) {
      console.warn("[shipeasy] data-attrs is not valid JSON:", String(err));
    }
  }

  return {
    sdkKey: ds.sdkKey ?? null,
    baseUrl: ds.baseUrl,
    user,
  };
}

(function init() {
  if (typeof window === "undefined") return;
  if (window.shipeasy) return; // idempotent

  const { sdkKey, baseUrl, user } = readScriptDataset();
  if (!sdkKey) {
    console.warn("[shipeasy] loader.js: missing data-sdk-key");
    return;
  }

  // Go through the same one-configure-call entry npm consumers use, rather
  // than `new Engine(...)`. It sets the module singleton that `see()` reports
  // through — constructing an Engine directly leaves that null, so every
  // see() call would warn "called before shipeasy({ clientKey })" and drop the
  // error. It also injects the i18n loader and attaches the devtools overlay,
  // which a bare Engine skips. `autoIdentify: false` because we identify with
  // the tag's own user on the very next line — the default anon identify()
  // would burn a redundant /sdk/evaluate round-trip first.
  shipeasy({ clientKey: sdkKey, baseUrl, autoIdentify: false });
  const client = getShipeasyClient();
  if (!client) {
    console.warn("[shipeasy] loader.js: client failed to configure");
    return;
  }

  // Kick off the first identify immediately so flags are warm by the
  // time customer code calls getFlag / universe().assign(). The promise is
  // exposed as `shipeasy.ready` for callers that want to await it.
  const ready = client.identify(user).catch((err) => {
    console.warn("[shipeasy] identify failed:", String(err));
  });

  window.shipeasy = {
    getFlag: (name) => client.getFlag(name),
    getConfig: <T = unknown>(name: string) => client.getConfig(name) as T | undefined,
    getKillswitch: (name, switchKey) => client.getKillswitch(name, switchKey),
    universe: <P = Record<string, unknown>>(name: string) => client.universe<P>(name),
    identify: (next) => client.identify(next),
    track: (event, props) => client.track(event, props),
    see,
    ready,
  };
})();
