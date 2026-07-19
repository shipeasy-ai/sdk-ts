import type { DevtoolsApi } from "../api";
import { see } from "../../devtools/self-report";
import { getGateOverride, setGateOverride } from "../overrides";
import { fetchEvaluatedFlags } from "../evaluate";
import type { GateRecord, ShipeasySdkBridge } from "../types";
import { I } from "../icons";
import {
  emptyState,
  escapeHtml,
  loadingState,
  searchEmptyState,
  copyButton,
  wireCopyButtons,
  timeAgo,
} from "./common";

interface ViewOpts {
  view: "page" | "all";
  search: string;
}

/** Context for pulling true evaluated statuses from the edge `/sdk/evaluate`. */
export interface GateEvalContext {
  edgeUrl: string;
  clientKey: string;
  /** The operator's project — project-whitelist gates key on `project_id`. */
  projectId: string;
}

function bridge(): ShipeasySdkBridge | null {
  return (window as unknown as { __shipeasy?: ShipeasySdkBridge }).__shipeasy ?? null;
}

interface RenderRow {
  name: string;
  killswitch: boolean;
  enabled: boolean;
  rolloutPct: number;
  override: boolean | null; // null = no override
  effective: boolean;
  live: boolean | null; // bridge value (null = bridge unavailable)
  updatedAt: string;
}

function buildRow(g: GateRecord, evaluated: Record<string, boolean> | null): RenderRow {
  const ov = getGateOverride(g.name);
  // Ground truth = the edge's stack-aware verdict for the operator's context
  // (whitelist gates evaluate ON here even though their flat `enabled` column is
  // false). Fall back to the page's client bridge, then the flat column.
  const edge = evaluated && g.name in evaluated ? evaluated[g.name] : null;
  const liveVal = bridge()?.getFlag(g.name);
  const live = edge !== null ? edge : typeof liveVal === "boolean" ? liveVal : null;
  const effective = ov !== null ? ov : (live ?? g.enabled);
  return {
    name: g.name,
    killswitch: g.killswitch,
    enabled: g.enabled,
    rolloutPct: g.rolloutPct,
    override: ov,
    effective,
    live,
    updatedAt: g.updatedAt,
  };
}

function renderRow(r: RenderRow, expandedKey: string | null): string {
  const isOpen = expandedKey === r.name;
  const overridden = r.override !== null;
  const muted = r.killswitch ? r.effective : !r.effective;
  const ic = r.killswitch ? I.power : I.shield;
  const iconColor = r.killswitch
    ? r.effective
      ? "var(--danger)"
      : "var(--accent)"
    : r.effective
      ? "var(--accent)"
      : "var(--fg-3)";

  let val = "";
  if (r.killswitch) {
    val = `<span class="val ${r.effective ? "killed" : "kill-live"}">${r.effective ? "KILLED" : "LIVE"}</span>`;
  } else {
    const cls = overridden ? "over" : r.effective ? "on" : "off";
    val = `<span class="val ${cls}">${r.effective ? "true" : "false"}</span>`;
  }
  const tog = `<div class="dtf-toggle${
    r.effective ? (overridden ? " over" : " on") : ""
  }" data-toggle="${escapeAttr(r.name)}"></div>`;

  const desc = r.killswitch
    ? r.effective
      ? `killswitch · KILLED (override: ${overridden ? "yes" : "no"})`
      : `killswitch · live · ${(r.rolloutPct / 100).toFixed(0)}% rollout`
    : `flag · ${(r.rolloutPct / 100).toFixed(0)}% rollout · updated ${timeAgo(r.updatedAt)}`;

  const detail = r.killswitch
    ? `
      <div class="crumbs">
        <div><span class="${r.effective ? "deny" : "pass"}">${r.effective ? "✗" : "✓"}</span> killswitch
          <span style="color:var(--fg-4)">→</span>
          <span class="${r.effective ? "deny" : "pass"}">${r.effective ? "KILLED" : "live"}</span>
        </div>
        <div class="indent meta">propagation: &lt;1s to 60+ regions</div>
      </div>
      <div class="actions">
        <button class="${r.effective ? "primary" : ""}" data-toggle-detail="${escapeAttr(r.name)}">${
          r.effective ? "✓ Restore" : "⚠ Pull the switch"
        }</button>
      </div>`
    : `
      <div class="crumbs">
        <div><span class="${overridden ? "skip" : r.effective ? "pass" : "deny"}">${
          overridden ? "↦" : r.effective ? "✓" : "✗"
        }</span> ${escapeHtml(r.name)}
          <span style="color:var(--fg-4)">→</span>
          <span class="${overridden ? "skip" : r.effective ? "pass" : "deny"}">
            ${overridden ? `forced ${r.effective ? "true" : "false"} (real: ${r.live === null ? "unknown" : r.live ? "true" : "false"})` : r.effective ? "true" : "false"}
          </span>
        </div>
        <div class="indent">rollout <span style="color:var(--fg-4)">=</span> ${(r.rolloutPct / 100).toFixed(0)}%</div>
      </div>
      <div class="mini">
        <span class="lbl">live</span><span class="v">${r.live === null ? "—" : r.live ? "true" : "false"}</span>
        <span class="lbl">override</span><span class="v">${overridden ? (r.override ? "true" : "false") : "none"}</span>
        <span class="lbl">updated</span><span class="v">${timeAgo(r.updatedAt)}</span>
      </div>
      <div class="actions">
        <button class="primary" data-toggle-detail="${escapeAttr(r.name)}">⤢ Force ${r.effective ? "false" : "true"}</button>
        ${overridden ? `<button data-clear-detail="${escapeAttr(r.name)}">↺ Clear override</button>` : ""}
      </div>`;

  return `
    <div class="dtf-row${isOpen ? " expanded" : ""}${muted ? " muted" : ""}" data-row="${escapeAttr(r.name)}">
      <div class="ic"><span style="color:${iconColor}">${ic}</span></div>
      <div class="meta">
        <div class="k">
          <span class="name">${escapeHtml(r.name)}</span>
          ${copyButton("g:" + r.name, "Copy feature flag name")}
          ${overridden ? `<span class="override-tag">forced</span>` : ""}
          ${r.live ? `<span class="live-dot" title="firing on this page"></span>` : ""}
        </div>
        <div class="v">${escapeHtml(desc)}</div>
      </div>
      ${val}${tog}
    </div>
    <div class="dtf-detail${isOpen ? " open" : ""}">
      <div class="inner"><div class="pad">${detail}</div></div>
    </div>`;
}

export async function renderGatesPanel(
  container: HTMLElement,
  api: DevtoolsApi,
  view: ViewOpts,
  setOverrideCount: (n: number) => void,
  evalCtx?: GateEvalContext,
): Promise<void> {
  container.innerHTML = loadingState();
  let gates: GateRecord[];
  try {
    gates = await api.gates();
  } catch (err) {
    container.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed to load feature flags: ${escapeHtml(String(err))}</div>`;
    see(err).causes_the("feature flag list").to("fail to load");
    return;
  }

  // Pull the true, stack-aware statuses from the edge once, keyed by the
  // operator's project (so project-whitelist gates like `release_module` show
  // their real ON state instead of the lossy flat `enabled` column). Merge the
  // page client's last identify() attrs so email/user-scoped gates evaluate
  // closer to reality too; `project_id` wins. Best-effort — fall back to flat
  // columns on any failure.
  let evaluated: Record<string, boolean> | null = null;
  if (evalCtx?.clientKey) {
    try {
      evaluated = await fetchEvaluatedFlags(evalCtx.edgeUrl, evalCtx.clientKey, {
        ...(bridge()?.user ?? {}),
        project_id: evalCtx.projectId,
      });
    } catch (err) {
      see(err).causes_the("feature flag statuses").to("fall back to flat gate columns");
    }
  }

  if (gates.length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>feature flags</em> yet",
      message: "Feature flags let you gate releases and ramp rollouts safely.",
      actions: api.hideAdminLinks
        ? []
        : [
            {
              icon: "+",
              label: "Create new feature flag",
              href: `${api.adminUrl}/dashboard/gates/new`,
            },
          ],
    });
    container.innerHTML = html;
    wire(container);
    setOverrideCount(0);
    return;
  }

  let expanded: string | null = null;

  function paint(): void {
    const q = view.search.trim().toLowerCase();
    const filtered = q ? gates.filter((g) => g.name.toLowerCase().includes(q)) : gates;
    const rows = filtered.map((g) => buildRow(g, evaluated));
    setOverrideCount(rows.filter((r) => r.override !== null).length);

    if (rows.length === 0) {
      container.innerHTML = searchEmptyState(view.search);
      return;
    }

    if (view.view === "page") {
      const active = rows.filter((r) => r.live === true || r.killswitch);
      const inactive = rows.filter((r) => !active.includes(r));
      container.innerHTML =
        `<div class="dtf-group">Active on this page<span class="pulse"><span class="d"></span>${active.length} firing</span></div>` +
        active.map((r) => renderRow(r, expanded)).join("") +
        (inactive.length
          ? `<div class="dtf-group">Inactive<span class="c">${inactive.length} more</span></div>` +
            inactive.map((r) => renderRow(r, expanded)).join("")
          : "");
    } else {
      container.innerHTML =
        `<div class="dtf-group">All flags<span class="c">${rows.length}</span></div>` +
        rows.map((r) => renderRow(r, expanded)).join("");
    }

    // Wire row click → expand
    container.querySelectorAll<HTMLElement>(".dtf-row").forEach((rowEl) => {
      rowEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".dtf-toggle") || target.closest(".dtf-copy")) return;
        const name = rowEl.dataset.row!;
        expanded = expanded === name ? null : name;
        paint();
      });
    });

    // Toggles (row + detail)
    container.querySelectorAll<HTMLElement>("[data-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = el.getAttribute("data-toggle")!;
        const r = rows.find((x) => x.name === name);
        if (!r) return;
        // Force the *opposite* of effective. setGateOverride reloads the page.
        setGateOverride(name, !r.effective);
      });
    });
    container.querySelectorAll<HTMLElement>("[data-toggle-detail]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = el.getAttribute("data-toggle-detail")!;
        const r = rows.find((x) => x.name === name);
        if (!r) return;
        setGateOverride(name, !r.effective);
      });
    });
    container.querySelectorAll<HTMLElement>("[data-clear-detail]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = el.getAttribute("data-clear-detail")!;
        setGateOverride(name, null);
      });
    });

    wireCopyButtons(container, Object.fromEntries(rows.map((r) => ["g:" + r.name, () => r.name])));
  }

  paint();
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
