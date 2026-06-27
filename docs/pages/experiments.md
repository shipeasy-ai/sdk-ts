# A/B experiments (`getExperiment` + `track`)

`getExperiment` enrolls a user into an experiment and returns the assigned
group plus its parameters. You read parameters from the result and record a
conversion with `track`.

## Read an experiment

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
const flags = new Client(req.user);

const { inExperiment, group, params } = flags.getExperiment("hero_cta", {
  primary_label: "Sign up", // default params (the control / not-enrolled value)
});

render(params.primary_label);
```

## `ExperimentResult`

```ts
interface ExperimentResult<P> {
  inExperiment: boolean;             // false if not enrolled (targeting/holdout/allocation)
  group: string;                     // "control" | "treatment" | … (your variation key)
  params: P;                         // the variation's params, or your defaults
}
```

When the user isn't enrolled, `inExperiment` is `false`, `group` is `"control"`,
and `params` is exactly the `defaultParams` you passed — so reading
`params.<key>` is always safe.

### Decoding params

Pass an optional `decode` to validate/shape the params:

```ts
const { params } = flags.getExperiment(
  "hero_cta",
  { primary_label: "Sign up" },
  (raw) => HeroSchema.parse(raw),
);
```

## Track conversions

Record the success event so the analysis pipeline can compute lift. Conversion
events are attributed to the enrolled user. You already have a `Client` from
`getExperiment` — call `track` on the **same handle**, so an experiment is
end-to-end Client-only:

```ts
// Same bound Client you read the experiment with — no user arg.
// Server: derives the unit from the bound attributes (user_id, else anonymous_id).
// Browser: attributes the active (identified) user.
flags.track("{{SUCCESS_EVENT}}", { value: order.total });
```

`Client.track(event, props?)` takes the same shape on both entrypoints; the
unit is always inferred from the user you bound the `Client` to.

## Manual exposure on the bound `Client`

When you read with auto-exposure disabled, log the exposure at the treatment's
render with `logExposure` on the same handle:

```ts
const { params } = flags.getExperiment("hero_cta", { primary_label: "Sign up" });
// …at the moment you actually render the treatment:
flags.logExposure("hero_cta");
```

On the server `logExposure(name)` re-evaluates enrolment for the bound
attributes and emits the exposure; in the browser it forwards for the identified
visitor (no-op when the user isn't enrolled). See
[Advanced → manual exposure](./advanced.md) for the read-side flag.

## Iterating over many users

When you don't have a single bound user — e.g. a batch job scoring many users —
construct a fresh `Client` per user inside the loop. It's cheap (it delegates to
the configuration built once at startup; it opens no connection):

```ts
for (const user of users) {
  const flags = new Client(user); // construct once per user (cheap)
  const { group } = flags.getExperiment("hero_cta", { primary_label: "Sign up" });
  flags.track("{{SUCCESS_EVENT}}", { group });
}
```

## Exposure logging

By default reading an experiment logs an exposure. To control exactly when the
exposure fires (e.g. log on render of the treatment, not on read), see
[Advanced → manual exposure](./advanced.md).
