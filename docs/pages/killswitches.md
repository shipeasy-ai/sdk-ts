# Kill switches (`getKillswitch`)

A kill switch is an operational on/off control that ships in the same KV blob as
gates and configs. It is **not user-bound** — it answers a global "is this
killed?" question.

## Read a kill switch

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or /client

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
const flags = new Client(req.user);

if (flags.getKillswitch("payments")) {
  // the "payments" kill switch is KILLED — short-circuit the feature
  return showMaintenanceNotice();
}
```

`getKillswitch(name)` returns `true` when the kill switch is killed as a whole,
`false` otherwise (including for an unknown kill switch).

## Named switches

A kill switch can carry per-key override **switches** — each named switch is
configured on the kill switch in the dashboard and holds its own boolean. Pass
the variable you want to gate as the `switchKey` to read that one switch:

```ts
flags.getKillswitch("checkout", "apple_pay"); // reads the "apple_pay" switch
```

The fallback contract (shared across every Shipeasy SDK): a **configured** switch
key returns that switch's own value; an **unconfigured** switch key falls back to
the kill switch's top-level `killed` value. So calling
`getKillswitch(name, variable)` is always safe — before anyone publishes a
per-key override for `variable`, it simply tracks the whole kill switch.

```ts
// "apple_pay" not yet configured on the "checkout" kill switch:
flags.getKillswitch("checkout", "apple_pay"); // === flags.getKillswitch("checkout")
```

## Browser facade

In the browser, the top-level facade also exposes the short alias `ks(...)`,
which is SSR-bootstrap aware (reads the hydrated bootstrap value synchronously
on first render):

```ts
import { ks } from "@shipeasy/sdk/client";
if (ks("payments")) { /* killed */ }
```
