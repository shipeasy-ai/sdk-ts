import { defineConfig } from "@hey-api/openapi-ts";

/**
 * Spec-first codegen for the devtools admin surface (`src/devtools/generated`).
 *
 * Input is `spec/admin-openapi.yaml` — a vendored snapshot of the bundled
 * `@shipeasy/openapi` admin contract (the same spec the dashboard, CLI, and the
 * in-browser devtools overlay are generated from). Refresh it with
 * `pnpm run refresh:spec` when working inside the shipeasy monorepo, then
 * re-run `pnpm run gen:devtools` and commit both.
 *
 * We deliberately emit ONLY types + zod schemas — no generated runtime client.
 * The devtools core (`src/devtools/api.ts`) owns its fetch transport (session
 * admin key, configurable base URL, memo cache, typed errors), mirroring how
 * the web devtools overlay consumes this same spec. Generated output is
 * machine-written — never hand-edit; consume it through `src/devtools/`.
 */
export default defineConfig({
  input: "./spec/admin-openapi.yaml",
  output: "./src/devtools/generated",
  plugins: [
    "@hey-api/typescript",
    // Emit `z.infer` request/response types (e.g. `CreateBugRequestInput`) so
    // the bug form consumes generated input shapes instead of hand-copied ones.
    {
      name: "zod",
      definitions: {
        types: { infer: { enabled: true, case: "PascalCase", name: "{{name}}Input" } },
      },
    },
  ],
});
