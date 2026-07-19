# Changelog

## 7.8.4 (2026-07-19)

### Revert 7.8.3's devtools-side gate evaluation — mirror the host app instead

- **The overlay no longer runs its own `/sdk/evaluate`.** 7.8.3 had the gate
  panel fetch statuses from the edge using a devtools-fabricated context
  (`project_id` = the overlay's own session project). That was the wrong model:
  it made the overlay report a project it invented rather than what the host app
  actually sees, so on a page whose app identified a _different_ user/project the
  panel disagreed with reality. The devtools must be a faithful mirror of the
  host app — the served value is once again whatever the app's own SDK evaluated
  for the user it called `shipeasy.identify(...)` with (`bridge.getFlag`), and
  the User panel shows that same identified user. Removed `evaluate.ts`, the
  `edgeUrl` DevtoolsOption, and the `data-edge-url` attribute.
- The correct fix for "a whitelist gate shows off" is to have the **host app**
  identify with the attribute the gate keys on (e.g. `project_id`) — not to have
  the overlay guess a context. (In shipeasy's own dashboard, `ShipeasyClientInit`
  now does exactly that.)

_(Overlay-only; ships via the bundled `se-devtools.js`, not the npm entry
points.)_

## 7.8.3 (2026-07-19)

### Fix: DevTools gate panel shows true stack-aware statuses

- **Statuses come from the edge, not the lossy flat columns.** The overlay's
  feature-flag panel derived each gate's shown value from the admin list's flat
  `enabled`/`rolloutPct` columns (a best-effort approximation of the gatekeeper
  stack) and the host page's own client bridge. A project-whitelist gate
  (`project_id in [...]` at 100%, then 0% public) collapses to
  `enabled:false`/`rolloutPct:0`, so it rendered "off" even while it was really
  **on** for the operator's project — and the page's client SDK never identifies
  with `project_id`, so its bridge couldn't correct that. The panel now calls the
  edge `/sdk/evaluate` once with the operator's context (crucially `project_id`,
  merged over the page's last identify attrs) and displays that stack-aware
  verdict, falling back to the client bridge then the flat column. Read-only: a
  throwaway `anonymous_id`, no page-SDK identity mutation. New optional
  `edgeUrl` option (`data-edge-url` attribute), defaulting to
  `https://cdn.shipeasy.ai`.

_(Overlay-only; ships via the bundled `se-devtools.js`, not the npm entry
points — no runtime change to `@shipeasy/sdk/server` or `/client`.)_

## 7.8.2 (2026-07-19)

### Fix: DevTools override cookie now survives reloads (grant persistence)

- **Overrides reach the server again.** The per-session signing grant that lets
  the overlay write the server-trusted `se_ov` cookie lived only in module
  memory and was set once, from the auth popup's postMessage. But every override
  reloads the page (wiping that memory) while the devtools **session token** is
  persisted in `sessionStorage` — so after any reload the overlay looked
  "connected" yet `writeSignedOverrideCookie` silently no-op'd (no grant), and an
  override only changed the URL param (client-only), never the cookie. The grant
  is now mirrored into `sessionStorage` next to the session token and rehydrated
  on overlay init for the restored project, so overrides keep writing the cookie
  across reloads. The grant is dropped on sign-out and when expired/project-
  mismatched. `Ks` is tab-scoped and sits in the same trust boundary as the
  already-persisted session token.

## 7.8.1 (2026-07-19)

### Fix: honor the gatekeeper `stack` when evaluating gates locally

- **Stacked gates now evaluate correctly in the server SDK.** `evalGateInternal`
  previously read only the flat `rules` + `rolloutPct` columns and ignored a
  gate's ordered `stack`. For a modern gatekeeper the flat columns are a lossy
  approximation — e.g. a whitelist condition at 100% followed by a 0% public
  rollout flattens to `rules: [project_id in [...]]`, `rolloutPct: 0`, which the
  flat path wrongly reads as "matches the whitelist **AND** is in the 0% bucket"
  = never true. The SDK now evaluates the `stack` top-to-bottom (condition rules
  → per-condition rollout, ramps, `bucketBy`), passing on the first entry that
  hits, exactly like `@shipeasy/core`'s `evalGatekeeper` and the edge worker. A
  stack-less gate still uses the legacy flat path unchanged. This makes
  `get_flag` / the SSR `flags` map agree with the canonical worker evaluation
  for whitelisted/targeted callers.

### Signed DevTools override cookies — overrides that reach the server (all kinds)

- **Server-trusted overrides.** DevTools overrides (feature flags, kill switches,
  configs, experiments) previously lived only in the URL query string and were
  applied purely client-side, so SSR (nav, route guards, `window.__SE_BOOTSTRAP`)
  never saw them. The overlay now also writes a **signed `se_ov` cookie**, and the
  server SDK verifies + applies it during `shipeasy()` — so an override finally
  changes what the server renders, and survives client-side navigation.
- **Unforgeable, any-user.** A paired-key HMAC handshake: the worker hands the SDK
  a per-project **verify key** (`overrideKey`/`overrideKeyId` on the `/sdk/flags`
  + `/sdk/evaluate` payload); the admin app hands the authenticated overlay a
  per-session **signing key**. Only an authenticated DevTools session can mint a
  cookie the server trusts; everything fails **closed** (missing key / forged /
  expired cookie ⇒ real values resolve).
- **Framework-general, not Next-specific.** `shipeasy({ overrideCookie })` accepts
  the bare `se_ov` value **or** a full `Cookie:` header string. Read the cookie
  however your framework exposes it (`next/headers`, `req.headers.cookie`,
  `c.req.header('cookie')`, Rack `request.cookies`, …); on Next.js it's auto-read.
  New `flags.verifyOverrides(cookie)` returns the verified map to feed `evaluate`.
- `getKillswitch` in the SSR bootstrap now reflects a verified override.

### Fixed

- The "No server key" setup warning is now emitted only on real deploys
  (`isDevOrTestEnv`), so it stops being noise in local dev / CI. (Downgraded from
  `error` to `warn`.)

## 7.7.0 (2026-07-13)

### see(): inline extras on `.to`, ambient per-request extras, no ordering footgun

- **`.to(outcome, extras)`** — the terminal now takes the extras inline, e.g.
  `see(e).causes_the("checkout").to("use cached prices", { order_id: oid })`.
  Equivalent to a final `.extras(...)`; folds under any later `.extras` (later
  wins). The chain already tolerated a trailing `.extras()` (it flushes on the
  next microtask), so there was never a hard ordering trap — but now you can put
  the extras where the consequence is, in one call.
- **`addExtras(...)` / `clearExtras()`** — an ambient per-request extras buffer,
  exported from both `@shipeasy/sdk/server` and `@shipeasy/sdk/client`. Call
  `addExtras({ order_id: id, tenant: t })` from anywhere (any layer, not just the
  catch) and every `see()` report that fires later in the same scope merges it
  in. A chained `.extras` / `.to` extra overrides an ambient key of the same
  name (chain merges OVER ambient); ambient extras are sanitized exactly like
  chained ones.
  - **Server** — the buffer is backed by `AsyncLocalStorage`, so concurrent
    requests never bleed. Wrap a request in the new **`runWithExtras(fn)`** (or
    the framework equivalent) to get a per-request scope; outside such a scope
    `addExtras` writes a module-level fallback buffer that you clear yourself
    with `clearExtras()`. The `seeExtrasContext` ALS is exported for advanced
    request-hook wiring, mirroring `seeContext`.
  - **Client (browser)** — a single module-level buffer (one user per page).
    Call `clearExtras()` on a client-side route change to reset it.

## 7.6.1 (2026-07-13)

### Fix: browser devtools login stuck on "Connect" after OAuth sign-in

- **Device-auth no longer tears down its listener on a COOP false-positive.**
  When the sign-in popup navigated to an OAuth provider that serves
  `Cross-Origin-Opener-Policy` (e.g. `accounts.google.com` sends
  `same-origin-allow-popups`), the opener's handle to the popup was neutered and
  `popup.closed` reported `true` while the window was genuinely open and
  mid-sign-in. The `startDeviceAuth` closed-poll then rejected the flow and
  removed the `message` listener before the approval `postMessage` arrived — so
  Google/GitHub sign-in delivered a valid token but the overlay stayed on the
  "Connect" screen. The `popup.closed` poll is removed; `postMessage`
  (popup → opener) survives the COOP split, so resolve-on-message plus the
  10-minute timeout are the reliable completion/failure paths.

## 7.6.0 (2026-07-10)

### React Native devtools overlay — home redesign, public feature requests, screenshots, key-based login

- **Full-page nested config viewer.** Tapping a config drills into a dedicated
  **read-only** screen (`ConfigViewerScreen`) instead of an inline JSON box: a
  tree of the value with expand/collapse and typed leaf readouts, plus a
  raw-JSON view. Configs are inspected, not forced, from the RN overlay. The
  config list rows are navigational.

- **Experiments grouped by status, with a full-page detail drill-in.** The flat
  list becomes collapsible **Running / Draft / Stopped / Archived** sections,
  each with a **count badge**. Running is open by default; the rest are folded
  (rows stay unmounted until expanded). Counts load upfront — one call for the
  active tab (running / draft / stopped), one for the archive tab
  (`DevtoolsClient.experiments({ archived })`) via the new `useExperiments` /
  `useArchivedExperiments` hooks. Tapping a row opens `ExperimentDetailScreen`:
  the experiment's metadata (universe, allocation, owner, audience, started,
  min sample), the **universe param schema**, and every **variant** as a
  collapsed-by-default card that expands to its resolved param fields (variant
  override → universe default). **Force assignment** picks a variant live.
  `ExperimentRecord` widens to carry the variant params + metadata.

- **Feature Flags panel — evaluation flow + per-flag switch.** Each flag row now
  carries an on/off **switch** (forces the value live) in place of the old
  live-value badge. Expanding a flag renders its full gatekeeper **flow**
  (whitelist → conditions → public rollout, first-match-wins) — the same model
  the dashboard's read-gate view uses — with each condition marked **pass/fail**
  for the identified user (evaluated locally from identify() attributes; rollout
  bucketing stays the edge's call) and the served value + source shown up top.
  New shared `buildGateFlow` / `evalRule` / `evalStepMatch` / `ruleSummary`
  helpers on `@shipeasy/sdk/devtools`; `GateRecord` gains `rules` + `stack`.

- **Redesigned logged-out home**: the Shipeasy brand mark, dedicated
  **Report a bug** / **Request a feature** action cards (shown when the project
  opted into public tickets), and a **Connect to Shipeasy** button pinned to the
  bottom.
- **Public feature requests**: the feature form now files through the same
  public `/cli/report` intake (`type: "feature"`) when logged out, not just the
  authed path — new `submitPublicFeature()` core helper +
  `featureFormToPublicInput()`. `useFeatureForm` gains the dual submit path
  (public + authed) and now takes a `config`.
- **Screenshot capture**: logged-in bug / feature forms can capture the current
  app screen (react-native-view-shot, optional peer) — the overlay hides itself
  for the shot and uploads it as a report attachment. New `<ScreenshotAttach>`
  component, `ScreenCaptureContext` / `useScreenCapture`, `canCaptureScreen()` /
  `captureScreenShot()`.
- **Key-based project auto-pick on login**: `<ShipeasyDevtools clientKey>` is now
  passed to the auth page, which resolves the key to its project and locks the
  flow there — the team member logs in and lands straight in the overlay with no
  project picker (mirrors the browser overlay). `startDeviceAuth` /
  `DevtoolsConfig` gain `clientKey`.
- `HomeScreen` exported for design/embedding surfaces.
- **User tab is now a read-only inspector**: it lists the exact `identify()`
  payload — caller-supplied fields split from the SDK's auto-collected
  attributes (`anonymous_id`, locale/timezone, device context), with objects
  rendered as JSON. The property-editing / "Re-evaluate to simulate another
  user" affordance is removed; the panel shows the live targeting inputs
  verbatim.
- **Drill-in section nav**: the cramped horizontal tab strip is replaced by a
  menu of big-tap section rows (far easier to hit on a phone); opening a section
  (or a report form) swaps the header brand for a **‹ Back** on the left. Each row carries the same
  Lucide icon the in-browser overlay uses (via `react-native-svg`, a new
  optional peer — text-glyph fallback when absent). The **Gates** section is
  renamed **Feature Flags** (matching the web overlay). **Log out** moves to the
  header top-right (replacing the close ✕ while logged in); the redundant
  project/email session row is dropped.

- **Feedback panel — AI/PR row tints, open-only list, header-driven back.**
  Rows now **tint by AI/PR state**: cyan when an agent opened a PR that's ready
  for review (with a tappable **PR link** on the row), amber when it posted a
  question back awaiting a reply, green when the PR **merged**. Resolved /
  won't-fix items are **no longer listed** (the Active/All toggle is gone — the
  list stays on open, actionable tickets). The detail's **metadata** renders in
  the same `Metadata` + `KV` style as the experiment detail. The per-panel back
  button is removed: Feedback's list ↔ detail nav is driven by the sheet
  header's single **‹ Back** via a new `SheetNav` context (`SheetNavContext`,
  exported), which a panel uses to hand the header a back handler + title. New
  `feedbackAgentInfo()` / `FEEDBACK_AGENT_LABEL` on `@shipeasy/sdk/devtools`;
  `FeedbackConnectorData` widens to carry the PR merged marker + agent trace.

- **Feedback panel — status sections, error/alert tickets, priority borders.**
  The queue now spans four sub-tabs — **Bugs / Features / Errors / Alerts** (the
  auto-filed system tickets are exposed too) — with open items grouped into
  **status sections**. Rows are decluttered: the status badge becomes the
  section, priority becomes a **left-border colour**, and the AI/PR pill is the
  only remaining badge, so long titles fit. New `DevtoolsClient.errors()` /
  `alerts()` / `opsItem()` / `updateOps()`; `useErrors` / `useAlerts` /
  `useOpsDetail` hooks; `OpsItemDetail` / `OpsItemType` types.

- **Active-overrides screen + header state.** The header shows a **⚡ N
  overrides** pill and an accent underline whenever any override is active;
  tapping it opens **Active overrides** — every forced flag / config / variant
  this session, clearable individually or all at once (`OverridesPanel`,
  exported).

- **Forcing a variant delivers its params.** `setExperimentOverride(name,
  group, params?)` now takes the variant's param override map, so a forced
  assignment resolves to that variant's real values (layered over the universe
  defaults) instead of just the defaults. The experiment detail passes the
  chosen variant's params.

- **Redesigned create-success screen.** Bug/feature submits land on a shared
  `CreateSuccess` screen (exported) that distinguishes the **public** path
  (ticket number + "pending review") from the **authed** path ("in the triage
  queue"), notes a dedup merge, and offers "Report/Request another".

- **The RN overlay's I18n panel is removed** for now (the section no longer
  appears in the drill-in menu; the SDK's i18n runtime is unchanged).

- **Polish.** The feedback detail header reads "Bug/Feature/Error/Alert detail"
  (the item type) instead of the item's long title. Config list rows show a
  scannable field summary instead of a raw one-line JSON dump. The config
  viewer's read-only value tree is extracted as a reusable `ValueTree` /
  `ValueContents` (exported) and now renders structured values wherever they
  appear — experiment variant params + universe defaults, and forced config
  overrides in the Active-overrides screen — instead of stringified JSON.

### Report forms — visual redesign (folded in from 7.5.1 prep)

- Bug and feature-request forms rebuilt: screen heading + explainer, field
  hints and "optional" label suffixes, focus ring on inputs (accent border),
  identity row (a quiet "follow-ups go to …" card instead of bare text),
  boxed submit errors, and a proper success state (check mark, ticket number
  chip, dedupe explanation).
- `Field` gains `hint` / `labelHint` props and a focused style; multiline
  inputs grow to 96pt min-height.
- The devtools sheet gets a grab handle.
- Form scroll views dismiss the keyboard interactively
  (`keyboardDismissMode="interactive"`).

## 7.5.0 (2026-07-10)

### Fixes: React Native devtools overlay

- **Crash-loop on mount fixed** (`Maximum update depth exceeded` / "The result
  of getSnapshot should be cached"): the capabilities bridge mints a fresh
  object per read, which React's `useSyncExternalStore` rejects as an unstable
  snapshot. `readDevtoolsCapabilities()` now memoizes by shallow equality, so
  the snapshot is referentially stable while the values are unchanged.

- **Metro no longer drops the optional Expo modules.** A new `react-native`
  exports condition pins `@shipeasy/sdk/react-native-devtools` to the CJS
  build. Metro previously resolved the ESM build, whose bundler-rewritten
  optional `require("expo-x")` calls it can't follow — expo-sensors /
  expo-web-browser / expo-secure-store silently fell out of the app bundle, so
  shake-to-open never armed and devtools login failed.

- The bug form no longer asks for the reporter's email when the app already
  identified one: `identify()`'s `email` attribute (read via the engine
  bridge) is used automatically, and the email field only renders when the
  identity has none. New `useIdentityEmail()` hook exposes the same value.
- The devtools sheet now lifts above the on-screen keyboard
  (`KeyboardAvoidingView`), so form inputs stay visible while typing.
- The logged-out bug form gets the same horizontal padding as the panels.

### Change: fetch auto-capture no longer mints issues — it only threads correlation

The client fetch wrapper (`autoCollect: { errors }`) no longer auto-reports
failed requests at all. Both the network-failure (`NetworkError`) and 5xx
(`Http5xx`) auto-reports are removed: a bare "request to /x failed" names the
transport, not what broke for the user, so it was unactionable and folded every
endpoint into a couple of noisy issues. **Reporting a failed request is now
always the caller's job** — `see()` it where you know the consequence.

What the wrapper still does is thread a per-request **correlation token** so
that report links to the backend across the network boundary: it mints the
token, sends it up on `X-SE-Correlation`, and stamps it on the object that
surfaces the failure — the thrown error (network failure) or the returned
`Response` (5xx). `see()` then picks that token up automatically from the
problem or its `.cause` chain (new internal `markCorrelated` /
`findCorrelation`, mirroring the existing `caused_by` stamp), so
`see(err)` — or `see(new Error(msg, { cause: res }))` for a 5xx — links to the
server-side issue for the same request with nothing threaded through by hand.

**Migration:** if you relied on the SDK auto-filing `NetworkError` / `Http5xx`
issues for unhandled fetch failures, add a `see()` at the call site (e.g. your
fetch wrapper's error path). A 5xx that no code `see()`s now produces no
client-side issue.

### Change: correlation now covers `XMLHttpRequest` too (axios, superagent, …)

Correlation was `fetch`-only, so an app whose HTTP goes through `XMLHttpRequest`
— axios's default adapter, superagent, jQuery.ajax — got no `X-SE-Correlation`
header and no stamp, and its `see()` reports never linked to the backend. The
client auto-capture now instruments **both** transports: it wraps
`XMLHttpRequest.open`/`send` to inject the same per-request token on same-origin
requests and, on a terminal failure (status `0` or `>= 500`), stamp the
`XMLHttpRequest` instance. Because axios (and most XHR wrappers) expose that
instance on the thrown error as `.request` / `.response.request`,
`findCorrelation` now probes those alongside the `.cause` chain — so
`see(err)` in an axios `catch`/interceptor links across the wire with nothing
threaded by hand. The XHR patch is idempotent and fully best-effort (any
failure leaves the request untouched); cross-origin requests are skipped, as
with `fetch`, to avoid forcing a CORS preflight.

## 7.4.1 (2026-07-10)

### Fix: devtools sign-in 404 when the overlay is served from the CDN

- The default `adminUrl` resolution (`scriptTagOrigin`) treated the origin
  serving `se-devtools.js` as the admin app. In production the bundle ships
  from `cdn.shipeasy.ai` (the edge Worker), so the device-auth popup opened
  `https://cdn.shipeasy.ai/devtools-auth` — a route that only exists on the
  admin app (`shipeasy.ai`) — and the edge Worker returned
  `{"error":"not_found","message":"No handler for GET /devtools-auth"}`. The
  CDN host is now recognised as a non-admin origin and falls through to the
  production admin URL, so sign-in works from the canonical script-tag snippet
  with no `adminUrl` override. `scriptTagOrigin` is now exported for testing.

### Fix: devtools list drain rejected bare-array bodies

- `DevtoolsClient`'s paginated list drain (gates / configs / experiments /
  universes) only accepted the `{ data, next_cursor }` envelope after the move
  to the generated client; a bare-array body (stubbed and legacy admin
  endpoints) made the overlays' list panels error out instead of rendering.
  Restored the pre-7.4.0 tolerance: a bare array is the complete list.

## 7.4.0 (2026-07-10)

### Devtools: browser overlay moved in, RN overlay at parity, generated-SDK core

- **New entry `@shipeasy/sdk/browser-devtools`** — the in-browser devtools
  overlay (formerly the monorepo's `@shipeasy/devtools` package) now ships from
  the SDK, in `src/browser-devtools/` parallel to the React Native overlay.
  Importable surface (`init` / `destroy` / `loadOnTrigger` + the URL-override
  helpers) plus a self-executing `dist/browser-devtools.global.js` for
  script-tag use (the `se-devtools.js` artifact). `@cfworker/json-schema` is
  bundled; `zod` stays a peer.
- **Headless core now rides the generated OpenAPI SDK.** Codegen emits the
  per-operation SDK + fetch client (`@hey-api/sdk` / `client-fetch`) alongside
  types+zod, and `DevtoolsClient` calls generated operations for every
  spec-covered endpoint (memo cache, cursor draining, 401→`onUnauthed`, and the
  few not-yet-spec'd routes stay hand-written and are marked `SPEC GAP`). New
  client surface: `universes()`, `profiles()`, `drafts()`, `keys()`,
  `createDraft()`, `upsertDraftKey()`, `updateKeyById()`, `upsertKeys()`,
  `updateFeatureRequest()`, plus `adminUrl` and shared record types
  (`UniverseRecord`, `ProfileRecord`, `DraftRecord`, `KeyRecord`,
  `FeedbackConnectorData`, `connectorData` on feedback records).
- **React Native overlay at parity with the web overlay.** New panels: User
  (edit props + re-evaluate for real), Events (live SDK stream), I18n (profile
  selector + per-key editing), and a full Feedback panel (bugs + feature
  requests, Active/All filters, detail views with inline status/priority
  editing, attachment previews and screenshot upload via optional
  `expo-image-picker`). Gates/Configs/Experiments gain search, expandable
  detail, live values and **live forcing** (no reload) driven by the Engine's
  programmatic overrides. Tabs are gated by the project's enabled modules.
- **Engine devtools bridge.** The client Engine publishes a full accessor on
  `globalThis` (`__SE_DEVTOOLS_ENGINE__`): live reads, the last `identify()`
  payload, override get/set/remove/clear, a re-render subscription, and a
  structured event feed. Overlays read it without importing the client (no
  duplicate Engine). `window.__shipeasy` additionally carries `user`.
- **Forms are react-hook-form.** `useBugForm()` / new `useFeatureForm()` return
  an RHF instance validated by the generated zod schemas via `zodResolver`
  (new optional peers `react-hook-form` + `@hookform/resolvers`; the hook shape
  changed from the hand-rolled `values`/`setField` of 7.3.0).
- i18n marker constants moved to `src/i18n-markers.ts`; `@shipeasy/sdk/client`
  re-exports them unchanged.

### i18n render-keys-only mode (testing)

- **i18n:** new `renderKeysOnly` toggle makes `i18n.t()` / `i18n.rich()` /
  `i18n.tEl()` return the translation **key** verbatim instead of resolving its
  value, so tests and snapshots assert against stable data instead of copy that
  changes when a translation is edited. **Defaults on when the runtime env is
  `"test"`** (`SHIPEASY_ENV` / `NODE_ENV`, i.e. under jest/vitest), off
  otherwise. Set it explicitly via `configure({ i18n: { renderKeysOnly } })` /
  `shipeasy({ …, i18n: { renderKeysOnly } })` (both entrypoints) or
  `i18n.configure({ renderKeysOnly })`. The flag is process-wide and shared
  between the server and browser bundles, so a server override also governs the
  `i18n.t()` calls in SSR'd `"use client"` components. Also exports `isTestEnv()`
  from the env helper.

### Performance

- **i18n:** `{{var}}` interpolation now short-circuits via a native
  `indexOf("{{")` scan (skipping the regex engine entirely for the common
  placeholder-free label) and reuses a hoisted `RegExp` instead of re-allocating
  one per `t()` call.

## 7.3.1 (2026-07-10)

### Fixes

- **client:** `getFlagDetail`/`getFlag` no longer throw
  `Cannot use 'in' operator to search for '<key>' in undefined` when the eval
  result lacks a `flags` map (partial `initFromBootstrap` payload or malformed
  wire response) — the lookup now reads as `FLAG_NOT_FOUND` and `getFlag`
  returns its default. The documented contract is unchanged; this only removes
  a crash path.

## 7.3.0 (2026-07-09)

### React Native devtools overlay

New optional entry points:

- **`@shipeasy/sdk/react-native-devtools`** — a shake-to-open on-device devtools
  overlay for RN/Expo apps: `<ShipeasyDevtools scheme="myapp://se-auth"
  clientKey={…}/>`. Shake several times fast to open (expo-sensors; imperative
  `ref.open()` fallback). Offers **Log in to Shipeasy** (device-auth in the
  system browser via the app's OWN deep-link scheme — PKCE code-exchange, the
  deep link never carries the token, so any scheme works with no registration)
  unlocking live **Gates / Configs / Experiments / Feedback** panels, and a
  **Report a bug** button on the logged-out home screen when the project has
  opted into public tickets. Hooks (`useDevtoolsAuth`, `useGates`,
  `useBugForm`, `useShakeToOpen`, …) are exported for custom surfaces. All
  Expo modules are optional peers; each missing one degrades a single
  capability.
- **`@shipeasy/sdk/devtools`** — the framework-agnostic core underneath:
  `DevtoolsClient` (admin API), `startDeviceAuth` (PKCE), `submitPublicBug`
  (`/cli/report` with the public client key; typed `PublicTicketsDisabled` on
  403), and the bug/feature form zod schemas generated from the admin OpenAPI
  contract. `zod` is an optional peer used only by these subpaths.

The browser client now surfaces project devtools capabilities from
`/sdk/evaluate` (`devtools.allow_public_tickets`) via
`getDevtoolsCapabilities()` / `subscribeDevtoolsCapabilities()` and publishes a
`globalThis` bridge the overlay reads — requires worker flags-blob format 6;
older workers simply read as `false`.

## 7.2.0 (2026-07-08)

### Server exposure now fires on read, not at `assign()`

The server `Assignment` now logs its single (deduped) exposure the **first time a
param is read** via `get()`, not eagerly at `assign()` time — so an assignment
that is computed but never read logs nothing (matching the canonical evaluation
spec, step 7). `assign()` is now side-effect free on the server. Read without
logging (peek) by passing the new opt-out:

```ts
const exp = flags.universe("hero_cta").assign();
exp.get("primary_label", "Sign up", { exposure: false }); // peek — no exposure
exp.get("primary_label", "Sign up");                       // logs the single exposure
```

`get<T>(field, fallback?, opts?: { exposure?: boolean })` gains the optional third
argument; the change is source-compatible. The **browser** entrypoint is
unchanged — it still logs at `assign()` time (`assign({ logExposure: false })` to
suppress). Exposure remains deduped per session and, new in this release, durably
per `(unit, experiment, group)` on the server via the `exposure_log` surface.

### Durable, forced-but-gated experiment overrides

Assignment now honours durable **ID overrides** (force a specific unit into a
group) and **cohort/gate overrides** (force units passing a gate into a group)
carried on the experiments blob (KV format 5). Overrides are *forced but still
gated*: a matched override pins the group only if the unit passes targeting and
isn't held out, and ID overrides beat cohort overrides. Running experiments are
untouched — the new resolution order rides `hash_version: 3`; `v1`/`v2`
assignments are byte-identical.

## 7.1.1 (2026-07-08)

### Fix — browser client no longer crashes under React Native

`notifyMounted()` (and the devtools bridge's `installBridge()`) dispatched a
`window.dispatchEvent(new CustomEvent(...))` guarded only by
`typeof window !== "undefined"`. React Native / Expo define a **bare `window`**
(truthy, but with no `dispatchEvent`) and have no `CustomEvent`, so that guard
passed and the call threw `undefined is not a function` — taking down
`shipeasy({ clientKey })` at configure time on-device. Both sites now go through
a feature-detected `dispatchWindow()` helper (checks `window.dispatchEvent` and
`CustomEvent` are real functions) and no-op off-DOM, matching the existing
`onWindow`/`onDocument` helpers.

With this, the browser entry (`@shipeasy/sdk/client`) runs on React Native with
**no polyfills** — every DOM-only path (event dispatch/listeners, cookie/storage
persistence, `sendBeacon`, `window.location`) either feature-detects or degrades
via `try/catch`; evaluation, `track()`, exposure logging and `see()` all still go
out over `fetch`. Added React-Native regression tests covering `flags.notifyMounted()`
and a full `shipeasy()` bootstrap with `window.dispatchEvent`/`CustomEvent` absent.

## 7.1.0 (2026-07-08)

### Environment-derived network & telemetry defaults

The SDK is now **quiet by default outside production** — an app that embeds it no
longer makes any outbound request from a local dev machine or a CI run unless it
opts in. Two options, both on the server `configure({ apiKey })`, the browser
`configure({ clientKey })`, and the SSR `shipeasy({ serverKey })` entry points:

- **`isNetworkEnabled`** (new) — master switch for **any** outbound request:
  flag/experiment fetches, `track()`, exposure logging, `see()` reports, usage
  telemetry, and internal error self-monitoring. `false` ⇒ fully offline (reads
  return code defaults / overrides).
- **`disableTelemetry`** (default changed) — the per-evaluation usage beacon.

Both **default to ON in production and OFF everywhere else**. Production is read
from `SHIPEASY_ENV`/`NODE_ENV`, falling back to the SDK's own `env` option (which
defaults to `"prod"`) when neither is set — so a real production deploy (including
Cloudflare Workers, where `NODE_ENV` is absent) stays on by default.

**Behaviour change:** if your app previously relied on the SDK fetching flags or
emitting telemetry while running under `NODE_ENV=development`/`test` (or with
`env: "dev"`), pass `isNetworkEnabled: true` (or set `NODE_ENV=production` /
`SHIPEASY_ENV=production`) to restore it. Explicitly-passed values always win.

## 7.0.0 (2026-07-08)

### Breaking — experiments are now read by universe, not by name

The whole experiment read surface is replaced. A **universe is a mutual-exclusion
pool**: a unit is enrolled in **at most one** experiment in it, so you ask a
universe for an assignment instead of naming an experiment. `getExperiment`,
`logExposure`, and `Client.logExposure` are **removed** on both entrypoints.

```ts
// Before (removed):
const exp = flags.getExperiment("checkout_color", user, { button_color: "red" });
if (exp.inExperiment && exp.params.button_color === "green") …

// After — server (@shipeasy/sdk/server):
const exp = flags.universe("checkout").assign(user);      // or new Client(user).universe("checkout").assign()
if (exp.get("button_color") === "green") …

// After — client (@shipeasy/sdk/client):
const exp = flags.universe("checkout").assign();          // browser identity is global
```

- **`universe(name).assign(user?)`** returns an `Assignment`:
  - `.name` — the experiment the unit landed in, or `null` when not enrolled.
  - `.group` — the assigned variant, or `null` when not enrolled.
  - `.enrolled` — boolean.
  - `.get(field, fallback?)` — resolves **variant override ?? universe default ??
    fallback**. Works even when not enrolled (you get the universe default), because
    the universe now owns the param schema + defaults. No more `decode`/`variants`.
- **Auto-exposure.** `assign()` logs a single exposure when the unit is enrolled
  (server dedups per process; browser dedups per session). The manual
  `logExposure` primitive is gone — reading *is* the exposure. On the browser you
  can still suppress it with `disableAutoExposure` or `assign({ logExposure: false })`.
- **Mutual exclusion (pooled assignment), per-experiment holdout gates, reserved
  headroom, and universe-default⊕variant param merge** are now honoured by local
  eval, matching the edge. The SSR bootstrap + `/sdk/evaluate` responses carry a
  `universes` defaults map and a `universe` field per experiment.
- `window.shipeasy.getExperiment(...)` (the `<script>` loader global) →
  `window.shipeasy.universe(name).assign().get(field)`.

Migration: replace each `getExperiment("<exp>", user, defaults)` with
`universe("<the experiment's universe>").assign(user)` and read fields via
`.get("field", fallbackFromDefaults)`; delete `logExposure` calls (exposure is
automatic).

## 6.5.0 (2026-07-08)

### Added

- **React Native / Expo support for `@shipeasy/sdk/client`.** The browser build is
  now safe to run under React Native, and the package advertises a `react-native`
  export condition (+ top-level field) so Metro resolves it to the client build.
  `configure()` / `new Client(user)` / `getFlag` / `getConfig` / `getExperiment` /
  `track` / `see()` all work over `fetch` — no polyfills or DOM shims required.
  See the new "React Native / Expo" section on the Installation page.

- **`configure({ anonymousStore })` — pluggable anonymous-id persistence.** A
  `{ get, set, remove }` store (sync or async) that the SDK hydrates before the
  first `/sdk/evaluate`, so the anonymous id — and thus bucketing — stays stable
  across app launches on runtimes with no cookie / `localStorage`. Back it with
  `@react-native-async-storage/async-storage` on React Native, or any store
  elsewhere. On a fresh device the freshly-minted id is written back; store
  failures are non-fatal (the in-memory id is used).

### Fixed

- **Client SDK no longer crashes under React Native.** React Native defines a
  global `window` (=== the global object) but exposes none of the DOM APIs on it,
  so the previous `typeof window !== "undefined"` guards ran browser-only code
  (`window.addEventListener` / `document.addEventListener`) and threw during
  `configure()`, `subscribe()`, `attachDevtools()`, and the i18n
  `whenReady()`/`onUpdate()` helpers. These now gate on the actual DOM capability
  and degrade gracefully: no lifecycle listeners (the event buffer flushes on its
  timer + explicit `track()`), no cookie/`localStorage` anon-id persistence (an
  anon id is generated per session — pass a stable `user_id` for durable
  bucketing), and the DOM-only extras (auto web-vitals, devtools overlay,
  loader-driven i18n) are skipped.

## 6.4.0 (2026-07-08)

### Added

- **SDK self-monitoring for internal errors.** When one of the SDK's last-resort
  guards (`safeRun`) swallows an internal failure — a bug on Shipeasy's side, not
  the caller's — it now also reports that error to Shipeasy's own project so we
  can track and fix SDK bugs across every app the SDK runs in. This is a
  dedicated, baked-in destination (a public client-key ingest credential),
  entirely separate from your `see()` reporting: internal errors never land in
  your project or Errors tab. The report carries only the error itself plus a
  stable, deduped consequence (subject = the guarded operation, e.g. `flags.get`)
  and is fire-and-forget — it can never slow down or break a read. On by default;
  opt out with `disableInternalErrorReporting: true` on `configure({ apiKey })`,
  browser `configure({ clientKey })`, or `shipeasy({ serverKey })`.

## 6.3.2 (2026-07-07)

### Fixed

- **Default API host now resolves.** The default `baseUrl` pointed at the
  unregistered domain `https://edge.shipeasy.dev`, so every `configure()`
  one-shot fetch and every `getFlag`/`getConfig`/`getExperiment`/`track`/`see()`
  call failed with a DNS error unless `baseUrl` was passed explicitly. Corrected
  to the real edge origin `https://api.shipeasy.ai` — the host the docs, CLI, and
  curl snippets already use. Explicit `baseUrl` overrides are unaffected.

## 6.3.1 (2026-07-07)

### Fixed

- Repair the build/test toolchain so the package publishes again. The publish
  workflow gates on type-check + test + build, all three of which had been red on
  `main` for weeks (pre-existing floating-dependency rot), so 6.3.0 could not be
  released to npm. Fixes: pin `vite` to a `vitest`-4-compatible major (vite 5
  lacks `./module-runner`), silence the TypeScript 6 `baseUrl` deprecation in the
  dts build, compile example JSX with the automatic runtime and scope the test
  runner to `src/`, and make the "missing server key" test assert on the
  flags/experiments/i18n endpoints instead of a global fetch count (which was
  polluted by earlier tests' fire-and-forget telemetry). No SDK behaviour change.

## 6.3.0 (2026-07-07)

Fail-safe reads and a configurable log level. (Superseded by 6.3.1 for the actual
npm release — 6.3.0 never published due to the CI breakage fixed above.)

### Added

- **`configure({ logLevel })`** (server, browser, and the SSR `shipeasy()`
  helper) — controls how loud the SDK is on `console` when it swallows an
  internal error. Ordering `silent < error < warn < info < debug`; defaults to
  `"warn"`. Also exported: the `LogLevel` type and the `LOG_LEVELS` array.

### Changed

- **Runtime methods never throw.** `getFlag`, `getFlagDetail`, `getConfig`,
  `getExperiment`, `getKillswitch`, `track`, `logExposure`, and `see()` are now
  guaranteed to never throw into product code — on any internal error they log at
  the configured level and return the documented safe default (a bad `decode`
  callback no longer escapes `getConfig`, for one). Setup/lifecycle calls
  (`new Client()` before `configure()`, offline snapshot loading) still throw so
  boot-time misconfiguration stays obvious.
- Every internal diagnostic now routes through the leveled logger, so
  `logLevel: "silent"` mutes the SDK entirely.

## 6.2.0 (2026-06-27)

The uniform SDK DX standard (experiment-platform doc 23). The documented surface
is now exactly `configure()` (+ the test/offline siblings) and the bound
`new Client(user)`; the `Engine` stays public but undocumented.

### Added

- **`configureForTesting({ attributes, flags, configs, experiments })`** — no api
  key, zero network; seeds overrides and registers the global engine so the bound
  `new Client(user)` reads them. **Replaces** any prior config (unlike
  `configure`'s first-config-wins) so a test suite can reconfigure between cases.
- **`configureForOffline({ snapshot | path, attributes, flags, configs, experiments })`**
  — evaluates the **real** rules from an in-memory snapshot or a JSON file, with
  overrides layered on top; also replaces prior config.
- **`configure({ poll })`** — `poll: true` starts the background poll internally
  (you never call `engine.init()` yourself); `init` (default `true`) is the
  one-shot fire-and-forget fetch. The advanced options (`baseUrl`, `env`,
  `disableTelemetry`, `privateAttributes`, `stickyStore`) are documented as
  **configure() options**.
- **Package-level helpers** so the docs never name the `Engine`: `overrideFlag`,
  `overrideConfig`, `overrideExperiment`, `clearOverrides`, and `onChange` —
  delegating to the configured global engine.
- **`ShipeasyProvider` global form** — `new ShipeasyProvider()` (no argument)
  resolves the engine built by `configure()`, so OpenFeature is wired without an
  `Engine` handle. Passing an explicit `Engine` stays supported.
- **`shipeasy-skill` CLI** (`npx shipeasy-skill install` / `print`) — the opt-in
  installer that copies the bundled agent skill into a consumer's project.

### Changed

- `getKillswitch(name, switchKey)` named-switch semantics: an **unconfigured**
  switch key now falls back to the kill switch's top-level value (cross-SDK
  contract), instead of returning the un-set default.
- `README.md` is now **generated** from `docs/` by `scripts/gen-readme.mjs`
  (CI enforces it's in sync); the docs were rewritten to be Engine-free around
  `configure()` + `Client`, with new `metrics/track` + `ops/see` snippet groups
  and specific placeholders.

## 6.1.0 (2026-06-27)

### Added

- **`track()` / `logExposure()` on the bound `Client`** (both entrypoints) —
  experiments are now end-to-end Client-only; you no longer have to drop down to
  the `Engine` to record a conversion or an exposure. The `Engine` forms remain
  for advanced use.

  - Server (`@shipeasy/sdk/server`): `client.track(event, props?)` derives the
    unit from the bound attribute bag (`user_id`, else `anonymous_id`) and
    delegates to `Engine.track(userId, event, props?)`. `client.logExposure(name)`
    re-evaluates enrolment for the bound attributes and emits the exposure.
  - Browser (`@shipeasy/sdk/client`): `client.track(event, props?)` and
    `client.logExposure(name)` forward to the engine for the already-identified
    visitor.

  ```ts
  const client = new Client(req.user);
  if (client.getExperiment("checkout_test", {}).inExperiment) {
    client.track("purchase", { value: 42 });
  }
  ```

## 6.0.0 (2026-06-25)

### BREAKING

- **`FlagsClient` → `Engine` (server) and `FlagsClientBrowser` → `Engine`
  (browser).** The heavyweight class that owns the key, HTTP, the blob cache,
  and the poll timer is now named `Engine` on both entrypoints. The name
  `Client` is now the new lightweight, user-bound handle (see below). Update
  every `new FlagsClient(...)` / `new FlagsClientBrowser(...)`,
  `FlagsClient.forTesting()` / `.fromSnapshot()` / `.fromFile()`, and any type
  imports (`FlagsClientBrowserOptions` → `EngineOptions`,
  `FlagsClientBrowserEnv` → `EngineEnv`). The OpenFeature providers
  (`@shipeasy/sdk/openfeature-server`, `@shipeasy/sdk/openfeature-web`) and the
  `<script>` loader now take an `Engine`. No behavior changed — only the name.

### Added

- **`configure()` + user-bound `new Client(user)` front door** on both
  entrypoints. Configure once at app boot with your key and an optional
  `attributes` transform (a function from *your own user object* to the
  Shipeasy targeting attribute map), then evaluate per user with
  `new Client(user)`:

  ```ts
  // server
  import { configure, Client } from "@shipeasy/sdk/server";
  configure({ apiKey: process.env.SHIPEASY_SERVER_KEY!, attributes: (u) => ({ user_id: u.id, plan: u.plan }) });
  if (new Client(req.user).getFlag("new_checkout")) { /* ... */ }

  // browser
  import { configure, Client } from "@shipeasy/sdk/client";
  configure({ clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY!, attributes: (u) => ({ user_id: u.id, plan: u.plan }) });
  const flags = new Client(currentUser);
  await flags.ready();
  flags.getFlag("new_checkout");
  ```

  The bound `Client` methods (`getFlag` / `getFlagDetail` / `getConfig` /
  `getExperiment` / `getKillswitch`) take **no user argument** — the user is
  bound at construction (the `attributes` transform runs once there; default is
  identity). `Client` is cheap: it delegates to the single configured `Engine`
  and never opens its own connection or poll timer. The browser is single-user,
  so `new Client(user)` `identify()`s the transformed attributes under the hood
  (fire-and-forget); `await client.ready()` to await the first `/sdk/evaluate`.
  Constructing a `Client` before `configure()` throws loudly. New public
  symbols: `configure`, `Client`, `AttributesFn`, `ConfigureOptions`,
  `_resetConfigureForTests` (and on the server, `configure` returns the
  `Engine`).

## 5.4.0 (2026-06-20)

### Added

- **SSR bootstrap as declarative `<script>` tags.** The `shipeasy()` server
  handle now exposes `getBootstrapData()` (structured tag specs) and
  `getBootstrapTags()` (HTML string), replacing the old `getBootstrapHtml()`
  inline-JS blob. The browser reads the SSR-evaluated flags/configs/experiments
  on first paint with no flash: `getBootstrapData()` returns a `bootstrap` tag
  (`src=cdn.shipeasy.ai/sdk/bootstrap.js` + `data-*` attributes, **no key**) and
  an optional `i18nLoader` tag carrying the SSR strings (`data-strings`) plus the
  public client key for runtime revalidation. The static loader hydrates
  `window.__SE_BOOTSTRAP` and persists the `__se_anon_id` cookie so the browser
  buckets identically to the server. Render real `<script>` elements in React
  (scripts set via `dangerouslySetInnerHTML` do not execute); use
  `getBootstrapTags()` for non-React SSR.

### Changed

- The client now also reads the bootstrap payload directly off the
  `se-bootstrap.js` tag's `data-*` attributes as a fallback, so synchronous
  first-render flag reads stay correct even before the external loader executes.
- The edit-labels marker shim moved out of the SSR script into the devtools
  bundle (it owns the label-editing loop). `isEditLabelsMode()` now reads the
  `se_edit_labels` cookie directly.

## 5.2.0 (2026-06-19)

### Added

- **Sticky bucketing (persistent assignment).** A unit's first-assigned variant
  is locked so changing an experiment's allocation % or group weights never
  silently re-buckets enrolled users (changing the experiment salt is the
  deliberate reshuffle lever). Targeting, holdout, and (for new units)
  allocation stay live; only the group pick is short-circuited.

  - **Browser:** ON by default. The assignment round-trips through a first-party
    `__se_sticky` cookie (so SSR server eval and the browser agree) — the client
    sends its current map to `/sdk/evaluate` and persists any new assignments
    the edge returns. Opt out with `shipeasy({ clientKey, stickyBucketing: false })`.
  - **Server:** `new FlagsClient({ stickyStore })` — absent ⇒ today's
    deterministic behaviour. Built-in `createInMemoryStickyStore()`; bring your
    own (e.g. a cookie-bridge over `__se_sticky`). `getExperiment` skips the
    allocation gate for an already-enrolled unit so a shrinking allocation keeps
    it in.

- **Multi-context bucketing (`bucketBy`).** Server experiment evaluation now
  honors an experiment's `bucketBy` attribute (e.g. `company_id`) — the holdout,
  allocation, and group hashes all key on that unit so a whole org stays on one
  variant. Defaults to `user_id ?? anonymous_id`; an absent named attribute
  falls back to the user (matches gate rollout). New golden vectors lock the
  behaviour across every SDK.

- **Private attributes** (LD/Statsig `privateAttributes`). New
  `privateAttributes?: string[]` option on both clients (and `shipeasy({…})`):
  usable for targeting, never persisted in analytics. The server evaluates
  locally so private attrs never leave for evaluation; the browser sends them to
  `/sdk/evaluate` under `private_attributes` (the edge must evaluate) but the
  worker never stores them. On both sides the listed keys are stripped from any
  `track(props)` payload.

- **Manual / suppressible exposure logging** (Statsig's `disableExposureLogging`
  + `manuallyLogExposure`). The browser `getExperiment` gains an options-object
  overload alongside the positional one, and both clients gain `logExposure`:

  ```ts
  // read without logging, then log at the treatment's render:
  const exp = flags.getExperiment("hero_cta", defaults, { logExposure: false });
  // ...later, when the treatment actually renders:
  flags.logExposure("hero_cta");

  // or flip the default for the whole client:
  shipeasy({ clientKey, disableAutoExposure: true });

  // server records the exposure at the decision point (it never auto-logs):
  flags.logExposure(userId, "hero_cta");
  ```

  Per-call `logExposure` wins over the client-level `disableAutoExposure`
  setting. The existing session dedup set means auto + manual never
  double-count. No wire change — exposure event shape and dedup are unchanged.

- **OpenFeature providers.** Two new entrypoints let apps standardized on the
  CNCF OpenFeature API plug Shipeasy in as the backing provider — a pure adapter
  over the existing clients, no change to evaluation:

  - `@shipeasy/sdk/openfeature-server` — `ShipeasyProvider` wrapping `FlagsClient`
    (peer-deps `@openfeature/server-sdk`).
  - `@shipeasy/sdk/openfeature-web` — `ShipeasyProvider` wrapping
    `FlagsClientBrowser` (peer-deps `@openfeature/web-sdk`).

  ```ts
  import { OpenFeature } from "@openfeature/server-sdk";
  import { FlagsClient } from "@shipeasy/sdk/server";
  import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-server";

  await OpenFeature.setProviderAndWait(
    new ShipeasyProvider(new FlagsClient({ apiKey: process.env.SHIPEASY_SERVER_KEY! })),
  );
  const on = await OpenFeature.getClient().getBooleanValue("new_checkout", false, {
    targetingKey: "u1",
  });
  ```

  Reason mapping: `RULE_MATCH→TARGETING_MATCH`, `DEFAULT→DEFAULT`, `OFF→DISABLED`,
  `OVERRIDE→STATIC`, `FLAG_NOT_FOUND→ERROR`/`FLAG_NOT_FOUND`,
  `CLIENT_NOT_READY→ERROR`/`PROVIDER_NOT_READY`. `EvaluationContext.targetingKey`
  maps to `user_id`; string/number/object flags route to `getConfig` with the
  caller default (type mismatch → `TYPE_MISMATCH`). The web provider reconciles
  `setContext` into `identify()`. Both providers are optional peers — install the
  matching `@openfeature/*` package in your app.

## 5.1.0 (2026-06-18)

### Added

- **Local-override test utility (Statsig-style).** Both `FlagsClient` (server)
  and `FlagsClientBrowser` (browser) gain a `forTesting()` static factory that
  returns a no-network, immediately-usable client — `init()`/`initOnce()`/
  `identify()` are no-ops (they never fetch), `track()` is a no-op, telemetry is
  off, no SDK key is required, and the client starts initialized/ready. Seed
  every entity with the new override setters (also usable on a normal client):

  ```ts
  const client = FlagsClient.forTesting();
  client.overrideFlag("new_checkout", true);
  client.overrideConfig("upload_limits", { max_uploads: 50 });
  client.overrideExperiment("hero_cta", "treatment", { primary_label: "Buy now" });
  client.getFlag("new_checkout", { user_id: "u1" }); // true
  client.clearOverrides();
  ```

  An override always wins over the fetched values. In the browser the precedence
  is: programmatic override > URL/devtools override > the server's evaluation.
  New methods: `overrideFlag`, `overrideConfig`, `overrideExperiment`,
  `clearOverrides`.

- **Default values on `getFlag` / `getConfig`.** Both clients accept a
  caller-supplied default returned **only** when the value can't be evaluated
  (client not initialized or key not found) — never for a flag that legitimately
  evaluates to `false`. Additive and backward-compatible:

  ```ts
  client.getFlag("new_checkout", { user_id: "u1" }, true); // server (3rd arg)
  client.getFlag("new_checkout", true);                    // browser (2nd arg)
  client.getConfig("limits", { defaultValue: { max: 50 } });
  ```

  `getConfig` gains an options-object overload `{ decode?, defaultValue? }`; the
  legacy `getConfig(name, decode)` callback form still works unchanged.

- **Flag evaluation detail (`getFlagDetail`).** LaunchDarkly `variationDetail`
  parity: `getFlagDetail(name[, user])` returns `{ value, reason }` where
  `reason: FlagReason` is one of `CLIENT_NOT_READY` | `FLAG_NOT_FOUND` | `OFF` |
  `OVERRIDE` | `RULE_MATCH` | `DEFAULT`. Computed at the client boundary — the
  canonical eval is untouched. `getFlag` now delegates to `getFlagDetail` (one
  evaluation, one telemetry beacon). Exported types: `FlagDetail`, `FlagReason`,
  `FLAG_REASONS` (from both `/server` and `/client`). On the browser `OFF` folds
  into `DEFAULT` (the server pre-evaluates the enabled/killed state).

- **Change listeners (server).** `FlagsClient.onChange(listener)` fires after a
  background poll returns NEW data (HTTP 200, not 304) and returns an
  unsubscribe function. Never fires in test/offline mode. The browser client's
  existing `subscribe()` is the equivalent.

- **Offline file/snapshot data source (server).** `FlagsClient.fromFile(path)`
  (Node `fs`) and `FlagsClient.fromSnapshot({ flags, experiments })` build a
  fully offline client — no network, telemetry off, `init()`/`initOnce()`/
  `track()` no-op — that runs the real eval against the snapshot (the two SDK
  wire bodies, `GET /sdk/flags` + `GET /sdk/experiments`). Overrides still apply
  on top.

## 5.0.0

### Changed (BREAKING)

- **`see.ControlFlowException` is now a fluent chain.** The reason moves out of a
  positional argument and onto a `.because()` step, with an optional `.extras()`
  tail for local debug context:

  ```ts
  // before
  see.ControlFlowException(e, "because it wasn't an encoded Foo");
  // after
  see.ControlFlowException(e).because("because it wasn't an encoded Foo");
  // optional debug context (kept on the mark for local debugging; never sent,
  // since an expected exception is by definition not reported):
  see.ControlFlowException(e).because("because it wasn't a Foo").extras({ tried: "Foo" });
  ```

- **`see.Violation` no longer has a `.message()`.** A violation's identity is its
  name; all variable/context data goes in `.extras()`. Migrate
  `see.Violation(n).message(m)...` to `see.Violation(n)....extras({ … })`. On the
  wire a violation's `message` is now its name (it already participated in the
  fingerprint via the name + consequence).

- **Auto-capture is limited to specific network failures.** The client no longer
  blanket-reports uncaught exceptions or unhandled promise rejections — those
  produced generic, consequence-less issues ("the page hit an error") that name
  the plumbing, not the feature, and double-counted anything an explicit `see()`
  already reported. Auto-capture now reports only `fetch` network errors and
  5xx, each carrying a specific endpoint subject and outcome. Report everything
  else explicitly with `see()` where the consequence is known.

- **`see()` + re-throw is now blessed, not banned.** Reporting a caught error and
  then re-throwing it links the re-thrown occurrence to the inner report as a
  `caused_by` chain (no double-count). The old "never `see()` then `throw`" rule
  is removed.

## 4.5.0

### Added

- **`@shipeasy/sdk/next` — a drop-in Next.js middleware** that mints the shared
  `__se_anon_id` bucketing cookie at the edge, so flags and experiments bucket
  identically on SSR and in the browser from the **first** request (no flash,
  even for fractional rollouts). A Server Component can't `Set-Cookie` during
  render, so this edge step is what makes the first request correct; the
  server/client SDK only read + client-persist the id.
  - Zero-config: `export { middleware, config } from "@shipeasy/sdk/next";`
  - Compose with an existing middleware: `export default withShipeasy(myMiddleware);`
  - Primitives for full control inside your own middleware (preserves your
    request-header forwarding): `readOrMintAnonId(req, requestHeaders)` +
    `commitAnonId(res, result, req)`.
  - `next` is an **optional** peer dependency — only resolved when you import
    this subpath. Contract: `experiment-platform/18-identity-bucketing.md`.

## 4.4.0

### Fixed

- **A 100%-rollout gate no longer evaluates `false` for an unidentified request.**
  `evalGateInternal` previously returned `false` whenever there was no
  `user_id`/`anonymous_id` — before even checking the rollout — so a fully
  rolled-out gate read during SSR (where no unit had been minted) came back off.
  It now short-circuits: with no unit, a gate is on iff `rolloutPct >= 10000`
  (a fractional rollout still needs a stable unit to bucket, and targeting rules
  are still evaluated first).

### Added

- **Shared anonymous bucketing id across server and client** so flags and
  experiments bucket identically on SSR and in the browser at any rollout %, and
  consistently as a rollout % changes. The stable unit now lives in a
  first-party, JS-readable `__se_anon_id` cookie (the cross-SDK contract — see
  `experiment-platform/18-identity-bucketing.md`):
  - The server `shipeasy()` reads `__se_anon_id` (minted by edge middleware, or
    by the SDK on cookie-miss), evaluates against it, and threads it into the
    bootstrap. `getBootstrapHtml` writes the cookie pre-paint and exposes the id
    on `window.__SE_BOOTSTRAP.anonId`.
  - The client `getOrCreateAnonId()` is now cookie-first (then bootstrap, then
    `localStorage`, then mint), mirroring the resolved id into both the cookie
    and `localStorage` so the browser adopts the exact id SSR bucketed against.
  - `ANON_ID_COOKIE` is exported from `@shipeasy/sdk/server`.

## 4.3.0

### Added

- **Cross-runtime error correlation (`caused_by` across the network boundary).**
  The in-process `.cause`-chain stamp can't link a browser error to its server
  cause. The client now mints a per-request correlation token, sends it up on
  the `X-SE-Correlation` header (**same-origin only** — a custom header would
  force a CORS preflight on cross-origin fetches), and ships it on any 5xx it
  auto-captures. A server boundary that reports the matching uncaught error
  under the same token lets the backend join the two issues by correlation,
  populating `caused_by` across the boundary.
- **Ambient server correlation** via a new exported `seeContext`
  (`AsyncLocalStorage`). `reportError` reads the token from it automatically, so
  server `see()` stays vanilla — no caller ever passes a correlation id. Seed it
  once in a server error boundary (e.g. Next's `onRequestError`) with
  `seeContext.run({ correlationId }, () => see(error)…)`.
- `isExpected` is now re-exported from `@shipeasy/sdk/server` so a server error
  boundary can skip errors a handler already reported + marked via
  `see.ControlFlowException`.
- `correlation_id` added to the `SeeErrorEvent` wire shape (join-only metadata;
  never persisted as an issue field). `buildSeeEvent` takes an optional
  `correlationId` argument.

## 4.2.0

### Changed (behavioral)

- **Auto-capture consequences rewritten to be readable and actionable.** Issue
  titles render as `{problem} causes the {subject} to {outcome}`, and the
  consequence feeds the issue fingerprint raw — the old auto-capture wording
  broke both rules:
  - Network failures: `causes_the("a network request")` rendered the doubled
    article "causes the **a** network request", and `` to(`fail with HTTP
    ${status}`) `` minted a separate issue per status code (500/502/503…).
    Both now report `causes_the("request to <endpoint>")` where `<endpoint>`
    is a low-cardinality template (query/hash dropped, same-origin host
    dropped, id-like path segments → `:id`), with outcomes
    `"get no response"` (network-level) and `"fail with a server error"`
    (5xx — the status stays in the message and `extras.status`).
  - Uncaught/unhandled-rejection subjects `"the page"` and the missing-
    consequence default `"the app"` dropped their articles (`"page"`,
    `"app"`).

  **Migration note:** the consequence participates in the fingerprint, so
  existing open auto-capture issues stop growing and re-open under the new
  titles — and network issues now group per endpoint instead of per status
  code.

## 4.1.0

### Changed (behavioral)

- **Auto-metrics are now experiment-participant-scoped by default.** The
  browser SDK only emits `__auto_*` metric events (web vitals, navigation
  timing, session activity) for visitors who are in ≥1 active experiment
  (`exposureSeen` non-empty). The experiment analysis pipeline only ever reads
  auto-metrics joined against exposures, so ungated emission was pure
  Analytics Engine write cost — ~60% of AE cost at scale (see the platform's
  cost model). Exceptions:
  - `__auto_abandoned` is still emitted unconditionally — it fires precisely
    when the user leaves before an exposure could land; the analysis-side
    post-exposure filter handles attribution.
  - Error capture (`see()` pipeline) is unaffected.

### Added

- `autoCollect: { always: true }` escape hatch on the `shipeasy()` client
  entrypoint (and `autoCollectAlways` on `FlagsClientBrowserOptions`) for
  customers who want site-wide vitals without running experiments.

## 4.0.0

### Added

- **`see()` — structured error reporting** (both entrypoints, vanilla JS, one
  import). A handled problem documents its product consequence with a fluent
  chain:

  ```ts
  see(err).causes_the("checkout").to("use cached prices").extras({ order_id });
  see.Violation("large query").message("got 5000 rows")
     .causes_the("results").to("be trimmed");
  see.ControlFlowException(err, "because the blob wasn't an encoded Foo");
  ```

  Reports land in the shipeasy **errors** primitive (fingerprint-grouped
  issues + near-real-time occurrence timeseries). The chain dispatches on the
  next microtask; error events bypass the 5s metric batch and ship immediately
  (`sendBeacon`-first in the browser, fire-and-forget `fetch` on the server),
  spam-guarded by a 30s dedup window and a 25-per-session/process cap.
  `see.ControlFlowException(err, "because …")`-marked exceptions are skipped
  by auto-capture and never reported.

### Changed (BREAKING)

- **Auto-captured errors moved to the errors primitive.** `window.onerror`,
  `unhandledrejection`, and fetch network/5xx failures are now reported as
  structured error events; the SDK **no longer emits the `__auto_js_error` and
  `__auto_network_error` metric events**. Metrics or alert rules built on
  those events (e.g. the `js_error_rate` / `network_error_rate` presets) stop
  receiving data — use the errors primitive instead. All other `__auto_*`
  vitals/engagement metrics are unchanged.
- The SDK's own collector/telemetry requests are excluded from network-error
  auto-capture (prevents self-amplifying feedback loops).

## 3.1.0

### Added

- **Per-evaluation usage telemetry.** Every `getFlag` / `getConfig` /
  `getExperiment` / `getKillswitch` call (server and browser) fires one
  fire-and-forget beacon (`sendBeacon` in the browser, non-awaited `fetch` on the
  server) to the usage host, so usage is counted by Cloudflare's native per-path
  analytics with zero per-request storage. The path carries `sha256(key)` (never
  the raw key), plus `side`/`env`/`feature`/`resource`. A 2s dedup window
  collapses repeated reads of the same key. ON by default; opt out with
  `disableTelemetry`.

## 3.0.1

### Fixed

- **SSR i18n strings no longer pin to the first fetch for the life of the worker
  isolate.** The per-profile `_i18nCache` that backs `i18n.init()` had no
  expiry, so once a profile's strings were fetched, every later server render
  reused them — an admin label edit (e.g. devtools "Apply changes", or a
  dashboard publish) updated D1/KV/CDN but the SSR bootstrap kept embedding the
  stale value, so the page never showed the new copy. Cache entries now carry a
  `fetchedAt` timestamp and expire after 60s (matching the `next: { revalidate:
  60 }` on the underlying fetch), so published changes surface within ~60s. A
  failed re-fetch keeps serving the last-known strings rather than regressing to
  key fallbacks.

## 3.0.0

### Breaking

- **Each entrypoint takes exactly one, separately-named key. No cross-type fallback,
  no key shared between server and browser.**
  - `@shipeasy/sdk/server` `shipeasy()` now takes **`serverKey`** (was `apiKey`),
    and no longer accepts `clientKey`. The server key authenticates flags,
    experiments **and** SSR i18n (`/sdk/i18n/strings` now accepts a server key for
    server-side use). The server never sees or forwards a client key.
  - `@shipeasy/sdk/client` `shipeasy()` now takes **`clientKey`** (was `apiKey`).
    The browser uses only the client key, for `/sdk/evaluate`, `/collect`, and the
    runtime i18n loader.
  - **No SDK key is embedded in `window.__SE_BOOTSTRAP` anymore.** The bootstrap
    carries flags/configs/experiments/i18n DATA + `i18nProfile` only — never a key,
    so the server key can never leak to the browser. Consequently the implicit
    "auto-init from the bootstrap key" is **removed**: the browser must initialise
    explicitly with `shipeasy({ clientKey })`.
  - The runtime i18n loader (`/sdk/i18n/loader.js`) is now injected by the **client**
    `shipeasy({ clientKey })` call, not by the server's `getBootstrapHtml()`.
    `getBootstrapHtml()`'s `apiKey` option is removed; the SSR i18n shim it emits
    still prevents an untranslated first-paint.

  Migration:
  ```diff
  // server (root layout)
  - await shipeasy({ apiKey: process.env.SHIPEASY_SERVER_KEY, clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY });
  + await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY });

  // client (a "use client" component, once at startup)
  - shipeasy({ apiKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY });
  + shipeasy({ clientKey: process.env.NEXT_PUBLIC_SHIPEASY_CLIENT_KEY });
  ```

  Why: server and client keys validate against different namespaces and the edge
  routes enforce the type, so substituting one for the other (the old `apiKey ??
  clientKey` fallback) could only ever produce guaranteed-401 traffic that masked a
  real missing-key misconfig. Naming each key for its side and forbidding the
  fallback makes misconfiguration loud and keeps the server key off the wire to the
  browser.

## 2.5.2

### Fixed

- **Server SDK no longer falls back between server and client keys.** `shipeasy()`
  from `@shipeasy/sdk/server` previously substituted the client key for a missing
  `apiKey` (and the server key for a missing `clientKey`). Because `/sdk/flags` and
  `/sdk/experiments` enforce a server key and `/sdk/i18n/strings` enforces a client
  key, that fallback always produced guaranteed-401 requests and masked the real
  misconfig. Now each key type is used only for its own endpoints: if the required
  key is missing, that operation is skipped and a loud, actionable error is logged
  (`No server key` / `No client key`) instead of firing a doomed request. Missing
  `apiKey` → flags/experiments skipped; missing `clientKey` → i18n skipped, copy
  falls back to hardcoded text. No more phantom 401s from minority render contexts
  where the env binding reads empty.

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
