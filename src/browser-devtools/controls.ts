// ShipEasy-owned controls fetched from a ShipEasy-internal project.
//
// The devtools bundle ships to every customer's app, so flags that should be
// flipped centrally (e.g. white-label kill switches) cannot live in the
// customer's own project. Instead we keep a tiny dedicated ShipEasy project
// whose only job is to host these meta-flags, and call its /sdk/evaluate
// endpoint from the overlay using the client key baked into this file.
//
// Setup expected in ShipEasy admin:
//   1. Create a project (e.g. "Devtools controls").
//   2. Generate a *client* SDK key for it. Leave the project domain blank —
//      the key must work from any customer origin, so `allowed_origin` must
//      be null (the auth middleware in packages/worker/src/lib/auth.ts
//      treats null as "allow all").
//   3. Paste the key into SHIPEASY_CONTROLS_CLIENT_KEY below.
//   4. Create a boolean gate named after each control (see types.ts) and
//      toggle it from the dashboard. Changes propagate via the same KV
//      blob + CDN purge path as any other gate.

import { HIDE_ADMIN_LINKS_GATE } from "./types";

/**
 * Public client SDK key for the ShipEasy central "shipeasy devtools" project
 * (`a5975cd3-…`). The project's `domain` is `*` so this key is accepted
 * from any customer origin (auth middleware in
 * packages/worker/src/lib/auth.ts treats `*` as match-all).
 * Empty string = controls fetch is disabled.
 */
const SHIPEASY_CONTROLS_CLIENT_KEY = "sdk_client_6cecf6208cb443faa86b9ce6c007aee4";

/** Edge base URL that hosts /sdk/evaluate for the controls project. */
const SHIPEASY_CONTROLS_BASE_URL = "https://cdn.shipeasy.ai";

interface EvaluateResponse {
  flags?: Record<string, boolean>;
}

// `evalGate` only answers without a unit id when a gate is fully rolled out
// (packages/core/src/eval/gate.ts; doc 18) — any fractional or targeted
// kill-switch evaluates to false if we send `{ user: {} }`. Mint a stable anon
// id for the controls call and persist it under a devtools-only key so those
// cases bucket correctly and we don't collide with the customer's own SDK anon id.
const CONTROLS_ANON_KEY = "__se_devtools_controls_anon";

function getControlsAnonId(): string {
  if (typeof window === "undefined") return "anon_devtools";
  try {
    const cached = localStorage.getItem(CONTROLS_ANON_KEY);
    if (cached) return cached;
  } catch {
    /* storage blocked — fall through and mint a per-load id */
  }
  const fresh =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `anon_${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(CONTROLS_ANON_KEY, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

interface ControlsState {
  hideAdminLinks: boolean;
}

const DEFAULT_STATE: ControlsState = { hideAdminLinks: false };

let state: ControlsState = { ...DEFAULT_STATE };
let inFlight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

/** Last-known value (synchronous read for panel render paths). */
export function getControlsState(): ControlsState {
  return state;
}

/** Re-render hook: called after the controls fetch lands with a changed value. */
export function subscribeControls(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * Fire-and-forget fetch from the controls project. Idempotent — concurrent
 * callers share the same in-flight promise. Failures are swallowed (the
 * overlay must keep working when the controls endpoint is unreachable).
 */
export function refreshControls(): Promise<void> {
  if (!SHIPEASY_CONTROLS_CLIENT_KEY) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${SHIPEASY_CONTROLS_BASE_URL}/sdk/evaluate`, {
        method: "POST",
        headers: {
          "X-SDK-Key": SHIPEASY_CONTROLS_CLIENT_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: { anonymous_id: getControlsAnonId() } }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as EvaluateResponse;
      const flags = body.flags ?? {};
      const next: ControlsState = {
        hideAdminLinks: Boolean(flags[HIDE_ADMIN_LINKS_GATE]),
      };
      const changed = next.hideAdminLinks !== state.hideAdminLinks;
      state = next;
      if (changed) for (const cb of subscribers) cb();
    } catch {
      /* network/parse error — keep prior state */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
