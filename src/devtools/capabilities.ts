// Devtools capabilities bridge — how the devtools overlays learn what the
// project allows (e.g. public bug intake) from the app's configured
// `@shipeasy/sdk/client` singleton WITHOUT importing it.
//
// The client and the devtools overlay ship as separate bundles; a direct module
// import would inline a second copy of the client (and its Engine singleton)
// into the overlay bundle, which would then read capabilities off the wrong,
// never-configured instance. Instead the client Engine publishes a tiny
// accessor on `globalThis` (works in browsers AND React Native — no `window`
// dependency) and the overlay reads through it. Mirrors the established
// `window.__shipeasy` bridge the web overlay uses.

import type { DevtoolsCapabilities } from "./types";

export const CAPABILITIES_BRIDGE_KEY = "__SE_DEVTOOLS_CAPS__";

/** The accessor the client Engine publishes on `globalThis`. */
export interface CapabilitiesBridge {
  get(): DevtoolsCapabilities | null;
  subscribe(listener: () => void): () => void;
}

function bridge(): CapabilitiesBridge | null {
  const g = globalThis as Record<string, unknown>;
  return (g[CAPABILITIES_BRIDGE_KEY] as CapabilitiesBridge | undefined) ?? null;
}

/** Capabilities from the configured client's last eval, or `null` before
 *  configure()/the first eval (or when no client SDK is present at all). */
export function readDevtoolsCapabilities(): DevtoolsCapabilities | null {
  return bridge()?.get() ?? null;
}

/**
 * Notify `listener` on capability changes. Safe to call before the client SDK
 * configures — polls for the bridge (1 Hz, self-terminating) and attaches when
 * it appears. Returns an unsubscribe.
 */
export function watchDevtoolsCapabilities(listener: () => void): () => void {
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
