import type { DevtoolsApi } from "../api";
import { getExpOverride, setExpOverride } from "../overrides";
import type { ExperimentRecord, ShipeasySdkBridge } from "../types";
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

function bridge(): ShipeasySdkBridge | null {
  return (window as unknown as { __shipeasy?: ShipeasySdkBridge }).__shipeasy ?? null;
}

interface RenderRow {
  name: string;
  status: ExperimentRecord["status"];
  groups: Array<{ name: string; weight: number }>;
  override: string | null;
  liveGroup: string | null;
  liveEnrolled: boolean;
  effective: string;
  updatedAt: string;
}

function buildRow(e: ExperimentRecord): RenderRow {
  const ov = getExpOverride(e.name);
  const live = bridge()?.getExperiment(e.name);
  const liveGroup = live?.inExperiment ? live.group : null;
  const groupNames = ["control", ...e.groups.map((g) => g.name)];
  const effective = ov ?? liveGroup ?? "control";
  return {
    name: e.name,
    status: e.status,
    groups: [{ name: "control", weight: 0 }, ...e.groups]
      .map((g, i) => ({
        name: i === 0 ? "control" : g.name,
        weight: g.weight,
      }))
      .filter((g, i, arr) => arr.findIndex((x) => x.name === g.name) === i),
    override: ov,
    liveGroup,
    liveEnrolled: live?.inExperiment ?? false,
    effective,
    updatedAt: e.updatedAt,
  };
  void groupNames;
}

function renderRow(r: RenderRow, expandedKey: string | null): string {
  const isOpen = expandedKey === r.name;
  const overridden = r.override !== null;
  const optHtml = r.groups
    .map(
      (g) =>
        `<option value="${escapeAttr(g.name)}"${g.name === r.effective ? " selected" : ""}>${escapeHtml(g.name)}</option>`,
    )
    .join("");
  const sel = `<select class="sel${overridden ? " over" : ""}" data-exp="${escapeAttr(r.name)}" style="grid-column:3 / span 2; justify-self:end">
    ${optHtml}
  </select>`;

  const desc = `experiment · ${r.status} · ${r.groups.length} variants${
    r.liveGroup ? ` · live: ${r.liveGroup}` : ""
  }`;

  const variantsHtml = r.groups
    .map((g, i) => {
      const assigned = g.name === r.effective;
      const swatch =
        ["var(--info)", "var(--accent)", "var(--warn)", "var(--danger)", "var(--pri)"][i] ??
        "var(--fg-3)";
      return `<div class="var-row${assigned ? " assigned" : ""}">
        <span class="sw" style="background:${swatch}"></span>
        <span>${escapeHtml(g.name)}</span>
        <span class="pct">${g.weight}%</span>
        <span style="font-size:9.5px;color:var(--fg-4)">${
          g.name === r.liveGroup ? "real" : g.name === r.override ? "forced" : ""
        }</span>
      </div>`;
    })
    .join("");

  const detail = `
    <div class="crumbs">
      <div><span class="${overridden ? "skip" : "pass"}">●</span> ${
        overridden
          ? "forced via URL override"
          : r.liveGroup
            ? "assigned via SDK"
            : "no live assignment"
      }</div>
    </div>
    ${variantsHtml}
    <div class="mini">
      <span class="lbl">status</span><span class="v">${r.status}</span>
      <span class="lbl">updated</span><span class="v">${timeAgo(r.updatedAt)}</span>
    </div>
    <div class="actions">
      ${overridden ? `<button data-clear="${escapeAttr(r.name)}">↺ Clear override</button>` : ""}
    </div>`;

  return `
    <div class="dtf-row${isOpen ? " expanded" : ""}${r.status !== "running" ? " muted" : ""}" data-row="${escapeAttr(r.name)}">
      <div class="ic"><span style="color:${r.liveEnrolled ? "var(--accent)" : "var(--fg-3)"}">${I.flask}</span></div>
      <div class="meta">
        <div class="k">
          <span class="name">${escapeHtml(r.name)}</span>
          ${copyButton("e:" + r.name, "Copy experiment name")}
          ${overridden ? `<span class="override-tag">forced</span>` : ""}
          ${r.liveEnrolled ? `<span class="live-dot" title="enrolled on this page"></span>` : ""}
        </div>
        <div class="v">${escapeHtml(desc)}</div>
      </div>
      ${sel}
    </div>
    <div class="dtf-detail${isOpen ? " open" : ""}">
      <div class="inner"><div class="pad">${detail}</div></div>
    </div>`;
}

export async function renderExperimentsPanel(
  container: HTMLElement,
  api: DevtoolsApi,
  view: ViewOpts,
  setOverrideCount: (n: number) => void,
): Promise<void> {
  container.innerHTML = loadingState();
  let experiments: ExperimentRecord[];
  try {
    experiments = await api.experiments();
  } catch (err) {
    container.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed to load experiments: ${escapeHtml(String(err))}</div>`;
    return;
  }
  if (experiments.length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>experiments</em> yet",
      message:
        "Run A/B tests with traffic-bucketed variants. Launch one to start measuring impact.",
      actions: api.hideAdminLinks
        ? []
        : [
            {
              icon: "+",
              label: "Create new experiment",
              href: `${api.adminUrl}/dashboard/experiments/new`,
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
    const filtered = q ? experiments.filter((e) => e.name.toLowerCase().includes(q)) : experiments;
    const rows = filtered.map(buildRow);
    setOverrideCount(rows.filter((r) => r.override !== null).length);

    if (rows.length === 0) {
      container.innerHTML = searchEmptyState(view.search);
      return;
    }

    if (view.view === "page") {
      const active = rows.filter((r) => r.liveEnrolled);
      const inactive = rows.filter((r) => !r.liveEnrolled);
      container.innerHTML =
        `<div class="dtf-group">Active on this page<span class="pulse"><span class="d"></span>${active.length} enrolled</span></div>` +
        (active.length
          ? active.map((r) => renderRow(r, expanded)).join("")
          : `<div class="se-empty">No experiments enrolled yet on this page.</div>`) +
        (inactive.length
          ? `<div class="dtf-group">Other<span class="c">${inactive.length}</span></div>` +
            inactive.map((r) => renderRow(r, expanded)).join("")
          : "");
    } else {
      container.innerHTML =
        `<div class="dtf-group">All experiments<span class="c">${rows.length}</span></div>` +
        rows.map((r) => renderRow(r, expanded)).join("");
    }

    container.querySelectorAll<HTMLElement>(".dtf-row").forEach((rowEl) => {
      rowEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest("select") || target.closest(".dtf-copy")) return;
        const name = rowEl.dataset.row!;
        expanded = expanded === name ? null : name;
        paint();
      });
    });

    container.querySelectorAll<HTMLSelectElement>("select[data-exp]").forEach((sel) => {
      sel.addEventListener("change", () => {
        setExpOverride(sel.dataset.exp!, sel.value || null);
      });
    });
    container.querySelectorAll<HTMLElement>("[data-clear]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setExpOverride(el.getAttribute("data-clear")!, null);
      });
    });

    wireCopyButtons(container, Object.fromEntries(rows.map((r) => ["e:" + r.name, () => r.name])));
  }

  paint();
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
