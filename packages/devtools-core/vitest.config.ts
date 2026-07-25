import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Resolve the sibling workspace packages from SOURCE, mirroring this package's
// tsconfig `paths`. Vitest uses node resolution, which would otherwise want
// their built `dist/` — forcing a build before every test run.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@shipeasy/sdk/devtools-contract",
        replacement: at("../../src/devtools-contract/index.ts"),
      },
    ],
  },
  test: {
    // Tests pick their own environment where they need a DOM
    // (`// @vitest-environment jsdom` at the top of the file).
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  esbuild: { jsx: "automatic" },
});
