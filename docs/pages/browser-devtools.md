# Browser devtools

The in-browser devtools overlay is **delivered as a hosted script**, not as an
npm dependency — nothing to install, and no overlay code in your production
bundle. It shares one headless core (`@shipeasy/devtools-core`) and one
generated OpenAPI contract with the React Native overlay. It renders in a Shadow
DOM, authenticates via a popup to the Shipeasy admin, and stores overrides **on
the page URL** (`?se_ks_*`, `?se_exp_*`, `?se_config_*`) so a state is portable —
paste the URL anywhere and the overrides travel with it.

| Surface | How it loads |
| --- | --- |
| `<script src="https://cdn.shipeasy.ai/se-devtools.js">` | Self-executing bundle; reads `data-project-id` / `data-client-api-key` off the tag |
| `se.getDevtoolsTag()` / `getDevtoolsData()` | The same tag, emitted from SSR with the ids already filled in |

## Script tag (zero-code)

```html
<script
  src="https://cdn.shipeasy.ai/se-devtools.js"
  data-project-id="proj_…"
  data-client-api-key="sdk_client_…"
  defer
></script>
```

The overlay opens with **Shift+Alt+S**, or by loading any page with `?se=1`.

## Emitting it from SSR

The server handle builds the same tag from the ids you already configured, so
nothing is repeated in the layout — and you can gate it on your own staff check:

```tsx
import { shipeasy } from "@shipeasy/sdk/server";

const se = await shipeasy({
  serverKey: process.env.SHIPEASY_SERVER_KEY ?? "",
  clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY, // PUBLIC key
  projectId: process.env.NEXT_PUBLIC_SHIPEASY_PROJECT_ID,
});

const dev = se.getDevtoolsData();          // pass { defer: false } to drop `defer`
{isStaff && <script src={dev.src} {...dev.attrs} />}
```

`se.getDevtoolsTag()` returns it as an HTML string for non-React SSR, and the
standalone `getDevtoolsTag(opts)` / `getDevtoolsData(opts)` exports build the tag
without a request handle.

## Configuring it

Set `window.__se_devtools_config` before the script tag runs to override the
defaults — `adminUrl` (point a local or staging app at a different admin
deployment), `accentColor`, `hideAdminLinks`, `hideRail`, `seed` (pre-baked
session/project for demos), and `onClose`:

```html
<script>
  window.__se_devtools_config = { adminUrl: "http://localhost:3000" };
</script>
<script src="https://cdn.shipeasy.ai/se-devtools.js" data-project-id="proj_…" defer></script>
```

Values on the tag (`data-project-id`, `data-client-api-key`) always win over the
same keys in `window.__se_devtools_config`.

## Panels

User (simulate properties + re-evaluate), Gates (force on/off), Experiments
(force variants), Configs (schema-form editing), Translations (profile/draft
selection and in-page click-to-edit label editing via `?se_edit_labels=1`),
Feedback (bugs + feature requests with attachments, screenshot capture and an
annotator), and a live Events stream. Tabs are hidden for modules the project
has disabled.

## Overrides are URL-only

Every override lives on the URL — nothing is written to storage — and applies
on reload. The same-origin navigation guard forwards `se_*` params across
links and client-side route changes so the forced state survives navigation.

The param format is stable, so you can hand-build or share a forced-state link
without any Shipeasy code:

```
?se_ks_{{FLAG_KEY}}=true        # force a gate / kill switch on (se_gate_ is an alias)
?se_exp_{{EXPERIMENT_KEY}}=treatment   # force an experiment group ("default" clears it)
?se_config_{{CONFIG_KEY}}=<json>       # config override; b64:<base64url> for large blobs
?se=1                            # open the overlay on load
```

The React Native overlay exposes the same forcing actions through the SDK's
programmatic overrides instead (no URL on native) — see the React Native
devtools page.
