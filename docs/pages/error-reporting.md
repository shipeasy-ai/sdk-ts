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
