// Devtools ⇄ Engine bridge — how a devtools overlay talks to the app's
// configured `@shipeasy/sdk/client` singleton WITHOUT importing it.
//
// Same rationale as the capabilities bridge (./capabilities.ts): the client
// and the overlay ship as separate bundles; a direct module import would
// inline a second copy of the client (and its Engine singleton) into the
// overlay, which would then read state off the wrong, never-configured
// instance. The Engine publishes this richer accessor on `globalThis`
// (browsers AND React Native — no `window` dependency); overlays read live
// values, the identified user, and the override store through it.
//
// The web overlay predates this bridge and keeps its URL-param override
// store (?se_ks_* + reload — portable, shareable URLs). React Native has no
// URL to write to, so its overlay drives the Engine's programmatic overrides
// through these methods instead: they apply live, no reload.

import type { User } from "../client";

export const ENGINE_BRIDGE_KEY = "__SE_DEVTOOLS_ENGINE__";

/** Snapshot of the Engine's programmatic override store. */
export interface DevtoolsOverridesSnapshot {
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
  /** experiment name → forced group. */
  experiments: Record<string, string>;
}

/** One entry in the devtools event feed (the RN Events panel's stream —
 *  mirrors the web overlay's `se:state:update` classification). */
export interface DevtoolsStateEvent {
  kind: "evaluate" | "override" | "update";
  /** e.g. `"identify"`, `"gate new_checkout"`. */
  subject: string;
  /** Rendered value, e.g. `"true"`, `"variant_b"`, `"cleared"`. */
  value: string;
  ts: number;
}

/** The accessor the client Engine publishes on `globalThis`. */
export interface DevtoolsEngineBridge {
  getFlag(name: string): boolean;
  getExperiment(name: string): { inExperiment: boolean; group: string };
  getConfig(name: string): unknown;
  /** The last identify() payload (caller fields ⊕ auto-collected attrs), or
   *  null before the app identifies. */
  getUser(): Record<string, unknown> | null;
  /** Re-run identify() with (possibly mutated) user props — the User panel's
   *  "Re-evaluate" action. Resolves when the fresh eval lands. */
  identify(user: User): Promise<void>;
  getOverrides(): DevtoolsOverridesSnapshot;
  setFlagOverride(name: string, value: boolean): void;
  setConfigOverride(name: string, value: unknown): void;
  setExperimentOverride(name: string, group: string): void;
  /** Remove a single override (the panels' "Restore" action). */
  removeOverride(kind: "flag" | "config" | "experiment", name: string): void;
  clearOverrides(): void;
  /** Re-render signal: fires after identify() and after any override change. */
  subscribe(listener: () => void): () => void;
  /** Structured event feed for the Events panel. */
  onEvent(listener: (event: DevtoolsStateEvent) => void): () => void;
}

function bridge(): DevtoolsEngineBridge | null {
  const g = globalThis as Record<string, unknown>;
  return (g[ENGINE_BRIDGE_KEY] as DevtoolsEngineBridge | undefined) ?? null;
}

/** The configured client's engine bridge, or `null` before configure() (or
 *  when no client SDK is present at all — the overlays hide live-state UI). */
export function readEngineBridge(): DevtoolsEngineBridge | null {
  return bridge();
}

/**
 * Notify `listener` when the bridge appears and on every subsequent state
 * change. Safe to call before the client SDK configures — polls for the
 * bridge (1 Hz, self-terminating) and attaches when it appears. Returns an
 * unsubscribe.
 */
export function watchEngineBridge(listener: () => void): () => void {
  const b = bridge();
  if (b) return b.subscribe(listener);
  let unsub: (() => void) | null = null;
  const timer = setInterval(() => {
    const late = bridge();
    if (late) {
      clearInterval(timer);
      unsub = late.subscribe(listener);
      listener();
    }
  }, 1000);
  return () => {
    clearInterval(timer);
    unsub?.();
  };
}
