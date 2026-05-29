# Changelog

## 2.5.1

### Fixed

- **Unload event flush no longer drops events.** `navigator.sendBeacon()` can't
  set the `X-SDK-Key` header, so page-unload flushes hit `/collect` unauthenticated
  and were rejected (401). The beacon now carries the key in the request body as
  `k`; the edge `/collect` endpoint reads it as a fallback when the header is absent.


## 2.5.0

### Added

- **`flags.ks(name, switch?)` killswitch reader.** Both `@shipeasy/sdk/server`
  and `@shipeasy/sdk/client` expose a new `flags.ks(name, switchKey?)` that
  returns the killswitch state for a given name. With no `switchKey`, returns
  the top-level killed state. With a `switchKey`, returns the per-switch
  override boolean. Backed by a new `killswitches` field on the bootstrap
  blob; older blobs without the field cause `ks()` to return `false`.

## 2.4.0

### Added

- **`__auto_session_active` heartbeat.** Client emits a session-activity ping
  in the `engagement` group on every page load, and again whenever the tab
  returns to the foreground after being hidden for more than 30 minutes
  (heuristic for a fresh session). Drives the new D1/D7/D30 retention
  presets in the admin UI's metric template gallery — `count_users` of
  `__auto_session_active` per day is the underlying signal.

  No app changes required if `autoCollect.engagement` is on (the default).
  Opt out the same way as the other engagement signals:

  ```ts
  shipeasy({ apiKey, autoCollect: { engagement: false } });
  ```

## 2.3.0

### Changed (breaking default)

- **`autoCollect` defaults back to ON.** 2.2.0 made auto-collection opt-in because
  the worker's `/collect` endpoint rejected `__auto_*` events not present in the
  project's event catalog. That validation now bypasses `__auto_*` names server-side
  (the worker treats them as built-in system events), so the SDK ships with vitals,
  errors, and engagement signals flowing on first install. This pairs with the new
  metric-presets gallery in the admin UI — customers see real LCP/INP/error data
  without per-event registration.

- **Per-group opt-out.** `autoCollect` accepts either a boolean or an object
  selecting individual groups:

  ```ts
  import { shipeasy } from "@shipeasy/sdk/client";

  shipeasy({ apiKey });                                      // all groups on (new default)
  shipeasy({ apiKey, autoCollect: false });                  // all off
  shipeasy({ apiKey, autoCollect: { errors: false } });      // vitals + engagement only
  ```

  Groups: `vitals` (LCP, INP, CLS, TTFB, FCP, page_load, dom_ready, fp),
  `errors` (`__auto_js_error`, `__auto_network_error`), `engagement`
  (`__auto_abandoned`).

- `FlagsClientBrowserOptions` gains an `autoGuardrailGroups?:
  Partial<AutoCollectGroups>` field for low-level callers that bypass `shipeasy()`.

## 2.2.0

### Changed (breaking default)

- **Auto-collected web vitals + JS error metrics are now opt-in.** The
  browser SDK previously installed PerformanceObservers + global error
  hooks on every `shipeasy()` boot and emitted `__auto_page_load`,
  `__auto_lcp`, `__auto_cls`, `__auto_ttfb`, `__auto_fcp`, `__auto_fp`,
  `__auto_dom_ready`, `__auto_js_error`, and `__auto_network_error`
  events through `/collect`. Because `/collect` validates metric names
  against the project's event catalog, this caused 422 errors and pending
  catalog rows for every project that hadn't approved those names.
  Auto-collection now requires `autoCollect: true` in `shipeasy(...)`:

  ```ts
  import { shipeasy } from "@shipeasy/sdk/client";
  shipeasy({ apiKey: "...", autoCollect: true });
  ```

  Existing callers who relied on the prior behavior must add the flag.
  The low-level `FlagsClientBrowser` accepts `autoGuardrails: true` for
  the same effect (also flipped from previous default).

## 2.1.15

### Fixed

- **Edit-labels cookie no longer breaks hydration on later visits.** The
  inline marker-patcher in the bootstrap script only activated when the
  URL contained `?se_edit_labels=1`, but the server-side `i18n.t()` reads
  the persisted `se_edit_labels=1` cookie (set automatically by the same
  bootstrap on the first URL-param visit, max-age 24h). After the URL
  param was stripped (a normal navigation), the server kept wrapping
  strings with `￹key￺…￻` markers via the cookie, while
  the client rendered plain strings — producing a React hydration
  mismatch (error #418) on every page in the 24h cookie window. The
  inline patcher now detects edit mode from the cookie too, matching
  the server's detection, so SSR and hydration agree.

## 2.1.14

### Fixed

- **SSR i18n no longer flashes raw keys in `"use client"` components.**
  In Next.js App Router, RSC and the SSR-of-client-components pass run
  in separate module graphs. Server Components import
  `@shipeasy/sdk/server` (which installs the
  `Symbol.for("@shipeasy/sdk:ssr-i18n")` getter on `globalThis`); client
  components only import `@shipeasy/sdk/client`, so the SSR pass for
  them ran in a graph where the getter was missing — `i18n.t()` returned
  the raw key, the SSR HTML embedded it, and on hydration the client
  (with `window.i18n` populated by the bootstrap shim) rendered the
  translated string, producing a hydration mismatch and a visible flash
  of keys before React swapped them out. The client SDK now falls back
  to reading the shared `Symbol.for("@shipeasy/sdk:ssr-i18n-cache")` Map
  directly when the getter isn't installed, so SSR strings resolve
  regardless of which module graph the component renders in.

## 2.1.13

### Added

- **`shipeasy()` lazy auto-identifies the visitor at boot.** Previously
  `shipeasy({ apiKey })` only configured the singleton; callers had to
  wire `flags.identify({ user_id })` themselves before flag/experiment
  reads returned anything useful. Now `shipeasy()` fires
  `client.identify({})` once after configure, sending the stable
  localStorage `anonId` and auto-collected browser attrs (locale,
  timezone, path, screen, referrer, user_agent) so anonymous-targeting
  gates evaluate immediately.
- **`autoIdentify?: boolean` opt-out** on `ShipeasyClientConfig` for hosts
  with their own identify orchestration that want to skip the boot
  `/sdk/evaluate` round-trip.

### Fixed

- **Race protection in `FlagsClientBrowser.identify()`.** A monotonic
  sequence counter ensures a later identify() always wins even when its
  `/sdk/evaluate` response races and lands before an earlier in-flight
  call's. Stale responses are dropped — `evalResult` and exposure
  logging only reflect the latest identify. Callers can now safely fire
  `flags.identify({ user_id })` while the boot auto-identify is still
  in flight without risk of being overwritten by it.
- **`identify()` no longer clears `userId` on a `{}` call.** Previously
  any identify with no `user_id` reset the stored user to `""`. Now the
  stored user is only overwritten when the call explicitly supplies a
  `user_id`, which is what the auto-identify path relies on to coexist
  with later authenticated identify()s.

### Compat

- Pure additive change to `ShipeasyClientConfig`. Existing 2-arg
  `shipeasy({ apiKey, baseUrl })` callers keep their behaviour and pick
  up auto-identify automatically.
- `FlagsClientBrowser.identify()` signature is unchanged. Direct callers
  (e.g. the `loader.js` script-tag bundle) get the race protection for
  free.

## 2.1.12

### Fixed

- **SSR `t()` wasn't wrapping with markers** because edit-labels mode is
  detected via URL param, but apps running on opennext-cloudflare don't
  have a Node-runtime middleware to forward the URL into RSCs. The inline
  patcher now sets a `se_edit_labels=1` cookie when it sees the URL param
  on the client; `shipeasy()` reads that cookie via `next/headers().cookies()`
  on subsequent requests so SSR knows. After enabling edit mode, **refresh
  once** for SSR-rendered text to start arriving with markers.
- `client/index.ts` `isEditLabelsMode()` falls back to reading the global
  fallback symbol directly when the property getter installed by
  `server/index.ts` isn't visible (Next.js bundles RSC, SSR and Edge
  layers separately and the getter side-effect doesn't always make it
  into the layer that runs `t()`).

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
