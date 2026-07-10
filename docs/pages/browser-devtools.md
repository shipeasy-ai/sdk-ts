# Browser devtools

The in-browser devtools overlay ships inside the SDK, sharing one headless core
(`@shipeasy/sdk/devtools`) and one generated OpenAPI contract with the React
Native overlay. It renders in a Shadow DOM, authenticates via a popup to the
Shipeasy admin, and stores overrides **on the page URL** (`?se_ks_*`,
`?se_exp_*`, `?se_config_*`) so a state is portable — paste the URL anywhere
and the overrides travel with it.

| Surface | How it loads |
| --- | --- |
| `<script src="https://cdn.shipeasy.ai/se-devtools.js">` | Self-executing bundle; reads `data-project-id` / `data-client-api-key` off the tag |
| `@shipeasy/sdk/browser-devtools` | Importable module: `init()`, `destroy()`, `loadOnTrigger()`, override get/setters |

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

## Programmatic

```ts
import { loadOnTrigger } from "@shipeasy/sdk/browser-devtools";

// Captures ?se params, opens on demand, binds the hotkey. Returns a cleanup fn.
const cleanup = loadOnTrigger({ projectId: "proj_…", clientKey: "sdk_client_…" });
```

`init(options)` mounts immediately; `destroy()` unmounts. Options cover
`adminUrl`, `accentColor`, `hideAdminLinks`, `hideRail`, `seed` (pre-baked
session/project for demos), and `onClose`.

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

```ts
import { buildOverrideUrl } from "@shipeasy/sdk/browser-devtools";

const url = buildOverrideUrl({
  gates: { "{{FLAG_KEY}}": true },
  experiments: { "{{EXPERIMENT_KEY}}": "treatment" },
  openDevtools: true,
});
```

The React Native overlay exposes the same forcing actions through the SDK's
programmatic overrides instead (no URL on native) — see the React Native
devtools page.
