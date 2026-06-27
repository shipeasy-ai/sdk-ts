Wire the i18n loader via the SSR bootstrap (it rides the server `shipeasy()` handle — no separate i18n init). The loader serves the `{{PROFILE}}` profile and hydrates `window.i18n`. Full root-layout wiring is on the Installation page.

```tsx
// app/layout.tsx — Next.js root layout (React Server Component)
import { shipeasy } from "@shipeasy/sdk/server";

// construct once per request (the SSR bootstrap handle; binds this request)
const se = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });

// getBootstrapData(emit?)
//   emit.clientKey — public client key embedded in the i18n loader tag (NOT
//                    the flags bootstrap tag); selects the {{PROFILE}} profile
const boot = se.getBootstrapData({
  clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY, // profile: {{PROFILE}}
});

// Render REAL <script> elements (dangerouslySetInnerHTML scripts do NOT run):
<script src={boot.bootstrap.src} {...boot.bootstrap.attrs} />;
{boot.i18nLoader && <script src={boot.i18nLoader.src} {...boot.i18nLoader.attrs} />}
```
