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

## Quickstart — browser

```ts
import { FlagsClientBrowser } from "@shipeasy/sdk/client";

const client = new FlagsClientBrowser({
  sdkKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!,
});

await client.identify({ user_id: "user-123", plan: "pro" });

if (client.getFlag("new_checkout")) {
  // ship it
}

const cfg = client.getConfig<{ max_uploads: number }>("upload_limits");
const { params } = client.getExperiment("hero_cta", {
  primary_label: "Sign up",
});
```

`identify()` automatically merges browser context (`locale`, `timezone`,
`path`, `referrer`, `screen_*`, `user_agent`) and a persisted
`anonymous_id` into the payload — so gate rules can target by locale or
holdouts can hash anonymous visitors out of the box.

## Quickstart — server (Node, Cloudflare Worker, Deno)

```ts
import { FlagsClient } from "@shipeasy/sdk/server";

const client = new FlagsClient({ sdkKey: process.env.SHIPEASY_SERVER_KEY! });

const cfg = await client.getConfig("plan_limits", { user_id: "u-1" });
```

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
