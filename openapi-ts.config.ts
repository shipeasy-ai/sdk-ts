import { defineConfig } from "@hey-api/openapi-ts";

/**
 * Spec-first codegen for the devtools admin surface (`src/devtools/generated`).
 *
 * Input is `spec/admin-openapi.yaml` — a vendored snapshot of the bundled
 * `@shipeasy/openapi` admin contract (the same spec the dashboard, CLI, and the
 * devtools overlays are generated from). Refresh it with
 * `pnpm run refresh:spec` when working inside the shipeasy monorepo, then
 * re-run `pnpm run gen:devtools` and commit both.
 *
 * Emits types + zod schemas + the per-operation SDK and fetch client. The
 * devtools core (`src/devtools/api.ts`) is a thin session wrapper over the
 * generated operations: it owns what codegen can't (per-session bearer key,
 * memo cache, cursor draining, 401 → onUnauthed, record projections) and calls
 * a generated function for every endpoint the spec covers. Generated output is
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
    // Per-operation SDK functions (tree-shakeable) over the fetch client.
    // DevtoolsClient passes its own per-session `client` instance to every
    // call — the module-level default client is never used.
    "@hey-api/sdk",
    "@hey-api/client-fetch",
  ],
});
