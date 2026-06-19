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
