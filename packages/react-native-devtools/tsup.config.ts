import { defineConfig } from "tsup";

// The overlay never imports the SDK client module (that would inline a second
// Engine singleton) — project capabilities arrive over the globalThis bridge
// the client Engine publishes, via `@shipeasy/sdk/devtools-contract`. Every UI
// peer stays external so it resolves from the consumer's app.
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  external: [
    "react",
    "react/jsx-runtime",
    "react-native",
    "react-native-svg",
    /^expo-/,
    "zod",
    "react-hook-form",
    /^@hookform\//,
    "@shipeasy/devtools-core",
    /^@shipeasy\/devtools-core\//,
    "@shipeasy/sdk",
    /^@shipeasy\/sdk\//,
  ],
});
