import { defineConfig } from "tsup";

// `next` is external: middleware runs inside Next's own edge runtime, so
// NextResponse must be the host's instance — a bundled copy would fail the
// `instanceof NextResponse` checks Next itself performs, and would pin the
// x-middleware-next protocol to whatever version we compiled against.
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  external: ["next", "next/server"],
});
