# Installation & configuration

One npm package, two entrypoints — `@shipeasy/sdk/server` (Node / Cloudflare
Worker / Deno, **server key**) and `@shipeasy/sdk/client` (browser, public
**client key**). This page is the canonical home for **`configure()`**: install
+ minimal wiring for the main TypeScript/JS frameworks, plus the one place each
key, the `attributes` transform, the identity default, and init-vs-one-shot live.

## Install

```bash
npm install @shipeasy/sdk
# or
pnpm add @shipeasy/sdk
# or
yarn add @shipeasy/sdk
```

The only runtime dependency is `murmurhash-js`. `zod` is an **optional** peer
dependency (only needed if you decode configs/experiments with a Zod schema).

### Runtime requirements

- **Node** ≥ 18 (server build; also runs on Cloudflare Workers and Deno).
- Any evergreen **browser** for the `/client` build.
- TypeScript ≥ 5 recommended (full types ship with the package).

### Entrypoints / import lines

```ts
// Server (Node / Cloudflare Worker / Deno) — uses the SERVER key
import { configure, Client, see } from "@shipeasy/sdk/server";

// Browser — uses the public CLIENT key
import { configure, Client, see, i18n } from "@shipeasy/sdk/client";

// Next.js App Router SSR bootstrap handle (server entry)
import { shipeasy } from "@shipeasy/sdk/server";

// OpenFeature providers (optional peer deps)
import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-server";
import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-web";
```

> **One key per entrypoint.** The server entry takes the **server** key
> (`configure({ apiKey })` / `shipeasy({ serverKey })`); the browser entry takes
> the public **client** key (`configure({ clientKey })`). Never pass `clientKey`
> to the server entry or the server key to the browser entry.

## `configure()` — the front door

Call `configure()` **once at app boot**, then evaluate per user with
`new Client(user)`. `configure()` builds the process-wide machinery (HTTP + blob
cache + poll lifecycle) and registers your `attributes` transform. The first
call wins (later calls are no-ops).

| Option | Side | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | server | — | **server** key (required on `@shipeasy/sdk/server`) |
| `clientKey` | browser | — | public **client** key (required on `@shipeasy/sdk/client`) |
| `attributes` | both | identity | `(yourUser) => ({ user_id, anonymous_id?, ...targeting })` — runs once per `new Client(user)`. Omit ⇒ **identity** transform (you must pass the attribute bag verbatim). |
| `poll` | server | `false` | `true` ⇒ start the **background poll** (initial fetch + periodic refresh) so rules stay fresh on a long-running server. The poll lifecycle lives inside the SDK — you never call an init method yourself. |
| `init` | server | `true` | One-shot fire-and-forget fetch on `configure()` (serverless-friendly). Ignored when `poll: true` (the poll does the initial fetch). Set `false` only to control the first fetch yourself. |
| `baseUrl` | both | `https://cdn.shipeasy.ai` | override the CDN/edge base |
| `env` | server | `prod` | which published env to read (`dev` / `staging` / `prod`) |
| `disableTelemetry` | both | `false` | turn off per-evaluation usage beacons. On Cloudflare Workers each beacon is an outbound subrequest (cap 50 free / 1000 paid per invocation), so set `true` on hot paths that evaluate many flags per request. |
| `privateAttributes` | both | `[]` | attribute names usable for targeting but stripped from every outbound `track()` payload (LD/Statsig `privateAttributes`). |
| `stickyStore` | server | — | a sticky-bucketing store so an enrolled unit stays in its first-assigned variant across requests even when allocation changes — see [Advanced → sticky bucketing](./advanced.md). |

`configure()` is **first-config-wins**: the first call builds the process-wide
state, later calls are no-ops. The test/offline siblings
`configureForTesting()` / `configureForOffline()` (see [Testing](./testing.md))
**replace** it so a suite can reconfigure between cases.

**Identity / bucketing unit.** Bucketing hashes on `user_id`, falling back to
`anonymous_id`. To bucket a whole org together, the experiment/gate carries a
`bucketBy` (e.g. `company_id`) — see [Advanced](./advanced.md).

**Env vars (convention).** `SHIPEASY_SERVER_KEY` (server, `configure({ apiKey })`
/ `shipeasy({ serverKey })`) and `NEXT_PUBLIC_SHIPEASY_CLIENT_KEY` (browser,
`configure({ clientKey })`).

---

## Next.js (App Router)

Next.js spans both sides: the **server** evaluates in Server Components / Route
Handlers, and the **browser** SDK reads on the client. Two wiring pieces:

### 1. Root layout — SSR bootstrap (server key)

`shipeasy({ serverKey })` pre-evaluates flags/configs/experiments and emits two
declarative `<script>` tags so the browser SDK reads them **synchronously on
first paint**. No SDK key is embedded in the bootstrap tag.

```tsx
// app/layout.tsx — React Server Component
import { shipeasy } from "@shipeasy/sdk/server";

export default async function RootLayout({ children }) {
  const se = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });
  const boot = se.getBootstrapData({
    clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY, // public client key
  });
  return (
    <html>
      <body>
        {/* Render REAL <script> elements — dangerouslySetInnerHTML scripts do NOT run. */}
        <script src={boot.bootstrap.src} {...boot.bootstrap.attrs} />
        {boot.i18nLoader && <script src={boot.i18nLoader.src} {...boot.i18nLoader.attrs} />}
        {children}
      </body>
    </html>
  );
}
```

For server-side reads in a Server Component / Route Handler, also `configure()`
the server engine once and bind per request:

```ts
import { configure, Client } from "@shipeasy/sdk/server";

configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!, // SERVER key
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan, country: u.geo.country }),
});

const flags = new Client(currentUser);
if (flags.getFlag("new_checkout")) { /* ... */ }
```

### 2. Browser entry — `"use client"` (client key)

Configure the browser SDK once at startup (e.g. a client component mounted in
the root layout):

```tsx
"use client";
import { useEffect } from "react";
import { configure } from "@shipeasy/sdk/client";

export function ShipeasyClient() {
  useEffect(() => {
    configure({
      clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!, // public CLIENT key
      attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
    });
  }, []);
  return null;
}
```

Then in any `"use client"` component:

```tsx
"use client";
import { Client } from "@shipeasy/sdk/client";

const flags = new Client(currentUser); // construct once per visitor
await flags.ready();                    // optional — await first /sdk/evaluate
if (flags.getFlag("new_checkout")) { /* ... */ }
```

> For React projects, [`@shipeasy/sdk-react`](https://github.com/shipeasy-ai/sdk-react)
> wraps this package with a `<ShipeasyProvider>` and hooks (thin layer over the
> same vanilla API).

---

## Express / Node

`configure()` kicks off a one-shot fetch, so the first `new Client(user)`
resolves against real rules with no extra wiring. For a long-running server that
should keep rules fresh, pass `poll: true` so the SDK runs the background refresh
for you — you never call an init method yourself.

```ts
import express from "express";
import { configure, Client } from "@shipeasy/sdk/server";

// Once, at boot — poll: true keeps rules fresh on a long-running server:
configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!, // SERVER key
  attributes: (u) => ({ user_id: u.id, plan: u.plan }),
  poll: true,
});

const app = express();
app.get("/checkout", (req, res) => {
  const flags = new Client(req.user); // construct once per request (cheap)
  if (flags.getFlag("new_checkout")) return res.render("checkout-v2");
  res.render("checkout");
});
```

For non-React SSR (Express + a template engine) you can still emit the bootstrap
tags: `se.getBootstrapTags()` returns the same two tags as an HTML string.

---

## Cloudflare Workers

The server build runs on `workerd`. Configure once at module scope; bind per
fetch. Disable per-evaluation telemetry on hot paths — each beacon is an
outbound subrequest (cap 50 free / 1000 paid per invocation).

```ts
import { configure, Client } from "@shipeasy/sdk/server";

configure({
  apiKey: globalThis.SHIPEASY_SERVER_KEY ?? "", // SERVER key (from env binding)
  disableTelemetry: true,                       // hot path — skip per-eval beacons
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const flags = new Client({ user_id: env.USER_ID }); // construct once per request
    const v2 = flags.getFlag("new_checkout");
    return new Response(v2 ? "v2" : "v1");
  },
};
```

> Workers isolates are short-lived — `configure()`'s one-shot fetch warms the
> blob; the CDN response is cached, so cold starts stay cheap. Use `poll: true`
> only on long-lived Node servers, not per-request Worker isolates.

---

## Browser / React (`"use client"`)

When you ship the SDK to the browser **without** Next.js SSR (a plain SPA or a
React app), configure once at app startup with the public client key:

```tsx
"use client";
import { useEffect } from "react";
import { configure, Client } from "@shipeasy/sdk/client";

// Once, at app startup (e.g. root useEffect):
function bootstrap() {
  configure({
    clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!, // public CLIENT key
    attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
  });
}

// Per visitor:
const flags = new Client(currentUser); // construct once per visitor
await flags.ready();                    // optional — await first /sdk/evaluate
flags.getFlag("new_checkout");
```

The browser is single-user: `new Client(user)` runs the transform and
`identify()`s the result, merging browser context (`locale`, `timezone`,
`path`, `referrer`, `screen_*`, `user_agent`) and a persisted `anonymous_id`.

### No-bundler script loader

For sites without a build step, drop the script loader in — no `npm install`,
no `configure()` call (the tag attributes ARE the configuration):

```html
<script
  src="https://cdn.shipeasy.ai/sdk/loader.js"
  data-sdk-key="sdk_client_..."
  data-user-id="user-123"
  data-attrs='{"plan":"pro","country":"US"}'
  defer
></script>
<script>
  await window.shipeasy.ready;
  if (window.shipeasy.getFlag("new_checkout")) { /* … */ }
</script>
```

---

## React Native / Expo

The `@shipeasy/sdk/client` build is **React Native safe**. Metro resolves the
package's `react-native` condition to the same client build, and the SDK detects
the absence of a DOM at runtime, so `configure()` / `new Client(user)` /
`getFlag` / `getConfig` / `universe().assign()` / `track` / `see` all work over `fetch`
— no polyfills, no `react-native-url-polyfill`, no `window`/`document` shims.

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { configure, Client } from "@shipeasy/sdk/client";

// Once, at app startup:
configure({
  clientKey: process.env.EXPO_PUBLIC_SHIPEASY_CLIENT_KEY!, // public CLIENT key
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
  // Persist the anonymous id so bucketing is stable across app launches
  // (there is no cookie / localStorage in React Native). Optional.
  anonymousStore: {
    get: (k) => AsyncStorage.getItem(k),
    set: (k, v) => AsyncStorage.setItem(k, v),
    remove: (k) => AsyncStorage.removeItem(k),
  },
});

// Per user:
const flags = new Client(currentUser); // construct once per visitor
await flags.ready();                    // optional — await first /sdk/evaluate
if (flags.getFlag("new_checkout")) { /* … */ }
```

**`anonymousStore`** is the one piece worth wiring: its `get`/`set`/`remove`
(sync or async — the SDK awaits either) back the anonymous id with a real store,
so `await flags.ready()` resolves against a stable id that survives restarts. On
a fresh install the SDK mints an id and persists it; on later launches it adopts
the stored one. Omit it and the anon id simply regenerates per session — passing
a stable `user_id` via `attributes` also gives you durable bucketing.

What else differs from a browser (all graceful — the SDK degrades, never throws):

- **No DOM lifecycle listeners.** There is no `beforeunload`/`visibilitychange`
  in React Native, so the event buffer flushes on its 5s timer and on explicit
  `track()` — not on tab-hide.
- **Auto web-vitals, the devtools overlay, and loader-driven i18n are skipped** —
  they are DOM-only. Flags, configs, experiments, `track()`, and `see()` error
  reporting are unaffected.

---

## Where to go next

See [Configuration](./configuration.md) for the full `attributes`, identity, and
SSR-bootstrap reference, and [Testing](./testing.md) for the network-free
`configureForTesting()` / `configureForOffline()` siblings.
