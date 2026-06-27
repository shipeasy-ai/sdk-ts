# @shipeasy/sdk

Feature gates, runtime configs, experiments, and metrics for the
[Shipeasy](https://shipeasy.ai) hosted service.

> Source-available under the [Shipeasy-SAL 1.0](./LICENSE). Use it freely
> as a client of Shipeasy. Don't use it to build a competing service.

## Install

```bash
npm install @shipeasy/sdk
# or
pnpm add @shipeasy/sdk
```

For React projects use [`@shipeasy/sdk-react`](https://github.com/shipeasy-ai/sdk-react)
which wraps this package with a `<ShipeasyProvider>` and hooks.

📖 **Documentation:** [Installation & configuration](docs/pages/installation.md)
(Next.js, Express/Node, Cloudflare Workers, browser/React) · [full docs](docs/)

## Quickstart — `configure()` once, then `new Client(user)`

The ergonomic front door: **configure once** with your key and an optional
`attributes` transform from *your own user object* to Shipeasy targeting
attributes, then evaluate per user with `new Client(user)`. The bound
`Client` takes **no user argument** on its methods — the user is bound at
construction.

### Browser

```ts
import { configure, Client } from "@shipeasy/sdk/client";

// Once, at app startup:
configure({
  clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!,
  // Optional — omit when you already pass a plain attribute object.
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan }),
});

// Per visitor:
const flags = new Client(currentUser);
await flags.ready(); // optional — await the first /sdk/evaluate round-trip

if (flags.getFlag("new_checkout")) {
  // ship it
}

const cfg = flags.getConfig<{ max_uploads: number }>("upload_limits");
const { params } = flags.getExperiment("hero_cta", { primary_label: "Sign up" });
```

The browser is single-user: `new Client(user)` runs the transform and
`identify()`s the result under the hood (merging browser context — `locale`,
`timezone`, `path`, `referrer`, `screen_*`, `user_agent` — and a persisted
`anonymous_id`). `getFlag` reflects the latest identify; `await client.ready()`
when you need the first evaluation to have resolved.

### Server (Node, Cloudflare Worker, Deno)

```ts
import { configure, Client } from "@shipeasy/sdk/server";

// Once, at app boot:
configure({
  apiKey: process.env.SHIPEASY_SERVER_KEY!,
  attributes: (u: MyUser) => ({ user_id: u.id, plan: u.plan, country: u.geo.country }),
});

// Per request:
const flags = new Client(req.user);
if (flags.getFlag("new_checkout")) { /* ... */ }
const cfg = flags.getConfig("plan_limits");
```

When you don't pass `attributes`, the transform is the **identity** function —
the user object you pass is used verbatim, so it should already be the
attribute bag (`{ user_id, anonymous_id, ...targeting }`).

### Low-level: the `Engine` directly

`Client` is a cheap, user-bound handle over a single shared `Engine` (the
heavyweight class that owns the key, HTTP, the blob cache, and the poll timer —
**renamed from `FlagsClient` / `FlagsClientBrowser` in 6.0.0**). You can still
construct and drive an `Engine` yourself:

```ts
import { Engine } from "@shipeasy/sdk/server";

const engine = new Engine({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
await engine.initOnce();
const on = engine.getFlag("new_checkout", { user_id: "u-1", plan: "pro" });
```

## SSR bootstrap (flags on first paint)

Server-render the evaluated flags / configs / experiments into the page so the
browser SDK reads them **synchronously on first paint** — no flash, no extra
round-trip. The `shipeasy()` server handle emits two declarative `<script>`
tags. **No SDK key is embedded** in the bootstrap tag (the server key never
reaches the browser).

```tsx
// app/layout.tsx — Next.js root layout (React Server Component)
import { shipeasy } from "@shipeasy/sdk/server";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const se = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });
  const boot = se.getBootstrapData({
    // public client key — lets the i18n loader revalidate strings at runtime
    clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY,
  });
  return (
    <html>
      <body>
        {/* Render REAL <script> elements — scripts set via
            dangerouslySetInnerHTML do NOT execute. */}
        <script src={boot.bootstrap.src} {...boot.bootstrap.attrs} />
        {boot.i18nLoader && <script src={boot.i18nLoader.src} {...boot.i18nLoader.attrs} />}
        {children}
      </body>
    </html>
  );
}
```

`bootstrap.src` is `https://cdn.shipeasy.ai/sdk/bootstrap.js` — a static loader
that reads its own `data-*` attributes, hydrates `window.__SE_BOOTSTRAP`, and
persists the `__se_anon_id` cookie so the browser buckets **identically** to the
server. The i18n loader tag carries the SSR strings (`data-strings`) for a
no-flash first paint plus the public client key for runtime revalidation.

For non-React SSR (Express, raw templates), `se.getBootstrapTags()` returns the
same two tags as an HTML string you can drop straight into the served markup.

## Error tracking — `see()`

`see` (shipeasy error) is the structured error reporter — opes-style: every
handled exception documents its **product consequence**, not just its stack.
Works in vanilla JS on both sides; the whole grammar hangs off one import:

```ts
import { see } from "@shipeasy/sdk/client"; // or "@shipeasy/sdk/server"

try {
  await submitOrder(order);
} catch (e) {
  see(e).causes_the("checkout").to("use cached prices").extras({ order_id: order.id });
}

// Non-exception problems — the name is a stable identifier (it participates
// in the issue fingerprint); all variable data goes in .extras():
if (rows.length > LIMIT) {
  see.Violation("large query")
    .causes_the("search results")
    .to("be trimmed")
    .extras({ rows: rows.length });
}

// Expected control-flow exceptions: document them, report nothing —
// auto-capture skips marked errors. The reason must start with "because".
try {
  return decodeFoo(blob);
} catch (e) {
  see.ControlFlowException(e).because("because it wasn't an encoded Foo");
  return decodeBar(blob);
}
```

Reports land in the Shipeasy **errors** primitive: fingerprint-grouped issues
(open / resolved / ignored, regression auto-reopens) with a near-real-time
occurrence timeseries. The chain dispatches on the next microtask — no
`.send()` — and ships immediately (`sendBeacon` in the browser, fire-and-forget
`fetch` on the server), spam-guarded by a 30s dedup window and a per-session
cap.

The client SDK also auto-captures **network failures** (fetch network errors +
5xx) into the same primitive (`autoCollect: { errors }`, on by default) — each
names a specific endpoint and a specific outcome. It deliberately does **not**
blanket-report uncaught exceptions or unhandled promise rejections: those carry
no actionable consequence ("the page hit an error" names the plumbing, not the
feature). Code that knows the consequence reports it explicitly with `see()` at
the catch site.

**Rules**: if you don't know the consequence, don't catch the exception. You
**may** `see()` then re-throw — the re-thrown error links to its inner report
as a `caused_by` chain instead of double-counting. Never use `see.Violation()`
for a caught exception (you'd drop the stack). No PII or high-cardinality data
in extras.

## Drop-in `<script>` loader (no bundler)

```html
<script
  src="https://cdn.shipeasy.ai/sdk/loader.js"
  data-sdk-key="sdk_client_..."
  data-user-id="user-123"
  data-user-email="u@x.com"
  data-user-plan="pro"
  data-attrs='{"country":"US"}'
  defer
></script>
<script>
  await window.shipeasy.ready;
  if (window.shipeasy.getFlag("new_checkout")) { /* … */ }
</script>
```

The loader IIFE is published to a public R2 bucket on every release and
cached for 1y at `loader-vX.Y.Z.js` (immutable) plus a rolling 5-minute
`loader.js`.

## Testing

For unit tests, build a **no-network** client with `forTesting()` and seed every
entity with local overrides (Statsig-style). In test mode the client is already
"initialized"/"ready", `init()`/`initOnce()`/`identify()` are no-ops (they never
fetch), `track()` is a no-op, telemetry is disabled, and no SDK key is required —
so your tests never touch the network.

```ts
// Server (Node / Cloudflare Worker / Deno)
import { Engine } from "@shipeasy/sdk/server";

const client = Engine.forTesting();

client.overrideFlag("new_checkout", true);
client.overrideConfig("upload_limits", { max_uploads: 50 });
client.overrideExperiment("hero_cta", "treatment", { primary_label: "Buy now" });

client.getFlag("new_checkout", { user_id: "u1" }); // true
client.getConfig("upload_limits"); // { max_uploads: 50 }
client.getExperiment("hero_cta", { user_id: "u1" }, { primary_label: "Sign up" });
// → { inExperiment: true, group: "treatment", params: { primary_label: "Buy now" } }

client.track("u1", "purchase"); // no-op — never hits the network
client.clearOverrides(); // reset every override back to default
```

```ts
// Browser (vanilla JS — no React required)
import { Engine } from "@shipeasy/sdk/client";

const client = Engine.forTesting();

client.overrideFlag("new_checkout", true);
client.overrideConfig("upload_limits", { max_uploads: 50 });
client.overrideExperiment("hero_cta", "treatment", { primary_label: "Buy now" });

client.getFlag("new_checkout"); // true
client.getConfig("upload_limits"); // { max_uploads: 50 }
client.getExperiment("hero_cta", { primary_label: "Sign up" });
// → { inExperiment: true, group: "treatment", params: { primary_label: "Buy now" } }

client.track("purchase"); // no-op
client.clearOverrides();
```

The `override*` setters also work on a **normal** client (not just `forTesting()`),
mirroring Statsig — a programmatic override always wins over the fetched values.
In the browser the precedence is: programmatic override > URL/devtools override
(`?se_gate_…` / `?se_config_…` / `?se_exp_…`) > the server's evaluation.

**API:**

```ts
overrideFlag(name: string, value: boolean): void;
overrideConfig(name: string, value: unknown): void;
overrideExperiment(name: string, group: string, params: Record<string, unknown>): void;
clearOverrides(): void;
```

## Default values

`getFlag` / `getConfig` take a caller-supplied default that is returned **only
when the value can't be evaluated** — the client isn't initialized yet, or the
key isn't in the loaded rules. A flag that legitimately evaluates to `false`
(disabled, rule denied, rolled out to 0%) still returns `false`, never the
default.

```ts
// Server
flags.get("new_checkout", { user_id: "u1" });        // false for a missing flag
flags.get("new_checkout", { user_id: "u1" }, true);  // true only if not-ready/not-found
flags.getConfig("limits", { defaultValue: { max: 50 } }); // default when key absent

// Browser (no user arg)
client.getFlag("new_checkout");        // false for a missing flag
client.getFlag("new_checkout", true);  // default when not-ready/not-found
client.getConfig("limits", { defaultValue: { max: 50 } });
```

The legacy `getConfig(name, decode)` callback signature still works unchanged;
the options object (`{ decode?, defaultValue? }`) is the new, additive form.

## Evaluation detail

`getFlagDetail(name[, user])` returns `{ value, reason }` (LaunchDarkly
`variationDetail` parity) so you can see *why* a flag resolved the way it did:

```ts
import type { FlagReason } from "@shipeasy/sdk/server"; // or /client

const d = client.getFlagDetail("new_checkout", { user_id: "u1" });
// → { value: true, reason: "RULE_MATCH" }
```

`FlagReason` is one of:

| reason             | meaning                                                     |
| ------------------ | ---------------------------------------------------------- |
| `CLIENT_NOT_READY` | no rules loaded yet (`init()` / `identify()` pending)      |
| `FLAG_NOT_FOUND`   | the gate name isn't in the loaded rules                    |
| `OFF`              | the gate exists but is disabled / killed (server only)     |
| `OVERRIDE`         | a local override (or `?se_gate_…` URL override) decided it |
| `RULE_MATCH`       | the gate evaluated `true`                                  |
| `DEFAULT`          | the gate evaluated `false`                                 |

`getFlag` is implemented on top of `getFlagDetail` (single evaluation, single
telemetry beacon). On the browser the server pre-evaluates the gate's
enabled/killed state into a boolean, so `OFF` folds into `DEFAULT` there.

## Change listeners

The server `Engine` fires registered listeners after a **background poll
returns new data** (HTTP 200, not 304) — handy for invalidating a cache or
re-rendering when a flag flips. Returns an unsubscribe function. Never fires in
test/offline mode (no polling happens):

```ts
const client = new Engine({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
await client.init();
const unsubscribe = client.onChange(() => {
  console.log("flag rules changed — re-evaluating");
});
// later…
unsubscribe();
```

The browser `Engine` already exposes the equivalent `subscribe()`
(fires after each `identify()` / override change).

## Offline snapshot

Build a fully offline server client from a captured snapshot — zero network.
Evaluations run the real eval against the snapshot; `init()`/`initOnce()`/
`track()` are no-ops and overrides still apply on top. The snapshot is just the
two SDK wire bodies:

```jsonc
// snapshot.json
{
  "flags":       /* body of GET /sdk/flags */,
  "experiments": /* body of GET /sdk/experiments */
}
```

```ts
import { Engine } from "@shipeasy/sdk/server";

const client = Engine.fromFile("./snapshot.json");
// or, if you already hold the parsed object:
const client = Engine.fromSnapshot({ flags, experiments });

client.getFlag("new_checkout", { user_id: "u1" });
```

`fromFile` is Node-only (it reads the file with `node:fs`); `fromSnapshot` works
anywhere.

## Devtools overlay

Press `Shift+Alt+S` on any page running the SDK (or append `?se=1` to the
URL). The Shipeasy devtools panel mounts in a Shadow DOM overlay and lets
you flip every gate / config / experiment / translation **for the current
session only** — handy for QA, demos, and bug repro.

## Documentation

Full docs at [docs.shipeasy.ai](https://docs.shipeasy.ai). API surfaces
covered there: targeting rules, holdouts, sequential stats, custom
metrics, Slack digests, OAuth/SSO, Claude/MCP integration.

## License

[Shipeasy-SAL 1.0](./LICENSE) — source-available, non-commercial-use,
permitted for use as a Shipeasy client.
