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
