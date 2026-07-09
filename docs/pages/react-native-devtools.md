# React Native devtools

The SDK ships a shake-to-open devtools overlay for React Native / Expo apps:
inspect the project's live gates, configs and experiments on-device, log in via
the Shipeasy web auth, and file bug reports — including a **public** bug path
that works without any login when the project has opted in.

| Entrypoint | What it is | Peer deps (all optional) |
| --- | --- | --- |
| `@shipeasy/sdk/react-native-devtools` | `<ShipeasyDevtools/>` overlay + hooks | `react`, `react-native`, `expo-web-browser`, `expo-crypto`, `expo-secure-store`, `expo-sensors`, `zod` |
| `@shipeasy/sdk/devtools` | Headless core (client, auth, public bug intake, form schemas) | `zod` |

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

Install the Expo peers you want (each degrades gracefully when absent):

```bash
npx expo install expo-web-browser expo-crypto expo-secure-store expo-sensors
```

- `expo-web-browser` — required for **Log in** (the auth browser round-trip).
- `expo-crypto` — PKCE digest (falls back to `crypto.subtle` where available).
- `expo-secure-store` — keeps the session across app launches (Keychain/Keystore).
- `expo-sensors` — shake-to-open (otherwise use `ref.open()`).

## Logging in

**Log in to Shipeasy** runs the device-auth flow: the web auth page opens in an
auth session, the user signs in and picks a project, and the page deep-links
back to your `scheme` carrying a one-time code — never the token. The SDK then
exchanges the code (PKCE, RFC 8252) for an admin key and stores it securely.
Once logged in, the overlay shows the **Gates / Configs / Experiments /
Feedback** panels for the project.

Because the deep link never carries the token, **any** app scheme is safe to
use — a malicious app squatting your scheme intercepts nothing usable.

## Public bug reports

The **Report a bug** button appears on the logged-out home screen only when the
project allows it: flip **Settings → Allow public tickets** in the dashboard
and mint a client key carrying the `tickets:public_create` scope. The overlay
learns the setting from the SDK's own evaluate call (no extra request) via
`useDevtoolsCapabilities()`. Submissions are force-filed as `pending_approval`
and human-reviewed. Logged-in users can always file (full authed path).

The bug form validates with the same generated schema the web devtools overlay
uses (`title` required; steps / actual result / email optional).

## Hooks

Building your own surface instead of the stock panel? The same hooks power it:

```tsx
import {
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useGates,
  useBugForm,
  useShakeToOpen,
} from "@shipeasy/sdk/react-native-devtools";

const auth = useDevtoolsAuth({ scheme: "myapp://se-auth" });
const gates = useGates(auth.client);          // { data, loading, error, refresh }
const caps = useDevtoolsCapabilities();       // { allowPublicTickets } | null
useShakeToOpen(() => setOpen(true));          // no-op without expo-sensors
```

The framework-agnostic core (`@shipeasy/sdk/devtools`) exposes the pieces
underneath — `DevtoolsClient`, `startDeviceAuth`, `submitPublicBug`, and the
zod form schemas — for non-React hosts.

## Theming

The overlay is self-contained (dark, brand-violet) and never inherits the host
app's styles. Override tokens with the `theme` prop:

```tsx
<ShipeasyDevtools scheme="myapp://se-auth" theme={{ accent: "#22d3ee", radius: 8 }} />
```
