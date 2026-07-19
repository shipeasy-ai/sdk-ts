// Self-executing entry for <script src="…/se-devtools.js"> usage.
// loadOnTrigger() sets up the Shift+Alt+S hotkey and ?se-devtools URL param detection.
import { loadOnTrigger, isDevtoolsRequested } from "./index";
import { isEditLabelsModeActive } from "./overrides";
import { installEditLabelsShim } from "./edit-labels-shim";
import { scanAndReplaceMarkers, toggleEditLabels } from "./panels/i18n";
import type { DevtoolsOptions } from "./types";

interface AutoGlobals {
  __se_devtools_config?: DevtoolsOptions & { clientKey?: string; projectId?: string };
  __se_devtools_ready?: boolean;
}

if (typeof window !== "undefined") {
  // Capture document.currentScript synchronously — it becomes null after
  // the script element finishes parsing, so we must read it here, before
  // any deferred callbacks run.
  // Fallback: Next.js App Router hoists <script src> to <head> as async,
  // which makes document.currentScript null at execution time. Query the
  // DOM for the script element in that case — it is already in the DOM
  // because the browser parsed it before fetching and running the bundle.
  const scriptEl =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>("script[data-client-api-key]");
  const dataClientKey = scriptEl?.getAttribute("data-client-api-key") ?? undefined;
  const dataProjectId = scriptEl?.getAttribute("data-project-id") ?? undefined;

  // data-project-id is required. data-client-api-key is required in production
  // for authenticated API calls; in development it may be omitted and the overlay
  // opens in unauthenticated mode (URL overrides and hotkey still work).
  if (!dataProjectId) {
    console.error(
      "[ShipEasy devtools] Missing required data-project-id attribute.\n" +
        'Add it to the <script> tag: <script src="…/se-devtools.js" data-project-id="<ID>">',
    );
  } else {
    if (!dataClientKey) {
      console.warn(
        "[ShipEasy devtools] data-client-api-key not set — overlay opens in unauthenticated mode.",
      );
    }
    // Config override for non-production deployments (local dev, staging).
    // Set `window.__se_devtools_config = { adminUrl }` before this script
    // runs to point the overlay at a different admin deployment. When unset
    // we default to the origin of the se-devtools.js <script> tag, so the
    // popup opens on the admin app that served the script.
    const windowCfg = (window as Window & AutoGlobals).__se_devtools_config ?? {};
    // data-* attributes on the <script> tag take precedence over any
    // window.__se_devtools_config values for clientKey / projectId.
    const cfg = { ...windowCfg, clientKey: dataClientKey, projectId: dataProjectId };

    // Capture whether ?se=1 is in the URL RIGHT NOW — synchronously, before
    // any framework router (Next.js App Router calls history.replaceState
    // during hydration to sync its scroll-restoration state, which can
    // strip unrecognised query params). We pass this flag to loadOnTrigger
    // so the overlay still opens even if the URL is cleaned by the time
    // window.load + 2 rAFs fires.
    const seRequestedAtLoad = isDevtoolsRequested();

    // Defer mount past React hydration. Mounting the overlay host onto
    // <html> mid-hydrate makes Next.js's hydration recovery (#418) tear
    // down the entire client tree including our host, and the reattach
    // observer can't keep up because it ALSO gets re-created. Waiting
    // until window.load + a couple of rAFs sidesteps the recovery cycle
    // entirely so the host lands on a steady-state DOM and stays.
    const startLoadOnTrigger = () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => loadOnTrigger(cfg, "Shift+Alt+S", seRequestedAtLoad)),
      );
    };
    if (document.readyState === "complete") startLoadOnTrigger();
    else window.addEventListener("load", startLoadOnTrigger, { once: true });
    void isDevtoolsRequested;

    // When ?se_edit_labels=1 is present, scan the DOM and replace Unicode
    // markers with <span data-label="key"> elements — even if the overlay is
    // not open.  We need to run AFTER:
    //   1. React has hydrated and rendered all t() call sites, AND
    //   2. The i18n CDN loader has fetched translations and installed window.i18n
    //
    // The safest trigger is window.i18n.on("update") which fires when the CDN
    // loader completes its fetch. At that point React has re-rendered with real
    // translated values (and marker strings), so the DOM is ready to scan.
    // We also fire once immediately on a rAF as a fallback for cases where
    // window.i18n is already available before this script runs.
    if (isEditLabelsModeActive()) {
      // Wrap window.i18n.t() so client re-renders and dynamic mounts keep
      // emitting edit-labels markers (SSR rendered them server-side; this keeps
      // them alive on the client). Must run before the scan loop below. This
      // shim used to be an inline <script> the server SDK generated — it now
      // lives in the devtools bundle.
      installEditLabelsShim();

      // Run one scan pass.  After the scan, install a childList-only observer so
      // newly-mounted components that render [data-label] spans also get cleaned.
      // We intentionally avoid characterData observation — it fires on every React
      // text update and creates a feedback loop with our own DOM writes.
      //
      // The observer is disconnected BEFORE each scan and reconnected AFTER so
      // that our own el.textContent = … mutations don't re-trigger the scan.
      let scanScheduled = false;

      const observer = new MutationObserver(() => scheduleScan());

      const scheduleScan = () => {
        if (scanScheduled) return;
        scanScheduled = true;
        // rAF lets React finish the current render cycle before we read the DOM.
        requestAnimationFrame(() => {
          scanScheduled = false;
          observer.disconnect(); // pause — don't react to our own writes
          scanAndReplaceMarkers();
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          }); // resume
        });
      };

      // First pass: defer past React hydration. Mutating SSR-rendered marker
      // text nodes into <span data-label> children mid-hydrate looks like a
      // text/element mismatch to React and triggers minified error #418, which
      // tears down the whole client tree (including our overlay host). Waiting
      // for window.load + a couple of rAFs gives React's commit phase time to
      // finish; subsequent scans are driven by MutationObserver and run after
      // each render cycle, which is safe.
      const firstScan = () => {
        requestAnimationFrame(() => requestAnimationFrame(() => scheduleScan()));
      };
      if (document.readyState === "complete") firstScan();
      else window.addEventListener("load", firstScan, { once: true });

      // Auto-activate the click-to-edit handler for ?se_edit_labels=1, so the
      // tabbed popper opens on click without requiring the user to manually flip
      // the toggle in the i18n panel (which gates behind dashboard auth).  Wait
      // for the overlay shadow root to mount, then arm the handler.
      const armEditMode = () => {
        const host = document.getElementById("shipeasy-devtools");
        if (!host?.shadowRoot) {
          setTimeout(armEditMode, 100);
          return;
        }
        toggleEditLabels(true, host.shadowRoot, () => scheduleScan());
      };
      armEditMode();
      window.addEventListener("se:i18n:ready", () => scheduleScan(), { once: true });

      // Also subscribe via window.i18n.on("update") if the loader is already installed.
      const w = window as Window & { i18n?: { on?: (ev: string, cb: () => void) => () => void } };
      if (w.i18n?.on) w.i18n.on("update", () => scheduleScan());
    }

    (window as Window & AutoGlobals).__se_devtools_ready = true;
  }
}
