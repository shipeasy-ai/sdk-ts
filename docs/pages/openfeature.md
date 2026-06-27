# OpenFeature

This SDK ships an OpenFeature provider (CNCF OpenFeature parity) so apps
standardized on the OpenFeature API can plug Shipeasy in as the backing
provider. The provider is a pure adapter over the SDK's local evaluation — no
change to how flags resolve.

| Entrypoint | Pair with | Peer dep (optional) |
| --- | --- | --- |
| `@shipeasy/sdk/openfeature-server` | `@openfeature/server-sdk` | `@openfeature/server-sdk` |

The provider class is named `ShipeasyProvider`.

## Server provider

Construct `new ShipeasyProvider()` with **no argument** — the global form
resolves the engine that `configure({ apiKey })` already built. Always
`configure()` first:

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { configure } from "@shipeasy/sdk/server";
import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-server";

// 1. Configure the SDK once at app boot (server key).
configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });

// 2. Register the provider — no-arg form resolves the configured engine.
await OpenFeature.setProviderAndWait(new ShipeasyProvider());

// 3. Read through the OpenFeature client.
const ofClient = OpenFeature.getClient();
const on = await ofClient.getBooleanValue("new_checkout", false, { targetingKey: "u1" });
```

The provider's `initialize()` runs the SDK's one-shot rules fetch (the SDK fires
`Ready` when the blob resolves) and `onClose()` tears the configuration down.

## Type / reason mapping

- `getBooleanValue` → `getFlagDetail` — the gate's `FlagReason` maps to an
  OpenFeature reason (`RULE_MATCH` → `TARGETING_MATCH`, `DEFAULT` → `DEFAULT`,
  `FLAG_NOT_FOUND` → `ERROR`/`FLAG_NOT_FOUND`, `CLIENT_NOT_READY` →
  `PROVIDER_NOT_READY`).
- `getStringValue` / `getNumberValue` / `getObjectValue` → `getConfig`, with a
  `TYPE_MISMATCH` error code when the stored config value doesn't match the
  requested type.

The `EvaluationContext.targetingKey` becomes the bucketing `user_id`.

## Tracking

The provider's OpenFeature `track()` forwards to the SDK's `track()` (no-op
without a `targetingKey`), so conversions for experiment analysis flow through
the same pipeline.
