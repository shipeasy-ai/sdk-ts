# Testing

For unit tests, swap the live `configure()` for **`configureForTesting()`** —
a drop-in sibling with **no network, ever** (no SDK key required). It replaces
the active configuration with a network-free engine, seeds the values your code
should see, and is read through the ordinary `new Client(user)`. In this mode
the rules never fetch, `track()` is a no-op, `assign()` logs no exposure, and
telemetry is off — your tests never touch the network.

```ts
import { configureForTesting, Client, clearOverrides } from "@shipeasy/sdk/server"; // or /client

// Seed everything the code under test should see (no key, no network):
configureForTesting({
  flags: { new_checkout: true },
  configs: { upload_limits: { max_uploads: 50 } },
});

const flags = new Client({ user_id: "u_1" }); // construct once per callsite
flags.getFlag("new_checkout");                 // true
flags.getConfig("upload_limits");              // { max_uploads: 50 }

clearOverrides(); // reset every seeded override back to the empty-blob default
```

To assert an **experiment** assignment, seed a real universe + experiment with
`configureForOffline()` (below) — an experiment override refines an experiment
that lives in a universe; it doesn't invent one in an empty universe. Read it
with `universe(name).assign()`:

```ts
const exp = new Client({ user_id: "u_1" }).universe("hero_cta").assign();
exp.enrolled;                 // true when the seeded experiment enrolled the unit
exp.group;                    // the assigned variant, or null
exp.get("primary_label", "Sign up"); // variant ?? universe default ?? fallback
```

`configureForTesting()` / `configureForOffline()` **replace** the active
configuration (unlike `configure()`, which is first-config-wins), so a suite can
reconfigure freely between cases.

## Seed shapes

`configureForTesting({ flags?, configs?, experiments?, attributes? })`:

| Field | Shape | Effect |
| --- | --- | --- |
| `flags` | `{ [name]: boolean }` | forced `getFlag` results |
| `configs` | `{ [name]: value }` | forced `getConfig` results |
| `experiments` | `{ [name]: [group, params] }` | forced enrolment for an experiment that exists in a universe (see below) |
| `attributes` | `(yourUser) => User` | same transform as `configure()` (default identity) |

An `experiments` seed (and `overrideExperiment`) **refines** an experiment that
already lives in a universe — it forces that experiment's variant. It does not
invent an experiment in an empty universe, and it is read by universe, not by
experiment name. Seed the universe + experiment via `configureForOffline()`, then
force the variant. On an empty test-mode blob (no snapshot) `universe().assign()`
returns not-enrolled regardless of the seed.

## Package-level overrides (on the spot)

Layer a quick override on top of whatever `configureForTesting()` /
`configureForOffline()` (or even a live `configure()`) set up. These are
package-level — no object to hold:

```ts
import {
  overrideFlag,
  overrideConfig,
  overrideExperiment,
  clearOverrides,
} from "@shipeasy/sdk/server"; // or /client

overrideFlag("new_checkout", true);
overrideConfig("upload_limits", { max_uploads: 50 });
overrideExperiment("hero_cta", "treatment", { primary_label: "Buy now" });
// …read through `new Client(user)` …
clearOverrides(); // drop every on-the-spot override
```

A programmatic override always **wins** over the fetched/seeded value. In the
browser the precedence is: programmatic override > URL/devtools override
(`?se_ks_…` / `?se_cf_…` / `?se_exp_…`) > the server's evaluation.

## Offline snapshot (server)

`configureForOffline()` evaluates the **real** rules from a captured snapshot
with no network — `init` is a no-op and overrides still layer on top. Pass an
in-memory `snapshot` object, or a `path` to a JSON file (Node-only — read with
`node:fs`):

```ts
import { configureForOffline, Client } from "@shipeasy/sdk/server";

// From a JSON file on disk (Node only):
configureForOffline({ path: "./snapshot.json" });

// …or from an object you already hold (works anywhere):
configureForOffline({ snapshot: { flags, experiments } });

// …optionally force a specific variant of an experiment that exists in the
// snapshot's universe (overrides layer on top of the real rules):
configureForOffline({
  snapshot: { flags, experiments },
  experiments: { hero_cta: ["treatment", { primary_label: "Buy now" }] },
});

const flags = new Client({ user_id: "u1" }); // construct once per callsite
flags.getFlag("new_checkout");
flags.universe("default").assign().group; // the experiment's universe (see snapshot below)
```

### Snapshot file shape

The snapshot is the two SDK wire bodies verbatim —
`{ flags: <GET /sdk/flags body>, experiments: <GET /sdk/experiments body> }`. A
gate's `rolloutPct` is **basis points** (`10000` = 100%); `enabled` is `1`/`0`.

```json
{
  "flags": {
    "version": "test-1",
    "plan": "free",
    "gates": {
      "new_checkout": {
        "rules": [],
        "rolloutPct": 10000,
        "salt": "s",
        "enabled": 1
      },
      "beta_banner": {
        "rules": [{ "attr": "plan", "op": "eq", "value": "pro" }],
        "rolloutPct": 5000,
        "salt": "s2",
        "enabled": 1
      }
    },
    "configs": {
      "upload_limits": { "value": { "max_uploads": 50 } }
    },
    "killswitches": {
      "payments": { "killed": 0 }
    }
  },
  "experiments": {
    "version": "test-1",
    "universes": {
      "default": { "holdout_range": null }
    },
    "experiments": {
      "hero_cta": {
        "universe": "default",
        "targetingGate": null,
        "allocationPct": 10000,
        "salt": "exp-salt",
        "status": "running",
        "groups": [
          { "name": "control", "weight": 5000, "params": { "primary_label": "Sign up" } },
          { "name": "treatment", "weight": 5000, "params": { "primary_label": "Buy now" } }
        ]
      }
    }
  }
}
```
