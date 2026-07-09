# A/B experiments (`universe().assign()` + `track`)

Experiments are read by **universe**. A universe is a mutual-exclusion pool: a
unit lands in **at most one** experiment in it. `assign()` picks that experiment
(if any) and returns the assigned group plus its resolved parameters. You read
parameters with `assign(...).get(field, fallback)` — and on the **server** that
first `get()` is what auto-logs the single exposure (see
[Exposure logging](#exposure-logging)). Record a conversion with `track`.

## Read an experiment

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
const flags = new Client(req.user); // construct once per user (cheap)

// Ask the UNIVERSE, not the experiment: the unit lands in ≤1 experiment in it.
const cta = flags.universe("hero_cta").assign();

// Read a param: variant override ?? universe default ?? your fallback.
render(cta.get("primary_label", "Sign up"));
```

On the **server** the user is bound at construction, so `assign()` takes no
argument, and the exposure fires on the first param `get()` (peek with
`get(field, fallback, { exposure: false })`). In the **browser** the identified
visitor is global, so `assign()` also takes no user, and the exposure fires at
assign time (suppress with `assign({ logExposure: false })`).

## `Assignment`

```ts
interface Assignment {
  name: string | null;   // the experiment the unit landed in, or null when not enrolled
  group: string | null;  // the assigned variant, or null when not enrolled
  enrolled: boolean;     // === (group !== null) — reading it does NOT log an exposure
  // variant ?? universe default ?? fallback. On the server, the first read of an
  // enrolled assignment logs the single exposure; pass { exposure: false } to peek.
  get<T>(field: string, fallback?: T, opts?: { exposure?: boolean }): T | undefined;
}
```

When the unit isn't enrolled (targeting/holdout/allocation), `enrolled` is
`false`, `group` and `name` are `null`, and `get(field, fallback)` returns the
universe default if there is one, else your `fallback` — so reading a param is
always safe.

```ts
const cta = flags.universe("hero_cta").assign();
if (cta.enrolled) {
  // cta.group is the variant, e.g. "treatment"
}
const label = cta.get("primary_label", "Sign up"); // never throws
```

## Track conversions

Record the success event so the analysis pipeline can compute lift. Conversion
events are attributed to the bound user. You already have a `Client` — call
`track` on the **same handle**, so an experiment is end-to-end Client-only:

```ts
// Same bound Client you assigned with — no user arg.
// Server: derives the unit from the bound attributes (user_id, else anonymous_id).
// Browser: attributes the active (identified) user.
flags.track("{{SUCCESS_EVENT}}", { value: order.total });
```

`Client.track(event, props?)` takes the same shape on both entrypoints; the
unit is always inferred from the user you bound the `Client` to.

## Iterating over many users

When you don't have a single bound user — e.g. a batch job scoring many users —
construct a fresh `Client` per user inside the loop. It's cheap (it delegates to
the configuration built once at startup; it opens no connection):

```ts
for (const user of users) {
  const flags = new Client(user); // construct once per user (cheap)
  const cta = flags.universe("hero_cta").assign();
  flags.track("{{SUCCESS_EVENT}}", { group: cta.group });
}
```

## Exposure logging

Exposure is logged **on read**: on the **server** the single (deduped) exposure
fires the first time you read a param of an enrolled assignment via `get()` — so
an assignment that is computed but never read logs nothing. `assign()` itself is
side-effect free. Read without logging (peek) by passing `{ exposure: false }`:

```ts
const cta = flags.universe("hero_cta").assign();
const label = cta.get("primary_label", "Sign up", { exposure: false }); // peek — no exposure
// ... later, at the real decision point:
render(cta.get("primary_label", "Sign up")); // this read logs the single exposure
```

In the **browser** the exposure fires at `assign()` time instead (the visitor is
already resolved); suppress it with `assign({ logExposure: false })`. Either way
exposure is deduped per session and durably per `(unit, experiment, group)`
server-side. For finer control see
[Advanced → exposure control](./advanced.md).
