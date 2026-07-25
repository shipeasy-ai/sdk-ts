import { defineConfig } from "tsup";

// One entry per deep-import subpath (`@shipeasy/devtools-core/api`, `/auth`, …)
// so the overlays keep importing the exact modules they did when this code
// lived inside the SDK. `splitting` dedupes the shared generated client across
// the ESM outputs. `zod` and the SDK contract are peers — never bundled.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    api: "src/api.ts",
    auth: "src/auth.ts",
    forms: "src/forms.ts",
    "gate-flow": "src/gate-flow.ts",
    "feedback-state": "src/feedback-state.ts",
    "public-report": "src/public-report.ts",
    "self-report": "src/self-report.ts",
  },
  outDir: "dist",
  format: ["cjs", "esm"],
  splitting: true,
  dts: true,
  clean: true,
  external: ["zod", "@shipeasy/sdk", /^@shipeasy\/sdk\//],
});
