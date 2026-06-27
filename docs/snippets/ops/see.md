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
  // .extras(obj)           structured fields attached to the report
  see(e).causes_the("checkout").extras({ order_id: order.id }).to("use cached prices");
}
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
