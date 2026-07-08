# CLAUDE.md — `@shipeasy/sdk` (TypeScript)

Guidance for AI agents (and humans) working in this repository.

## What this is

`@shipeasy/sdk` — the TypeScript SDK for [Shipeasy](https://shipeasy.ai): feature
flags, dynamic configs, kill switches, A/B experiments, metric tracking, `see()`
error reporting, and SSR/i18n helpers. Dual build (tsup): the **server** entry
(`@shipeasy/sdk/server`, server key) and the **browser** entry
(`@shipeasy/sdk/client`, public client key) — never interchange the keys. Source
under `src/`, tests under `src/__tests__/` (run with `vitest`).

## The documented public surface (this is a contract)

Users are taught exactly **two** things, and the docs must never drift from them:

1. **`configure()`** — and its siblings `configureForTesting()` /
   `configureForOffline()` — for setup.
2. **`new Client(user)`** — the cheap, user-bound handle for *all* reads
   (`getFlag` / `getFlagDetail` / `getConfig` / `getKillswitch` / `track`, plus
   universe assignment via `universe(name).assign()`).

Plus the package-level helpers that let users avoid the heavyweight object:
`overrideFlag` / `overrideConfig` / `overrideExperiment` / `clearOverrides`,
`onChange`, the SSR helpers (`shipeasy()` / `getBootstrapData` / `getBootstrapTags`),
the global-form `ShipeasyProvider` (OpenFeature), and the `see()` family.

**The `Engine` class is an internal detail. Do NOT document it.** It stays public
for advanced/back-compat use, but no page, snippet, skill, or the README should
tell a user to construct or call an `Engine`. New user-facing capability that
today only exists on the `Engine` should get a `configure`-style or package-level
affordance, then be documented through that.

## HARD RULE: change the SDK → update the docs in the SAME change

`docs/` is the published, user-facing source of truth (rendered at
<https://shipeasy-ai.github.io/sdk-ts/> and ingested by the Shipeasy CLI/MCP `docs`
tooling and the central docs portal). If you change the SDK's **public API or
behaviour**, you MUST update the docs in the same commit:

- New/changed/removed public function, method, argument, default, or return shape
  → update the relevant `docs/pages/*.md`, the matching `docs/snippets/**`, and
  `docs/skill/SKILL.md`.
- New page / snippet / placeholder → also update `docs/manifest.json`.
- See [`docs/CLAUDE.md`](docs/CLAUDE.md) for the docs structure and conventions.

**`README.md` is generated — do not hand-edit it.** It is assembled from the docs
by `scripts/gen-readme.mjs` (install + quickstart pulled from the pages, a docs
table, and the testing section). After editing `docs/`, run:

```bash
pnpm run gen:readme
```

CI (`.github/workflows/test.yml`) re-runs it and fails if `README.md` is out of
date, so commit the regenerated file. A code change that lands without its doc
update is incomplete — when in doubt, grep `docs/` for the symbol you touched.

## Versioning & release

- Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
- Publishing is **release-gated**: a GitHub release on `shipeasy-ai/sdk-ts` triggers
  the OIDC Trusted-Publishing workflow (`.github/workflows/publish.yml`) which
  publishes `@shipeasy/sdk` to npm with provenance. Never `npm publish` from a
  local checkout.

## Checks before you commit

- `pnpm run type-check`, `pnpm run build`, `pnpm run test` (vitest; the suite is
  hermetic — no network). CI runs them on Node 20/22/24 via `test.yml`; the
  generated README shows the Tests badge.
- New public behaviour ships with a test.
- Docs updated per the hard rule above; `docs/manifest.json` stays valid JSON and
  every path it lists exists.
- `pnpm run gen:readme` and commit the result (CI checks it's in sync).
