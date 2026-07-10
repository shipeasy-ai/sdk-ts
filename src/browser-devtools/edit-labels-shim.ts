// Edit-labels client shim.
//
// In edit-labels mode (?se_edit_labels=1 or the se_edit_labels cookie) the
// devtools scanner needs every translated string in the DOM wrapped in the
// 3-section marker `￹key￺varsJson￺value￻` so it can turn them into editable
// <span data-label> nodes. SSR already renders markers server-side; this shim
// keeps them alive on the CLIENT — it wraps window.i18n.t() so re-renders and
// client-only mounts keep emitting markers.
//
// This logic used to live as an inline <script> the TS server SDK generated
// (and was duplicated in apps/ui's root layout). It now lives here, in the
// devtools bundle, because devtools owns the whole label-editing loop — so any
// platform that drops the standalone se-devtools.js tag gets it for free.

import { LABEL_MARKER_START, LABEL_MARKER_SEP, LABEL_MARKER_END } from "../i18n-markers";

type I18nLike = {
  t?: (key: string, vars?: Record<string, unknown>) => string;
  __sePatched?: boolean;
};

type ShimWindow = Window & {
  i18n?: I18nLike;
  // The original (unpatched) t() — panels/i18n.ts reads this to render preview
  // values without the marker wrapping.
  _sei18n_t?: (key: string, vars?: Record<string, unknown>) => string;
  __se_editlabels_shim?: boolean;
};

function wrap(v: I18nLike | undefined, w: ShimWindow): I18nLike | undefined {
  if (!v || typeof v.t !== "function" || v.__sePatched) return v;
  const orig = v.t.bind(v);
  v.__sePatched = true;
  w._sei18n_t = orig;
  v.t = (key: string, vars?: Record<string, unknown>): string => {
    const r = orig(key, vars);
    // Untranslated (missing key) → leave plain so the scanner skips it.
    if (r === key) return key;
    let varsJson = "";
    try {
      if (vars && typeof vars === "object") {
        let hasKey = false;
        for (const _k in vars) {
          hasKey = true;
          break;
        }
        if (hasKey) varsJson = JSON.stringify(vars);
      }
    } catch {
      varsJson = "";
    }
    return (
      LABEL_MARKER_START +
      key +
      LABEL_MARKER_SEP +
      varsJson +
      LABEL_MARKER_SEP +
      r +
      LABEL_MARKER_END
    );
  };
  return v;
}

/**
 * Patch window.i18n.t() to emit edit-labels markers. Idempotent. Patches any
 * already-installed window.i18n (the SSR/i18n-loader install runs at parse
 * time, before this bundle) AND intercepts future reassignments via a
 * get/set accessor, so a later CDN-loader install is wrapped too.
 */
export function installEditLabelsShim(): void {
  if (typeof window === "undefined") return;
  const w = window as ShimWindow;
  if (w.__se_editlabels_shim) return;
  w.__se_editlabels_shim = true;

  let current = wrap(w.i18n, w);
  try {
    Object.defineProperty(window, "i18n", {
      configurable: true,
      get() {
        return current;
      },
      set(v: I18nLike) {
        current = wrap(v, w);
      },
    });
  } catch {
    // i18n was defined non-configurable — the direct patch above already
    // covers the value present at install time.
  }
}
