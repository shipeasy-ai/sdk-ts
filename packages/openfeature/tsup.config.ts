import { defineConfig } from "tsup";

// Both providers wrap the app's ALREADY-configured SDK instance, so
// @shipeasy/sdk is a peer and stays external — bundling it would inline a
// second Engine and the provider would read a never-configured one. The
// @openfeature/* packages are optional peers: install only the side you use.
export default defineConfig({
  entry: { server: "src/server.ts", web: "src/web.ts" },
  outDir: "dist",
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  external: [
    "@openfeature/server-sdk",
    "@openfeature/web-sdk",
    "@shipeasy/sdk",
    /^@shipeasy\/sdk\//,
  ],
});
