import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Resolve @shipeasy/sdk from SOURCE, mirroring this package's tsconfig `paths`
// — vitest uses node resolution, which would otherwise demand a built dist/.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@shipeasy/sdk/server", replacement: at("../../src/server/index.ts") },
      { find: "@shipeasy/sdk/client", replacement: at("../../src/client/index.ts") },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
