Wire the i18n loader via the SSR bootstrap (it rides the server `shipeasy()` handle — no separate i18n init). The loader serves the `{{PROFILE}}` profile and hydrates `window.i18n`. Full root-layout wiring is on the Installation page.

```tsx
// app/layout.tsx — Next.js root layout (React Server Component)
import { shipeasy } from "@shipeasy/sdk/server";

// construct once per request (the SSR bootstrap handle; binds this request)
//   clientKey          — PUBLIC client key the i18n loader tag carries (NOT the
//                        flags bootstrap tag, which embeds no key at all)
//   i18nDefaultProfile — the profile to load; defaults to "en:prod"
const se = await shipeasy({
  serverKey: process.env.SHIPEASY_SERVER_KEY ?? "",
  clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY,
  i18nDefaultProfile: "{{PROFILE}}",
});

// getBootstrapData(emit?) — every value comes from the config above; pass an
// emit option only to override one tag.
const boot = se.getBootstrapData();

// Render REAL <script> elements (dangerouslySetInnerHTML scripts do NOT run):
<script src={boot.bootstrap.src} {...boot.bootstrap.attrs} />;
{boot.i18nLoader && <script src={boot.i18nLoader.src} {...boot.i18nLoader.attrs} />}
```
