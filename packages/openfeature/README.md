# @shipeasy/openfeature

[OpenFeature](https://openfeature.dev) providers for
[Shipeasy](https://shipeasy.ai) — a pure adapter over the SDK's local
evaluation, so flags resolve exactly as they do natively.

```bash
npm install @shipeasy/openfeature
```

| Entrypoint | Pair with |
| --- | --- |
| `@shipeasy/openfeature/server` | `@openfeature/server-sdk` |
| `@shipeasy/openfeature/web` | `@openfeature/web-sdk` |

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { ShipeasyProvider } from "@shipeasy/openfeature/server";

// configure() first — the provider wraps the engine it builds.
await OpenFeature.setProviderAndWait(new ShipeasyProvider());
```

`@shipeasy/sdk` is a **peer**, not a dependency: the provider wraps the engine
your `configure()` call already built, so it must resolve to the same installed
copy.

Full docs: <https://shipeasy-ai.github.io/sdk-ts/pages/openfeature.md>
