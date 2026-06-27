Read a kill switch (not user-bound — global on/off, optionally per-switch). Assumes `configure()` ran at startup — see Installation.

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user)
const flags = new Client(currentUser);

// getKillswitch(name, switchKey?)
//   name      — the kill switch name
//   switchKey — optional; reads a single named override switch instead of
//               the whole-killswitch "killed" flag
if (flags.getKillswitch("{{RESOURCE_NAME}}")) {
  // killed — short-circuit the feature
}
```
