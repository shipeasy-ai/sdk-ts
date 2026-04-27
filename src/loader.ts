// Drop-in <script>-tag loader. Built to dist/loader/loader.global.js and
// served from the public R2 bucket so non-React customers can integrate
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
// The loader reads its own dataset, instantiates FlagsClientBrowser,
// auto-identifies, and exposes a small global API on `window.shipeasy`:
//
//   window.shipeasy.getFlag("my_gate")
//   window.shipeasy.getConfig("my_config")
//   window.shipeasy.getExperiment("my_exp", { defaultParam: 1 })
//   window.shipeasy.identify({ user_id: "u-1", plan: "pro" })
//   window.shipeasy.track("checkout_started", { value: 49 })
//
// React consumers should use @shipeasy/sdk-react's <ShipeasyProvider>
// instead — this loader is the easy onboarding path for vanilla HTML,
// Vue, Svelte, Rails ERB, etc.

import { FlagsClientBrowser, type ExperimentResult, type User } from "./client";

interface ShipeasyGlobal {
  getFlag(name: string): boolean;
  getConfig<T = unknown>(name: string): T | undefined;
  getExperiment<P extends Record<string, unknown>>(
    name: string,
    defaultParams: P,
  ): ExperimentResult<P>;
  identify(user: User): Promise<void>;
  track(event: string, props?: Record<string, unknown>): void;
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

  const client = new FlagsClientBrowser({ sdkKey, baseUrl });

  // Kick off the first identify immediately so flags are warm by the
  // time customer code calls getFlag / getExperiment. The promise is
  // exposed as `shipeasy.ready` for callers that want to await it.
  const ready = client.identify(user).catch((err) => {
    console.warn("[shipeasy] identify failed:", String(err));
  });

  window.shipeasy = {
    getFlag: (name) => client.getFlag(name),
    getConfig: <T = unknown>(name: string) => client.getConfig(name) as T | undefined,
    getExperiment: <P extends Record<string, unknown>>(name: string, defaultParams: P) =>
      client.getExperiment<P>(name, defaultParams),
    identify: (next) => client.identify(next),
    track: (event, props) => client.track(event, props),
    ready,
  };
})();
