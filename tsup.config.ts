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
