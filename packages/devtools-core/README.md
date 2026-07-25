# @shipeasy/devtools-core

Headless core shared by the [Shipeasy](https://shipeasy.ai) devtools overlays —
the admin API client, PKCE device auth, public bug intake, and the generated
form schemas.

You normally do not install this directly: it comes with
[`@shipeasy/react-native-devtools`](https://www.npmjs.com/package/@shipeasy/react-native-devtools).
Install it on its own only to build a custom devtools surface.

```bash
npm install @shipeasy/devtools-core
```

It reads the app's live SDK state over the `globalThis` bridge the client Engine
publishes (`@shipeasy/sdk/devtools-contract`) rather than importing the client,
so it can never inline a second Engine. `@shipeasy/sdk` is therefore a peer.

Full docs: <https://shipeasy-ai.github.io/sdk-ts/>
