# CLAUDE.md — `docs/`

This folder is the SDK's **published documentation**. It follows the cross-SDK
Shipeasy doc standard (experiment-platform `22-*` + `23-sdk-dx-standard.md`) so the
same structure exists in every Shipeasy SDK repo and can be consumed by tooling.

## How it's published

GitHub Pages serves this folder verbatim: **Settings → Pages → Deploy from a
branch → `main` / `/docs`**. Files are then fetchable raw at:

```
https://shipeasy-ai.github.io/sdk-ts/manifest.json
https://shipeasy-ai.github.io/sdk-ts/pages/<page>.md
https://shipeasy-ai.github.io/sdk-ts/snippets/<group>/<leaf>.md
https://shipeasy-ai.github.io/sdk-ts/skill/SKILL.md
```

`/.nojekyll` MUST stay — it makes Pages serve raw `.md`/JSON bytes (no Jekyll
HTML rendering), which is what the `docs` tooling fetches. Three consumers read
this folder: end users (rendered on github.com), the Shipeasy CLI/MCP `docs` op
(raw fetch from Pages), and the central docs portal (`apps/ui`/`apps/docs`).

## Structure

```
docs/
├── .nojekyll                 # keep — serve raw bytes
├── manifest.json             # the index of everything (schemaVersion 2)
├── skill/SKILL.md            # installable agent skill (YAML frontmatter + guide)
├── pages/                    # feature-reference pages (FIXED key vocabulary)
└── snippets/<group>/<leaf>.md  # tiny copy-paste blocks, grouped
```

### `manifest.json`

The runtime index. Keep it valid JSON and in sync with the files on disk:

- `sdk` — the registry name (`"typescript"`).
- `placeholders` — every `{{TOKEN}}` used in snippets (callers substitute these):
  `FLAG_KEY`, `CONFIG_KEY`, `KILLSWITCH_KEY`, `EXPERIMENT_KEY`, `EVENT_NAME`,
  `SUCCESS_EVENT`, `PROFILE`. Add a token here when you introduce it.
- `skill` — path to the installable skill.
- `pages` — map of page key → path. The **keys are a fixed vocabulary shared
  across all SDKs**: `overview, installation, configuration, flags, configs,
  killswitches, experiments, i18n, error-reporting, testing, openfeature,
  advanced`. Don't rename keys.
- `snippets` — nested `{ group: { leaf: path } }`. Groups: `release`
  (flags/configs/killswitches/experiments), `metrics` (track), `i18n`
  (setup/render), `ops` (see). Adding a snippet = add the file **and** its
  manifest entry.

### `pages/`

One feature-reference page per fixed key. Each starts with an H1 (used as the
title/description by the portal generator) and documents that feature for **this
SDK's real API**. Written around `configure()` + `new Client(user)` — never the
`Engine` (see the repo-root `CLAUDE.md`).

### `snippets/<group>/<leaf>.md`

Minimal copy-paste examples. Conventions (enforced — keep them):

- **No `configure()` call inside snippet code** — configuration is shown on the
  Installation page. A one-line "Assumes `configure()` ran at startup — see
  Installation." note is fine.
- **Construct the bound client on its own line**, with a "construct once per
  callsite" comment — never chain `new Client(user).getFlag(...)`.
- **Document every argument** inline (defaults, optional params, what each does).
- Use the manifest's `{{PLACEHOLDER}}` tokens for resource keys / event names /
  profile (e.g. `{{FLAG_KEY}}`, `{{EVENT_NAME}}`), not hard-coded names.
- A file may hold a few labelled mini-snippets (`### Heading` + a block each) to
  cover a feature's main variations — keep each block small and focused.

### `skill/SKILL.md`

An installable Claude-Code-style skill: YAML frontmatter (`name`, `description`)
followed by a tight, copy-paste-runnable usage guide. The frontmatter ships with
it (a consumer installs it verbatim via `npx shipeasy-skill install`), so keep it
valid.

## The README is generated from these docs

`../README.md` is **generated** by `../scripts/gen-readme.mjs` — it pulls the
install block, the quickstart, and the testing section out of these pages and
builds a documentation table from `manifest.json`. After any doc edit, run
`pnpm run gen:readme` from the repo root and commit the result; CI (`test.yml`)
fails if it drifts. Never hand-edit the README.

## Working on the docs

- **Keep docs in lockstep with the code.** Any public API/behaviour change in
  `src/` updates the matching page(s), snippet(s), and the skill in the *same*
  change, then regenerate the README (repo-root `CLAUDE.md` hard rule).
- After edits: `node -e "JSON.parse(require('fs').readFileSync('docs/manifest.json'))"`
  and confirm every `pages`/`snippets`/`skill` path the manifest lists exists.
- Prefer plain Markdown (fenced code, tables, lists). The central portal compiles
  these as MDX, so avoid bare `<` / unescaped `{` in prose (inside code fences is
  fine).
- Don't restructure the fixed `pages` keys or drop `.nojekyll`.
