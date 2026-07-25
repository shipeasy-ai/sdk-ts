# @shipeasy/react-native-devtools

Shake-to-open [Shipeasy](https://shipeasy.ai) devtools overlay for React Native
and Expo apps — inspect live flags, configs and experiments on-device, **force
values without a reload**, watch the SDK event stream, triage the ops queue, and
file bug reports (including a public path that needs no login).

```bash
npm install @shipeasy/react-native-devtools react-hook-form @hookform/resolvers
npx expo install expo-web-browser expo-crypto expo-secure-store expo-sensors expo-image-picker react-native-svg
```

```tsx
import { useRef } from "react";
import { ShipeasyDevtools, type DevtoolsHandle } from "@shipeasy/react-native-devtools";

const devtools = useRef<DevtoolsHandle>(null);

<ShipeasyDevtools ref={devtools} scheme="myapp://se-auth" clientKey={CLIENT_KEY} />;
```

Shake several times quickly to open, or call `devtools.current?.open()`. Each
`expo-*` peer is optional and degrades gracefully when absent.

This overlay ships separately from `@shipeasy/sdk` so an app that only reads
flags never pulls a UI toolchain into its dependency tree — the SDK itself has
zero peer dependencies.

Full docs: <https://shipeasy-ai.github.io/sdk-ts/pages/react-native-devtools.md>
