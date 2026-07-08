# Configuration

Configure the SDK **once** at app boot, then evaluate per user with
`new Client(user)`. `configure()` builds the process-wide machinery (HTTP +
blob cache + poll lifecycle) and registers your `attributes` transform.

## Server

```ts
import { configure, Client } from "@shipeasy/sdk/server";

configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!, // the SERVER key
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan, country: u.geo.country }),
});

// Per request:
const flags = new Client(req.user);
if (flags.getFlag("new_checkout")) { /* ... */ }
```

`configure()` kicks off a one-shot fetch so the first
`new Client(user).getFlag(...)` resolves against real rules with no extra
wiring. For a long-running server that should keep rules fresh, pass `poll: true`
and the SDK runs the background refresh for you:

```ts
configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!, poll: true });
```

## Browser

```ts
import { configure, Client } from "@shipeasy/sdk/client";

configure({
  clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!, // the CLIENT key
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
});

const flags = new Client(currentUser);
await flags.ready(); // optional — await the first /sdk/evaluate round-trip
flags.getFlag("new_checkout");
```

The browser is single-user: `new Client(user)` runs the transform and
`identify()`s the result, merging browser context (`locale`, `timezone`,
`path`, `referrer`, `screen_*`, `user_agent`) and a persisted `anonymous_id`.

## Fail-safe reads & the `logLevel` option

Every **runtime** method the SDK exposes — `getFlag`, `getFlagDetail`,
`getConfig`, `universe(name).assign()`, `getKillswitch`, `track`, and
`see()` — is guaranteed to **never throw** into your code. If anything goes wrong
internally (a bad `decode` callback, a malformed value, an unexpected state) the
call fails silently: it returns the documented safe default (`false` /
`undefined` / the not-enrolled result) and reports the swallowed error on
`console` so you still find out. A feature-flag read can never take down a
request.

`logLevel` controls how loud that reporting is:

```ts
configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,
  logLevel: "warn", // default — "silent" | "error" | "warn" | "info" | "debug"
});
```

Ordering is `silent < error < warn < info < debug`; a level prints everything at
or below it. The default `"warn"` prints `error` + `warn` and stays quiet
otherwise. Pass `"silent"` to mute the SDK entirely. The same option exists on
the browser `configure({ clientKey, logLevel })` and on the SSR
`shipeasy({ serverKey, logLevel })` helper.

When one of these last-resort guards catches an internal SDK failure — a bug on
*our* side, not yours — the SDK also reports it to **Shipeasy's own** project so
we can find and fix SDK bugs across the apps that run it. This never touches
your project or your Errors tab, carries no user/app data beyond the error
itself, and is fire-and-forget (it can never slow down or break a read). It is
on by default; opt out with `disableInternalErrorReporting: true` on any of the
`configure({ apiKey })`, browser `configure({ clientKey })`, or
`shipeasy({ serverKey })` entry points.

> Setup is deliberately still loud: constructing `new Client(user)` before
> `configure()`, or loading a bad offline snapshot, throws — those are boot-time
> misconfigurations you want to see immediately, not per-request runtime reads.

## The `attributes` transform

`attributes` maps **your** user object into the Shipeasy attribute bag that
every flag / experiment evaluation sees. It runs once per `new Client(user)`.

```ts
type AttributesFn<U> = (user: U) => User; // User = { user_id?, anonymous_id?, ...targeting }
```

When you **omit** `attributes`, the transform is the **identity** function — the
object you pass to `new Client(...)` is used verbatim, so it must already be the
attribute bag (`{ user_id, anonymous_id, ...targeting }`).

## Identity / bucketing unit

Bucketing hashes on `user_id` (falling back to `anonymous_id`). To bucket on a
different attribute (e.g. `company_id`), the experiment carries a `bucketBy` —
make sure your `attributes` transform surfaces that attribute. See
[Advanced](./advanced.md).

## Network & telemetry defaults (environment-derived)

The SDK is **quiet by default outside production** — an app that embeds it never
phones home from a local dev machine or a CI run. Two switches control egress,
and both **default to ON in production and OFF everywhere else**:

| Option | Controls | Default |
| --- | --- | --- |
| `isNetworkEnabled` | **Any** outbound request — flag/experiment fetches, `track()`, exposure logging, `see()` reports, usage telemetry, internal error self-monitoring. When `false` the SDK is fully offline: reads return code defaults / overrides. | `true` in prod, `false` otherwise |
| `disableTelemetry` | Just the per-evaluation usage telemetry beacon ("tracking"/outside logging). | telemetry ON in prod, OFF otherwise |

Production is inferred, in order:

1. `SHIPEASY_ENV`, then `NODE_ENV` — a value of `production`/`prod` ⇒ production.
2. When neither is set (e.g. a Cloudflare Worker, or the browser, where there is
   no native `NODE_ENV`), the SDK's own `env` option is used — and it defaults to
   `"prod"`. So a real production deploy stays **on** by default; set `env: "dev"`
   (or pass the switch explicitly) to keep a non-standard build quiet.

Pass either option explicitly to override the environment default:

```ts
// Force the SDK fully offline regardless of environment (no requests at all):
configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!, isNetworkEnabled: false });

// Keep flag fetching but never emit usage telemetry:
configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!, disableTelemetry: true });
```

Both options exist identically on the browser `configure({ clientKey, … })` and
the SSR `shipeasy({ serverKey, … })` entry points. `isNetworkEnabled: false` is
the production-safe equivalent of the test/offline modes below.

## Test & offline configuration

For tests, swap `configure()` for `configureForTesting()` (no network, seed
overrides) or `configureForOffline()` (evaluate real rules from a captured
snapshot). Both replace the active configuration and are read through the same
`new Client(user)` — see [Testing](./testing.md).

## SSR bootstrap (flags on first paint)

Server-render evaluated flags / configs / experiments so the browser SDK reads
them **synchronously on first paint** — no flash, no extra round-trip. The
`shipeasy()` server handle emits two declarative `<script>` tags. **No SDK key
is embedded** in the bootstrap tag.

```tsx
// app/layout.tsx — Next.js root layout (React Server Component)
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

For non-React SSR (Express, raw templates), `se.getBootstrapTags()` returns the
same two tags as an HTML string. See [i18n](./i18n.md) for the loader details.

## Environment variables (convention)

| Variable | Side | Purpose |
| --- | --- | --- |
| `SHIPEASY_SERVER_KEY` | server | server key for `configure({ apiKey })` / `shipeasy({ serverKey })` |
| `NEXT_PUBLIC_SHIPEASY_CLIENT_KEY` | browser | public client key for `configure({ clientKey })` |
