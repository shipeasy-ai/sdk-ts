# Shipeasy · TypeScript Entity Guide

A single-page, runnable **guide document** for the Shipeasy SDK. It renders one
styled card per Shipeasy entity — what the entity is, the SDK call that produces
it, and its current value — so you can read top to bottom and understand the
whole surface at a glance.

Built with **Next.js 15 (App Router) + React 19 + TypeScript**. Plain CSS, no UI
kit, dark Shipeasy brand.

## ⚠ The SDK is not wired in yet

This example is **fully standalone** — it does **not** depend on
`@shipeasy/sdk`, makes **zero network calls**, and renders entirely from
placeholder constants in [`app/entities.ts`](./app/entities.ts).

Every value you see (`new_checkout = true`, `billing_copy = {…}`, etc.) is a
hardcoded placeholder. The banner at the top of the page says so. For each
entity the page shows the **real SDK call** as both:

- a visible code block on the card, and
- a commented-out `// TODO: once @shipeasy/sdk is installed` block in
  [`app/page.tsx`](./app/page.tsx) and [`app/layout.tsx`](./app/layout.tsx).

This lets you stand the guide up immediately, then make it live on your own
schedule.

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

To verify a production build:

```bash
npm install
npm run build
```

Both succeed with no external services, because nothing external is imported.

## Entities covered (in page order)

1. **Feature flag** — `new_checkout` (boolean + targeting + rollout)
2. **Dynamic config** — `billing_copy` (typed JSON, no redeploy)
3. **A/B experiment** — `checkout_button` (group + params)
4. **Kill switch** — `payments_paused` (ships in the flags blob)
5. **Event / metric** — `checkout_completed` (fire-and-forget `track`)
6. **i18n label** — `hero.title` (server-managed copy)
7. **Error reporting** — `see()` (structured, consequence-first reports)

## Next step — install `@shipeasy/sdk` and replace each `// TODO`

1. Install the SDK:

   ```bash
   npm install @shipeasy/sdk
   ```

2. Configure the **server** key once in [`app/layout.tsx`](./app/layout.tsx):

   ```ts
   import { shipeasy } from "@shipeasy/sdk/server";
   const client = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });
   ```

   (The browser uses the separate public **client** key via
   `@shipeasy/sdk/client` — never pass `clientKey` to the server entrypoint or
   `serverKey` to the client.)

3. In [`app/page.tsx`](./app/page.tsx), uncomment the `// TODO` block and feed
   the real call results into each card instead of the placeholder constants in
   `app/entities.ts`. The exact call for every entity is already written out on
   each card.

Docs: <https://docs.shipeasy.ai>
