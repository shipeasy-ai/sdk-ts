# Changelog

## 2.1.11

### Changed

- **Label markers now carry variables.** `?se_edit_labels=1` produces
  3-section markers `￹key￺varsJson￺value￻` (was `￹key￺value￻`).
  Devtools picks up `{key, vars, value}` directly from any text node or
  attribute that contains the marker — no more value-based reverse-lookups
  or template/value diffing to recover variable names. `varsJson` is `""`
  when the call site passed no variables.
- **SSR `i18n.t()` wraps with markers in edit-labels mode.** Previously
  only `tEl()` did. Server Component-rendered text (e.g. `<span>Member</span>`)
  now arrives in the DOM as `￹common.member￺￺Member￻` instead of plain
  `Member`, so devtools doesn't need to guess which key produced a string.

### Compat

- `encodeLabelMarker(key, value, variables?)` — `variables` is a new
  optional third arg. Existing 2-arg callers keep compiling; the emitted
  marker just has an empty `varsJson` section.
- `LABEL_MARKER_RE` now has three capture groups. Anything that destructures
  exec results expecting `[, key, value]` must update to `[, key, vars, value]`.

## 2.1.10

### Fixed

- **CF Workers crash on every `shipeasy()` call.** The SSR edit-mode
  setter installed via `Object.defineProperty(globalThis, …)` called
  `AsyncLocalStorage.enterWith()`, which workerd does not implement —
  every server-rendered page returned HTTP 500 with
  `Error: asyncLocalStorage.enterWith() is not implemented`. The
  `enterWith` call is now wrapped in try/catch; the per-isolate
  fallback global already covers the read path on runtimes without
  enterWith.

## 2.1.9

`getBootstrapHtml()` is now self-contained — consumers just inline its
output and get a fully-wired client.

### Fixed

- **i18n profile pass-through.** `shipeasy({ i18nDefaultProfile })` was
  honored for the SSR string fetch but the loader `<script>` injected by
  `getBootstrapHtml()` always used the hardcoded `"en:prod"` default, so
  client-side runtime translation lookups missed every key whenever the
  caller used a non-default profile. The closure now forwards
  `i18nProfile` so the loader and the SSR fetch agree.

### Added

- **Edit-labels shim baked into bootstrap.** When `?se_edit_labels=1` is
  in the URL, `getBootstrapHtml()` now emits a `window.i18n` setter
  interceptor as the first statement of its script. Both the inline SSR
  shim and the later CDN loader assignment get wrapped, so every
  translated string is rendered as `￹key￺value￻` for the devtools overlay
  to scan. Previously consumers had to add this shim manually in
  `<head>` before the bootstrap script — easy to forget and silently
  broke in-place editing in production.

## 2.1.8

Drop unused `zod` peer dependency (the SDK source has no `zod` imports — the
optional peer was vestigial and produced misleading peer warnings for
consumers).

Reconciles the git/npm version skew: versions 2.1.2, 2.1.3, 2.1.5, and 2.1.7
were published manually to npm from local checkouts and never tagged or
released through this repo's CI. 2.1.8 is the first attested CI publish since
2.1.1 and skips the missing patch numbers to avoid colliding with the
manually-published versions on npm.

## 2.1.1

Re-publish of 2.1.0. The 2.1.0 release ran CI without `@types/node` and the
publish workflow failed at `tsc --noEmit` (`Cannot find module 'node:async_hooks'`).
2.1.1 ships the same code plus the missing devDep so CI green-lights publish.

## 2.1.0

### Added

- `i18n.rich(key, fallback, components?, variables?)` — translate a key whose
  value contains `<tag>content</tag>` segments. Built-in renderers for 20
  inline HTML tags (`b`, `i`, `u`, `s`, `em`, `strong`, `del`, `ins`, `mark`,
  `small`, `code`, `pre`, `kbd`, `sub`, `sup`, `span`, `a`, `p`, `br`, `hr`)
  return real DOM nodes in the browser and HTML strings on the server.
  Framework-agnostic — no React or DOM dependency in the SDK itself; pass any
  `components` map whose renderers return JSX, DOM nodes, markdown, etc.
- `i18n.configure({ components })` — register global rich-text component
  overrides (e.g. swap the built-in `<a>` for a framework `<Link>`).
  Lookup chain per call: per-call `components` → configure() defaults →
  built-in defaults → passthrough.
- `I18nKey` and `I18nString` branded string types — opt-in nominal types for
  call-site annotation. Both extend `string` so plain literals remain
  assignable, but APIs that want to enforce "this came from i18n" can declare
  `title: I18nString` and TypeScript will steer callers toward `i18n.t(...)`.
- `i18n.t<F extends string>(key, fallback, variables?)` — generic preserves
  the literal type of `fallback` (e.g. `i18n.t('k', 'Clinical')` returns
  `'Clinical' & I18nString`, not `string`), preventing widening that broke
  discriminated unions.
- Legacy `i18n.t(key, variables)` overload restored for backwards-compat —
  if arg 2 is a string it's the fallback, if it's an object it's variables.

### Changed

- `I18nVariables` now accepts `string | number | null | undefined`. Null /
  undefined values keep their `{{name}}` placeholder instead of rendering
  the literal string `"null"`. Templates that interpolate optional fields
  (`?.` chains, nullable columns) no longer need manual `?? ""` coercion.
- `i18n.tEl()` is now `@deprecated` — delegates to `i18n.t()` and returns
  the translated string. Edit-labels marker behavior preserved for the
  devtools overlay.

## 2.0.0

### Breaking

- `i18n.t(key, fallback, variables?)` — `fallback` is now a required second
  positional argument. The SDK returns the interpolated `fallback` whenever
  the key is missing from the active profile (CDN downtime, profile not yet
  fetched, key not yet published), so pages never render a raw key.
- `i18n.tEl(key, fallback, variables?, desc?)` — same shape, with the existing
  `desc` slot moved to position four.
- Variable interpolation (`{{name}}`) now runs on the `fallback` string as
  well as the translated string, so the same `variables` object works in both
  paths.

### Migration

```ts
// Before
i18n.t("hero.title");
i18n.t("hero.greeting", { name });
i18n.tEl("nav.cta", undefined, "Primary CTA");

// After
i18n.t("hero.title", "Ship faster.");
i18n.t("hero.greeting", "Welcome, {{name}}", { name });
i18n.tEl("nav.cta", "Install with Claude", undefined, "Primary CTA");
```

The `@shipeasy/react` adapter ships a matching 2.0 release: `t`, `tEl`, and
`<ShipEasyI18nString>` all require a `fallback`. See its CHANGELOG for the
React-side migration.
