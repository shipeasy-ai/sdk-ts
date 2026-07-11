# React Native devtools

The SDK ships a shake-to-open devtools overlay for React Native / Expo apps at
feature parity with the in-browser overlay: inspect the project's live feature
flags, configs and experiments on-device, **force values live** (no reload),
inspect the identified user, watch the SDK event stream, triage the ops queue
(bugs, features, errors, alerts), and file bug reports **and feature requests** —
including a **public** path that works without any login when the project has
opted in.

| Entrypoint | What it is | Peer deps |
| --- | --- | --- |
| `@shipeasy/sdk/react-native-devtools` | `<ShipeasyDevtools/>` overlay + hooks | `react`, `react-native`, `react-hook-form`, `@hookform/resolvers`, `zod`, plus optional `expo-*` + `react-native-svg` (below) |
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

The logged-out home screen shows the Shipeasy mark, the public **Report a bug**
and **Request a feature** actions (when the project opted in), and a
**Connect to Shipeasy** button for team members to log in.

Install the form peers (required when mounting the overlay) and the Expo peers
you want (each degrades gracefully when absent):

```bash
npm install react-hook-form @hookform/resolvers
npx expo install expo-web-browser expo-crypto expo-secure-store expo-sensors expo-image-picker react-native-view-shot react-native-svg
```

- `react-hook-form` + `@hookform/resolvers` — the bug / feature forms
  (validated against the generated zod schemas).
- `react-native-svg` — the section-menu icons (the same Lucide glyphs the
  in-browser overlay uses). Absent → the menu falls back to text glyphs.
- `expo-web-browser` — required for **Log in** (the auth browser round-trip).
- `expo-crypto` — PKCE digest (falls back to `crypto.subtle` where available).
- `expo-secure-store` — keeps the session across app launches (Keychain/Keystore).
- `expo-sensors` — shake-to-open (otherwise use `ref.open()`).
- `expo-image-picker` — attach an existing image to feedback items.
- `react-native-view-shot` — **capture the current screen** as a report
  attachment (the overlay hides itself for the shot). Without it the capture
  button is hidden.

## Logging in

**Connect to Shipeasy** runs the device-auth flow: the web auth page opens in an
auth session, the user signs in, and the page deep-links back to your `scheme`
carrying a one-time code — never the token. The SDK then exchanges the code
(PKCE, RFC 8252) for an admin key and stores it securely.

Because you pass the app's `clientKey`, the auth page resolves it to the project
that key belongs to and **locks the flow to that project** — the team member
signs in and lands straight in the overlay, with no project picker (the key *is*
the project identity, the same contract the browser overlay uses). Pass an
explicit `projectId` to override.

Because the deep link never carries the token, **any** app scheme is safe to
use — a malicious app squatting your scheme intercepts nothing usable.

## Panels

Once logged in, the overlay opens a drill-in menu with one big-tap row per
module the project has enabled (disabled modules are hidden, matching the web
overlay); tapping a row opens that panel with a **‹ Back** affordance:

- **User** — a read-only view of the exact `identify()` payload: the fields the
  app passed, plus the attributes the SDK auto-collects on every identify()
  (`anonymous_id`, locale/timezone and device context). These are the live
  targeting inputs, verbatim — nothing here is editable.
- **Feature Flags** — an **on/off switch per flag** on the row (forces the value
  live). Expanding a flag shows the full **evaluation flow** — every gate step
  (whitelist → conditions → public rollout), first-match-wins, with each
  condition marked **pass / fail** for the currently identified user (evaluated
  locally against the identify() attributes) and each rollout step's %. The
  served value + source (live vs forced override) is shown up top; **Clear
  override** restores the live value.
- **Configs** — each config drills into a **full-page nested viewer**: a
  **read-only** tree of the effective value with expand/collapse and typed leaf
  readouts, plus a **raw JSON** view. Configs are inspected, not forced, from
  the overlay.
- **Experiments** — grouped into collapsible **status sections** (Running,
  Draft, Stopped, Archived), each with a **count badge**. **Running** is open by
  default; the rest are folded (their rows stay unmounted until expanded).
  Tapping a row drills into a **full-page detail screen**: the experiment's
  metadata (universe, allocation, owner, audience, started, min sample), the
  **universe param schema** it draws from, and every **variant** as a
  collapsed-by-default card that expands to its resolved param fields (variant
  override → universe default). **Force assignment** picks a variant live;
  **Restore live** clears it.
- **Feedback** — the project's ops queue across four sub-tabs: **Bugs**,
  **Features**, **Errors**, and **Alerts** (the last two are the auto-filed
  system tickets). **Open items only** — resolved / won't-fix are never listed —
  grouped into **status sections**. A row carries a **priority left-border**
  (red critical → orange high → yellow medium) and, as its only badge, an
  **AI/PR state pill**: cyan when an agent opened a PR ready for review (a
  tappable **PR link**), amber when it posted a question back awaiting a reply,
  green when the PR **merged**. Tapping a row opens the detail (its **metadata**
  block matches the experiment detail) with inline **status / priority editing**
  (all types) and, for bugs/features, attachment previews + screenshot upload
  (expo-image-picker). The detail's Back is the sheet header's ‹ Back (no
  per-panel button) — panels drive it through the `SheetNav` context.
- **Events** — the live SDK event stream (identify evaluations, override
  mutations), captured even while the overlay is closed.

The header shows a **⚡ N overrides** pill and an accent underline whenever any
override is active; tapping the pill opens **Active overrides** — every forced
flag / config / experiment variant this session, each clearable individually or
all at once (`OverridesPanel`, also exported).

## Live values and forcing

Live state comes from the app's configured `@shipeasy/sdk/client` singleton via
a `globalThis` bridge — the overlay never imports the client module. On the
web, devtools overrides ride URL params and reload the page; React Native has
no URL, so the RN overlay drives the Engine's **programmatic overrides**
instead: forcing a flag or experiment variant applies immediately and notifies
`onChange` subscribers, so a running app that reads through `getFlag` /
`universe(...).assign()` re-renders with the forced value. Forcing a variant
passes that variant's **param overrides**, so the assignment delivers the
variant's real values (layered over the universe defaults), not just the
defaults. Configs are read-only in the RN overlay. If the app hasn't configured
the client SDK, panels still list the project's resources but hide live values
and forcing.

## Public bug reports and feature requests

The **Report a bug** and **Request a feature** actions appear on the logged-out
home screen only when the project allows it: flip **Settings → Allow public
tickets** in the dashboard and mint a client key carrying the
`tickets:public_create` scope. The overlay learns the setting from the SDK's own
evaluate call (no extra request) via `useDevtoolsCapabilities()`. Submissions
are force-filed as `pending_approval` and human-reviewed. Logged-in users can
always file both (full authed path), also from the Feedback panel.

The forms are react-hook-form over the same generated schemas the web devtools
overlay validates with (`title` required; the rest optional). The reporter email
is sourced from the app's `identify()` payload (its `email` attribute, read via
the engine bridge — also exposed as the `useIdentityEmail()` hook): when the app
has identified an email the form doesn't ask for it, and only shows the email
field otherwise.

### Attaching a screenshot

When logged in, the forms show an **Attach a screenshot** button
(react-native-view-shot). Tapping it hides the overlay, captures the current app
screen, and previews a thumbnail; the submit uploads it as a report attachment,
visible in the dashboard's feedback detail. The public (logged-out) path takes
no attachments — the intake is JSON only.

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
underneath — `DevtoolsClient`, `startDeviceAuth`, `submitPublicBug`,
`submitPublicFeature`, the zod form schemas, and the engine-bridge readers — for
non-React hosts.

## Theming

The overlay is self-contained (dark, brand-violet) and never inherits the host
app's styles. Override tokens with the `theme` prop:

```tsx
<ShipeasyDevtools scheme="myapp://se-auth" theme={{ accent: "#22d3ee", radius: 8 }} />
```
