# Advanced

LaunchDarkly / Statsig parity features. All are configured on the `Engine` (or
on `configure()` / `shipeasy()`, which forward Engine options).

## Manual exposure

By default reading an experiment fires one exposure beacon. To control exactly
when the exposure is logged (e.g. only when the treatment actually renders),
suppress auto-exposure and call `logExposure(name)` yourself.

```ts
// Read without logging an exposure…
const { params } = flags.getExperiment("hero_cta", { primary_label: "Sign up" }, {
  logExposure: false, // per-call opt-out (Engine form)
});
// …then log it at render time:
flags.logExposure("hero_cta"); // Engine / top-level facade
```

Set `disableAutoExposure: true` on the Engine to make manual exposure the
default for every read. The bound `Client` exposes `logExposure(name)` directly
(it forwards to the Engine for the bound user), so the snippet above works on the
same `Client` handle you read with — `flags.logExposure("hero_cta")`. The
`Engine` / top-level facade `logExposure` remains for code without a bound
`Client`.

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
company get the same variant. You can also force a default bucketing key at the
Engine level:

```ts
const engine = new Engine({ apiKey: KEY, bucketBy: "company_id" });
// now getFlag/getExperiment hash on user.company_id
```

When `bucketBy` is set, the value of that attribute is the hash unit; if it's
missing on the user, evaluation falls back to the standard identifier.

## Sticky bucketing

Lock a user into the **first variant they were assigned** even if the
experiment's allocation later changes. On by default in the browser (persisted
in the `__se_sticky` cookie so SSR server eval and the browser agree). Opt out
with `stickyBucketing: false`:

```ts
const engine = new Engine({ sdkKey: CLIENT_KEY, stickyBucketing: false });
```

On the server, provide a sticky store via the Engine options to persist
assignments across requests.

## Anonymous-id bucketing

The browser persists an `anonymous_id` (and the SSR bootstrap mints a matching
`__se_anon_id` cookie) so a logged-out visitor buckets **identically** before
and after the server pre-evaluation — no flag flicker on first paint.

## Change listeners

The server `Engine` fires listeners after a background poll returns **new** data
(HTTP 200, not 304). Returns an unsubscribe. Never fires in test/offline mode:

```ts
const engine = new Engine({ apiKey: KEY });
await engine.init();
const unsubscribe = engine.onChange(() => { /* re-evaluate / invalidate cache */ });
```

The browser `Engine` exposes the equivalent `subscribe()` (fires after each
`identify()` / override change).

## Devtools overlay

Press `Shift+Alt+S` on any page running the SDK (or append `?se=1`). The
Shipeasy devtools panel mounts in a Shadow DOM overlay and lets you flip every
gate / config / experiment / translation **for the current session only** —
handy for QA, demos, and bug repro.
