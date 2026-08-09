import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

/**
 * `@shipeasy/sdk` has NO dependencies on a framework and NO peer dependencies —
 * an app that installs it to read a flag must never be made to resolve Next.js.
 * The server entry still carries a Next-only ambient fallback (`next/headers`,
 * for Next apps that never pass `opts.cookies`), and the try/catch around it only
 * covers the RUNTIME half: a statically analysable `next/headers` specifier is
 * resolved by Rollup/Vite while bundling a non-Next app, failing the build
 * outright, long before any catch can run.
 *
 * These tests bundle the EMITTED files (what a consumer installs — the source is
 * not what ships, and esbuild folds the deliberately split specifier back into a
 * literal before the `unfold-next-headers` tsup plugin re-splits it) the way a
 * non-Next server app would, and assert they come out clean. The control case
 * proves the bundler would in fact have caught a regression.
 *
 * The other half of the contract — that a real Next app STILL gets its ambient
 * cookie read, on both webpack and Turbopack — cannot be covered here; it needs a
 * real `next build`. Re-run that by hand if you touch `loadNextHeaders`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_BUNDLE = resolve(root, "dist/server/index.mjs");
const CLIENT_BUNDLE = resolve(root, "dist/client/index.mjs");

/** Bundle `entry` the way a non-Next Node/Workers app would: nothing externalised,
 *  so every specifier the SDK names has to resolve. Resolves on success. */
async function bundleAsNonNextApp(entry: string): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: entry,
      write: false,
      minify: false,
      reportCompressedSize: false,
    },
  });
}

describe("bundler portability", () => {
  it("ships the built server bundle (CI builds before it tests)", () => {
    expect(existsSync(SERVER_BUNDLE), `missing ${SERVER_BUNDLE} — run \`pnpm build\` first`).toBe(
      true,
    );
  });

  it("keeps the next/headers specifier unanalysable in the emitted bundle", () => {
    for (const file of ["dist/server/index.mjs", "dist/server/index.js"]) {
      const code = readFileSync(resolve(root, file), "utf8");
      expect(code, `${file} lost the split specifier`).toContain('import("next" + "/headers")');
      expect(code, `${file} has a foldable next/headers literal`).not.toContain(
        'import("next/headers")',
      );
    }
  });

  it("bundles the server entry into a non-Next app with no framework resolution", async () => {
    await expect(bundleAsNonNextApp(SERVER_BUNDLE)).resolves.toBeUndefined();
  }, 60_000);

  it("bundles the client entry into a non-Next app with no framework resolution", async () => {
    await expect(bundleAsNonNextApp(CLIENT_BUNDLE)).resolves.toBeUndefined();
  }, 60_000);

  it("would have caught the regression: an analysable next/headers fails the same build", async () => {
    await expect(
      bundleAsNonNextApp(resolve(root, "src/__tests__/fixtures/next-headers-literal.ts")),
    ).rejects.toThrow(/failed to resolve import "next\/headers"/i);
  }, 60_000);
});
