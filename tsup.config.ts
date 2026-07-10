import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/server/index.ts" },
    outDir: "dist/server",
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
  },
  {
    entry: { index: "src/client/index.ts" },
    outDir: "dist/client",
    format: ["cjs", "esm"],
    dts: true,
  },
  // Optional Next.js adapter: a drop-in middleware (+ primitives) that mints the
  // shared `__se_anon_id` bucketing cookie at the edge. `next` is external (an
  // optional peer) — only resolved in consumers that import this subpath.
  {
    entry: { index: "src/next/index.ts" },
    outDir: "dist/next",
    format: ["cjs", "esm"],
    dts: true,
    external: ["next", "next/server"],
  },
  // OpenFeature providers. The `@openfeature/*` packages are optional peers —
  // external so they resolve from the consumer's install, not bundled here.
  {
    entry: { index: "src/openfeature-server/index.ts" },
    outDir: "dist/openfeature-server",
    format: ["cjs", "esm"],
    dts: true,
    external: ["@openfeature/server-sdk", "@openfeature/web-sdk"],
  },
  {
    entry: { index: "src/openfeature-web/index.ts" },
    outDir: "dist/openfeature-web",
    format: ["cjs", "esm"],
    dts: true,
    external: ["@openfeature/server-sdk", "@openfeature/web-sdk"],
  },
  // Headless devtools core (admin API client, PKCE device auth, public bug
  // intake, form schemas). `zod` is an optional peer of this subpath — external
  // so it resolves from the consumer's install.
  {
    entry: { index: "src/devtools/index.ts" },
    outDir: "dist/devtools",
    format: ["cjs", "esm"],
    dts: true,
    external: ["zod"],
  },
  // React Native devtools overlay. React / react-native / the expo-* modules
  // are optional peers — external, resolved (or not) in the consumer app. The
  // overlay never imports the client module (that would inline a second Engine
  // singleton); project capabilities arrive via the globalThis bridge the
  // client Engine publishes (src/devtools/capabilities.ts).
  {
    entry: { index: "src/react-native-devtools/index.ts" },
    outDir: "dist/react-native-devtools",
    format: ["cjs", "esm"],
    dts: true,
    external: [
      "react",
      "react/jsx-runtime",
      "react-native",
      /^expo-/,
      "zod",
      "react-hook-form",
      /^@hookform\//,
    ],
  },
  // Browser devtools overlay (importable entry). `zod` stays an external peer;
  // @cfworker/json-schema (the config schema-form validator) is bundled so the
  // SDK keeps zero runtime dependencies.
  {
    entry: { index: "src/browser-devtools/index.ts" },
    outDir: "dist/browser-devtools",
    format: ["cjs", "esm"],
    dts: true,
    external: ["zod"],
    noExternal: ["@cfworker/json-schema"],
    target: "es2020",
  },
  // Self-executing browser bundle for <script src="…/se-devtools.js"> usage —
  // the artifact the shipeasy monorepo copies to apps/ui/public/se-devtools.js.
  // Runs loadOnTrigger() automatically; everything (zod included) is bundled.
  {
    // tsup names iife outputs `<entry>.global.js` → dist/browser-devtools.global.js
    entry: { "browser-devtools": "src/browser-devtools/auto.ts" },
    outDir: "dist",
    format: ["iife"],
    target: "es2020",
    minify: true,
    dts: false,
  },
  // `shipeasy-skill` CLI — the opt-in installer that copies the bundled agent
  // skill (docs/skill/SKILL.md) into a consumer's project. A Node bin (CJS +
  // shebang); SKILL.md ships via the package `files` list and is read at runtime.
  {
    entry: { "skill-cli": "src/skill-cli.ts" },
    outDir: "dist",
    format: ["cjs"],
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  // Drop-in <script>-tag loader for non-React customers. Uploaded to the
  // public R2 bucket on every npm publish via the `publish-loader` script.
  // Not exported via the npm `files` list — it's a CDN artifact, not a
  // package import surface.
  {
    entry: { loader: "src/loader.ts" },
    outDir: "dist/loader",
    format: ["iife"],
    globalName: "__shipeasyLoader",
    minify: true,
    dts: false,
  },
]);
