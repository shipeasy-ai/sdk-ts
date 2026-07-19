/**
 * Devtools overlay types.
 *
 * The admin-API record projections (`GateRecord`, `ConfigRecord`, …) live in
 * the shared headless core (`../devtools/types`) — one contract for the
 * browser and React Native overlays, derived from the generated OpenAPI
 * output where a projection matches 1:1 (e.g. `UniverseRecord`). This module
 * re-exports them and keeps only the browser-overlay-specific declarations
 * (`DevtoolsOptions`, the popup-auth `DevtoolsSession`, `ShipeasySdkBridge`).
 *
 * NB: the shared `BugStatus` includes `pending_approval` (public intake) —
 * the overlay renders it like `open` but badged, see panels/feedback.ts.
 */

export type {
  AttachmentRecord,
  AttachmentUploadResult,
  BugDetail,
  BugPriority,
  BugRecord,
  BugStatus,
  ConfigRecord,
  DraftRecord,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  FeedbackConnectorData,
  GateRecord,
  KeyRecord,
  ProfileRecord,
  ProjectModules,
  ProjectRecord,
  UniverseRecord,
} from "../devtools/types";
export { PERMISSIVE_CONFIG_SCHEMA } from "../devtools/types";

import type { BugPriority, BugStatus, ProjectRecord } from "../devtools/types";

// Bugs and feature requests share one status set and one priority set.
export type FeatureRequestStatus = BugStatus;
/** @deprecated feature-request importance is now the shared `priority`. */
export type FeatureRequestImportance = BugPriority;

export interface DevtoolsOptions {
  /**
   * Admin app base URL. Defaults to the origin of the <script> tag that
   * loaded the devtools bundle, falling back to window.location.origin.
   * Override when embedding from a different admin deployment.
   */
  adminUrl?: string;
  /**
   * Customer SDK client (public) key. When set, the devtools auth popup
   * passes it as `?sdkKey=…` so ShipEasy can resolve the project without
   * relying on `window.__SE_BOOTSTRAP`. Typically read from the script
   * tag's `data-client-api-key` attribute in the auto-init bundle.
   */
  clientKey?: string;
  /**
   * ShipEasy project ID. Optional companion to `clientKey` — when both are
   * provided, the auth popup passes `?projectId=…` so the admin can skip
   * the key→project lookup entirely. Typically read from the script tag's
   * `data-project-id` attribute in the auto-init bundle.
   */
  projectId?: string;
  /**
   * Force-hide every deep link from the overlay back into the ShipEasy
   * admin dashboard ("Open dashboard ↗", empty-state "Create new …" CTAs,
   * bug/feature row click-throughs). Use for white-labelled embeds where
   * the underlying ShipEasy URLs should not be exposed to the end user.
   *
   * If unset, the overlay also evaluates the ShipEasy gate
   * `HIDE_ADMIN_LINKS_GATE` against the customer's SDK bridge — so a
   * ShipEasy gate can flip this on at runtime without a redeploy. When
   * either source is true, links are hidden.
   */
  hideAdminLinks?: boolean;
  /**
   * Override the `--accent` CSS custom property on the shadow host before
   * the overlay renders. Accepts any valid CSS colour value or `var(…)`
   * reference (e.g. `'var(--brand-color)'`). When set as a `var()`, it is
   * resolved against the host page's cascade, allowing the overlay to
   * inherit the embedding page's brand colour automatically.
   */
  accentColor?: string;
  /**
   * Pre-seed session and/or project state before the overlay mounts.
   * Each field is written to sessionStorage only when the corresponding
   * key is not already present — an existing real session is never
   * overwritten. Useful for demo embeds, testing, and SSR-preloaded auth.
   */
  seed?: {
    /** Pre-set token + projectId. Skips the sign-in prompt on first open. */
    session?: DevtoolsSession;
    /** Pre-set the project cache. Prevents the initial project API fetch. */
    project?: ProjectRecord;
    /** Default active panel key (e.g. "feedback"). Only applied when no panel was previously selected. */
    activePanel?: string;
  };
  /**
   * Drop the collapsed "rail" state entirely. The overlay always mounts
   * expanded, and the header collapse button closes (tears down) the overlay
   * instead of docking it to an edge rail. Use when the embedding page owns
   * the open/close affordance (e.g. its own launch button) and a persistent
   * floating mini-bar would be redundant or off-brand.
   */
  hideRail?: boolean;
  /**
   * Called when the user closes the overlay from inside it (the header
   * collapse button) while `hideRail` is set. The embedder should tear the
   * overlay down here. Defaults to a full `destroy()` when mounted via the
   * package's own `init()` entry point.
   */
  onClose?: () => void;
}

/**
 * Name of the ShipEasy gate (evaluated via `window.__shipeasy.getFlag()`)
 * that, when ON, hides admin dashboard links in the devtools overlay.
 * The customer creates and toggles this gate in their own ShipEasy
 * project; devtools picks it up via the already-installed SDK bridge.
 */
export const HIDE_ADMIN_LINKS_GATE = "shipeasy_hide_admin_links";

/** The browser overlay's popup-auth session (narrower than the RN core's
 *  DevtoolsSession — the popup flow doesn't surface email/project name). */
export interface DevtoolsSession {
  token: string;
  projectId: string;
}

/** Mirrors `originAllowed` in packages/worker/src/lib/auth.ts. */
export function projectOwnsHost(host: string, domain: string | null): boolean {
  if (!domain) return false;
  if (domain === "*") return true;
  if (domain.startsWith("*.")) {
    const apex = domain.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  return host === domain || host === `www.${domain}`;
}

export type OverridePersistence = "session" | "local";

/**
 * Bridge written to window.__shipeasy by the host framework integration.
 * Devtools reads from these to show live SDK evaluation results.
 */
export interface ShipeasySdkBridge {
  getFlag(name: string): boolean;
  getExperiment(name: string): { inExperiment: boolean; group: string } | undefined;
  getConfig(name: string): unknown;
  /** Last identify() payload — the User panel reads it when present. */
  user?: Record<string, unknown> | null;
}
