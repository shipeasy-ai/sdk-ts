# @shipeasy/next

Next.js middleware adapter for [Shipeasy](https://shipeasy.ai). Mints the shared
`__se_anon_id` bucketing cookie at the edge, **before** render, so the very first
request already has a stable bucketing unit — SSR and the browser SDK then
evaluate against the identical value at any rollout percentage.

```bash
npm install @shipeasy/next
```

```ts
// middleware.ts
export { middleware, config } from "@shipeasy/next";
```

Composing with your own middleware:

```ts
import { withShipeasy } from "@shipeasy/next";

export const middleware = withShipeasy(async (req) => {
  // …your logic; return a NextResponse, or nothing to continue
});
```

`next` is a peer of this package only — it is **not** a peer of `@shipeasy/sdk`,
which declares no peer dependencies at all.

Full docs: <https://shipeasy-ai.github.io/sdk-ts/pages/installation.md>
