Read an experiment's params, then record the conversion event on the same bound `Client`. Assumes `configure()` ran at startup — see Installation.

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user + runs the attributes transform)
const flags = new Client(currentUser);

// getExperiment<P>(name, defaultParams, decode?)
//   name          — the experiment name
//   defaultParams — params returned when NOT enrolled (control / holdout); also
//                   defines the param shape P
//   decode        — optional (raw) => P to validate/shape the group's params
const { inExperiment, group, params } = flags.getExperiment(
  "{{EXPERIMENT_KEY}}",
  { primary_label: "Sign up" }, // defaultParams (used when not enrolled)
);

render(params.primary_label);

// On conversion — Client-only track (NOT the Engine); the unit is inferred
// from the bound user (user_id, else anonymous_id):
//   track(eventName, props?)
//     eventName — the success event name
//     props     — optional metric properties (private attrs are stripped)
flags.track("{{SUCCESS_EVENT}}", { group }); // props optional
```
