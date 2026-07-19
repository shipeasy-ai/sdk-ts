// One-off, stack-aware gate evaluation via the edge `/sdk/evaluate`, used by the
// overlay to DISPLAY true evaluated statuses instead of the lossy flat columns
// from the admin gate list.
//
// The admin list ships each gate's flat `enabled`/`rolloutPct` — a best-effort
// approximation of its gatekeeper stack. A whitelist gate (`project_id in [...]`
// at 100%, then 0% public) collapses to `enabled:false`/`rolloutPct:0`, so
// rendering that reads "off" even when the gate is really ON for the operator's
// project. The edge is the ground truth: it walks the full stack. We call it
// once with the operator's context — crucially `project_id`, which
// project-whitelist gates key on but the host page's own client SDK never
// identifies with — and read back the evaluated flags map.
//
// Read-only + side-effect-free by construction: a throwaway `anonymous_id` that
// is never reused, no page-SDK identity mutation. Failures are swallowed by the
// caller, which falls back to the flat columns.

interface EvalResponse {
  flags?: Record<string, boolean>;
}

/**
 * POST the operator context to the edge and return its evaluated flags map.
 * `{}` when no client key is available (unauthenticated / keyless dev overlay).
 * Throws on a non-2xx response so the caller can log + fall back.
 */
export async function fetchEvaluatedFlags(
  edgeUrl: string,
  clientKey: string,
  context: Record<string, unknown>,
): Promise<Record<string, boolean>> {
  if (!clientKey || !edgeUrl) return {};
  const base = edgeUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/sdk/evaluate?env=prod`, {
    method: "POST",
    headers: { "X-SDK-Key": clientKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      // project_id (and the rest of `context`) wins over the throwaway id.
      user: { anonymous_id: "se-devtools-preview", ...context },
    }),
  });
  if (!res.ok) throw new Error(`/sdk/evaluate returned ${res.status}`);
  const data = (await res.json()) as EvalResponse;
  return data.flags ?? {};
}
