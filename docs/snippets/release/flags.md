Read a feature flag per user with a bound `Client`. Assumes `configure()` ran at startup — see Installation.

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user + runs the attributes transform)
const flags = new Client(currentUser);

// getFlag(name, defaultValue?)
//   name         — the flag/gate name
//   defaultValue — returned ONLY when the flag can't be evaluated
//                  (client not ready / flag not found); defaults to false
if (flags.getFlag("{{FLAG_KEY}}", false)) {
  // ship it
}
```
