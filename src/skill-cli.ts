/**
 * `shipeasy-skill` — install the bundled Shipeasy agent skill into a project.
 *
 * npm has no safe post-install hook for this (installers run non-interactively),
 * so shipping the skill is an explicit, opt-in command:
 *
 *     npx shipeasy-skill install                 # -> .claude/skills/shipeasy-typescript/SKILL.md
 *     npx shipeasy-skill install --dir path/     # custom destination (file or dir)
 *     npx shipeasy-skill install --force         # overwrite an existing file
 *     npx shipeasy-skill print                   # write the skill to stdout
 *
 * The skill (docs/skill/SKILL.md) ships in the package `files` list; at runtime
 * we resolve it relative to this built file, with a source-checkout fallback.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_DEST = ".claude/skills/shipeasy-typescript/SKILL.md";

function skillText(): string {
  // Built file lives at <pkg>/dist/skill-cli.js → SKILL.md at <pkg>/docs/skill.
  // Source checkout: this file is <pkg>/src/skill-cli.ts → same relative path.
  const candidates = [
    join(__dirname, "..", "docs", "skill", "SKILL.md"),
    join(__dirname, "..", "..", "docs", "skill", "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("shipeasy-skill: bundled SKILL.md not found in the package.");
}

function install(dir: string, force: boolean): number {
  let dest = resolve(dir);
  // Treat an existing directory, or a path with no file extension, as a directory.
  const looksLikeDir = (existsSync(dest) && statSync(dest).isDirectory()) || !/\.[^/]+$/.test(dest);
  if (looksLikeDir) dest = join(dest, "SKILL.md");
  if (existsSync(dest) && !force) {
    process.stderr.write(`shipeasy-skill: refusing to overwrite ${dest} — pass --force\n`);
    return 1;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, skillText(), "utf8");
  process.stdout.write(`shipeasy-skill: installed the Shipeasy agent skill → ${dest}\n`);
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "print") {
    process.stdout.write(skillText());
    return 0;
  }
  if (cmd === "install") {
    let dir = DEFAULT_DEST;
    let force = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--force") force = true;
      else if (rest[i] === "--dir") dir = rest[++i] ?? DEFAULT_DEST;
    }
    return install(dir, force);
  }
  process.stdout.write(
    "shipeasy-skill — install the Shipeasy agent skill.\n\n" +
      "  shipeasy-skill install [--dir <path>] [--force]\n" +
      "  shipeasy-skill print\n",
  );
  return cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
