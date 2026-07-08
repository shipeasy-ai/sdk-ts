Assign a unit within a universe (a mutual-exclusion pool — the unit lands in ≤1 experiment), read the assigned params, then record the conversion event on the same bound `Client`. Assumes `configure()` ran at startup — see Installation.

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user + runs the attributes transform)
const flags = new Client(currentUser);

// universe(name).assign() → Assignment
//   name  — the UNIVERSE name (not an experiment); the unit lands in ≤1 experiment
//   .name     — the experiment the unit landed in, or null when not enrolled
//   .group    — the assigned variant, or null when not enrolled
//   .enrolled — === (group !== null)
//   .get(field, fallback) — variant override ?? universe default ?? fallback
// Server: assign() takes no arg (user bound at construction).
// Browser: assign(opts?) — opts.logExposure to force/suppress the exposure beacon.
const exp = flags.universe("{{EXPERIMENT_KEY}}").assign();

render(exp.get("primary_label", "Sign up")); // always safe — falls back when not enrolled

// On conversion — Client-only track (NOT the Engine); the unit is inferred
// from the bound user (user_id, else anonymous_id):
//   track(eventName, props?)
//     eventName — the success event name
//     props     — optional metric properties (private attrs are stripped)
flags.track("{{SUCCESS_EVENT}}", { group: exp.group }); // props optional
```
