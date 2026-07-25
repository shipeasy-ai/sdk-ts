import { defineConfig } from "tsup";

// Private package: the only artifact is the self-executing bundle served as
// `se-devtools.js` by the admin app and the edge worker (the shipeasy monorepo
// copies it into apps/ui/public + packages/worker/public). Everything is
// bundled — zod, @cfworker/json-schema, the devtools core and the SDK contract
// — because the overlay is delivered as a plain <script src>, not an import.
export default defineConfig({
  entry: { "se-devtools": "src/auto.ts" },
  outDir: "dist",
  format: ["iife"],
  target: "es2020",
  minify: true,
  dts: false,
  clean: true,
});
