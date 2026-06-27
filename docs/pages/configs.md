# Dynamic configs (`getConfig`)

A dynamic config is a typed JSON value (with targeting) you read at runtime —
remote config without a deploy.

## Read a typed value

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
const flags = new Client(req.user);

const cfg = flags.getConfig<{ max_uploads: number }>("upload_limits");
// → { max_uploads: 50 } | undefined
```

`getConfig<T>(name)` returns `T | undefined` — `undefined` when the config key
isn't in the loaded rules or the client isn't ready yet.

## Defaults

Pass a `defaultValue` via the options object to get a guaranteed value:

```ts
flags.getConfig("plan_limits", { defaultValue: { max: 50 } });
// → the config value, or { max: 50 } when the key is absent / not ready
```

## Decoding

Two equivalent forms — a `decode` callback (legacy) or the additive options
object (`{ decode?, defaultValue? }`):

```ts
// callback form
flags.getConfig("limits", (raw) => LimitsSchema.parse(raw));

// options form (additive — pair decode + defaultValue)
flags.getConfig("limits", {
  decode: (raw) => LimitsSchema.parse(raw),
  defaultValue: { max: 50 },
});
```

`zod` is an optional peer dependency — use it (or any validator) inside the
`decode` callback. If `decode` throws, the SDK warns and falls back to the
default / `undefined`.

> A dynamic config is not user-targeting-bound the way a flag is — it resolves
> from the loaded rules blob — but it is still read through the same bound
> `Client` so there is one read surface for everything.
