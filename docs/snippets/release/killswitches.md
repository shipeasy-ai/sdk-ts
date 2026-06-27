Read a kill switch (not user-bound — global on/off, optionally per-switch). Assumes `configure()` ran at startup — see Installation.

### Whole kill switch

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user)
const flags = new Client(currentUser);

// getKillswitch(name, switchKey?)
//   name      — the kill switch name
//   switchKey — optional; reads a single named override switch instead of
//               the whole-killswitch "killed" flag
if (flags.getKillswitch("{{KILLSWITCH_KEY}}")) {
  // killed — short-circuit the feature
}
```

### Named switch (with fallback)

```ts
const flags = new Client(currentUser); // construct once per callsite

// Pass the variable to gate as the switchKey. A CONFIGURED switch returns its
// own value; an UNCONFIGURED switch falls back to the whole-killswitch "killed"
// value — so this is always safe to call before any per-key override exists.
if (flags.getKillswitch("{{KILLSWITCH_KEY}}", "apple_pay")) {
  // the "apple_pay" switch is on (or the whole kill switch is killed)
}
```
