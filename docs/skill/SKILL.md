---
name: shipeasy-typescript
description: Use Shipeasy (feature flags, configs, kill switches, A/B experiments, i18n) from TypeScript / JavaScript. Covers configure() + Client(user), getFlag/getConfig/getKillswitch/getExperiment, track, testing, OpenFeature, and the see() error reporter — server (@shipeasy/sdk/server) and browser (@shipeasy/sdk/client).
---

# Shipeasy TypeScript SDK

`@shipeasy/sdk` — one package, two entrypoints: `@shipeasy/sdk/server` (Node /
Cloudflare Worker / Deno, **server** key) and `@shipeasy/sdk/client` (browser,
public **client** key). Everything works from vanilla JS.

> The documented surface is exactly **`configure()`** (setup) and the bound
> **`new Client(user)`** (use), plus the package-level helpers below. For deeper
> docs, fetch any page/snippet from the manifest at
> <https://shipeasy-ai.github.io/sdk/manifest.json> (raw page/snippet URLs below).

## Install

```bash
npm install @shipeasy/sdk
```

## Configure once, evaluate per user

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,           // browser: clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }), // optional; omit = identity
  // poll: true  // long-running server: keep flags fresh with a background poll (no engine.init() needed)
});

const flags = new Client(currentUser); // browser: await flags.ready() before first read

flags.getFlag("new_checkout");                         // boolean (2nd arg = default if not-ready/not-found)
flags.getConfig<{ max: number }>("limits", { defaultValue: { max: 50 } });
flags.getKillswitch("payments");                       // global on/off (not user-bound)
flags.getFlagDetail("new_checkout");                   // { value, reason }
```

`configure()` is first-config-wins and owns the fetch lifecycle (one-shot by
default; `poll: true` for a background refresh). Construct `new Client(user)` once
per user/request — it binds the user, so no method takes a user argument.
Full reference: <https://shipeasy-ai.github.io/sdk/pages/configuration.md> ·
<https://shipeasy-ai.github.io/sdk/pages/flags.md> ·
snippets <https://shipeasy-ai.github.io/sdk/snippets/release/flags.md> ·
<https://shipeasy-ai.github.io/sdk/snippets/release/configs.md> ·
<https://shipeasy-ai.github.io/sdk/snippets/release/killswitches.md>

## Experiments + track (Client-only, end to end)

```ts
const flags = new Client(currentUser); // construct once per callsite
const { inExperiment, group, params } = flags.getExperiment("hero_cta", {
  primary_label: "Sign up", // default params (control / not-enrolled)
});
render(params.primary_label);

flags.logExposure("hero_cta");          // record the exposure where you present it
flags.track("purchase", { value: 42 }); // record a conversion for the bound user
```

`ExperimentResult = { inExperiment: boolean; group: string; params: P }`. Full
reference: <https://shipeasy-ai.github.io/sdk/pages/experiments.md> · track snippet
<https://shipeasy-ai.github.io/sdk/snippets/metrics/track.md>

## i18n

Full i18n ships in this SDK. Wire the loader via the SSR bootstrap (no separate
init), then render with `i18n.t`:

```ts
import { i18n } from "@shipeasy/sdk/client";
i18n.t("checkout.cta", "Place order");
i18n.t("cart.count", "{count} items", { count: cart.length });
```

Full reference: <https://shipeasy-ai.github.io/sdk/pages/i18n.md> · snippets
<https://shipeasy-ai.github.io/sdk/snippets/i18n/setup.md> ·
<https://shipeasy-ai.github.io/sdk/snippets/i18n/render.md>

## Error reporting (see)

```ts
import { see } from "@shipeasy/sdk/server"; // or /client

try { await submitOrder(order); }
catch (e) { see(e).causes_the("checkout").to("use cached prices").extras({ order_id: order.id }); }

see.Violation("large query").causes_the("results").to("be trimmed").extras({ rows });
see.ControlFlowException(e).because("because it wasn't an encoded Foo"); // expected — reports nothing
```

Fire-and-forget on the next microtask (no `.send()`). Don't catch what you can't
name a consequence for. You may `see()` then re-throw (links as `caused_by`). Full
reference: <https://shipeasy-ai.github.io/sdk/pages/error-reporting.md> · snippet
<https://shipeasy-ai.github.io/sdk/snippets/ops/see.md>

## Testing — no network

```ts
import { configureForTesting, configureForOffline, Client, overrideFlag, clearOverrides } from "@shipeasy/sdk/server";

// Seed values up front; reads go through the ordinary new Client(user). Replaces
// prior config, so each test can reconfigure freely.
configureForTesting({
  flags: { new_checkout: true },
  configs: { limits: { max: 50 } },
  experiments: { hero_cta: ["treatment", { primary_label: "Buy now" }] },
});
const flags = new Client({ user_id: "u_1" });
flags.getFlag("new_checkout"); // true

overrideFlag("new_checkout", false); // flip on the spot
clearOverrides();                    // drop every override (incl. the seed)

// Offline: evaluate the REAL rules from a snapshot or JSON file, no network.
configureForOffline({ path: "./shipeasy-snapshot.json" });
// or: configureForOffline({ snapshot: { flags, experiments }, flags: { new_checkout: true } });
```

Full reference: <https://shipeasy-ai.github.io/sdk/pages/testing.md>

## OpenFeature

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-server"; // or /openfeature-web

// Assumes configure({ apiKey }) ran at startup — the no-arg provider resolves it.
await OpenFeature.setProviderAndWait(new ShipeasyProvider());
await OpenFeature.getClient().getBooleanValue("new_checkout", false, { targetingKey: "u1" });
```

Full reference: <https://shipeasy-ai.github.io/sdk/pages/openfeature.md>

## Advanced

`privateAttributes`, `bucketBy` (custom bucketing unit), `stickyBucketing`
(browser: on by default, `__se_sticky` cookie), manual exposure
(`getExperiment(..., { logExposure: false })` + `flags.logExposure(name)`),
`onChange(cb)` (requires `configure({ poll: true })`) / browser `subscribe()`.
Devtools overlay: `Shift+Alt+S` or `?se=1`. Full reference:
<https://shipeasy-ai.github.io/sdk/pages/advanced.md>
