# Advanced

LaunchDarkly / Statsig parity features. All are set as options on `configure()`
(or on `shipeasy()` for SSR), or read through the bound `Client`.

## Exposure control

One (deduped) exposure beacon is logged per enrolled unit. **When** it fires
differs by entrypoint, and both give you a way to suppress it:

- **Server** — exposure fires on the **first `get()` read** of an enrolled
  assignment, not at `assign()` time. To read without logging (peek), pass
  `{ exposure: false }`; the exposure then fires on the next real read.

  ```ts
  const flags = new Client(user); // construct once per callsite

  const cta = flags.universe("hero_cta").assign();
  // Peek the params WITHOUT logging an exposure:
  const preview = cta.get("primary_label", "Sign up", { exposure: false });

  // …at the moment you actually render the treatment, read normally to log it:
  render(cta.get("primary_label", "Sign up")); // logs the single exposure (deduped)
  ```

- **Browser** — exposure fires at `assign()` time (the visitor is already
  resolved). Suppress it with `assign({ logExposure: false })` and re-`assign()`
  with logging on at render, or make suppression the default for **every** read
  with `disableAutoExposure: true` on `configure()` and opt back in per callsite
  with `assign({ logExposure: true })`.

  ```ts
  const flags = new Client(visitor); // construct once per callsite

  const cta = flags.universe("hero_cta").assign({ logExposure: false });
  render(cta.get("primary_label", "Sign up"));

  flags.universe("hero_cta").assign(); // …log the exposure at render (deduped per session)
  ```

Either way the exposure is deduped per session and durably per
`(unit, experiment, group)` server-side.

## Private attributes

Attributes you mark private are used for **evaluation** but stripped from every
outbound `track()` payload (LD/Statsig `privateAttributes`):

```ts
configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,
  privateAttributes: ["email", "ip"],
});
```

On the browser they are still sent to `/sdk/evaluate` under `private_attributes`
so the edge can evaluate with them (unavoidable), but they never appear in
tracked event props.

## `bucketBy` — custom bucketing unit

Bucketing hashes on `user_id` (falling back to `anonymous_id`) by default. An
experiment can carry its own `bucketBy` (e.g. `company_id`) so all users in a
company get the same variant — set on the experiment in the dashboard, no SDK
change needed. When `bucketBy` is set, the value of that attribute is the hash
unit; if it's missing on the user, evaluation falls back to the standard
identifier. Make sure your `attributes` transform surfaces the bucketing
attribute:

```ts
configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,
  attributes: (u: MyUser) => ({ user_id: u.id, company_id: u.orgId }),
});
```

## Sticky bucketing

Lock a unit into the **first variant it was assigned** even if the experiment's
allocation later changes. On the server, pass a `stickyStore` to `configure()`
to persist assignments across requests:

```ts
import { configure, createInMemoryStickyStore } from "@shipeasy/sdk/server";

configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,
  stickyStore: createInMemoryStickyStore(), // or a cookie-bridge over __se_sticky
});
```

`createInMemoryStickyStore()` is process-local (good for a single-process server
or tests); for a multi-process deployment back the `StickyBucketStore` interface
(`get(unit)` / `set(unit, exp, entry)`) with shared storage or a request-cookie
bridge. In the browser, sticky bucketing is on by default (persisted in the
`__se_sticky` cookie so SSR server eval and the browser agree).

## Anonymous-id bucketing

The browser persists an `anonymous_id` (and the SSR bootstrap mints a matching
`__se_anon_id` cookie) so a logged-out visitor buckets **identically** before
and after the server pre-evaluation — no flag flicker on first paint.

## Change listeners

The package-level `onChange()` fires after a background poll returns **new** data
(HTTP 200, not 304) and returns an unsubscribe callable. It requires
`configure({ poll: true })` (no poll thread runs otherwise) and never fires in
test/offline mode:

```ts
import { configure, onChange } from "@shipeasy/sdk/server";

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!, poll: true });

const unsubscribe = onChange(() => { /* re-evaluate / invalidate cache */ });
```

In the browser, `onChange()` fires after each `identify()` / override change.

## Devtools overlay

Press `Shift+Alt+S` on any page running the SDK (or append `?se=1`). The
Shipeasy devtools panel mounts in a Shadow DOM overlay and lets you flip every
gate / config / experiment / translation **for the current session only** —
handy for QA, demos, and bug repro.
