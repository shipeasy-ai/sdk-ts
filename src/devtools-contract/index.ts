// `@shipeasy/sdk/devtools-contract` — the zero-dependency seam between the SDK
// and the devtools packages (@shipeasy/devtools-core, @shipeasy/browser-devtools,
// @shipeasy/react-native-devtools).
//
// The overlays live outside this package so their heavy optional peers (react,
// react-native, expo-*, zod, react-hook-form) never land on `@shipeasy/sdk`'s
// peer list. What they still need is the *contract*: the globalThis bridge the
// client Engine publishes, the capability payload shape, the override-cookie
// format, the i18n edit-labels markers, and the see() event builders.
//
// Everything re-exported here is leaf code with no third-party imports and no
// reference to the Engine — importing this subpath can never inline a second
// Engine singleton into an overlay bundle.
//
// This is a published surface but NOT part of the documented public API: it is
// versioned with the SDK and consumed only by the devtools packages, which
// declare `@shipeasy/sdk` as a peer so there is exactly one copy and no
// bridge-key skew.

export * from "./bridge";
export * from "./capabilities";

export * from "../i18n-markers";
export * from "../overrides/cookie";
export * from "../see/core";
