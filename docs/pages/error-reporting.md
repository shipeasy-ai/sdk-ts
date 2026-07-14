# Error reporting (`see()`)

`see` (shipeasy error) is the structured error reporter. Every handled
exception documents its **product consequence**, not just its stack. It works
in vanilla JS on **both** sides — the whole grammar hangs off one import:

```ts
import { see } from "@shipeasy/sdk/client"; // or "@shipeasy/sdk/server"
```

## Report a handled exception — `see(e)`

```ts
try {
  await submitOrder(order);
} catch (e) {
  see(e).causes_the("checkout").to("use cached prices").extras({ order_id: order.id });
}
```

The chain dispatches on the **next microtask** — no `.send()`. It ships
immediately (`sendBeacon` in the browser, fire-and-forget `fetch` on the
server), spam-guarded by a 30s dedup window and a per-session cap.

`.causes_the` sets the subject; `.to(outcome)` is the terminal. You can attach
context with `.extras(obj)` or fold it into the terminal inline as
`.to(outcome, obj)` — both are equivalent, so there is no ordering to remember:

```ts
// these two are the same report:
see(e).causes_the("checkout").extras({ order_id: order.id }).to("use cached prices");
see(e).causes_the("checkout").to("use cached prices", { order_id: order.id });
```

### Attach context from anywhere — `addExtras()`

To attach context without threading it into the catch block, buffer it earlier
with `addExtras`. Every `see()` report that fires later in the **same scope**
merges it in:

```ts
import { see, addExtras, clearExtras, runWithExtras } from "@shipeasy/sdk/server";

// server: wrap the request so addExtras is isolated per request (AsyncLocalStorage)
runWithExtras(async () => {
  addExtras({ order_id: order.id, tenant: tenant.slug }); // from any layer, early

  // ...later, deep in a service...
  try {
    await charge(order);
  } catch (e) {
    see(e).causes_the("checkout").to("use cached prices");
    // report carries order_id + tenant automatically
  }
});
```

- **Server** — the buffer is backed by `AsyncLocalStorage`, so concurrent
  requests never bleed into each other. Wrap each request in `runWithExtras(fn)`
  (or wire the `seeExtrasContext` ALS into your framework's request hook) to get
  a per-request scope. Outside such a scope `addExtras` writes a module-level
  fallback buffer — call `clearExtras()` when the unit of work ends (job/script).
- **Browser** — a single module-level buffer (one user per page). Import
  `addExtras` / `clearExtras` from `@shipeasy/sdk/client`; call `clearExtras()`
  on a client-side route change if you don't want the context to persist.

A chained `.extras` / `.to` extra of the same key overrides an ambient one
(chain merges **over** ambient); ambient extras are sanitized like any other.

## Report a non-exception problem — `see.Violation(name)`

The `name` is a stable identifier (it participates in the issue fingerprint),
so put variable data in `.extras()`, never the name:

```ts
if (rows.length > LIMIT) {
  see.Violation("large query")
    .causes_the("search results")
    .to("be trimmed")
    .extras({ rows: rows.length });
}
```

Never use `see.Violation()` for a caught exception — you'd drop the stack. Pass
the caught `Error` to `see()` instead.

## Mark expected control flow — `see.ControlFlowException(e)`

Document an expected exception and report **nothing** (auto-capture skips marked
errors). The reason must start with `"because"`:

```ts
try {
  return decodeFoo(blob);
} catch (e) {
  see.ControlFlowException(e).because("because it wasn't an encoded Foo");
  return decodeBar(blob);
}
```

## Where reports land

The Shipeasy **errors** primitive — fingerprint-grouped issues
(open / resolved / ignored, regression auto-reopens) with a near-real-time
occurrence timeseries.

## Client auto-capture & cross-network correlation

The client SDK does **not** mint issues of its own for failed requests — a bare
"request to /x failed" names the transport, not what broke for the user, so it's
unactionable. Reporting is always yours: `see()` the failure where you know the
consequence.

What the SDK *does* do (`autoCollect: { errors }`, on by default) is thread a
per-request **correlation token** so your report links to the backend across the
wire. This works no matter which HTTP client you use — the SDK instruments both
`fetch` **and** `XMLHttpRequest`, so axios (its default adapter), superagent,
jQuery.ajax, and native callers are all covered. On each same-origin request it
mints a token, sends it up on the `X-SE-Correlation` header (which a server
`see()` echoes), and stamps it onto the object that surfaces the failure:

- a **network failure** (offline / DNS / CORS) throws — the token is stamped on
  the thrown error, so `see(err)` picks it up automatically;
- a **5xx** over `fetch` returns a `Response` — the token is stamped on the
  `Response`, so a fetcher that throws `new Error(msg, { cause: res })` links via
  the `.cause` chain;
- a **5xx** (or network failure) over `XMLHttpRequest` — the token is stamped on
  the `XMLHttpRequest`, which axios and most wrappers expose on the thrown error
  as `.request` / `.response.request`, so `see(err)` in your `catch` or axios
  interceptor picks it up with nothing threaded by hand.

Either way, once you `see()` the failure, that occurrence and the server-side
issue for the same request fold into one `caused_by` chain. The SDK also
deliberately does **not** blanket-report uncaught exceptions or unhandled promise
rejections (no actionable consequence).

## Rules

- If you don't know the consequence, **don't catch** the exception.
- You **may** `see()` then re-throw — the re-thrown error links to its inner
  report as a `caused_by` chain instead of double-counting.
- Never put PII or high-cardinality data in `extras`.
- A `see()` call before `configure()` / `shipeasy()` warns and drops — it never
  throws.
