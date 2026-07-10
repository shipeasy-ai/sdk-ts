import type { OverridePersistence } from "./types";

/**
 * URL-only override store. The single source of truth for in-session
 * overrides is the page URL — the devtools never write to sessionStorage
 * or localStorage. Mutations update the address bar and reload (or
 * replaceState in dry-run mode), so the override is portable: paste the
 * URL anywhere and the override travels with it.
 *
 * Recognized params (legacy `se-…` aliases are also accepted on read):
 *
 *   ?se=1                       open the devtools overlay
 *   ?se_ks_<name>=true|false    killswitch / gate override
 *   ?se_gate_<name>=true|false  alias for ?se_ks_<name>
 *   ?se_exp_<name>=<group>      experiment group override (use literal "default" to clear)
 *   ?se_config_<name>=<value>   config override; value parsed as JSON, or `b64:<base64url>` for large blobs
 *   ?se_i18n=<profile>          active translation profile
 *   ?se_i18n_draft=<id>         active translation draft
 *   ?se_i18n_label_<key>=<txt>  per-key translated text override
 *
 * `OverridePersistence` is kept in the signature for backward compat but
 * is now ignored — every override lives on the URL only.
 */

const TRUE_RX = /^(true|on|1|yes)$/i;
const FALSE_RX = /^(false|off|0|no)$/i;
const SE_PARAM_RX = /^se(?:_|-|$)/;

function parseBool(raw: string): boolean | null {
  if (TRUE_RX.test(raw)) return true;
  if (FALSE_RX.test(raw)) return false;
  return null;
}

function decodeConfigValue(raw: string): unknown {
  if (raw.startsWith("b64:")) {
    try {
      const json = atob(raw.slice(4).replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function encodeConfigValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= 60) return json;
  return `b64:${btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function currentParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

/**
 * Look up a single override key in the URL, honouring both the canonical
 * `se_` form and the legacy `se-` prefix. Returns the *first* match found.
 */
function readParam(canonical: string, legacy?: string): string | null {
  const params = currentParams();
  const direct = params.get(canonical);
  if (direct !== null) return direct;
  if (legacy) {
    const legacyVal = params.get(legacy);
    if (legacyVal !== null) return legacyVal;
  }
  return null;
}

/**
 * Mutate the current URL by applying the given param updates and reload.
 * `null` removes the param. Other reload semantics are intentionally hidden
 * from callers — every setter goes through this single funnel.
 */
function applyAndReload(updates: Array<[string, string | null]>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  // Always re-open devtools after a redirect so the user can keep editing.
  url.searchParams.set("se", "1");
  for (const [k, v] of updates) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  window.location.assign(url.toString());
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Kept as a no-op for API compatibility — the URL is read on demand by
 * each override getter, so there is nothing to bootstrap.
 */
export function initFromUrl(): void {
  /* intentionally empty: URL is the source of truth */
}

export function isDevtoolsRequested(): boolean {
  if (typeof window === "undefined") return false;
  const p = currentParams();
  // Edit-labels mode needs the overlay's shadow root to host the click-to-edit
  // popper — without it, clicking a [data-label] span has nowhere to attach the
  // edit modal. Treat ?se_edit_labels=1 as implicitly requesting the overlay.
  return p.has("se") || p.has("se_devtools") || p.has("se-devtools") || p.has("se_edit_labels");
}

/** True when ?se_edit_labels=1 is present — t() emits markers, devtools scans DOM. */
export function isEditLabelsModeActive(): boolean {
  if (typeof window === "undefined") return false;
  return currentParams().has("se_edit_labels");
}

/** Toggle the edit-labels mode by adding/removing ?se_edit_labels and reloading. */
export function setEditLabelsMode(on: boolean): void {
  // Clear the SSR-detection cookie when turning off so the next render stops
  // marker-wrapping. The inline patcher rewrites the cookie when the URL
  // param is present, so we don't need to set it here on `on=true`.
  if (!on && typeof document !== "undefined") {
    try {
      document.cookie = "se_edit_labels=;path=/;max-age=0;samesite=lax";
    } catch {
      /* cookies blocked — best-effort */
    }
  }
  applyAndReload([["se_edit_labels", on ? "1" : null]]);
}

// ── Gate / killswitch overrides ─────────────────────────────────────────────

export function getGateOverride(name: string): boolean | null {
  const v =
    readParam(`se_ks_${name}`) ?? readParam(`se_gate_${name}`) ?? readParam(`se-gate-${name}`);
  return v === null ? null : parseBool(v);
}

export function setGateOverride(
  name: string,
  value: boolean | null,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([
    [`se_ks_${name}`, value === null ? null : value ? "true" : "false"],
    [`se_gate_${name}`, null],
    [`se-gate-${name}`, null],
  ]);
}

// ── Config overrides ────────────────────────────────────────────────────────

export function getConfigOverride(name: string): unknown {
  const v = readParam(`se_config_${name}`, `se-config-${name}`);
  if (v === null) return undefined;
  return decodeConfigValue(v);
}

export function setConfigOverride(
  name: string,
  value: unknown,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([
    [`se_config_${name}`, value == null ? null : encodeConfigValue(value)],
    [`se-config-${name}`, null],
  ]);
}

// ── Experiment overrides ────────────────────────────────────────────────────

export function getExpOverride(name: string): string | null {
  const v = readParam(`se_exp_${name}`, `se-exp-${name}`);
  // The literal "default" / "" / "none" clears the override (treated as no override).
  if (v === null || v === "" || v === "default" || v === "none") return null;
  return v;
}

export function setExpOverride(
  name: string,
  variant: string | null,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([
    [`se_exp_${name}`, variant],
    [`se-exp-${name}`, null],
  ]);
}

// ── Active i18n profile / draft ─────────────────────────────────────────────

export function getI18nProfileOverride(): string | null {
  return readParam("se_i18n");
}

export function setI18nProfileOverride(
  profileId: string | null,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([["se_i18n", profileId]]);
}

export function getI18nDraftOverride(): string | null {
  return readParam("se_i18n_draft");
}

export function setI18nDraftOverride(
  draftId: string | null,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([["se_i18n_draft", draftId]]);
}

// ── Per-key i18n label overrides ────────────────────────────────────────────

export function getI18nLabelOverride(labelKey: string): string | null {
  return readParam(`se_i18n_label_${labelKey}`);
}

export function setI18nLabelOverride(
  labelKey: string,
  value: string | null,
  _p: OverridePersistence = "session",
): void {
  void _p;
  applyAndReload([[`se_i18n_label_${labelKey}`, value]]);
}

/**
 * Snapshot every per-key i18n label override currently set on the URL.
 * Used by the Save-as-draft flow to bulk-promote session edits into a draft.
 */
export function listI18nLabelOverrides(): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const params = currentParams();
  for (const [k, v] of params.entries()) {
    if (k.startsWith("se_i18n_label_")) {
      out.push({ key: k.slice("se_i18n_label_".length), value: v });
    }
  }
  return out;
}

/**
 * Set or clear a single per-key label override *without reloading*. The normal
 * `setI18nLabelOverride` reloads to re-render the page through the SDK; this
 * variant just rewrites the URL param via `replaceState` — used after we've
 * already persisted an edit to the profile and want to drop its stale
 * live-preview param in place.
 */
export function setI18nLabelOverrideSilently(labelKey: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const param = `se_i18n_label_${labelKey}`;
  if (value === null) url.searchParams.delete(param);
  else url.searchParams.set(param, value);
  window.history.replaceState({}, "", url.toString());
}

/** Drop every `se_i18n_label_*` URL param without reloading immediately. */
export function clearI18nLabelOverridesSilently(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const k of [...url.searchParams.keys()]) {
    if (k.startsWith("se_i18n_label_")) url.searchParams.delete(k);
  }
  window.history.replaceState({}, "", url.toString());
}

// ── Bulk operations ─────────────────────────────────────────────────────────

export function clearAllOverrides(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const k of [...url.searchParams.keys()]) {
    if (SE_PARAM_RX.test(k)) url.searchParams.delete(k);
  }
  url.searchParams.set("se", "1");
  window.location.assign(url.toString());
}

// ── URL builder + share helpers ─────────────────────────────────────────────

export interface OverrideUrlInput {
  /** Map of gate name → boolean. */
  gates?: Record<string, boolean>;
  /** Map of experiment name → group. */
  experiments?: Record<string, string>;
  /** Map of config name → JSON-serializable value. */
  configs?: Record<string, unknown>;
  /** Active translation profile id/name. */
  i18nProfile?: string;
  /** Active translation draft id. */
  i18nDraft?: string;
  /** Per-key translation overrides. */
  i18nLabels?: Record<string, string>;
  /** Open the devtools overlay on the resulting URL. */
  openDevtools?: boolean;
}

/**
 * Compose a URL that, when opened, applies the given overrides to whatever
 * page it points at. Existing `se_*` params on the base URL are stripped
 * first so the result is a clean snapshot of `input`.
 */
export function buildOverrideUrl(input: OverrideUrlInput, baseUrl?: string): string {
  const url = new URL(
    baseUrl ?? (typeof window !== "undefined" ? window.location.href : "https://example.com/"),
  );
  for (const k of [...url.searchParams.keys()]) {
    if (SE_PARAM_RX.test(k)) url.searchParams.delete(k);
  }
  if (input.openDevtools) url.searchParams.set("se", "1");
  for (const [name, on] of Object.entries(input.gates ?? {})) {
    url.searchParams.set(`se_ks_${name}`, on ? "true" : "false");
  }
  for (const [name, group] of Object.entries(input.experiments ?? {})) {
    url.searchParams.set(`se_exp_${name}`, group);
  }
  for (const [name, value] of Object.entries(input.configs ?? {})) {
    url.searchParams.set(`se_config_${name}`, encodeConfigValue(value));
  }
  if (input.i18nProfile) url.searchParams.set("se_i18n", input.i18nProfile);
  if (input.i18nDraft) url.searchParams.set("se_i18n_draft", input.i18nDraft);
  for (const [k, v] of Object.entries(input.i18nLabels ?? {})) {
    url.searchParams.set(`se_i18n_label_${k}`, v);
  }
  return url.toString();
}

/**
 * Snapshot the current URL overrides into an `OverrideUrlInput`. Used by
 * the "Share URL" button so the operator can copy the exact session.
 */
export function snapshotOverridesFromStorage(): OverrideUrlInput {
  const out: OverrideUrlInput = {
    gates: {},
    experiments: {},
    configs: {},
    i18nLabels: {},
  };
  if (typeof window === "undefined") return out;
  const params = currentParams();
  for (const [k, v] of params) {
    if (k.startsWith("se_ks_")) {
      const b = parseBool(v);
      if (b !== null) out.gates![k.slice(6)] = b;
    } else if (k.startsWith("se_gate_")) {
      const b = parseBool(v);
      if (b !== null) out.gates![k.slice(8)] = b;
    } else if (k.startsWith("se-gate-")) {
      const b = parseBool(v);
      if (b !== null) out.gates![k.slice(8)] = b;
    } else if (k.startsWith("se_exp_")) {
      out.experiments![k.slice(7)] = v;
    } else if (k.startsWith("se-exp-")) {
      out.experiments![k.slice(7)] = v;
    } else if (k.startsWith("se_config_")) {
      out.configs![k.slice(10)] = decodeConfigValue(v);
    } else if (k.startsWith("se-config-")) {
      out.configs![k.slice(10)] = decodeConfigValue(v);
    } else if (k === "se_i18n") {
      out.i18nProfile = v;
    } else if (k === "se_i18n_draft") {
      out.i18nDraft = v;
    } else if (k.startsWith("se_i18n_label_")) {
      out.i18nLabels![k.slice("se_i18n_label_".length)] = v;
    }
  }
  return out;
}

/**
 * Persist any extra overrides into the URL and reload. The current URL
 * params already act as the override store, so this only matters when the
 * caller wants to merge new values atomically.
 */
export function applyOverridesToUrlAndReload(extra?: OverrideUrlInput): void {
  if (typeof window === "undefined") return;
  const merged: OverrideUrlInput = {
    ...snapshotOverridesFromStorage(),
    ...extra,
    openDevtools: true,
  };
  const next = buildOverrideUrl(merged);
  window.location.assign(next);
}

// ── Navigation guard ────────────────────────────────────────────────────────

/**
 * Read every `se_*` / `se-*` / bare `se` param from the current URL.
 * Used by the nav guard to forward overrides into a destination URL.
 */
function collectSeParams(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (typeof window === "undefined") return out;
  for (const [k, v] of new URLSearchParams(window.location.search)) {
    if (k === "se" || SE_PARAM_RX.test(k)) out.push([k, v]);
  }
  return out;
}

/** Merge current `se_*` params into `target` (URL). Existing keys in target win. */
function mergeSeParamsInto(target: URL): void {
  for (const [k, v] of collectSeParams()) {
    if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  }
}

/**
 * Install a same-origin navigation guard so `se_*` overrides survive when
 * the user clicks a link or the app calls history.pushState/replaceState.
 * Returns a cleanup function. Idempotent: a second call without cleanup
 * just returns a no-op cleanup.
 */
export function installNavGuard(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const w = window as Window & { __seNavGuardInstalled?: boolean };
  if (w.__seNavGuardInstalled) return () => {};
  w.__seNavGuardInstalled = true;

  const origin = window.location.origin;

  function onClick(e: MouseEvent): void {
    if (e.defaultPrevented) return;
    // Let the browser handle modified clicks for downloads/new-tab — but we
    // still rewrite the href so the new tab/window receives the overrides.
    const path = (e.composedPath?.() ?? []) as EventTarget[];
    let anchor: HTMLAnchorElement | null = null;
    for (const node of path) {
      if (node instanceof HTMLAnchorElement) {
        anchor = node;
        break;
      }
    }
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    // Skip non-http schemes (mailto:, tel:, javascript:, blob:, data:, hash-only).
    if (/^(mailto:|tel:|javascript:|blob:|data:|#)/i.test(href)) return;
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    mergeSeParamsInto(url);
    const next = url.toString();
    if (next !== anchor.href) {
      // Rewrite in-place so any modifier-click (cmd/ctrl/middle) opens the
      // updated URL too. Also benefits programmatic anchor.click() calls.
      anchor.href = next;
    }
  }

  document.addEventListener("click", onClick, true);

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  function rewriteUrlArg(urlArg: string | URL | null | undefined): string | URL | null | undefined {
    if (urlArg == null) return urlArg;
    let parsed: URL;
    try {
      parsed = new URL(urlArg.toString(), window.location.href);
    } catch {
      return urlArg;
    }
    if (parsed.origin !== origin) return urlArg;
    mergeSeParamsInto(parsed);
    return parsed.toString();
  }

  history.pushState = function (data, unused, urlArg) {
    return origPush(data, unused, rewriteUrlArg(urlArg) as string | URL | null | undefined);
  } as History["pushState"];

  history.replaceState = function (data, unused, urlArg) {
    return origReplace(data, unused, rewriteUrlArg(urlArg) as string | URL | null | undefined);
  } as History["replaceState"];

  return () => {
    document.removeEventListener("click", onClick, true);
    history.pushState = origPush;
    history.replaceState = origReplace;
    w.__seNavGuardInstalled = false;
  };
}
