# React Native devtools

The SDK ships a shake-to-open devtools overlay for React Native / Expo apps at
feature parity with the in-browser overlay: inspect the project's live gates,
configs and experiments on-device, **force values live** (no reload), simulate
users, watch the SDK event stream, browse and edit translations, triage
feedback, and file bug reports — including a **public** bug path that works
without any login when the project has opted in.

| Entrypoint | What it is | Peer deps |
| --- | --- | --- |
| `@shipeasy/sdk/react-native-devtools` | `<ShipeasyDevtools/>` overlay + hooks | `react`, `react-native`, `react-hook-form`, `@hookform/resolvers`, `zod`, plus optional `expo-*` (below) |
| `@shipeasy/sdk/devtools` | Headless core (client, auth, public bug intake, form schemas) | `zod` |
| `@shipeasy/sdk/browser-devtools` | The web overlay (see its page) | — |

## Quick start

Mount the overlay once near the app root and pass your app's **own deep-link
scheme** (any custom scheme your app registers — no Shipeasy-side registration
needed) plus the public client key:

```tsx
import { useRef } from "react";
import { ShipeasyDevtools, type DevtoolsHandle } from "@shipeasy/sdk/react-native-devtools";

export function App() {
  const devtools = useRef<DevtoolsHandle>(null);
  return (
    <>
      {/* …your app… */}
      <ShipeasyDevtools
        ref={devtools}
        scheme="myapp://se-auth"
        clientKey={process.env.EXPO_PUBLIC_SHIPEASY_CLIENT_KEY ?? ""}
      />
    </>
  );
}
```

Shake the phone **several times quickly** to open the panel (expo-sensors).
Without expo-sensors — or from a debug menu — call `devtools.current?.open()`.

Install the form peers (required when mounting the overlay) and the Expo peers
you want (each degrades gracefully when absent):

```bash
npm install react-hook-form @hookform/resolvers
npx expo install expo-web-browser expo-crypto expo-secure-store expo-sensors expo-image-picker
```

- `react-hook-form` + `@hookform/resolvers` — the bug / feature forms
  (validated against the generated zod schemas).
- `expo-web-browser` — required for **Log in** (the auth browser round-trip).
- `expo-crypto` — PKCE digest (falls back to `crypto.subtle` where available).
- `expo-secure-store` — keeps the session across app launches (Keychain/Keystore).
- `expo-sensors` — shake-to-open (otherwise use `ref.open()`).
- `expo-image-picker` — attach screenshots to feedback items.

## Logging in

**Log in to Shipeasy** runs the device-auth flow: the web auth page opens in an
auth session, the user signs in and picks a project, and the page deep-links
back to your `scheme` carrying a one-time code — never the token. The SDK then
exchanges the code (PKCE, RFC 8252) for an admin key and stores it securely.

Because the deep link never carries the token, **any** app scheme is safe to
use — a malicious app squatting your scheme intercepts nothing usable.

## Panels

Once logged in, the overlay shows one tab per module the project has enabled
(disabled modules are hidden, matching the web overlay):

- **User** — the app's `identify()` payload; edit properties and
  **Re-evaluate** to simulate another user (this re-runs the real evaluation,
  so gates/experiments/configs re-resolve live).
- **Gates** — rollout, killswitch flag, the value this device is being served,
  and **Force on / Force off / Restore** buttons.
- **Configs** — effective values with a JSON override editor (schema-checked at
  the root) and **Restore**.
- **Experiments** — status, universe, weights, the live assignment, and
  per-variant forcing.
- **Feedback** — bugs + feature requests with Active/All filtering, detail
  views, inline **status / priority editing**, attachment previews + screenshot
  upload (expo-image-picker), and the create forms.
- **I18n** — profile selector, searchable key list, per-key value editing
  applied to the profile. (The web overlay's in-page click-to-edit mode is
  DOM-only and has no RN equivalent.)
- **Events** — the live SDK event stream (identify evaluations, override
  mutations), captured even while the overlay is closed.

## Live values and forcing

Live state comes from the app's configured `@shipeasy/sdk/client` singleton via
a `globalThis` bridge — the overlay never imports the client module. On the
web, devtools overrides ride URL params and reload the page; React Native has
no URL, so the RN overlay drives the Engine's **programmatic overrides**
instead: forcing a gate, variant, or config applies immediately and notifies
`onChange` subscribers. If the app hasn't configured the client SDK, panels
still list the project's resources but hide live values and forcing.

## Public bug reports

The **Report a bug** button appears on the logged-out home screen only when the
project allows it: flip **Settings → Allow public tickets** in the dashboard
and mint a client key carrying the `tickets:public_create` scope. The overlay
learns the setting from the SDK's own evaluate call (no extra request) via
`useDevtoolsCapabilities()`. Submissions are force-filed as `pending_approval`
and human-reviewed. Logged-in users can always file (full authed path), and can
also submit **feature requests** from the Feedback panel.

The forms are react-hook-form over the same generated schemas the web devtools
overlay validates with (`title` required; steps / actual result / email
optional).

## Hooks

Building your own surface instead of the stock panel? The same hooks power it:

```tsx
import {
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useEngineBridge,
  useEventLog,
  useGates,
  useBugForm,
  useShakeToOpen,
} from "@shipeasy/sdk/react-native-devtools";

const auth = useDevtoolsAuth({ scheme: "myapp://se-auth" });
const gates = useGates(auth.client);          // { data, loading, error, refresh }
const caps = useDevtoolsCapabilities();       // { allowPublicTickets } | null
const bridge = useEngineBridge();             // live values + overrides, or null
const events = useEventLog();                 // the captured SDK event feed
useShakeToOpen(() => setOpen(true));          // no-op without expo-sensors
```

`useBugForm()` / `useFeatureForm()` return a react-hook-form instance (`form`)
plus the submit-path glue — drive custom fields with
`<Controller control={form.control} …>`. Additional queries: `useProject`,
`useUniverses`, `useFeatureRequests`, `useBugDetail`, `useFeatureDetail`,
`useProfiles`, `useI18nKeys`.

The framework-agnostic core (`@shipeasy/sdk/devtools`) exposes the pieces
underneath — `DevtoolsClient`, `startDeviceAuth`, `submitPublicBug`, the zod
form schemas, and the engine-bridge readers — for non-React hosts.

## Theming

The overlay is self-contained (dark, brand-violet) and never inherits the host
app's styles. Override tokens with the `theme` prop:

```tsx
<ShipeasyDevtools scheme="myapp://se-auth" theme={{ accent: "#22d3ee", radius: 8 }} />
```
