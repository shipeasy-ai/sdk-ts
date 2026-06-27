# Overview

`@shipeasy/sdk` is the TypeScript / JavaScript SDK for the [Shipeasy](https://shipeasy.ai)
hosted platform — feature gates, runtime configs, kill switches, A/B
experiments, metrics, and i18n. It ships **two entrypoints** from one package:

- `@shipeasy/sdk/server` — Node, Cloudflare Workers, Deno (authenticates with
  the **server** key).
- `@shipeasy/sdk/client` — the browser (authenticates with the public
  **client** key).

The APIs are framework-agnostic: everything works from vanilla JS. React
conveniences live in the separate `@shipeasy/sdk-react` wrapper.

## Mental model: `configure()` once, then `new Client(user)`

Configure the SDK **once** at app startup with your key and an optional
`attributes` transform from your own user object to Shipeasy targeting
attributes. Then evaluate **per user** with `new Client(user)`. The bound
`Client` takes no user argument on its methods — the user is bound at
construction.

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!,
            attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }) });

const flags = new Client(currentUser);
if (flags.getFlag("new_checkout")) { /* ship it */ }
```

## Engine vs Client

- **`Engine`** is the heavyweight singleton — it owns the key, the HTTP
  transport, the blob cache, and the poll timer. `configure()` builds one
  process-wide Engine for you. (It was named `FlagsClient` / `FlagsClientBrowser`
  before 6.0.0.)
- **`Client(user)`** is a cheap, user-bound handle over that shared Engine. It
  opens no connection and runs no poller — it just binds the resolved
  attribute bag once at construction. Construct one per user / per request. It
  exposes `getFlag`, `getFlagDetail`, `getConfig`, `getExperiment`,
  `getKillswitch`, plus `track(event, props?)` and `logExposure(name)` — so
  reading an experiment **and** recording its conversion/exposure are
  end-to-end Client-only (no need to drop to the Engine).

You can also drive an `Engine` directly when you don't want the configure-once
front door (see [Configuration](./configuration.md) and [Advanced](./advanced.md)).

## Where to go next

| Page | What it covers |
| --- | --- |
| [Installation](./installation.md) | install command, runtime versions, import lines |
| [Configuration](./configuration.md) | `configure()`, `attributes`, env vars, SSR bootstrap |
| [Flags](./flags.md) | `getFlag`, `getFlagDetail`, defaults |
| [Configs](./configs.md) | `getConfig` typed values + defaults |
| [Kill switches](./killswitches.md) | `getKillswitch` semantics |
| [Experiments](./experiments.md) | `getExperiment`, `ExperimentResult`, `track` |
| [i18n](./i18n.md) | loader, SSR bootstrap, `i18n.t()` |
| [Error reporting](./error-reporting.md) | `see()` grammar |
| [Testing](./testing.md) | `forTesting()`, `override*`, `fromFile`/`fromSnapshot` |
| [OpenFeature](./openfeature.md) | server + web providers |
| [Advanced](./advanced.md) | manual exposure, private attrs, bucketBy, sticky |
