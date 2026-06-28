import { defineConfig } from "vitest/config";

// renderToStaticMarkup does not need a DOM, so the default node environment is
// fine. The page under test is a server component (no browser globals).
export default defineConfig({
  // The example's tsconfig uses `jsx: "preserve"` (Next compiles JSX). Under
  // Vitest/esbuild we compile JSX ourselves with the automatic runtime so the
  // server component renders without a classic `React` global in scope.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
