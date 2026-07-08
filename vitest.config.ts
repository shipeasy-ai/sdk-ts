import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // The SDK's own test suite lives under src/__tests__/ (per CLAUDE.md). Scope
    // the runner there so the default glob doesn't sweep in the examples/ demo
    // app's aspirational render test (it drives a placeholder page).
    include: ["src/**/*.test.ts"],
    // Declare the suite production-equivalent for the env-derived egress
    // defaults (network + telemetry are OFF outside prod). See setup.ts.
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  // The example render test (examples/guide) uses JSX; esbuild's default classic
  // runtime would need React in scope. Use the automatic runtime so the JSX
  // compiles without a manual React import.
  esbuild: {
    jsx: "automatic",
  },
});
