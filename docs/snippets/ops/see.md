Report a caught, handled error (or a non-exception "violation") to Shipeasy with
`see()` — fire-and-forget, never re-throws. Package-level, so it reports against
the configuration from `configure()`. Assumes `configure()` ran at startup — see
Installation.

### Report a handled exception

```ts
import { see } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

try {
  await charge(order);
} catch (e) {
  // .causes_the(subject)   what the error affects (e.g. "checkout")
  // .to(outcome)           the terminal — what you do about it; builds + fires once
  see(e).causes_the("checkout").to("use the backup processor");
  await fallbackCharge(order);
}
```

### Attach context with `.extras(...)`

```ts
try {
  await charge(order);
} catch (e) {
  // .extras(obj)           structured fields attached to the report. PREFERRED:
  //                        chain it AFTER the terminal, so the consequence
  //                        sentence stays whole and extras hang off the end.
  //                        (The chain dispatches on the next microtask, so a
  //                        post-.to .extras is still folded into the report.)
  see(e).causes_the("checkout").to("use cached prices").extras({ order_id: order.id });

  // Also fine — extras folded into the terminal inline:
  see(e).causes_the("checkout").to("use cached prices", { order_id: order.id });

  // NEVER: extras wedged between the subject and the outcome — it splits the
  // consequence sentence in half and is hard to read.
  // see(e).causes_the("checkout").extras({ order_id: order.id }).to("use cached prices");
}
```

### Attach context from anywhere with `addExtras(...)`

```ts
import { see, addExtras, clearExtras, runWithExtras } from "@shipeasy/sdk/server";
// or: import { see, addExtras, clearExtras } from "@shipeasy/sdk/client";

// Buffer extras earlier — from any layer, not just the catch. Every see() report
// that fires LATER in the same scope carries them, so you don't thread context
// down into the catch site. A chained .extras / .to extra of the same key wins.
runWithExtras(async () => {          // server: per-request AsyncLocalStorage scope
  addExtras({ order_id: order.id, tenant: tenant.slug });

  // ...deep in a service, later in the same request...
  try {
    await charge(order);
  } catch (e) {
    // report carries order_id + tenant automatically
    see(e).causes_the("checkout").to("use cached prices");
  }
});
// In the browser there is one user per page — call addExtras() directly (no
// runWithExtras) and clearExtras() on a route change.
```

### Report a non-exception violation

```ts
// A bad state that isn't an exception — the name is a STABLE fingerprint; put
// variable data in .extras, never the name. .to() is the terminal.
see.Violation("missing_invoice").causes_the("billing").to("skip the dunning email");
```

### Mark an expected exception — report NOTHING

```ts
try {
  parse(token);
} catch (e) {
  // transmits nothing; .because(...) / .extras() are local-debug only
  see.ControlFlowException(e).because("because end of stream is expected");
}
```
