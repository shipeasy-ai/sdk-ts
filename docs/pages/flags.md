# Feature flags (`getFlag`)

A flag (a.k.a. a **gate**) evaluates to a `boolean` for a given user.

## Read a flag

Configure once at startup, then bind the user and read:

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });

const flags = new Client(req.user); // construct once per callsite
if (flags.getFlag("new_checkout")) { /* ship it */ }
```

Browser is identical, swapping the entrypoint + key:

```ts
import { configure, Client } from "@shipeasy/sdk/client";

configure({ clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY! });
const flags = new Client(currentUser);
await flags.ready();
flags.getFlag("new_checkout"); // boolean
```

## Default / fallback behaviour

`getFlag` takes a caller-supplied default returned **only when the value can't
be evaluated** — the client isn't initialized yet, or the key isn't in the
loaded rules. A flag that legitimately evaluates to `false` (disabled, rule
denied, rolled out to 0%) still returns `false`, never the default.

```ts
const flags = new Client(req.user);   // construct once per callsite

flags.getFlag("new_checkout");        // false for a missing/disabled flag
flags.getFlag("new_checkout", true);  // true ONLY if not-ready / not-found
```

## Evaluation detail — `getFlagDetail`

`getFlagDetail` returns `{ value, reason }` (LaunchDarkly `variationDetail`
parity) so you can see *why* a flag resolved:

```ts
import type { FlagReason } from "@shipeasy/sdk/server"; // or /client

const d = flags.getFlagDetail("new_checkout"); // bound Client
// → { value: true, reason: "RULE_MATCH" }
```

| `FlagReason` | meaning |
| --- | --- |
| `CLIENT_NOT_READY` | no rules loaded yet (`init()` / `identify()` pending) |
| `FLAG_NOT_FOUND` | the gate name isn't in the loaded rules |
| `OFF` | the gate exists but is disabled / killed (server only) |
| `OVERRIDE` | a local override (or `?se_gate_…` URL override) decided it |
| `RULE_MATCH` | the gate evaluated `true` |
| `DEFAULT` | the gate evaluated `false` |

`getFlag` is implemented on top of `getFlagDetail` (single evaluation, single
telemetry beacon). On the browser the server pre-evaluates enabled/killed state,
so `OFF` folds into `DEFAULT` there.
