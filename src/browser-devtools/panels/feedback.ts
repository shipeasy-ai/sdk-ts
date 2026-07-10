import type { DevtoolsApi } from "../api";
import type {
  AttachmentRecord,
  BugDetail,
  BugPriority,
  BugRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  FeedbackConnectorData,
} from "../types";
import { I } from "../icons";
import { captureScreenshot, startRecording, type RecordingHandle } from "./capture";
import { createAnnotator } from "./annotator";
import { escapeHtml, fmtBytes, timeAgo, emptyState, loadingState } from "./common";

interface FeedbackHook {
  sub: "bugs" | "features";
  setSub: (s: "bugs" | "features") => void;
  /** Optional one-shot signal from the rail's quick-actions hovercard. When
   * set, the panel opens directly into the matching form instead of the list.
   * Cleared via `consumePendingForm` so re-renders don't re-trigger. */
  pendingForm?: "bug" | "feature" | null;
  consumePendingForm?: () => void;
}

export interface PendingAttachment {
  id: string;
  kind: "screenshot" | "recording" | "file";
  filename: string;
  blob: Blob;
  /** Object URL for screenshots/recordings, used both for the card thumb and
   * the lightbox preview. Created on attach, revoked when the user removes
   * the attachment or submits the form. */
  previewUrl?: string;
  duration?: number;
  progress?: number; // 0-100; undefined = uploaded
  error?: string;
}

// Bugs and feature requests share one status set and one priority set, so the
// feature-request maps below are just aliases of the bug ones.
const BUG_STATUS_CLS: Record<BugRecord["status"], string> = {
  open: "badge-run",
  // Public intake (/cli/report) force-files as pending_approval — style like
  // `open` so the queue reads naturally until a human approves/triages it.
  pending_approval: "badge-run",
  triaged: "badge-run",
  in_progress: "badge-run",
  ready_for_qa: "badge-run",
  resolved: "badge-on",
  wont_fix: "badge-off",
};
const FR_STATUS_CLS: Record<FeatureRequestRecord["status"], string> = BUG_STATUS_CLS;
const BUG_PRI_CLS: Record<NonNullable<BugRecord["priority"]>, string> = {
  critical: "badge-warn",
  high: "badge-warn",
  medium: "badge-run",
  nice_to_have: "badge-draft",
};
const FR_IMP_CLS = BUG_PRI_CLS;

// Terminal statuses the "active" filter hides, per sub.
const BUG_TERMINAL_STATUSES: ReadonlyArray<string> = ["resolved"];
const FR_TERMINAL_STATUSES = BUG_TERMINAL_STATUSES;
// Ordered status list per sub (drives the multiselect filter dropdown). Derived
// from the badge maps so the order + membership stay in lockstep with them.
const BUG_STATUSES: ReadonlyArray<string> = Object.keys(BUG_STATUS_CLS);
const FR_STATUSES: ReadonlyArray<string> = Object.keys(FR_STATUS_CLS);
// The "Active" quick-pick set: every status except the terminal ones. This is
// also the default selection, preserving the old "active hides resolved" view.
const BUG_ACTIVE_STATUSES: ReadonlyArray<string> = BUG_STATUSES.filter(
  (s) => !BUG_TERMINAL_STATUSES.includes(s),
);
const FR_ACTIVE_STATUSES: ReadonlyArray<string> = FR_STATUSES.filter(
  (s) => !FR_TERMINAL_STATUSES.includes(s),
);

// Resolved ("closed") reports are dropped on fetch — devtools never loads,
// counts, or lists them. Triage happens here; finished work belongs in the
// dashboard. Applied to every fetched list so the tab counts and the rows
// stay in lockstep (no resolved item inflates a count it can't be seen in).
function dropTerminal<T extends { status: string }>(
  rows: T[],
  terminal: ReadonlyArray<string>,
): T[] {
  return rows.filter((r) => !terminal.includes(r.status));
}

// The linked GitHub PR, if the ops loop opened one (stored on the report's
// connector_data). Rendered in the detail toprow next to the Page link so the
// reporter can jump straight to the fix.
function prLinkHtml(cd: FeedbackConnectorData | null | undefined): string {
  const pr = cd?.github?.pr;
  if (!pr?.url) return "";
  return `<a class="se-fb-link se-fb-pr" target="_blank" rel="noopener" href="${escapeHtml(pr.url)}">${I.gitPr} PR #${pr.number}</a>`;
}

// Persist the per-sub status-filter selection so a reload restores whatever
// the user was triaging on, instead of resetting to the "active" default.
const FEEDBACK_STATUS_FILTER_KEY = "se_l_fb_status_filter";

function loadStatusFilter(defaults: {
  bugs: ReadonlyArray<string>;
  features: ReadonlyArray<string>;
}): { bugs: Set<string>; features: Set<string> } {
  try {
    const raw = localStorage.getItem(FEEDBACK_STATUS_FILTER_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { bugs?: string[]; features?: string[] };
      return {
        bugs: new Set(Array.isArray(saved.bugs) ? saved.bugs : defaults.bugs),
        features: new Set(Array.isArray(saved.features) ? saved.features : defaults.features),
      };
    }
  } catch {
    /* ignore */
  }
  return { bugs: new Set(defaults.bugs), features: new Set(defaults.features) };
}

function saveStatusFilter(filter: { bugs: Set<string>; features: Set<string> }): void {
  try {
    localStorage.setItem(
      FEEDBACK_STATUS_FILTER_KEY,
      JSON.stringify({ bugs: [...filter.bugs], features: [...filter.features] }),
    );
  } catch {
    /* ignore */
  }
}

function fieldBlock(label: string, value: string | null | undefined): string {
  if (!value || !value.trim()) return "";
  return `<div class="se-fb-section">
    <div class="lbl">${escapeHtml(label)}</div>
    <div class="se-fb-block">${escapeHtml(value)}</div>
  </div>`;
}

function badge(label: string, cls: string): string {
  return `<span class="badge ${cls}">${escapeHtml(label.replace(/_/g, " "))}</span>`;
}

interface BadgeOption<T extends string> {
  value: T;
  cls: string;
  label?: string;
}

// The shared fields the unified feedback list renders. Both BugRecord and
// FeatureRequestRecord satisfy this (each adds its own type-specific fields,
// surfaced via the per-sub FeedbackListCfg).
interface FeedbackListItem {
  id: string;
  title: string;
  createdAt: string;
  reporterEmail: string | null;
  pageUrl: string | null;
  status: string;
  connectorData?: FeedbackConnectorData | null;
}

// Attach a click-to-edit dropdown to a badge container. `slot` is the element
// holding the current badge; clicking it opens an inline option strip with
// every alternative as a badge. Picking one calls `onPick`, swaps the
// current badge optimistically, and closes. Click-outside closes without
// applying. Stops propagation so the parent row's expand toggle is unaffected.
function attachBadgeDropdown<T extends string>(
  slot: HTMLElement,
  opts: {
    current: T;
    options: ReadonlyArray<BadgeOption<T>>;
    onPick: (next: T) => Promise<void> | void;
  },
): void {
  slot.classList.add("se-bdrop");
  slot.setAttribute("role", "button");
  slot.setAttribute("tabindex", "0");
  slot.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu();
  });

  function renderCurrent(value: T): void {
    const opt = opts.options.find((o) => o.value === value);
    if (!opt) return;
    slot.innerHTML = badge(opt.label ?? value, opt.cls) + `<span class="se-bdrop-caret">▾</span>`;
  }

  function openMenu(): void {
    if (slot.dataset.open === "1") return;
    slot.dataset.open = "1";
    const menu = document.createElement("div");
    menu.className = "se-bdrop-menu";
    menu.setAttribute("role", "listbox");
    menu.addEventListener("click", (ev) => ev.stopPropagation());
    for (const o of opts.options) {
      const row = document.createElement("button");
      const isCurrent = o.value === opts.current;
      row.type = "button";
      row.className = `se-bdrop-item${isCurrent ? " is-current" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", isCurrent ? "true" : "false");
      row.innerHTML = `<span class="se-bdrop-check" aria-hidden="true">${isCurrent ? "✓" : ""}</span><span class="badge ${o.cls}">${escapeHtml((o.label ?? o.value).replace(/_/g, " "))}</span>`;
      row.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        close();
        if (o.value === opts.current) return;
        opts.current = o.value;
        renderCurrent(o.value);
        try {
          await opts.onPick(o.value);
        } catch (err) {
          console.error("Failed to update", err);
        }
      });
      menu.appendChild(row);
    }
    slot.appendChild(menu);
    const onDoc = (ev: Event) => {
      if (!menu.contains(ev.target as Node) && ev.target !== slot) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    function close(): void {
      menu.remove();
      delete slot.dataset.open;
      document.removeEventListener("click", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    }
    setTimeout(() => {
      document.addEventListener("click", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }
}

// Attach the status-filter dropdown to a trigger element. Unlike
// `attachBadgeDropdown` this is multiselect: clicking a status toggles its
// membership in `selected` and re-filters the list in place (via `onChange`)
// WITHOUT closing the menu, so several statuses can be picked in one open.
// `selected` is mutated directly; an empty or full set means "no filter"
// (show everything). Two quick rows seed common sets: "All statuses" clears
// the set, "Active" selects every non-terminal status.
function attachStatusFilterDropdown(
  slot: HTMLElement,
  opts: {
    statuses: ReadonlyArray<string>;
    statusCls: Record<string, string>;
    activePreset: ReadonlyArray<string>;
    selected: Set<string>;
    onChange: () => void;
  },
): void {
  slot.setAttribute("role", "button");
  slot.setAttribute("tabindex", "0");
  slot.setAttribute("aria-haspopup", "listbox");
  slot.setAttribute("aria-label", "Filter by status");
  slot.innerHTML = `<span class="se-fb-filter-label"></span><span class="se-bdrop-caret">▾</span>`;
  const labelEl = slot.querySelector<HTMLElement>(".se-fb-filter-label")!;

  function isShowingAll(): boolean {
    return opts.selected.size === 0 || opts.selected.size === opts.statuses.length;
  }
  function isActivePreset(): boolean {
    return (
      opts.selected.size === opts.activePreset.length &&
      opts.activePreset.every((s) => opts.selected.has(s))
    );
  }
  function renderTrigger(): void {
    labelEl.textContent = isShowingAll()
      ? "All statuses"
      : isActivePreset()
        ? "Active"
        : `${opts.selected.size} selected`;
  }
  renderTrigger();

  let menu: HTMLDivElement | null = null;
  function close(): void {
    menu?.remove();
    menu = null;
    delete slot.dataset.open;
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onDoc(ev: Event): void {
    if (!menu) return;
    // The overlay lives in a shadow root, so a document-level listener sees a
    // retargeted `ev.target` (the shadow host) — `menu.contains()` would always
    // be false and close the menu on every in-menu click. `composedPath()`
    // crosses the shadow boundary and lists the real nodes, so an outside click
    // is "menu + slot are both absent from the path".
    const path = ev.composedPath();
    if (!path.includes(menu) && !path.includes(slot)) close();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") close();
  }

  function afterChange(): void {
    renderTrigger();
    renderMenu();
    opts.onChange();
  }
  function renderMenu(): void {
    if (!menu) return;
    const showingAll = isShowingAll();
    const presetActive = isActivePreset();
    const quick = (key: string, label: string, on: boolean) =>
      `<button type="button" class="se-bdrop-item se-fb-quick${on ? " is-current" : ""}" data-quick="${key}">
        <span class="se-bdrop-check" aria-hidden="true">${on ? "✓" : ""}</span><span class="se-fb-quick-label">${label}</span>
      </button>`;
    menu.innerHTML =
      quick("all", "All statuses", showingAll) +
      quick("active", "Active", presetActive) +
      `<div class="se-bdrop-sep" role="separator"></div>` +
      opts.statuses
        .map((s) => {
          const on = opts.selected.has(s);
          return `<button type="button" class="se-bdrop-item${on ? " is-current" : ""}" role="option" aria-selected="${on}" data-status-opt="${escapeHtml(s)}">
            <span class="se-bdrop-check" aria-hidden="true">${on ? "✓" : ""}</span><span class="badge ${opts.statusCls[s]}">${escapeHtml(s.replace(/_/g, " "))}</span>
          </button>`;
        })
        .join("");
    menu.querySelector('[data-quick="all"]')!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      opts.selected.clear();
      afterChange();
    });
    menu.querySelector('[data-quick="active"]')!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      opts.selected.clear();
      opts.activePreset.forEach((s) => opts.selected.add(s));
      afterChange();
    });
    menu.querySelectorAll<HTMLElement>("[data-status-opt]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const s = btn.dataset.statusOpt!;
        if (opts.selected.has(s)) opts.selected.delete(s);
        else opts.selected.add(s);
        afterChange();
      });
    });
  }
  function open(): void {
    if (slot.dataset.open === "1") return;
    slot.dataset.open = "1";
    menu = document.createElement("div");
    menu.className = "se-bdrop-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-multiselectable", "true");
    menu.addEventListener("click", (ev) => ev.stopPropagation());
    renderMenu();
    slot.appendChild(menu);
    setTimeout(() => {
      document.addEventListener("click", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  slot.addEventListener("click", (e) => {
    e.stopPropagation();
    if (slot.dataset.open === "1") close();
    else open();
  });
  slot.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (slot.dataset.open === "1") close();
      else open();
    }
  });
}

export async function renderFeedbackPanel(
  container: HTMLElement,
  api: DevtoolsApi,
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  hook: FeedbackHook,
): Promise<void> {
  const shadow = container.getRootNode() as ShadowRoot;

  // Panel-local form mode: when a user clicks "+ File a bug" / "+ Request a
  // feature" we replace the list with the form inline (no modal).  `null`
  // = list view.  The Back / Cancel button on the form flips this back.
  let formMode: "bug" | "feature" | null = null;

  // When the user clicks "Edit" on a row we reuse that type's form (the same
  // one used for creation) prefilled with the detail. `null` = the form is in
  // create mode. Cleared alongside `formMode` when the form closes.
  let editBug: BugDetail | null = null;
  let editFeature: FeatureRequestDetail | null = null;

  // Per-sub list status filter: the set of statuses to show. An empty or full
  // set means "no filter" (show everything). The default is the "active" preset
  // (every status except terminal/resolved) — what users usually want when
  // triaging. Panel-scoped so the selection survives sub-tab switches.
  const statusFilter: { bugs: Set<string>; features: Set<string> } = loadStatusFilter({
    bugs: BUG_ACTIVE_STATUSES,
    features: FR_ACTIVE_STATUSES,
  });

  // Quick client-side title search. Filters the already-fetched list by
  // title substring (case-insensitive) without hitting the network. Kept at
  // panel scope so it survives re-paints; the last fetched lists are cached
  // here too so typing re-filters in place (no refetch, input keeps focus).
  let searchQuery = "";
  let lastBugs: BugRecord[] | null = null;
  let lastFeatures: FeatureRequestRecord[] | null = null;

  // Caches for the expanded-row attachment preview. paint() rebuilds the DOM
  // on every expand/collapse, so we keep state at panel scope so that:
  //  - the bug/feature detail (incl. attachment list) is fetched once per id
  //  - the attachment Blob is fetched once per attachment id, with the
  //    resulting object URL reused for thumbnails AND lightbox preview.
  // Object URLs intentionally aren't revoked here — they're cheap and the
  // panel is short-lived; revoking on row collapse would re-download on
  // re-expand which feels worse than a small leak.
  const detailCache = new Map<string, Promise<BugDetail | FeatureRequestDetail>>();
  const attachmentUrlCache = new Map<string, Promise<string>>();
  function ensureBugDetail(id: string): Promise<BugDetail> {
    let p = detailCache.get(id) as Promise<BugDetail> | undefined;
    if (!p) {
      p = api.bug(id);
      detailCache.set(id, p);
    }
    return p;
  }
  function ensureFeatureDetail(id: string): Promise<FeatureRequestDetail> {
    let p = detailCache.get(id) as Promise<FeatureRequestDetail> | undefined;
    if (!p) {
      p = api.featureRequest(id);
      detailCache.set(id, p);
    }
    return p;
  }
  function ensureAttachmentUrl(attachmentId: string): Promise<string> {
    let p = attachmentUrlCache.get(attachmentId);
    if (!p) {
      p = api.attachmentBlob(attachmentId).then((blob) => URL.createObjectURL(blob));
      attachmentUrlCache.set(attachmentId, p);
    }
    return p;
  }

  // Honour a one-shot pending form request from the rail hovercard. Clear it
  // so re-renders (e.g. after submit) drop back to the list view. The caller
  // is responsible for syncing `sub` to the matching form before render.
  if (hook.pendingForm) {
    formMode = hook.pendingForm;
    hook.consumePendingForm?.();
  }

  async function render(): Promise<void> {
    if (formMode === "bug") {
      const editing = editBug;
      mountBugForm(
        container,
        api,
        modalRoot,
        shadow,
        () => {
          formMode = null;
          editBug = null;
          // Drop the cached detail (and its list) for the edited bug so the
          // row re-fetches fresh text/priority next time it's expanded.
          if (editing) detailCache.delete(editing.id);
          void render();
        },
        editing,
      );
      return;
    }
    if (formMode === "feature") {
      const editing = editFeature;
      mountFeatureForm(
        container,
        api,
        modalRoot,
        shadow,
        () => {
          formMode = null;
          editFeature = null;
          // Drop the cached detail (and its list) for the edited request so the
          // row re-fetches fresh text/priority next time it's expanded.
          if (editing) detailCache.delete(editing.id);
          void render();
        },
        editing,
      );
      return;
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    container.innerHTML = `
      <div class="se-fb-subtabs">
        <button class="${hook.sub === "bugs" ? "active" : ""}" data-sub="bugs">${I.bug} Bugs <span class="c">…</span></button>
        <button class="${hook.sub === "features" ? "active" : ""}" data-sub="features">${I.sparkles} Feature requests <span class="c">…</span></button>
      </div>
      <div class="se-feedback-head">
        <button class="ibtn pri" data-action="file">+ ${hook.sub === "bugs" ? "File a bug" : "Feature"}</button>
        <input class="se-input se-fb-search" data-fb-search type="search"
          placeholder="Search ${hook.sub === "bugs" ? "bugs" : "feature requests"}…"
          aria-label="Search by title" value="${escapeHtml(searchQuery)}" />
        <span class="se-fb-filter-drop" data-status-filter></span>
        <span class="grow"></span>
        ${
          api.hideAdminLinks
            ? ""
            : `<a class="ibtn" target="_blank" rel="noopener" href="${escapeHtml(api.adminUrl)}/dashboard/${hook.sub === "bugs" ? "bugs" : "feature-requests"}">${I.external} Open dashboard</a>`
        }
      </div>
      <div class="se-feedback-list" data-list></div>`;

    container.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((btn) => {
      btn.addEventListener("click", () => hook.setSub(btn.dataset.sub as "bugs" | "features"));
    });
    container.querySelector('[data-action="file"]')!.addEventListener("click", () => {
      formMode = hook.sub === "bugs" ? "bug" : "feature";
      void render();
    });
    const filterSlot = container.querySelector<HTMLElement>("[data-status-filter]");
    if (filterSlot) {
      attachStatusFilterDropdown(filterSlot, {
        // Resolved is never loaded, so it never appears as a filter option.
        statuses: hook.sub === "bugs" ? BUG_ACTIVE_STATUSES : FR_ACTIVE_STATUSES,
        statusCls: hook.sub === "bugs" ? BUG_STATUS_CLS : FR_STATUS_CLS,
        activePreset: hook.sub === "bugs" ? BUG_ACTIVE_STATUSES : FR_ACTIVE_STATUSES,
        selected: statusFilter[hook.sub],
        // Re-filter the cached list in place — no refetch, and the menu stays
        // open so multiple statuses can be toggled in one go.
        onChange: () => {
          saveStatusFilter(statusFilter);
          const list = container.querySelector<HTMLElement>("[data-list]");
          if (!list) return;
          if (hook.sub === "bugs") {
            if (lastBugs) renderList(list, lastBugs, bugListCfg());
          } else if (lastFeatures) {
            renderList(list, lastFeatures, featureListCfg());
          }
        },
      });
    }
    // Live title search re-filters the cached list in place — no refetch, so
    // the input keeps focus while typing. Falls back to a no-op until the
    // first fetch populates the cache.
    container
      .querySelector<HTMLInputElement>("[data-fb-search]")
      ?.addEventListener("input", (ev) => {
        searchQuery = (ev.target as HTMLInputElement).value;
        const list = container.querySelector<HTMLElement>("[data-list]");
        if (!list) return;
        if (hook.sub === "bugs") {
          if (lastBugs) renderList(list, lastBugs, bugListCfg());
        } else if (lastFeatures) {
          renderList(list, lastFeatures, featureListCfg());
        }
      });

    const listEl = container.querySelector<HTMLElement>("[data-list]")!;
    listEl.innerHTML = loadingState();

    if (hook.sub === "bugs") {
      let items: BugRecord[];
      try {
        items = dropTerminal(await api.bugs(), BUG_TERMINAL_STATUSES);
      } catch (err) {
        listEl.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed: ${escapeHtml(String(err))}</div>`;
        return;
      }
      // Update count badge
      const cBadge = container.querySelector<HTMLElement>('[data-sub="bugs"] .c')!;
      cBadge.textContent = String(items.length);
      const cBadgeOther = container.querySelector<HTMLElement>('[data-sub="features"] .c')!;
      try {
        const fr = dropTerminal(await api.featureRequests(), FR_TERMINAL_STATUSES);
        cBadgeOther.textContent = String(fr.length);
      } catch {
        cBadgeOther.textContent = "?";
      }
      lastBugs = items;
      renderList(listEl, items, bugListCfg());
    } else {
      let items: FeatureRequestRecord[];
      try {
        items = dropTerminal(await api.featureRequests(), FR_TERMINAL_STATUSES);
      } catch (err) {
        listEl.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed: ${escapeHtml(String(err))}</div>`;
        return;
      }
      const cBadge = container.querySelector<HTMLElement>('[data-sub="features"] .c')!;
      cBadge.textContent = String(items.length);
      const cBadgeOther = container.querySelector<HTMLElement>('[data-sub="bugs"] .c')!;
      try {
        const bs = dropTerminal(await api.bugs(), BUG_TERMINAL_STATUSES);
        cBadgeOther.textContent = String(bs.length);
      } catch {
        cBadgeOther.textContent = "?";
      }
      lastFeatures = items;
      renderList(listEl, items, featureListCfg());
    }
  }

  // Per-sub descriptor consumed by the shared `renderList`. Captures every
  // place bugs and feature requests diverge — the status/secondary badges, the
  // text fields, the dashboard path, and the Edit handler — so the row + detail
  // markup and all the wiring live in one place ("same table, similar fields").
  interface FeedbackListCfg<T extends FeedbackListItem> {
    sub: "bugs" | "features";
    nounPlural: string; // "bugs" | "feature requests"
    dashboardPath: string; // "bugs" | "feature-requests"
    emptyMessage: string;
    statusOptions: ReadonlyArray<BadgeOption<string>>;
    statusCls: Record<string, string>;
    applyStatus: (item: T, next: string) => Promise<void>;
    // Secondary badge: the shared priority field (bugs + features). `html` seeds
    // the row slot; `wire` attaches the click-to-edit dropdown.
    secondaryHtml: (item: T) => string;
    wireSecondary: (slot: HTMLElement, item: T) => void;
    hydrateText: (slot: HTMLElement, id: string) => void;
    hydrateAttach: (slot: HTMLElement, id: string) => void;
    openEdit: (id: string) => Promise<void>;
  }

  function renderList<T extends FeedbackListItem>(
    listEl: HTMLElement,
    all: T[],
    cfg: FeedbackListCfg<T>,
  ): void {
    const selected = statusFilter[cfg.sub];
    // An empty or full selection means "no filter" — show everything.
    const isFiltering = selected.size > 0 && selected.size < Object.keys(cfg.statusCls).length;
    // Newest first, then keep only the selected statuses (when filtering).
    let items = [...all].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    if (isFiltering) items = items.filter((it) => selected.has(it.status));
    const query = searchQuery.trim().toLowerCase();
    if (query) items = items.filter((it) => it.title.toLowerCase().includes(query));

    if (items.length === 0) {
      if (query) {
        listEl.innerHTML = `<div class="se-empty">No ${cfg.nounPlural} match <em>${escapeHtml(searchQuery.trim())}</em>.</div>`;
        return;
      }
      // The project has items but the status filter excluded them all.
      if (all.length > 0) {
        listEl.innerHTML = `<div class="se-empty">No ${cfg.nounPlural} match the selected statuses.</div>`;
        return;
      }
      // Genuinely empty project → onboarding card.
      const { html, wire } = emptyState({
        title: `No <em>${cfg.nounPlural}</em> yet`,
        message: cfg.emptyMessage,
        actions: [
          {
            icon: "+",
            label: cfg.sub === "bugs" ? "File a bug" : "Feature",
            onClick: () => {
              formMode = cfg.sub === "bugs" ? "bug" : "feature";
              void render();
            },
          },
          ...(api.hideAdminLinks
            ? []
            : [
                { label: "Open dashboard", href: `${api.adminUrl}/dashboard/${cfg.dashboardPath}` },
              ]),
        ],
      });
      listEl.innerHTML = html;
      wire(listEl);
      return;
    }

    const expanded = new Set<string>();
    const paint = () => {
      listEl.innerHTML = items
        .map(
          (it) => `
          <div class="se-feedback-row${expanded.has(it.id) ? " expanded" : ""}" data-id="${escapeHtml(it.id)}">
            <span class="chev">▸</span>
            <div class="grow">
              <div class="row-name">${escapeHtml(it.title)}</div>
              <div class="row-sub">${escapeHtml(timeAgo(it.createdAt))}${it.reporterEmail ? " · " + escapeHtml(it.reporterEmail) : ""}</div>
            </div>
            <span class="se-bdrop-slot" data-secondary="${escapeHtml(it.id)}">${cfg.secondaryHtml(it)}</span>
            <span class="se-bdrop-slot" data-status="${escapeHtml(it.id)}">${badge(it.status, cfg.statusCls[it.status])}<span class="se-bdrop-caret">▾</span></span>
          </div>
          <div class="se-feedback-detail${expanded.has(it.id) ? " open" : ""}">
            <div class="inner"><div class="pad">
              <div class="se-fb-toprow">
                ${
                  it.pageUrl
                    ? `<a class="se-fb-link" target="_blank" rel="noopener" href="${escapeHtml(it.pageUrl)}">Page ${I.external}</a>`
                    : ""
                }
                ${prLinkHtml(it.connectorData)}
                <button class="ibtn se-fb-edit" data-edit="${escapeHtml(it.id)}">${I.pencil} Edit</button>
              </div>
              <div class="se-text-slot" data-text-slot="${escapeHtml(it.id)}"></div>
              <div class="se-attach-slot" data-attach-slot="${escapeHtml(it.id)}"></div>
              ${
                api.hideAdminLinks
                  ? ""
                  : `<div class="se-fb-actions">
                <a class="ibtn pri" target="_blank" rel="noopener" href="${escapeHtml(api.adminUrl)}/dashboard/${cfg.dashboardPath}/${escapeHtml(it.id)}">${I.external} Open in dashboard</a>
              </div>`
              }
            </div></div>
          </div>`,
        )
        .join("");
      listEl.querySelectorAll<HTMLElement>("[data-id]").forEach((row) => {
        row.addEventListener("click", () => {
          const id = row.dataset.id!;
          if (expanded.has(id)) expanded.delete(id);
          else expanded.add(id);
          paint();
        });
      });

      // Status + secondary dropdowns on every row (collapsed + expanded).
      listEl.querySelectorAll<HTMLElement>("[data-status]").forEach((slot) => {
        const item = items.find((x) => x.id === slot.dataset.status);
        if (!item) return;
        attachBadgeDropdown(slot, {
          current: item.status,
          options: cfg.statusOptions,
          onPick: (next) => cfg.applyStatus(item, next),
        });
      });
      listEl.querySelectorAll<HTMLElement>("[data-secondary]").forEach((slot) => {
        const item = items.find((x) => x.id === slot.dataset.secondary);
        if (item) cfg.wireSecondary(slot, item);
      });

      // Lazy-load text + attachments and wire Edit for any expanded rows.
      for (const id of expanded) {
        const tSlot = listEl.querySelector<HTMLElement>(`[data-text-slot="${id}"]`);
        if (tSlot) cfg.hydrateText(tSlot, id);
        const aSlot = listEl.querySelector<HTMLElement>(`[data-attach-slot="${id}"]`);
        if (aSlot) cfg.hydrateAttach(aSlot, id);
        const editBtn = listEl.querySelector<HTMLElement>(`[data-edit="${id}"]`);
        editBtn?.addEventListener("click", (e) => {
          e.stopPropagation();
          void cfg.openEdit(id);
        });
      }
    };
    paint();
  }

  function bugListCfg(): FeedbackListCfg<BugRecord> {
    return {
      sub: "bugs",
      nounPlural: "bugs",
      dashboardPath: "bugs",
      emptyMessage:
        "Spotted something off on this page? File a bug with a screenshot or recording.",
      statusCls: BUG_STATUS_CLS,
      statusOptions: (Object.keys(BUG_STATUS_CLS) as BugRecord["status"][]).map((v) => ({
        value: v,
        cls: BUG_STATUS_CLS[v],
      })),
      applyStatus: async (b, next) => {
        b.status = next as BugRecord["status"];
        await api.updateBug(b.id, { status: b.status });
      },
      secondaryHtml: (b) => {
        const v = b.priority ?? "";
        const cls = v ? BUG_PRI_CLS[v] : "badge-off";
        return badge(v || "unset", cls) + `<span class="se-bdrop-caret">▾</span>`;
      },
      wireSecondary: (slot, b) => {
        attachBadgeDropdown(slot, {
          current: b.priority ?? "",
          options: [
            { value: "", cls: "badge-off", label: "unset" },
            { value: "nice_to_have", cls: BUG_PRI_CLS.nice_to_have },
            { value: "medium", cls: BUG_PRI_CLS.medium },
            { value: "high", cls: BUG_PRI_CLS.high },
            { value: "critical", cls: BUG_PRI_CLS.critical },
          ],
          onPick: async (next) => {
            b.priority = (next || null) as BugRecord["priority"];
            await api.updateBug(b.id, { priority: b.priority });
          },
        });
      },
      hydrateText: (slot, id) => hydrateBugTextSlot(slot, ensureBugDetail(id)),
      hydrateAttach: (slot, id) => hydrateAttachmentSlot(slot, ensureBugDetail(id)),
      openEdit: async (id) => {
        editBug = await ensureBugDetail(id);
        formMode = "bug";
        void render();
      },
    };
  }

  function featureListCfg(): FeedbackListCfg<FeatureRequestRecord> {
    return {
      sub: "features",
      nounPlural: "feature requests",
      dashboardPath: "feature-requests",
      emptyMessage: "Capture asks from the field with priority, status, and a clean trail.",
      statusCls: FR_STATUS_CLS,
      statusOptions: (Object.keys(FR_STATUS_CLS) as FeatureRequestRecord["status"][]).map((v) => ({
        value: v,
        cls: FR_STATUS_CLS[v],
      })),
      applyStatus: async (f, next) => {
        f.status = next as FeatureRequestRecord["status"];
        await api.updateFeatureRequest(f.id, { status: f.status });
      },
      secondaryHtml: (f) => {
        const v = f.priority ?? "";
        const cls = v ? FR_IMP_CLS[v] : "badge-off";
        return badge(v || "unset", cls) + `<span class="se-bdrop-caret">▾</span>`;
      },
      wireSecondary: (slot, f) => {
        attachBadgeDropdown(slot, {
          current: f.priority ?? "",
          options: [
            { value: "", cls: "badge-off", label: "unset" },
            { value: "nice_to_have", cls: FR_IMP_CLS.nice_to_have },
            { value: "medium", cls: FR_IMP_CLS.medium },
            { value: "high", cls: FR_IMP_CLS.high },
            { value: "critical", cls: FR_IMP_CLS.critical },
          ],
          onPick: async (next) => {
            f.priority = (next || null) as FeatureRequestRecord["priority"];
            await api.updateFeatureRequest(f.id, { priority: f.priority });
          },
        });
      },
      hydrateText: (slot, id) => hydrateFeatureTextSlot(slot, ensureFeatureDetail(id)),
      hydrateAttach: (slot, id) => hydrateAttachmentSlot(slot, ensureFeatureDetail(id)),
      openEdit: async (id) => {
        editFeature = await ensureFeatureDetail(id);
        formMode = "feature";
        void render();
      },
    };
  }

  function hydrateBugTextSlot(slot: HTMLElement, detailPromise: Promise<BugDetail>): void {
    if (slot.dataset.hydrated === "1") return;
    slot.dataset.hydrated = "1";
    slot.innerHTML = `<div class="se-attach-slot-loading">Loading details…</div>`;
    detailPromise
      .then((d) => {
        if (!slot.isConnected) return;
        const parts: string[] = [
          fieldBlock("Steps to reproduce", d.stepsToReproduce),
          fieldBlock("Actual result", d.actualResult),
          fieldBlock("Expected result", d.expectedResult),
        ];
        slot.innerHTML = parts.filter(Boolean).join("");
      })
      .catch((err) => {
        if (!slot.isConnected) return;
        slot.innerHTML = `<div class="se-attach-slot-loading err">Failed: ${escapeHtml(String(err))}</div>`;
      });
  }

  function hydrateFeatureTextSlot(
    slot: HTMLElement,
    detailPromise: Promise<FeatureRequestDetail>,
  ): void {
    if (slot.dataset.hydrated === "1") return;
    slot.dataset.hydrated = "1";
    slot.innerHTML = `<div class="se-attach-slot-loading">Loading details…</div>`;
    detailPromise
      .then((d) => {
        if (!slot.isConnected) return;
        const parts: string[] = [
          fieldBlock("What would it do?", d.description),
          fieldBlock("Use case", d.useCase),
        ];
        slot.innerHTML = parts.filter(Boolean).join("");
      })
      .catch((err) => {
        if (!slot.isConnected) return;
        slot.innerHTML = `<div class="se-attach-slot-loading err">Failed: ${escapeHtml(String(err))}</div>`;
      });
  }

  // Renders the attachments grid into a row's expanded detail. The detail
  // promise is shared (panel-scoped cache); on resolve we paint thumbnails
  // and lazy-fetch each blob on demand so list view doesn't pay the cost
  // until a row is opened.
  function hydrateAttachmentSlot(
    slot: HTMLElement,
    detailPromise: Promise<{ attachments: AttachmentRecord[] }>,
  ): void {
    if (slot.dataset.hydrated === "1") return;
    slot.dataset.hydrated = "1";
    slot.innerHTML = `<div class="se-attach-slot-loading">Loading attachments…</div>`;
    detailPromise
      .then((d) => {
        if (!slot.isConnected) return;
        if (d.attachments.length === 0) {
          slot.innerHTML = "";
          return;
        }
        slot.innerHTML = `<div class="se-attach-grid">${d.attachments
          .map(serverAttachmentCardHtml)
          .join("")}</div>`;
        // Kick off thumbnail fetches for screenshots — recordings just show
        // a play icon, no auto-fetch (would download every video on open).
        slot.querySelectorAll<HTMLElement>("[data-thumb-fetch]").forEach((el) => {
          const aid = el.dataset.thumbFetch!;
          ensureAttachmentUrl(aid)
            .then((url) => {
              if (!el.isConnected) return;
              el.style.backgroundImage = `url('${url}')`;
              el.classList.add("has-image");
            })
            .catch(() => {
              /* keep placeholder */
            });
        });
        // Wire click → fetch blob (cached) → openLightbox
        slot.querySelectorAll<HTMLElement>("[data-preview-id]").forEach((el) => {
          el.addEventListener("click", async (e) => {
            e.stopPropagation();
            const aid = el.dataset.previewId!;
            const att = d.attachments.find((x) => x.id === aid);
            if (!att) return;
            try {
              const url = await ensureAttachmentUrl(aid);
              openLightbox(modalRoot, {
                kind: att.kind,
                filename: att.filename,
                url,
                sizeBytes: att.sizeBytes,
              });
            } catch (err) {
              console.error(err);
            }
          });
        });
      })
      .catch((err) => {
        if (!slot.isConnected) return;
        slot.innerHTML = `<div class="se-attach-slot-loading err">Failed: ${escapeHtml(String(err))}</div>`;
      });
  }

  await render();
}

// ── Inline form scaffold ────────────────────────────────────────────────────
//
// Bug + feature forms render inline inside the feedback panel container,
// not as floating modals. The scaffold below lays out the same header /
// body / footer as the old modal but as a normal element tree, so the
// panel rail and footer stay visible while the user is filling out the
// form. `onCancel` is invoked when the user discards or hits Back.
function mountInlineForm(
  container: HTMLElement,
  opts: {
    title: string;
    bodyHtml: string;
    isDirty: () => boolean;
    onSubmit: () => Promise<void> | void;
    onCancel: () => void;
  },
): { host: HTMLElement; close: () => void } {
  container.innerHTML = `
    <div class="dtf-inline-form">
      <div class="hd">
        <button class="back" data-action="cancel">${I.arrowLeft} Back</button>
        <span class="k" style="margin-left:8px">${escapeHtml(opts.title)}</span>
      </div>
      <div class="bd">${opts.bodyHtml}</div>
      <div class="ft">
        <span class="sp"></span>
        <button data-action="cancel">Cancel</button>
        <button class="primary" data-action="submit">Submit</button>
      </div>
    </div>`;
  const host = container.querySelector<HTMLElement>(".dtf-inline-form")!;

  let askDiscard = false;
  const tryClose = () => {
    if (!opts.isDirty()) return doClose();
    if (askDiscard) return doClose();
    askDiscard = true;
    const banner = document.createElement("div");
    banner.className = "dtf-discard";
    banner.innerHTML = `${I.alert}<span>Discard your changes?</span><span style="flex:1"></span>
      <button class="ibtn" data-action="keep">Keep editing</button>
      <button class="ibtn danger" data-action="discard">Discard</button>`;
    host.querySelector(".hd")!.after(banner);
    banner.querySelector('[data-action="keep"]')!.addEventListener("click", () => {
      banner.remove();
      askDiscard = false;
    });
    banner.querySelector('[data-action="discard"]')!.addEventListener("click", () => doClose());
  };
  const doClose = () => {
    document.removeEventListener("keydown", onKey);
    opts.onCancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") tryClose();
  };
  document.addEventListener("keydown", onKey);
  host.querySelectorAll('[data-action="cancel"]').forEach((b) => {
    b.addEventListener("click", () => tryClose());
  });
  host.querySelector('[data-action="submit"]')!.addEventListener("click", async () => {
    await opts.onSubmit();
  });
  return { host, close: doClose };
}

// ── Form modal infrastructure (annotator only) ──────────────────────────────

function openFormModal(
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  opts: {
    title: string;
    bodyHtml: string;
    isDirty: () => boolean;
    onSubmit: () => Promise<void> | void;
  },
): { wrap: HTMLElement; modal: HTMLElement; close: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "dtf-modal-bg";
  wrap.innerHTML = `
    <div class="dtf-modal lg">
      <div class="hd">
        <button class="back" data-action="close">${I.arrowLeft} Back</button>
        <span class="k" style="margin-left:8px">${escapeHtml(opts.title)}</span>
        <span style="flex:1"></span>
        <button class="x" data-action="close" title="Close (Esc)">${I.x}</button>
      </div>
      <div class="bd">${opts.bodyHtml}</div>
      <div class="ft">
        <span class="sp"></span>
        <button data-action="cancel">Cancel</button>
        <button class="primary" data-action="submit">Submit</button>
      </div>
    </div>`;
  modalRoot.appendChild(wrap);
  const modal = wrap.querySelector<HTMLElement>(".dtf-modal")!;

  let askDiscard = false;
  const tryClose = () => {
    if (!opts.isDirty()) return doClose();
    if (askDiscard) return doClose();
    askDiscard = true;
    const banner = document.createElement("div");
    banner.className = "dtf-discard";
    banner.innerHTML = `${I.alert}<span>Discard your changes?</span><span style="flex:1"></span>
      <button class="ibtn" data-action="keep">Keep editing</button>
      <button class="ibtn danger" data-action="discard">Discard</button>`;
    modal.querySelector(".hd")!.after(banner);
    banner.querySelector('[data-action="keep"]')!.addEventListener("click", () => {
      banner.remove();
      askDiscard = false;
    });
    banner.querySelector('[data-action="discard"]')!.addEventListener("click", () => doClose());
  };
  const doClose = () => {
    document.removeEventListener("keydown", onKey);
    wrap.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") tryClose();
  };
  document.addEventListener("keydown", onKey);
  modal.querySelectorAll('[data-action="close"], [data-action="cancel"]').forEach((b) => {
    b.addEventListener("click", () => tryClose());
  });
  modal.querySelector('[data-action="submit"]')!.addEventListener("click", async () => {
    await opts.onSubmit();
  });
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) tryClose();
  });
  return { wrap, modal, close: doClose };
}

// Read-only attachment card for an already-uploaded attachment shown in an
// expanded bug/feature row. Mirrors the layout of attachmentCardHtml minus
// the remove button and upload progress bar; the thumbnail's background
// image is filled in async after the blob fetches (see hydrateAttachmentSlot).
function serverAttachmentCardHtml(a: AttachmentRecord): string {
  const idAttr = escapeHtml(a.id);
  const previewable = a.kind === "screenshot" || a.kind === "recording";
  const previewHtml =
    a.kind === "screenshot"
      ? `<div class="preview screenshot" data-preview-id="${idAttr}" data-thumb-fetch="${idAttr}">
           <span class="scrim">click to preview</span>
         </div>`
      : a.kind === "recording"
        ? `<div class="preview recording" data-preview-id="${idAttr}">
             <div class="play">${I.playFilled}</div>
             <span class="scrim">click to play</span>
           </div>`
        : `<div class="preview file">${I.file}<span class="ext">.${escapeHtml(fileExt(a.filename))}</span></div>`;
  void previewable;
  const ic = a.kind === "screenshot" ? I.camera : a.kind === "recording" ? I.record : I.file;
  return `
    <div class="se-attach-card readonly">
      ${previewHtml}
      <div class="meta">
        <span class="ic">${ic}</span>
        <span class="name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
        <span class="size">${escapeHtml(fmtBytes(a.sizeBytes))}</span>
      </div>
    </div>`;
}

function attachmentCardHtml(a: PendingAttachment): string {
  const bg = a.previewUrl ? ` style="background-image:url('${a.previewUrl}')"` : "";
  const hasImg = a.previewUrl && (a.kind === "screenshot" || a.kind === "recording");
  const clickable = a.kind === "screenshot" || a.kind === "recording";
  const previewHtml =
    a.kind === "screenshot"
      ? `<div class="preview screenshot${hasImg ? " has-image" : ""}" data-preview="${escapeHtml(a.id)}"${bg}>
           ${clickable ? `<span class="scrim">click to preview</span>` : ""}
         </div>`
      : a.kind === "recording"
        ? `<div class="preview recording${hasImg ? " has-image" : ""}" data-preview="${escapeHtml(a.id)}"${bg}>
             <div class="play">${I.playFilled}</div>
             ${a.duration ? `<span class="dur">${fmtDuration(a.duration)}</span>` : ""}
             ${clickable ? `<span class="scrim">click to play</span>` : ""}
           </div>`
        : `<div class="preview file">${I.file}<span class="ext">.${escapeHtml(fileExt(a.filename))}</span></div>`;
  const progress =
    a.progress != null && a.progress < 100
      ? `<div class="progress"><div class="fill" style="width:${a.progress}%"></div></div>`
      : "";
  const ic = a.kind === "screenshot" ? I.camera : a.kind === "recording" ? I.record : I.file;
  return `
    <div class="se-attach-card" data-attach="${escapeHtml(a.id)}">
      ${previewHtml}
      ${progress}
      <button class="rm" data-remove="${escapeHtml(a.id)}" title="Remove">${I.x}</button>
      <div class="meta">
        <span class="ic">${ic}</span>
        <span class="name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
        <span class="size">${escapeHtml(fmtBytes(a.blob.size))}</span>
      </div>
    </div>`;
}

function openLightbox(
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  a: {
    kind: "screenshot" | "recording" | "file";
    filename: string;
    url: string;
    sizeBytes: number;
  },
): void {
  if (!a.url) return;
  const wrap = document.createElement("div");
  wrap.className = "dtf-lightbox";
  const isVideo = a.kind === "recording";
  wrap.innerHTML = `
    <div class="frame">
      <button class="x" data-action="close" title="Close (Esc)">${I.x}</button>
      ${
        isVideo
          ? `<video src="${a.url}" controls autoplay playsinline></video>`
          : `<img src="${a.url}" alt="${escapeHtml(a.filename)}" />`
      }
      <div class="cap">
        <span>${escapeHtml(a.filename)}</span>
        <span style="color:var(--fg-4)">·</span>
        <span style="color:var(--fg-4)">${escapeHtml(fmtBytes(a.sizeBytes))}</span>
      </div>
    </div>`;
  modalRoot.appendChild(wrap);
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || (e.target as HTMLElement).closest('[data-action="close"]')) {
      close();
    }
  });
}

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "file";
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Shared attachment field ──────────────────────────────────────────────────
//
// Screenshot / record / upload controls + the preview grid + a status line.
// Used identically by the bug and feature-request forms — both let a reporter
// attach a screenshot, a screen recording, or an arbitrary file. The `[data-
// status]` line doubles as the form's submit/error status (setStatus targets
// it), so each form embeds this block exactly once.
export const ATTACHMENTS_FIELD_HTML = `
      <div class="se-field">
        <span class="se-label">Attachments</span>
        <div class="se-actions">
          <button type="button" class="ibtn" data-action="screenshot">${I.camera} Screenshot</button>
          <button type="button" class="ibtn" data-action="record">${I.record} Record screen</button>
          <button type="button" class="ibtn" data-action="upload">${I.upload} Upload file</button>
          <input type="file" hidden data-action="file-input"/>
        </div>
        <div class="se-attach-grid" data-attach-grid></div>
        <div class="se-status" data-status></div>
      </div>`;

// Wire the attachment controls inside an already-mounted form. Owns the pending
// attachment list, the preview grid repaint, and the screenshot/record/upload
// capture flows. Returns the live `attachments` array (read at submit time to
// upload) and a `revokeAllPreviews` cleanup the caller invokes on cancel/submit
// to release object URLs. Must be called after the form DOM exists so the
// buttons/grid are present.
export function wireAttachments(
  modal: HTMLElement,
  shadow: ShadowRoot,
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  setStatus: (msg: string, err?: boolean) => void,
): { attachments: PendingAttachment[]; revokeAllPreviews: () => void } {
  const attachments: PendingAttachment[] = [];
  let recording: RecordingHandle | null = null;
  const revokeAllPreviews = () => {
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
  };

  const grid = modal.querySelector<HTMLElement>("[data-attach-grid]")!;
  const repaintGrid = () => {
    grid.innerHTML = attachments.map(attachmentCardHtml).join("");
    grid.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = attachments.findIndex((a) => a.id === btn.dataset.remove);
        if (i >= 0) {
          const [removed] = attachments.splice(i, 1);
          if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        }
        repaintGrid();
      });
    });
    grid.querySelectorAll<HTMLElement>("[data-preview]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = attachments.find((x) => x.id === el.dataset.preview);
        if (a && a.previewUrl) {
          openLightbox(modalRoot, {
            kind: a.kind,
            filename: a.filename,
            url: a.previewUrl,
            sizeBytes: a.blob.size,
          });
        }
      });
    });
  };
  const addAttachment = (a: PendingAttachment) => {
    if (!a.previewUrl && (a.kind === "screenshot" || a.kind === "recording")) {
      a.previewUrl = URL.createObjectURL(a.blob);
    }
    attachments.push(a);
    repaintGrid();
  };

  modal.querySelector('[data-action="screenshot"]')!.addEventListener("click", async () => {
    setStatus("Pick a screen/tab to capture…");
    try {
      const blob = await captureScreenshot(shadow.host as HTMLElement);
      setStatus("");
      openAnnotateModal(modalRoot, shadow, blob, (annotated) => {
        addAttachment({
          id: "at_" + Math.random().toString(36).slice(2, 7),
          kind: "screenshot",
          filename: `screenshot-${Date.now()}.png`,
          blob: annotated,
        });
      });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  });
  const recordBtn = modal.querySelector<HTMLButtonElement>('[data-action="record"]')!;
  // Shared finalizer used by both the in-panel Stop button and the browser's
  // "Stop sharing" UI (which fires through startRecording's onEnded callback).
  // Guarded so concurrent triggers don't double-finalize.
  let finalizing = false;
  async function finalizeRecording() {
    if (!recording || finalizing) return;
    finalizing = true;
    try {
      recordBtn.disabled = true;
      setStatus("Finalizing recording…");
      const blob = await recording.stop();
      recording = null;
      recordBtn.classList.remove("recording");
      recordBtn.innerHTML = `${I.record} Record screen`;
      addAttachment({
        id: "at_" + Math.random().toString(36).slice(2, 7),
        kind: "recording",
        filename: `recording-${Date.now()}.webm`,
        blob,
      });
      setStatus("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      recordBtn.disabled = false;
      finalizing = false;
    }
  }
  recordBtn.addEventListener("click", async () => {
    if (recording) {
      await finalizeRecording();
      return;
    }
    setStatus("Pick a screen/tab to record…");
    try {
      recording = await startRecording(shadow.host as HTMLElement, () => {
        void finalizeRecording();
      });
      recordBtn.classList.add("recording");
      recordBtn.innerHTML = `${I.record} Stop recording`;
      setStatus("Recording…");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      recording = null;
    }
  });
  const fileInput = modal.querySelector<HTMLInputElement>('[data-action="file-input"]')!;
  modal.querySelector('[data-action="upload"]')!.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const isImage = f.type.startsWith("image/");
    const isVideo = f.type.startsWith("video/");
    addAttachment({
      id: "at_" + Math.random().toString(36).slice(2, 7),
      kind: isImage ? "screenshot" : isVideo ? "recording" : "file",
      filename: f.name,
      blob: f,
    });
    fileInput.value = "";
  });

  return { attachments, revokeAllPreviews };
}

// ── Bug form (inline) ───────────────────────────────────────────────────────

function mountBugForm(
  container: HTMLElement,
  api: DevtoolsApi,
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  shadow: ShadowRoot,
  onClose: () => void,
  // When provided, the form opens in edit mode: prefilled with this bug's
  // current fields and saving PATCHes the existing record instead of
  // creating a new one. Newly attached files still upload to the same bug.
  edit?: BugDetail | null,
): void {
  const isEdit = !!edit;
  // Populated once the form DOM is mounted (see wireAttachments below). The
  // isDirty/onCancel/submit closures read these `let` bindings at call time.
  let attachments: PendingAttachment[] = [];
  let revokeAllPreviews = () => {};

  const bodyHtml = `
    <div class="se-form">
      <label class="se-field" data-field-wrap="title">
        <span class="se-label">Title <span class="se-req">*</span></span>
        <input class="se-input" data-field="title" placeholder="Short summary of the bug" />
      </label>
      <label class="se-field" data-field-wrap="steps">
        <span class="se-label">Steps to reproduce <span class="se-req">*</span></span>
        <textarea class="se-input se-textarea" data-field="steps" rows="4"
          placeholder="1. Go to…&#10;2. Click…"></textarea>
      </label>
      <div class="se-field-row">
        <label class="se-field">
          <span class="se-label">Actual result</span>
          <textarea class="se-input se-textarea" data-field="actual" rows="3"></textarea>
        </label>
        <label class="se-field">
          <span class="se-label">Expected result</span>
          <textarea class="se-input se-textarea" data-field="expected" rows="3"></textarea>
        </label>
      </div>
      <label class="se-field">
        <span class="se-label">Priority</span>
        <select class="se-input" data-field="priority">
          <option value="">— optional —</option>
          <option value="nice_to_have">Nice to have</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </label>
${ATTACHMENTS_FIELD_HTML}
    </div>`;

  const formState: {
    title: string;
    steps: string;
    actual: string;
    expected: string;
    priority: "" | BugPriority;
  } = {
    title: edit?.title ?? "",
    steps: edit?.stepsToReproduce ?? "",
    actual: edit?.actualResult ?? "",
    expected: edit?.expectedResult ?? "",
    priority: edit?.priority ?? "",
  };
  // Snapshot of the prefilled values so edit-mode dirtiness compares against
  // what was loaded (in create mode the baseline is empty).
  const initial = { ...formState };

  const handle = mountInlineForm(container, {
    title: isEdit ? "Edit bug" : "File a bug",
    bodyHtml,
    isDirty: () =>
      formState.title !== initial.title ||
      formState.steps !== initial.steps ||
      formState.actual !== initial.actual ||
      formState.expected !== initial.expected ||
      formState.priority !== initial.priority ||
      attachments.length > 0,
    onSubmit: submit,
    onCancel: () => {
      revokeAllPreviews();
      onClose();
    },
  });

  const modal = handle.host;
  const status = modal.querySelector<HTMLElement>("[data-status]")!;
  const setStatus = (msg: string, err = false) => {
    status.textContent = msg;
    status.classList.toggle("err", err);
  };

  modal
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-field]")
    .forEach((el) => {
      // Prefill from formState — populated in edit mode, empty for create.
      const seed = (formState as Record<string, string>)[el.dataset.field!];
      if (seed) el.value = seed;
      const update = () => {
        (formState as Record<string, string>)[el.dataset.field!] = el.value;
        // Clear field-level invalid state as soon as the user types — they've
        // acknowledged the error, no point keeping it red while they fix it.
        const wrap = el.closest<HTMLElement>("[data-field-wrap]");
        if (wrap?.classList.contains("invalid") && el.value.trim()) {
          wrap.classList.remove("invalid");
        }
      };
      el.addEventListener("input", update);
      el.addEventListener("change", update);
    });

  ({ attachments, revokeAllPreviews } = wireAttachments(modal, shadow, modalRoot, setStatus));

  async function submit(): Promise<void> {
    // Highlight every empty required field at once, then focus + scroll the
    // first one into view so the user immediately sees what's missing even
    // if the form has been scrolled past it.
    const requiredFields: Array<"title" | "steps"> = ["title", "steps"];
    let firstInvalid: HTMLElement | null = null;
    for (const f of requiredFields) {
      const wrap = modal.querySelector<HTMLElement>(`[data-field-wrap="${f}"]`);
      const input = modal.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-field="${f}"]`,
      );
      const empty = !formState[f].trim();
      wrap?.classList.toggle("invalid", empty);
      if (empty && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) {
      setStatus("");
      firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
      firstInvalid.focus({ preventScroll: true });
      return;
    }
    setStatus(isEdit ? "Saving…" : "Submitting…");
    try {
      // The target bug id: the edited record, or the freshly-created one.
      let bugId: string;
      if (edit) {
        await api.updateBug(edit.id, {
          title: formState.title.trim(),
          stepsToReproduce: formState.steps,
          actualResult: formState.actual,
          expectedResult: formState.expected,
          // null clears the priority when the user picks "— optional —".
          priority: formState.priority || null,
        });
        bugId = edit.id;
      } else {
        const created = await api.createBug({
          title: formState.title.trim(),
          stepsToReproduce: formState.steps,
          actualResult: formState.actual,
          expectedResult: formState.expected,
          priority: formState.priority || undefined,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        });
        bugId = created.id;
      }
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        setStatus(`Uploading ${i + 1}/${attachments.length}…`);
        await api.uploadAttachment({
          reportKind: "bug",
          reportId: bugId,
          kind: a.kind,
          filename: a.filename,
          blob: a.blob,
        });
      }
      revokeAllPreviews();
      handle.close();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }
}

function openAnnotateModal(
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  shadow: ShadowRoot,
  source: Blob,
  onSave: (blob: Blob) => void,
): void {
  const wrap = document.createElement("div");
  wrap.className = "dtf-modal-bg annotate";
  wrap.innerHTML = `
    <div class="dtf-modal lg annot-modal">
      <div class="hd">
        <span class="k">Annotate screenshot</span>
        <button class="x" data-action="close">${I.x}</button>
      </div>
      <div class="bd annot-bd" data-host>Preparing annotator…</div>
      <div class="ft">
        <span class="sp"></span>
        <button data-action="close">Cancel</button>
        <button class="primary" data-action="save">Use screenshot</button>
      </div>
    </div>`;
  // Inset the scrim so the docked devtools panel stays fully visible — the
  // panel's z-index is higher than the modal's, so without this it covers the
  // modal's right edge (incl. the Save button).
  reserveSpaceForPanel(wrap, shadow);
  modalRoot.appendChild(wrap);
  const onResize = () => {
    reserveSpaceForPanel(wrap, shadow);
    fitAnnotatorCanvas(wrap);
  };
  window.addEventListener("resize", onResize);
  const close = () => {
    window.removeEventListener("resize", onResize);
    wrap.remove();
  };
  wrap.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener("click", close));
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });

  const host = wrap.querySelector<HTMLElement>("[data-host]")!;
  createAnnotator(source)
    .then((ann) => {
      host.innerHTML = "";
      host.appendChild(ann.root);
      // Size canvas to fit the available area so the modal shrinks to the
      // screenshot's aspect ratio instead of stretching the scrim.
      fitAnnotatorCanvas(wrap);
      wrap.querySelector('[data-action="save"]')!.addEventListener("click", async () => {
        const blob = await ann.export();
        close();
        onSave(blob);
      });
    })
    .catch((err) => {
      host.innerHTML = `<div class="err">${escapeHtml(String(err))}</div>`;
    });
}

function reserveSpaceForPanel(wrap: HTMLElement, shadow: ShadowRoot): void {
  const panel = shadow.querySelector<HTMLElement>(".dtf-panel");
  wrap.style.left = wrap.style.right = wrap.style.top = wrap.style.bottom = "";
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fromRight = vw - r.right;
  const fromLeft = r.left;
  const fromTop = r.top;
  const fromBottom = vh - r.bottom;
  const min = Math.min(fromRight, fromLeft, fromTop, fromBottom);
  const gap = 12;
  if (min === fromRight) wrap.style.right = `${Math.max(0, vw - r.left + gap)}px`;
  else if (min === fromLeft) wrap.style.left = `${r.right + gap}px`;
  else if (min === fromTop) wrap.style.top = `${r.bottom + gap}px`;
  else wrap.style.bottom = `${Math.max(0, vh - r.top + gap)}px`;
}

function fitAnnotatorCanvas(wrap: HTMLElement): void {
  const canvas = wrap.querySelector<HTMLCanvasElement>(".se-annot-canvas");
  if (!canvas || !canvas.width || !canvas.height) return;
  const wrapRect = wrap.getBoundingClientRect();
  const cs = getComputedStyle(wrap);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // Reserve room for header (~38px), footer (~50px), modal border (4px),
  // stage padding (24px), and stage canvas border (2px).
  const chromeH = 38 + 50 + 4 + 24 + 2;
  const chromeW = 4 + 24 + 2;
  const availW = Math.max(120, wrapRect.width - padX - chromeW);
  const availH = Math.max(120, wrapRect.height - padY - chromeH);
  const ratio = canvas.width / canvas.height;
  let cw = availW;
  let ch = cw / ratio;
  if (ch > availH) {
    ch = availH;
    cw = ch * ratio;
  }
  canvas.style.width = `${Math.floor(cw)}px`;
  canvas.style.height = `${Math.floor(ch)}px`;
}

// ── Feature request form (inline) ───────────────────────────────────────────

function mountFeatureForm(
  container: HTMLElement,
  api: DevtoolsApi,
  modalRoot: ParentNode & { appendChild: (n: Node) => Node },
  shadow: ShadowRoot,
  onClose: () => void,
  // When provided, the form opens in edit mode: prefilled with this request's
  // current fields and saving PATCHes the existing record instead of creating a
  // new one. Newly attached files still upload to the same request.
  edit?: FeatureRequestDetail | null,
): void {
  const isEdit = !!edit;
  const formState = {
    title: edit?.title ?? "",
    description: edit?.description ?? "",
    useCase: edit?.useCase ?? "",
    priority: (edit?.priority ?? "nice_to_have") as BugPriority,
  };
  // Snapshot of the prefilled values so edit-mode dirtiness compares against
  // what was loaded (in create mode the baseline is empty).
  const initial = { ...formState };
  // Populated once the form DOM is mounted (see wireAttachments below). The
  // isDirty/onCancel/submit closures read these `let` bindings at call time.
  let attachments: PendingAttachment[] = [];
  let revokeAllPreviews = () => {};

  const bodyHtml = `
    <div class="se-form">
      <label class="se-field" data-field-wrap="title">
        <span class="se-label">Title <span class="se-req">*</span></span>
        <input class="se-input" data-field="title" placeholder="One-line summary of the feature" />
      </label>
      <label class="se-field">
        <span class="se-label">What would it do?</span>
        <textarea class="se-input se-textarea" data-field="description" rows="4"
          placeholder="Describe the feature you'd like to see."></textarea>
      </label>
      <label class="se-field">
        <span class="se-label">Use case / why does it matter?</span>
        <textarea class="se-input se-textarea" data-field="useCase" rows="3"
          placeholder="Who needs this? What does it unlock?"></textarea>
      </label>
      <label class="se-field">
        <span class="se-label">Priority</span>
        <select class="se-input" data-field="priority">
          <option value="nice_to_have">Nice to have</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </label>
${ATTACHMENTS_FIELD_HTML}
    </div>`;

  const handle = mountInlineForm(container, {
    title: isEdit ? "Edit feature request" : "Request a feature",
    bodyHtml,
    isDirty: () =>
      formState.title !== initial.title ||
      formState.description !== initial.description ||
      formState.useCase !== initial.useCase ||
      formState.priority !== initial.priority ||
      attachments.length > 0,
    onSubmit: submit,
    onCancel: () => {
      revokeAllPreviews();
      onClose();
    },
  });

  const modal = handle.host;
  const status = modal.querySelector<HTMLElement>("[data-status]")!;
  const setStatus = (msg: string, err = false) => {
    status.textContent = msg;
    status.classList.toggle("err", err);
  };
  modal
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-field]")
    .forEach((el) => {
      // Prefill from formState — populated in edit mode, empty for create.
      const seed = (formState as Record<string, string>)[el.dataset.field!];
      if (seed) el.value = seed;
      const update = () => {
        (formState as Record<string, string>)[el.dataset.field!] = el.value;
        const wrap = el.closest<HTMLElement>("[data-field-wrap]");
        if (wrap?.classList.contains("invalid") && el.value.trim()) {
          wrap.classList.remove("invalid");
        }
      };
      el.addEventListener("input", update);
      el.addEventListener("change", update);
    });

  ({ attachments, revokeAllPreviews } = wireAttachments(modal, shadow, modalRoot, setStatus));

  async function submit(): Promise<void> {
    const titleWrap = modal.querySelector<HTMLElement>('[data-field-wrap="title"]');
    if (!formState.title.trim()) {
      titleWrap?.classList.add("invalid");
      setStatus("");
      const input = modal.querySelector<HTMLInputElement>('[data-field="title"]');
      input?.scrollIntoView({ block: "center", behavior: "smooth" });
      input?.focus({ preventScroll: true });
      return;
    }
    setStatus(isEdit ? "Saving…" : "Submitting…");
    try {
      // The target request id: the edited record, or the freshly-created one.
      let frId: string;
      if (edit) {
        await api.updateFeatureRequest(edit.id, {
          title: formState.title.trim(),
          description: formState.description,
          useCase: formState.useCase,
          priority: formState.priority,
        });
        frId = edit.id;
      } else {
        const created = await api.createFeatureRequest({
          title: formState.title.trim(),
          description: formState.description,
          useCase: formState.useCase,
          priority: formState.priority,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
        });
        frId = created.id;
      }
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        setStatus(`Uploading ${i + 1}/${attachments.length}…`);
        await api.uploadAttachment({
          reportKind: "feature_request",
          reportId: frId,
          kind: a.kind,
          filename: a.filename,
          blob: a.blob,
        });
      }
      revokeAllPreviews();
      handle.close();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }
}
