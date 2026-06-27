Track a metric/conversion event from the bound `Client`. Metrics in the
dashboard are computed from these events. Assumes `configure()` ran at startup —
see Installation.

### Track an event

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user)
const flags = new Client(currentUser);

// track(eventName, props?)
//   eventName — the event your metric is built on (required)
//   props     — optional payload; numeric/string fields you can sum/filter on
//               in a metric (private attributes are stripped before egress)
flags.track("{{EVENT_NAME}}", { amount: 49, currency: "usd" });
```

Fire-and-forget (never blocks your response) and a no-op under
`configureForTesting()` / `configureForOffline()`. The unit is the bound user
(`user_id`, else `anonymous_id`); with no unit the call is a no-op.

### Track without properties

```ts
const flags = new Client(currentUser); // construct once per callsite

flags.track("{{EVENT_NAME}}"); // props are optional
```
