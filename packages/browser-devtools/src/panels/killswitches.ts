import type { DevtoolsApi } from "../api";
import { see } from "@shipeasy/devtools-core/self-report";
import { getGateOverride, setGateOverride } from "../overrides";
import type { KillswitchRecord, ShipeasySdkBridge } from "../types";
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

export interface KillswitchRow {
  name: string;
  description: string | null;
  /** Dashboard (published) state, preferring the prod env. */
  published: boolean;
  /** Named sub-switches that are tripped, from the same env. */
  trippedSwitches: string[];
  /** Forced via ?se_ks_<name>, or null. */
  override: boolean | null;
  /** What the host app's SDK is serving right now, or null without a bridge. */
  live: boolean | null;
  /** true = KILLED. */
  effective: boolean;
  updatedAt: string;
}

export function buildKillswitchRow(k: KillswitchRecord): KillswitchRow {
  const env = k.envs?.prod ?? Object.values(k.envs ?? {})[0];
  const published = env?.value === true;
  const trippedSwitches = Object.entries(env?.switches ?? {})
    .filter(([, v]) => v === true)
    .map(([n]) => n);
  const override = getGateOverride(k.name);
  const liveVal = bridge()?.getKillswitch?.(k.name);
  const live = typeof liveVal === "boolean" ? liveVal : null;
  return {
    name: k.name,
    description: k.description,
    published,
    trippedSwitches,
    override,
    live,
    effective: override ?? live ?? published,
    updatedAt: k.updatedAt,
  };
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function renderRow(r: KillswitchRow, expandedKey: string | null): string {
  const isOpen = expandedKey === r.name;
  const overridden = r.override !== null;
  const killed = r.effective;
  const iconColor = killed ? "var(--danger)" : "var(--accent)";
  const val = `<span class="val ${overridden ? "over" : killed ? "killed" : "kill-live"}">${killed ? "KILLED" : "LIVE"}</span>`;
  const tog = `<div class="dtf-toggle${killed ? (overridden ? " over" : " on") : ""}" data-toggle="${escapeAttr(r.name)}"></div>`;
  const tripped = r.trippedSwitches.length
    ? ` · tripped: ${r.trippedSwitches.join(", ")}`
    : "";
  const desc = `killswitch · ${killed ? "killed" : "live"}${tripped} · updated ${timeAgo(r.updatedAt)}`;
  const state = (v: boolean | null) => (v === null ? "—" : v ? "killed" : "live");

  const detail = `
    <div class="crumbs">
      <div><span class="${overridden ? "skip" : killed ? "deny" : "pass"}">${overridden ? "↦" : killed ? "✗" : "✓"}</span> ${escapeHtml(r.name)}
        <span style="color:var(--fg-4)">→</span>
        <span class="${overridden ? "skip" : killed ? "deny" : "pass"}">${
          overridden ? `forced ${killed ? "killed" : "live"}` : killed ? "KILLED" : "live"
        }</span>
      </div>
      ${r.description ? `<div class="indent meta">${escapeHtml(r.description)}</div>` : ""}
    </div>
    <div class="mini">
      <span class="lbl">published</span><span class="v">${state(r.published)}</span>
      <span class="lbl">live</span><span class="v">${state(r.live)}</span>
      <span class="lbl">override</span><span class="v">${overridden ? state(r.override) : "none"}</span>
    </div>
    <div class="actions">
      <button class="${killed ? "primary" : ""}" data-toggle-detail="${escapeAttr(r.name)}">${
        killed ? "✓ Force live" : "⚠ Force killed"
      }</button>
      ${overridden ? `<button data-clear-detail="${escapeAttr(r.name)}">↺ Clear override</button>` : ""}
    </div>`;

  return `
    <div class="dtf-row${isOpen ? " expanded" : ""}${killed ? " muted" : ""}" data-row="${escapeAttr(r.name)}">
      <div class="ic"><span style="color:${iconColor}">${I.power}</span></div>
      <div class="meta">
        <div class="k">
          <span class="name">${escapeHtml(r.name)}</span>
          ${copyButton("k:" + r.name, "Copy killswitch name")}
          ${overridden ? `<span class="override-tag">forced</span>` : ""}
        </div>
        <div class="v">${escapeHtml(desc)}</div>
      </div>
      ${val}${tog}
    </div>
    <div class="dtf-detail${isOpen ? " open" : ""}">
      <div class="inner"><div class="pad">${detail}</div></div>
    </div>`;
}

export async function renderKillswitchesPanel(
  container: HTMLElement,
  api: DevtoolsApi,
  view: ViewOpts,
  setOverrideCount: (n: number) => void,
): Promise<void> {
  container.innerHTML = loadingState();
  let switches: KillswitchRecord[];
  try {
    switches = await api.killswitches();
  } catch (err) {
    container.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed to load killswitches: ${escapeHtml(String(err))}</div>`;
    see(err).causes_the("killswitch list").to("fail to load");
    return;
  }

  if (switches.length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>killswitches</em> yet",
      message: "A killswitch turns a feature off for everyone, instantly, without a deploy.",
      actions: api.hideAdminLinks
        ? []
        : [
            {
              icon: "+",
              label: "Create new killswitch",
              href: `${api.adminUrl}/dashboard/${encodeURIComponent(api.projectId)}/killswitches`,
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
    const filtered = q ? switches.filter((k) => k.name.toLowerCase().includes(q)) : switches;
    const rows = filtered.map(buildKillswitchRow);
    setOverrideCount(rows.filter((r) => r.override !== null).length);

    if (rows.length === 0) {
      container.innerHTML = searchEmptyState(view.search);
      return;
    }

    // A killswitch is page-wide by nature, so "page" lists the ones currently
    // killed (what is changing behaviour here) and "all" lists everything.
    if (view.view === "page") {
      const killed = rows.filter((r) => r.effective);
      const live = rows.filter((r) => !r.effective);
      container.innerHTML =
        `<div class="dtf-group">Killed<span class="pulse"><span class="d"></span>${killed.length} killed</span></div>` +
        (killed.length
          ? killed.map((r) => renderRow(r, expanded)).join("")
          : `<div class="se-empty">Nothing is killed right now.</div>`) +
        (live.length
          ? `<div class="dtf-group">Live<span class="c">${live.length}</span></div>` +
            live.map((r) => renderRow(r, expanded)).join("")
          : "");
    } else {
      container.innerHTML =
        `<div class="dtf-group">All killswitches<span class="c">${rows.length}</span></div>` +
        rows.map((r) => renderRow(r, expanded)).join("");
    }

    container.querySelectorAll<HTMLElement>(".dtf-row").forEach((rowEl) => {
      rowEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".dtf-toggle") || target.closest(".dtf-copy")) return;
        const name = rowEl.dataset.row!;
        expanded = expanded === name ? null : name;
        paint();
      });
    });

    // Both the row toggle and the detail button force the opposite state; the
    // override rides ?se_ks_<name>= and reloads the page.
    const flip = (attr: string) => {
      container.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const name = el.getAttribute(attr)!;
          const r = rows.find((x) => x.name === name);
          if (r) setGateOverride(name, !r.effective);
        });
      });
    };
    flip("data-toggle");
    flip("data-toggle-detail");
    container.querySelectorAll<HTMLElement>("[data-clear-detail]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setGateOverride(el.getAttribute("data-clear-detail")!, null);
      });
    });

    wireCopyButtons(container, Object.fromEntries(rows.map((r) => ["k:" + r.name, () => r.name])));
  }

  paint();
}
