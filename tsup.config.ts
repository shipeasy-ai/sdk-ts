import type { Plugin } from "tsup";
import { defineConfig } from "tsup";

/**
 * Keep the Next-only ambient `next/headers` import UNANALYSABLE in the published
 * server bundle.
 *
 * The source writes it as `import("next" + "/headers")` on purpose, but esbuild
 * constant-folds that back into a single string literal — and a literal is the
 * one form that breaks non-Next consumers: Rollup/Vite resolve it while bundling
 * and hard-fail ("Rollup failed to resolve import 'next/headers'") long before
 * the try/catch around it can run. This package has no dependencies and no peers;
 * installing it to read a flag must never make a build resolve Next.
 *
 * So re-split the concatenation in the emitted chunk. The two bundlers that
 * matter behave differently on it, which is exactly what we want:
 *   • webpack / Turbopack EVALUATE the concatenation, so a Next app still maps it
 *     to Next's own bundled `next/headers` — the ambient cookie read (and its
 *     request scope) keeps working, which an ignore-comment would have broken.
 *   • Rollup / Vite refuse to analyse it and leave a runtime-only import, which
 *     simply throws in a non-Next runtime and lands in the catch.
 * Verified end to end by `src/__tests__/bundler-portability.test.ts` (bundles the
 * emitted files) and by a real `next build` on both bundlers.
 */
const FOLDED = 'import("next/headers")';
const SPLIT = 'import("next" + "/headers")';
const unfoldNextHeaders: Plugin = {
  name: "unfold-next-headers",
  renderChunk(code) {
    if (!code.includes(FOLDED)) return;
    return { code: code.split(FOLDED).join(SPLIT) };
  },
};

export default defineConfig([
  {
    entry: { index: "src/server/index.ts" },
    outDir: "dist/server",
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    plugins: [unfoldNextHeaders],
  },
  {
    entry: { index: "src/client/index.ts" },
    outDir: "dist/client",
    format: ["cjs", "esm"],
    dts: true,
  },
  // NOTE: this package declares NO peer dependencies at all. Every integration
  // that would need one lives in its own package under packages/* —
  // @shipeasy/next (peer: next), @shipeasy/openfeature (peers: @openfeature/*),
  // and the three devtools packages (react / react-native / expo-* / zod).
  // Installing @shipeasy/sdk to read a flag must never make npm resolve, or
  // version-check, a framework you aren't using.
  //
  // The zero-dependency seam the devtools packages build on: the globalThis
  // bridge the client Engine publishes, the capability payload shape, the
  // override-cookie format, the i18n edit-labels markers, and the see() event
  // builders. The overlays themselves live in packages/* (@shipeasy/devtools-core,
  // @shipeasy/browser-devtools, @shipeasy/react-native-devtools) so their react /
  // react-native / expo-* / zod peers never land on this package's peer list.
  {
    entry: { index: "src/devtools-contract/index.ts" },
    outDir: "dist/devtools-contract",
    format: ["cjs", "esm"],
    dts: true,
  },
  // `shipeasy-skill` CLI — the opt-in installer that copies the bundled agent
  // skill (docs/skill/SKILL.md) into a consumer's project. A Node bin (CJS +
  // shebang); SKILL.md ships via the package `files` list and is read at runtime.
  {
    entry: { "skill-cli": "src/skill-cli.ts" },
    outDir: "dist",
    format: ["cjs"],
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
