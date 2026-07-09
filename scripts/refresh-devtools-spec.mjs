// Refresh spec/admin-openapi.yaml from the shipeasy monorepo's bundled
// @shipeasy/openapi contract. Only works when this repo is checked out as the
// monorepo's packages/server-sdks/sdk-ts submodule (the normal dev setup);
// standalone checkouts keep using the committed snapshot.
//
// Usage: pnpm run refresh:spec  (then `pnpm run gen:devtools` + commit both)

import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../../../marketplace/openapi/openapi.yaml");
const target = resolve(here, "../spec/admin-openapi.yaml");

if (!existsSync(source)) {
  console.error(
    `Monorepo spec not found at ${source} — run this from the shipeasy monorepo checkout.`,
  );
  process.exit(1);
}

copyFileSync(source, target);
console.log(`Refreshed ${target}`);
