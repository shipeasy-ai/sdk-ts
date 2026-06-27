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
