import { STYLES } from "./styles";
import { loadSession, saveSession, clearSession, startDeviceAuth } from "./auth";
import {
  clearAllOverrides,
  isEditLabelsModeActive,
  setEditLabelsMode,
  listI18nLabelOverrides,
  clearI18nLabelOverridesSilently,
  getI18nProfileOverride,
} from "./overrides";
import { DevtoolsApi, DEVTOOLS_UNAUTHED_EVENT } from "./api";
import { renderUserPanel, type UserPanelState } from "./panels/user";
import { renderGatesPanel } from "./panels/gates";
import { renderExperimentsPanel } from "./panels/experiments";
import { renderConfigsPanel } from "./panels/configs";
import { renderLabelsPanel, toggleEditLabels, scanAndReplaceMarkers } from "./panels/i18n";
import { renderFeedbackPanel, type Sub as FeedbackSub } from "./panels/feedback";
import { renderEventsPanel } from "./panels/events";
import type { DevtoolsOptions, DevtoolsSession, ProjectRecord } from "./types";
import { projectOwnsHost } from "./types";
import { getControlsState, refreshControls, subscribeControls } from "./controls";
import { I } from "./icons";

type PanelKey = "user" | "gates" | "experiments" | "configs" | "labels" | "feedback" | "events";
type Edge = "top" | "right" | "bottom" | "left";

interface OverlayState {
  edge: Edge;
  offsetPct: number; // 0–100
  railIconSize: number; // collapsed rail icon px (24–56)
  collapsed: boolean;
  // Free-floating expanded panel: top-left px + size px. Both null until the
  // user first drags or resizes the window; until then the expanded panel docks
  // to `edge` (the legacy default). Set + cleared together via `ensureFree`.
  pos: { x: number; y: number } | null;
  size: { w: number; h: number } | null;
}

// Min drag-resize bounds for the expanded panel (px). The height floor keeps
// the footer below the body's own `min-height` + header/footer chrome so a
// shrunk panel never clips its own controls.
const PANEL_MIN_W = 340;
const PANEL_MIN_H = 460;

const PANEL_MODULE: Partial<Record<PanelKey, keyof ProjectRecord["modules"]>> = {
  gates: "gates",
  configs: "configs",
  experiments: "experiments",
  labels: "translations",
  feedback: "feedback",
  user: "user",
  events: "events",
};

const TABS: Array<{ k: PanelKey; label: string; icon: string; description: string }> = [
  { k: "user", label: "User", icon: I.users, description: "props · impersonate" },
  { k: "gates", label: "Feature Flags", icon: I.shield, description: "flags & killswitches" },
  { k: "experiments", label: "Experiments", icon: I.flask, description: "A/B variants" },
  { k: "configs", label: "Configs", icon: I.sliders, description: "remote values" },
  { k: "labels", label: "Translations", icon: I.book, description: "i18n strings" },
  { k: "feedback", label: "Feedback", icon: I.bug, description: "bugs + requests" },
  { k: "events", label: "Events", icon: I.activity, description: "live stream" },
];

const PROJECT_CACHE_KEY = "se_dt_project";
const OVERLAY_KEY = "se_l_overlay";
const ACTIVE_PANEL_KEY = "se_l_active_panel";
// Per-tab filter selection (search text + page/all view) and the feedback
// subtab. Persisted to localStorage so a reload restores whatever the user
// was filtering on, per tab — not reset to defaults every session.
const TAB_VIEW_KEY = "se_l_tab_view";
const FEEDBACK_SUB_KEY = "se_l_feedback_sub";

const RAIL_MIN = 24;
const RAIL_MAX = 56;

const DEFAULT_STATE: OverlayState = {
  edge: "right",
  offsetPct: 50,
  railIconSize: 32,
  collapsed: false,
  pos: null,
  size: null,
};

function loadCachedProject(): ProjectRecord | null {
  try {
    const raw = sessionStorage.getItem(PROJECT_CACHE_KEY);
    if (raw) return JSON.parse(raw) as ProjectRecord;
  } catch {
    /* ignore */
  }
  return null;
}

function saveCachedProject(p: ProjectRecord | null): void {
  try {
    if (p === null) sessionStorage.removeItem(PROJECT_CACHE_KEY);
    else sessionStorage.setItem(PROJECT_CACHE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function loadOverlayState(): OverlayState {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_STATE };
}

function saveOverlayState(s: OverlayState): void {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const VALID_PANEL_KEYS: ReadonlySet<string> = new Set([
  "user",
  "gates",
  "experiments",
  "configs",
  "labels",
  "feedback",
  "events",
]);

function loadActivePanel(): PanelKey | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_PANEL_KEY);
    if (raw && VALID_PANEL_KEYS.has(raw)) return raw as PanelKey;
  } catch {
    /* ignore */
  }
  return null;
}

function saveActivePanel(key: PanelKey | null): void {
  try {
    if (key === null) sessionStorage.removeItem(ACTIVE_PANEL_KEY);
    else sessionStorage.setItem(ACTIVE_PANEL_KEY, key);
  } catch {
    /* ignore */
  }
}

function loadTabView(defaults: Record<PanelKey, ViewState>): Record<PanelKey, ViewState> {
  try {
    const raw = localStorage.getItem(TAB_VIEW_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<PanelKey, Partial<ViewState>>>;
      const out = { ...defaults } as Record<PanelKey, ViewState>;
      for (const k of Object.keys(out) as PanelKey[]) {
        const s = saved[k];
        if (s) {
          out[k] = {
            view: s.view === "page" || s.view === "all" ? s.view : out[k].view,
            search: typeof s.search === "string" ? s.search : out[k].search,
          };
        }
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return { ...defaults };
}

function saveTabView(tabView: Record<PanelKey, ViewState>): void {
  try {
    localStorage.setItem(TAB_VIEW_KEY, JSON.stringify(tabView));
  } catch {
    /* ignore */
  }
}

function loadFeedbackSub(): FeedbackSub {
  try {
    const raw = localStorage.getItem(FEEDBACK_SUB_KEY);
    if (raw === "bugs" || raw === "features" || raw === "errors" || raw === "alerts") return raw;
  } catch {
    /* ignore */
  }
  return "bugs";
}

function saveFeedbackSub(sub: FeedbackSub): void {
  try {
    localStorage.setItem(FEEDBACK_SUB_KEY, sub);
  } catch {
    /* ignore */
  }
}

/**
 * Read the customer SDK client key that the host SDK injects into
 * `window.__SE_BOOTSTRAP.apiKey`. Its presence is proof the page is a real
 * ShipEasy customer page (not just any origin claiming to be one) — used
 * to skip the origin-lock check that would otherwise sign out a localhost
 * dev whose project's configured domain is the prod hostname.
 */
function readBridgeApiKey(): string | null {
  if (typeof window === "undefined") return null;
  const bs = (window as unknown as { __SE_BOOTSTRAP?: { apiKey?: string } }).__SE_BOOTSTRAP;
  return typeof bs?.apiKey === "string" && bs.apiKey ? bs.apiKey : null;
}

function sameModules(a: ProjectRecord["modules"], b: ProjectRecord["modules"]): boolean {
  return (
    a.translations === b.translations &&
    a.configs === b.configs &&
    a.gates === b.gates &&
    a.experiments === b.experiments &&
    a.feedback === b.feedback
  );
}

function resolveHideAdminLinks(opts: Required<DevtoolsOptions>): boolean {
  // Caller-supplied option wins, then the ShipEasy-owned controls project
  // (refreshed by controls.ts via the central /sdk/evaluate endpoint).
  // We deliberately do NOT fall back to the customer's __shipeasy bridge —
  // this is a ShipEasy-internal kill switch, not a customer-controlled flag.
  if (opts.hideAdminLinks) return true;
  if (getControlsState().hideAdminLinks) return true;
  return false;
}

interface ViewState {
  view: "page" | "all";
  search: string;
}

export function createOverlay(opts: Required<DevtoolsOptions>): { destroy: () => void } {
  // Shadow host
  const host = document.createElement("div");
  host.setAttribute("id", "shipeasy-devtools");
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);
  const root = document.createElement("div");
  shadow.appendChild(root);

  // Allow the embedding page to override the accent colour. Setting it as an
  // inline style on the shadow host overrides the :host { --accent } rule in
  // the shadow stylesheet (inline styles beat stylesheet rules in the cascade).
  if (opts.accentColor) {
    host.style.setProperty("--accent", opts.accentColor);
  }

  // Pre-seed session and project state when provided. Each key is only
  // written if not already present so that an existing real session is
  // never overwritten by a demo seed.
  if (opts.seed.session) {
    try {
      if (!sessionStorage.getItem("se_dt_session")) saveSession(opts.seed.session);
    } catch {
      /* ignore */
    }
  }
  if (opts.seed.project) {
    try {
      if (!sessionStorage.getItem(PROJECT_CACHE_KEY)) saveCachedProject(opts.seed.project);
    } catch {
      /* ignore */
    }
  }
  if (opts.seed.activePanel) {
    try {
      if (!sessionStorage.getItem(ACTIVE_PANEL_KEY))
        saveActivePanel(opts.seed.activePanel as PanelKey);
    } catch {
      /* ignore */
    }
  }

  // State
  let state: OverlayState = loadOverlayState();
  let activeKey: PanelKey | null = loadActivePanel();
  let session: DevtoolsSession | null = loadSession();
  let project: ProjectRecord | null = loadCachedProject();
  if (project && session && project.id !== session.projectId) {
    project = null;
    saveCachedProject(null);
  }

  // Single DevtoolsApi instance per session — reused across renders so its
  // in-memory response cache survives tab switches. Reset on signout / when
  // the session swaps to a different project.
  let api: DevtoolsApi | null = null;
  function getApi(): DevtoolsApi | null {
    if (!session) return null;
    if (!api || api.token !== session.token || api.projectId !== session.projectId) {
      api = new DevtoolsApi(
        opts.adminUrl,
        session.token,
        session.projectId,
        resolveHideAdminLinks(opts),
      );
    } else {
      // Kill-switch state can flip while the overlay is open — keep the cached
      // api instance but refresh the boolean, since it gates empty-state CTAs.
      api.hideAdminLinks = resolveHideAdminLinks(opts);
    }
    return api;
  }

  // Per-tab view state (search + page/all). Seeded from localStorage so the
  // user's last filter selection per tab survives a reload.
  const tabView: Record<PanelKey, ViewState> = loadTabView({
    user: { view: "all", search: "" },
    gates: { view: "page", search: "" },
    experiments: { view: "page", search: "" },
    configs: { view: "page", search: "" },
    labels: { view: "page", search: "" },
    feedback: { view: "all", search: "" },
    events: { view: "all", search: "" },
  });
  // Labels-tab locale
  let labelLocale = "en-US";
  // Feedback subtab (persisted across reloads)
  let feedbackSub: FeedbackSub = loadFeedbackSub();
  // One-shot signal from the rail hovercard's quick-actions ("File a bug" /
  // "Request a feature"). Read once by renderFeedbackPanel, then cleared.
  let feedbackPendingForm: "bug" | "feature" | null = null;
  // User-tab editable state lives across re-renders
  const userState: UserPanelState = { props: {}, dirty: {} };

  // Gates rendered into the overrides count so the overbar / footer can react.
  // Computed by the gates panel each render and stored on `globals` for the
  // shell to use.
  const overridesByTab: Record<PanelKey, number> = {
    user: 0,
    gates: 0,
    experiments: 0,
    configs: 0,
    labels: 0,
    feedback: 0,
    events: 0,
  };

  function totalOverrides(): number {
    return Object.values(overridesByTab).reduce((a, b) => a + b, 0);
  }

  function isPanelEnabled(key: PanelKey): boolean {
    const mod = PANEL_MODULE[key];
    if (!mod) return true; // user / events have no module gate
    if (!project) return !session; // unauthed: show all
    return project.modules[mod];
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function applyPanelStyle(panel: HTMLElement): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const { edge, offsetPct, collapsed } = state;
    const ps = panel.style;
    ps.top = ps.bottom = ps.left = ps.right = ps.transform = "";
    panel.dataset.edge = edge;
    if (collapsed) {
      // Floating rail anchored to edge, centred along it.
      if (edge === "right") {
        ps.right = "10px";
        ps.top = `${offsetPct}%`;
        ps.transform = "translateY(-50%)";
      } else if (edge === "left") {
        ps.left = "10px";
        ps.top = `${offsetPct}%`;
        ps.transform = "translateY(-50%)";
      } else if (edge === "top") {
        ps.top = "10px";
        ps.left = `${offsetPct}%`;
        ps.transform = "translateX(-50%)";
      } else {
        ps.bottom = "10px";
        ps.left = `${offsetPct}%`;
        ps.transform = "translateX(-50%)";
      }
    } else if (state.pos && state.size) {
      // Free-floating: user has dragged/resized the window. Anchor by top-left
      // px and pin an explicit size, overriding the CSS dock width + min/max
      // height so it can be made smaller or larger at will. Clamp into the
      // viewport so a window resize never strands it off-screen.
      const w = Math.min(state.size.w, W - 16);
      const h = Math.min(state.size.h, H - 16);
      const x = Math.max(8, Math.min(W - w - 8, state.pos.x));
      const y = Math.max(8, Math.min(H - h - 8, state.pos.y));
      ps.left = `${x}px`;
      ps.top = `${y}px`;
      ps.width = `${w}px`;
      ps.height = `${h}px`;
      ps.minHeight = "0";
      ps.maxHeight = "none";
    } else {
      // Expanded panel docked to one edge (first-run default, until dragged).
      if (edge === "right") {
        ps.right = "12px";
        ps.top = "18px";
      } else if (edge === "left") {
        ps.left = "12px";
        ps.top = "18px";
      } else if (edge === "top") {
        ps.top = "12px";
        ps.right = "18px";
      } else {
        ps.bottom = "12px";
        ps.right = "18px";
      }
    }
  }

  // Snapshot the panel's current geometry into free-floating state the first
  // time the user grabs the drag handle or resize corner, so subsequent moves
  // anchor by top-left px instead of the docked edge.
  function ensureFree(panel: HTMLElement): void {
    if (state.pos && state.size) return;
    const r = panel.getBoundingClientRect();
    state = {
      ...state,
      pos: { x: r.left, y: r.top },
      size: { w: r.width, h: r.height },
    };
  }

  function nearestEdge(x: number, y: number): { edge: Edge; offsetPct: number } {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const candidates: Array<[number, Edge]> = [
      [W - x, "right"],
      [x, "left"],
      [y, "top"],
      [H - y, "bottom"],
    ];
    candidates.sort((a, b) => a[0] - b[0]);
    const edge = candidates[0][1];
    const isVert = edge === "left" || edge === "right";
    const offsetPct = Math.max(5, Math.min(95, isVert ? (y / H) * 100 : (x / W) * 100));
    return { edge, offsetPct };
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function render(): void {
    const panel = document.createElement("div");
    panel.className = state.collapsed ? "dtf-panel collapsed" : "dtf-panel";
    panel.setAttribute("data-edge", state.edge);
    // Mount before populating: renderExpanded → renderTabBody looks up
    // `#dtf-body` via root.querySelector. Calling it on a detached panel
    // either returns null (first render) or the previous body that's about
    // to be torn down, so the new body never receives its loading skeleton.
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(panel);
    applyPanelStyle(panel);
    if (state.collapsed) {
      renderCollapsed(panel);
    } else {
      renderExpanded(panel);
    }
  }

  // Mounts a quick-actions hovercard on the feedback rail icon. Shown on
  // hover, click jumps the panel directly into the corresponding inline form
  // ("File a bug" / "Request a feature") via feedbackPendingForm. Card is
  // appended to the shadow root with position:fixed and removed on hide so
  // re-renders don't leak DOM.
  function attachFeedbackQuickActions(btn: HTMLElement): void {
    let card: HTMLElement | null = null;
    let hideTimer: number | null = null;

    const openForm = (form: "bug" | "feature") => {
      hide(true);
      feedbackPendingForm = form;
      feedbackSub = form === "bug" ? "bugs" : "features";
      saveFeedbackSub(feedbackSub);
      activeKey = "feedback";
      saveActivePanel(activeKey);
      state = { ...state, collapsed: false };
      saveOverlayState(state);
      render();
    };

    const position = () => {
      if (!card) return;
      const r = btn.getBoundingClientRect();
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const margin = 8;
      // Pick a side based on which edge the panel is anchored to. Keeps the
      // card on the "outside" so it doesn't overlap the panel body.
      let left: number;
      let top: number;
      if (state.edge === "right") {
        left = r.left - cw - margin;
        top = r.top + r.height / 2 - ch / 2;
      } else if (state.edge === "left") {
        left = r.right + margin;
        top = r.top + r.height / 2 - ch / 2;
      } else if (state.edge === "top") {
        left = r.left + r.width / 2 - cw / 2;
        top = r.bottom + margin;
      } else {
        left = r.left + r.width / 2 - cw / 2;
        top = r.top - ch - margin;
      }
      // Clamp to viewport.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      left = Math.max(8, Math.min(vw - cw - 8, left));
      top = Math.max(8, Math.min(vh - ch - 8, top));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    };

    const show = () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (card) return;
      card = document.createElement("div");
      card.className = "se-qa";
      card.innerHTML =
        `<span class="qa-hd">Quick actions</span>` +
        `<button data-qa="bug">${I.bug}<span>File a bug</span></button>` +
        `<button data-qa="feature">${I.lightbulb}<span>Request a feature</span></button>`;
      shadow.appendChild(card);
      position();
      // Two RAFs so the browser commits the initial transform before the
      // .show class swaps it — avoids a janky pop-in on first hover.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => card?.classList.add("show"));
      });
      card.addEventListener("mouseenter", show);
      card.addEventListener("mouseleave", () => hide());
      card.querySelectorAll<HTMLButtonElement>("[data-qa]").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openForm(b.dataset.qa as "bug" | "feature");
        });
      });
    };
    const hide = (immediate = false) => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      const drop = () => {
        if (card) {
          card.remove();
          card = null;
        }
      };
      if (immediate) {
        drop();
      } else {
        hideTimer = window.setTimeout(drop, 160);
      }
    };
    btn.addEventListener("mouseenter", show);
    btn.addEventListener("mouseleave", () => hide());
    // The card lives on the shadow root, not inside the panel, so it survives
    // the render() that the rail-icon click handler triggers — without this
    // the card is left orphaned with no listeners to dismiss it.
    btn.addEventListener("click", () => hide(true));
  }

  function renderCollapsed(panel: HTMLElement): void {
    const sz = state.railIconSize;
    // Unauthed: collapse all tab icons into one lock icon. The user can't do
    // anything until they connect, so don't tease tabs they can't open. The
    // tooltip is a multi-line explainer instead of the usual one-word label.
    const icons = !session
      ? `<button class="ri lock-only" data-tab="__lock__" ` +
        `style="width:${sz}px;height:${sz}px" title="">` +
        I.lock.replace(
          `<svg `,
          `<svg width="${Math.round(sz * 0.5)}" height="${Math.round(sz * 0.5)}" `,
        ) +
        `<span class="tip tip-multi">` +
        `<b>Devtools locked</b>` +
        `Sign in to ShipEasy to inspect and override feature flags, configs, experiments, and translations on this page.` +
        `<span class="hint">Click to connect →</span>` +
        `</span>` +
        `</button>`
      : TABS.filter((t) => isPanelEnabled(t.k))
          .map((t) => {
            const ov = overridesByTab[t.k] > 0;
            return (
              `<button class="ri" data-tab="${t.k}" ` +
              `style="width:${sz}px;height:${sz}px">` +
              t.icon.replace(
                `<svg `,
                `<svg width="${Math.round(sz * 0.5)}" height="${Math.round(sz * 0.5)}" `,
              ) +
              (ov ? `<span class="dotw"></span>` : "") +
              `<span class="tip">${t.label}</span>` +
              `</button>`
            );
          })
          .join("");
    const railHtml =
      `<div class="dtf-panel-rail">` +
      `<div class="mk" title="Drag to reposition · click to expand" ` +
      `style="width:${sz * 0.7}px;height:${sz * 0.7}px"></div>` +
      icons +
      `<div class="dtf-rail-resize" ` +
      `style="width:${state.edge === "right" || state.edge === "left" ? sz : 12}px;` +
      `height:${state.edge === "right" || state.edge === "left" ? 12 : sz}px" ` +
      `title="Drag to resize"></div>` +
      `</div>`;
    panel.innerHTML = railHtml;

    // Drag the brand mark to reposition; click to expand.
    const mk = panel.querySelector<HTMLElement>(".mk")!;
    let dragged = false;
    mk.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragged = false;
      const startX = e.clientX;
      const startY = e.clientY;
      // Record the offset between the cursor and the panel's centerline so the
      // panel doesn't pop to put its center under the cursor on first move.
      // applyPanelStyle anchors via translate(-50%) along the parallel axis,
      // so we adjust the synthetic cursor position by these deltas.
      const r0 = panel.getBoundingClientRect();
      const grabDx = e.clientX - (r0.left + r0.width / 2);
      const grabDy = e.clientY - (r0.top + r0.height / 2);
      mk.classList.add("dragging");
      let lastEdge: Edge = state.edge;
      const move = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) dragged = true;
        // Subtract grab deltas: edge picks from the cursor (so it still snaps
        // to the closest edge to the pointer), but the parallel-axis position
        // tracks where the panel center *would* be if we kept it pinned to
        // the original grab point on the mark.
        const { edge } = nearestEdge(ev.clientX, ev.clientY);
        const isVert = edge === "left" || edge === "right";
        const cx = ev.clientX - grabDx;
        const cy = ev.clientY - grabDy;
        const W = window.innerWidth;
        const H = window.innerHeight;
        const offsetPct = Math.max(5, Math.min(95, isVert ? (cy / H) * 100 : (cx / W) * 100));
        state = { ...state, edge, offsetPct };
        applyPanelStyle(panel);
        panel.setAttribute("data-edge", edge);
        lastEdge = edge;
      };
      const up = () => {
        mk.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveOverlayState(state);
        // The rail-resize handle's width/height are inline styles set at
        // render time per edge. Re-render after a drag so the handle reorients
        // to match the new edge (flex-direction itself is CSS-driven).
        if (dragged) render();
        void lastEdge;
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    mk.addEventListener("click", () => {
      if (dragged) return;
      state = { ...state, collapsed: false };
      saveOverlayState(state);
      render();
    });

    panel.querySelectorAll<HTMLButtonElement>(".ri").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.tab!;
        // The synthetic "__lock__" key on the unauthed rail just expands the
        // panel into the auth modal — there is no real tab to activate.
        if (k !== "__lock__") {
          activeKey = k as PanelKey;
          saveActivePanel(activeKey);
        }
        state = { ...state, collapsed: false };
        saveOverlayState(state);
        render();
      });
      if (btn.dataset.tab === "feedback") attachFeedbackQuickActions(btn);
    });

    const resize = panel.querySelector<HTMLElement>(".dtf-rail-resize")!;
    resize.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isVert = state.edge === "right" || state.edge === "left";
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = state.railIconSize;
      resize.classList.add("dragging");
      const move = (ev: MouseEvent) => {
        const delta = isVert ? ev.clientY - startY : ev.clientX - startX;
        const next = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(startSize + delta)));
        state = { ...state, railIconSize: next };
        render();
      };
      const up = () => {
        resize.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveOverlayState(state);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  function renderExpandedUnauthed(panel: HTMLElement): void {
    const origin = window.location.host;
    panel.innerHTML = `
      <div class="dtf-head">
        <div class="mk" title="Drag to reposition"></div>
        <div class="ti">
          <span class="title">Locked</span>
          <span class="sub">${escapeHtml(origin)}</span>
        </div>
        <div class="actions">
          <button class="ib" data-action="collapse" title="${opts.hideRail ? "Close" : "Collapse"}">${I.x}</button>
        </div>
      </div>
      <div class="dtf-split">
        <div class="dtf-rail">
          <button class="t lock-only active" title="">
            ${I.lock}
            <span class="tip tip-multi">
              <b>Devtools locked</b>
              Sign in to ShipEasy to inspect and override flags, configs, experiments, and translations on this page.
              <span class="hint">Click <em>Connect</em> to start →</span>
            </span>
          </button>
        </div>
        <div class="dtf-pane" style="position:relative">
          <div class="dtf-body" id="dtf-body" aria-hidden="true" inert></div>
          <div class="auth-locked" role="dialog" aria-modal="true">
            <div class="auth-locked-card">
              <div class="ic-big">${I.lock}</div>
              <h2>Connect to <em>ShipEasy</em></h2>
              <p>Sign in to inspect and override flags, configs, experiments, and translations live on this page.</p>
              <div class="features">
                <div class="row"><span class="ic">${I.shield}</span><span class="k">Toggle feature flags &amp; killswitches</span></div>
                <div class="row"><span class="ic">${I.flask}</span><span class="k">Force experiment variants</span></div>
                <div class="row"><span class="ic">${I.sliders}</span><span class="k">Override config values</span></div>
                <div class="row"><span class="ic">${I.book}</span><span class="k">Edit translations in-place</span></div>
              </div>
              <button class="cta" data-action="connect" autofocus>Connect →</button>
              <div class="meta">A new tab will open for you to approve this device.</div>
              <div class="status" data-status></div>
              <div class="err" data-err style="display:none"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="dtf-foot">
        <div class="stat-line">
          <span style="width:5px;height:5px;border-radius:50%;background:var(--fg-4);display:inline-block"></span>
          <span class="stat" style="color:var(--fg-3)">Not connected</span>
        </div>
      </div>`;

    // Header drag
    const headMk = panel.querySelector<HTMLElement>(".dtf-head .mk")!;
    headMk.addEventListener("mousedown", (e) => {
      e.preventDefault();
      headMk.classList.add("dragging");
      const move = (ev: MouseEvent) => {
        const { edge, offsetPct } = nearestEdge(ev.clientX, ev.clientY);
        state = { ...state, edge, offsetPct };
        applyPanelStyle(panel);
      };
      const up = () => {
        headMk.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveOverlayState(state);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    panel.querySelector('[data-action="collapse"]')!.addEventListener("click", () => {
      // With the rail hidden there is no collapsed state to dock to — the
      // close button tears the overlay down via the embedder's handler.
      if (opts.hideRail) {
        opts.onClose();
        return;
      }
      state = { ...state, collapsed: true };
      saveOverlayState(state);
      render();
    });

    const cta = panel.querySelector<HTMLButtonElement>('[data-action="connect"]')!;
    const statusEl = panel.querySelector<HTMLElement>("[data-status]")!;
    const errEl = panel.querySelector<HTMLElement>("[data-err]")!;
    cta.addEventListener("click", async () => {
      cta.disabled = true;
      cta.innerHTML = `<span class="spin"></span> Opening…`;
      statusEl.textContent = "";
      errEl.style.display = "none";
      errEl.textContent = "";
      try {
        session = await startDeviceAuth(opts, () => {
          statusEl.textContent = "Waiting for approval in the opened tab…";
          cta.innerHTML = `<span class="spin"></span> Waiting for approval`;
        });
        // Successful auth — re-render the panel with real content. Pick the
        // first enabled tab so the user lands somewhere useful.
        activeKey = TABS.find((t) => isPanelEnabled(t.k))?.k ?? "gates";
        saveActivePanel(activeKey);
        render();
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
        errEl.style.display = "block";
        statusEl.textContent = "";
        cta.disabled = false;
        cta.textContent = "Retry connect →";
      }
    });
  }

  function renderExpanded(panel: HTMLElement): void {
    if (!session) {
      renderExpandedUnauthed(panel);
      return;
    }
    const tab = (
      activeKey && activeKey !== ("__lock__" as PanelKey)
        ? activeKey
        : (TABS.find((t) => isPanelEnabled(t.k))?.k ?? "gates")
    ) as PanelKey;
    if (activeKey !== tab) {
      activeKey = tab;
      saveActivePanel(tab);
    }
    const tabDef = TABS.find((t) => t.k === tab)!;
    const projectName = project?.name ?? "";
    const origin = window.location.host;
    const sub = projectName || origin;

    const railIcons = TABS.filter((t) => isPanelEnabled(t.k))
      .map((t) => {
        const active = t.k === tab;
        const ov = overridesByTab[t.k] > 0;
        return (
          `<button class="t${active ? " active" : ""}" data-tab="${t.k}" title="${t.label}">` +
          t.icon +
          (ov ? `<span class="dotw"></span>` : "") +
          `<span class="tip">${t.label}</span>` +
          `</button>`
        );
      })
      .join("");

    const showSearch = tabHasSearch(tab);

    const overbar =
      totalOverrides() > 0
        ? `<div class="dtf-overbar">` +
          I.alert +
          `<span><b>${totalOverrides()} session override${totalOverrides() > 1 ? "s" : ""}</b> · cleared on refresh</span>` +
          `<button data-action="clear-overrides">Clear all</button>` +
          `</div>`
        : "";

    const searchBar = showSearch ? searchBarHtml(tab) : "";

    panel.innerHTML = `
      <div class="dtf-head">
        <div class="mk" title="Drag to reposition"></div>
        <div class="ti">
          <span class="title">${escapeHtml(tabDef.label)}</span>
          <span class="sub">${escapeHtml(sub)}</span>
        </div>
        ${headExtrasHtml(tab)}
        <div class="actions">
          <button class="ib" data-action="refresh" title="Refresh">${I.refresh}</button>
          <button class="ib" data-action="collapse" title="${opts.hideRail ? "Close" : "Collapse"}">${I.x}</button>
        </div>
      </div>
      <div class="dtf-split">
        <div class="dtf-rail">${railIcons}</div>
        <div class="dtf-pane">
          ${overbar}
          ${searchBar}
          <div class="dtf-body" id="dtf-body"></div>
        </div>
      </div>
      <div class="dtf-foot">
        <div class="stat-line">
          <span class="ok"></span>
          <span class="stat">SDK <b>connected</b></span>
          ${session ? "" : `<span class="sk">unauthed</span>`}
          <span class="grow"></span>
          ${
            totalOverrides() > 0
              ? `<button class="ibtn danger" data-action="clear-overrides" title="Drop all session overrides">Clear overrides</button>`
              : ""
          }
          ${
            session
              ? `<button class="ibtn" data-action="signout" title="Sign out of this project">Sign out</button>`
              : ""
          }
        </div>
      </div>
      <div class="dtf-resize" title="Drag to resize"></div>
    `;

    // Drag handle on header mk — moves the expanded panel freely (no edge snap).
    const headMk = panel.querySelector<HTMLElement>(".dtf-head .mk")!;
    headMk.addEventListener("mousedown", (e) => {
      e.preventDefault();
      ensureFree(panel);
      headMk.classList.add("dragging");
      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { ...state.pos! };
      const move = (ev: MouseEvent) => {
        state = {
          ...state,
          pos: { x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) },
        };
        applyPanelStyle(panel);
      };
      const up = () => {
        headMk.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveOverlayState(state);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    // Resize handle at the bottom-right corner — grows/shrinks the panel,
    // anchored top-left.
    const resizeH = panel.querySelector<HTMLElement>(".dtf-resize");
    resizeH?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ensureFree(panel);
      resizeH.classList.add("dragging");
      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { ...state.size! };
      const anchor = { ...state.pos! };
      const move = (ev: MouseEvent) => {
        const maxW = window.innerWidth - anchor.x - 8;
        const maxH = window.innerHeight - anchor.y - 8;
        const w = Math.max(PANEL_MIN_W, Math.min(maxW, orig.w + (ev.clientX - startX)));
        const h = Math.max(PANEL_MIN_H, Math.min(maxH, orig.h + (ev.clientY - startY)));
        state = { ...state, size: { w, h } };
        applyPanelStyle(panel);
      };
      const up = () => {
        resizeH.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveOverlayState(state);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    // Labels-tab head extras (Edit-on-page toggle). Locale select is wired
    // by renderLabelsPanel once profiles load.
    wireHeadExtras(panel);

    // Header actions
    panel.querySelector('[data-action="refresh"]')!.addEventListener("click", () => {
      // Drop the in-memory api cache so the next render fetches fresh data
      // for every panel. Cheap — panel modules call api.<list>() directly.
      const api = getApi();
      api?.invalidate();
      // A genuine reload: refetch project meta (module gating) and the
      // ShipEasy controls (admin-link kill switch) alongside the panel data,
      // not just a re-render of stale state.
      if (api) void ensureProjectLoaded(api);
      void refreshControls();
      render();
    });
    panel.querySelector('[data-action="collapse"]')!.addEventListener("click", () => {
      // With the rail hidden there is no collapsed state to dock to — the
      // close button tears the overlay down via the embedder's handler.
      if (opts.hideRail) {
        opts.onClose();
        return;
      }
      state = { ...state, collapsed: true };
      saveOverlayState(state);
      render();
    });

    // Tab rail
    panel.querySelectorAll<HTMLButtonElement>(".dtf-rail .t").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchTab(btn.dataset.tab as PanelKey);
      });
      if (btn.dataset.tab === "feedback") attachFeedbackQuickActions(btn);
    });

    // Search + view
    if (showSearch) wireSearch(panel, tab);

    // Footer actions
    panel.querySelector('[data-action="clear-overrides"]')?.addEventListener("click", () => {
      clearAllOverrides();
    });
    panel.querySelector('[data-action="signout"]')?.addEventListener("click", () => {
      clearSession();
      saveCachedProject(null);
      session = null;
      project = null;
      api = null;
      render();
    });

    renderTabBody();
  }

  // Tab swap without tearing down the whole panel. Mutates only the surfaces
  // that change between tabs — rail .active state, header title, the optional
  // .dtf-search bar, and the body — so nothing else flickers. Falls back to a
  // full render() in the unauthed/collapsed cases that need the shell to
  // recompose.
  function switchTab(next: PanelKey): void {
    if (!session || state.collapsed) {
      activeKey = next;
      saveActivePanel(next);
      render();
      return;
    }
    if (next === activeKey) return;
    const panel = root.querySelector<HTMLElement>(".dtf-panel");
    if (!panel) {
      activeKey = next;
      saveActivePanel(next);
      render();
      return;
    }
    activeKey = next;
    saveActivePanel(next);

    // Rail active class — flip in place.
    panel.querySelectorAll<HTMLButtonElement>(".dtf-rail .t").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === next);
    });

    // Header title.
    const tabDef = TABS.find((t) => t.k === next);
    const titleEl = panel.querySelector<HTMLElement>(".dtf-head .ti .title");
    if (tabDef && titleEl) titleEl.textContent = tabDef.label;

    // Header extras (locale select + edit-labels toggle for `labels` tab).
    const head = panel.querySelector<HTMLElement>(".dtf-head");
    head?.querySelector(".dtf-head-extras")?.remove();
    if (head && next === "labels") {
      const ti = head.querySelector(".ti");
      ti?.insertAdjacentHTML("afterend", headExtrasHtml(next));
      wireHeadExtras(panel);
    }

    // Search bar — drop the existing one (if any) and insert one for the new
    // tab if the new tab uses search. Cheaper to rebuild than to reconcile
    // placeholder/value/locale-select across tab kinds.
    const pane = panel.querySelector<HTMLElement>(".dtf-pane");
    pane?.querySelector(".dtf-search")?.remove();
    if (pane && tabHasSearch(next)) {
      const body = pane.querySelector<HTMLElement>("#dtf-body");
      body?.insertAdjacentHTML("beforebegin", searchBarHtml(next));
      wireSearch(panel, next);
    }

    // Body content.
    renderTabBody();
  }

  function tabHasSearch(tab: PanelKey): boolean {
    return tab === "gates" || tab === "experiments" || tab === "configs";
  }

  function searchBarHtml(tab: PanelKey): string {
    const view = tabView[tab];
    const tabLabel = (TABS.find((t) => t.k === tab)?.label ?? tab).toLowerCase();
    return `<div class="dtf-search">
        <div class="input">
          ${I.search}
          <input placeholder="Filter ${tabLabel}…" value="${escapeAttr(view.search)}" />
          ${view.search ? `<span class="kbd" data-action="clear-search">esc</span>` : `<span class="kbd">⌘K</span>`}
        </div>
        <div class="seg">
          <button class="${view.view === "page" ? "active" : ""}" data-view="page">page</button>
          <button class="${view.view === "all" ? "active" : ""}" data-view="all">all</button>
        </div>
      </div>`;
  }

  function headExtrasHtml(tab: PanelKey): string {
    if (tab !== "labels") return "";
    // "Edit on page" toggle lives in the panel body (rendered by renderLabelsPanel).
    // The header only shows the locale/profile selector, which renderLabelsPanel wires up.
    return `<div class="dtf-head-extras" data-labels-extras>
        <select class="dtf-head-locale" data-locale title="Profile / locale"></select>
      </div>`;
  }

  function wireHeadExtras(_panel: HTMLElement): void {
    // No-op: the locale select is wired by renderLabelsPanel via shadow-root query,
    // and the edit-labels toggle now lives inside the panel body.
  }

  function collectVariablesByKey(): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    if (typeof document === "undefined") return out;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-label]"))) {
      const key = el.getAttribute("data-label");
      if (!key || out.has(key)) continue;
      const raw = el.getAttribute("data-variables");
      if (!raw) continue;
      try {
        out.set(key, JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* malformed — skip */
      }
    }
    return out;
  }

  function openExitEditModal(
    panel: HTMLElement,
    overrides: Array<{ key: string; value: string }>,
  ): void {
    panel.querySelector(".dtf-modal-bg")?.remove();

    const api = getApi();
    const profileId = getI18nProfileOverride();
    const defaultName = `edit-${new Date().toISOString().slice(0, 10)}`;
    const varsByKey = collectVariablesByKey();

    const rowsHtml = overrides
      .map((o, idx) => {
        const vars = varsByKey.get(o.key);
        const varsCell = vars
          ? Object.entries(vars)
              .map(
                ([k, v]) =>
                  `<div class="kv"><span class="vk mono">{{${escapeHtml(k)}}}</span><span class="vv">${escapeHtml(String(v))}</span></div>`,
              )
              .join("")
          : `<span style="color:var(--fg-3)">—</span>`;
        return `
          <tr data-row="${idx}">
            <td class="k mono" title="${escapeAttr(o.key)}">${escapeHtml(o.key)}</td>
            <td><textarea class="dtf-input" data-edit="${idx}" rows="1" spellcheck="false">${escapeHtml(o.value)}</textarea></td>
            <td class="v">${varsCell}</td>
          </tr>`;
      })
      .join("");

    const wrap = document.createElement("div");
    wrap.className = "dtf-modal-bg";
    wrap.innerHTML = `
      <div class="dtf-modal lg" role="dialog" aria-modal="true">
        <div class="hd">
          <span class="k">Review label edits (${overrides.length})</span>
          <button class="x" data-cancel aria-label="Close">${I.x}</button>
        </div>
        <div class="bd">
          <p style="margin:0;color:var(--fg-2);font-size:11px;line-height:1.5">
            Tweak any value before applying. <b>Apply changes</b> writes to
            ${profileId ? `profile <span class="mono" style="color:var(--fg)">${escapeHtml(profileId)}</span>` : "the active profile"} directly.
            <b>Save as draft</b> bundles them into a named draft for review.
          </p>
          <table class="dtf-edits">
            <thead>
              <tr><th>Key</th><th>Value</th><th>Variables</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div class="row" data-name-row>
            <span class="lbl mono">Draft name</span>
            <input class="dtf-input" data-name placeholder="${escapeAttr(defaultName)}" value="${escapeAttr(defaultName)}" />
          </div>
          <div class="row" style="display:${api ? "none" : "grid"}">
            <span class="lbl mono">Note</span>
            <span style="color:var(--warn);font-size:11px">Not signed in — only Discard is available.</span>
          </div>
          <div class="dtf-modal-err" data-err style="color:var(--danger);font-family:var(--mono);font-size:10.5px;min-height:0"></div>
        </div>
        <div class="ft">
          <span style="flex:1"></span>
          <button class="ibtn" data-discard>Discard changes</button>
          <button class="ibtn" data-save${api ? "" : " disabled"}>Save as draft</button>
          <button class="ibtn pri" data-apply${api ? "" : " disabled"}>Apply changes</button>
        </div>
      </div>`;
    panel.appendChild(wrap);

    const nameInp = wrap.querySelector<HTMLInputElement>("[data-name]")!;
    const errEl = wrap.querySelector<HTMLElement>("[data-err]")!;
    const saveBtn = wrap.querySelector<HTMLButtonElement>("[data-save]")!;
    const applyBtn = wrap.querySelector<HTMLButtonElement>("[data-apply]")!;
    const discardBtn = wrap.querySelector<HTMLButtonElement>("[data-discard]")!;
    const cancelBtn = wrap.querySelector<HTMLButtonElement>("[data-cancel]")!;

    function readEdits(): Array<{ key: string; value: string }> {
      return overrides.map((o, idx) => {
        const ta = wrap.querySelector<HTMLTextAreaElement>(`[data-edit="${idx}"]`);
        return { key: o.key, value: ta?.value ?? o.value };
      });
    }

    async function resolveTargetProfile(): Promise<string | null> {
      if (!api) return null;
      if (profileId) return profileId;
      try {
        const profiles = await api.profiles();
        return (
          profiles.find((p) => p.isDefault)?.id ??
          profiles.find((p) => p.name === "en:prod")?.id ??
          profiles[0]?.id ??
          null
        );
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
        return null;
      }
    }

    function lockButtons(disabled: boolean) {
      saveBtn.disabled = disabled || !api;
      applyBtn.disabled = disabled || !api;
      discardBtn.disabled = disabled;
    }

    const close = () => wrap.remove();
    cancelBtn.addEventListener("click", close);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    discardBtn.addEventListener("click", () => {
      close();
      setEditLabelsMode(false);
    });

    saveBtn.addEventListener("click", async () => {
      if (!api) return;
      errEl.textContent = "";
      const name = (nameInp.value || defaultName).trim();
      if (!name) {
        errEl.textContent = "Draft name is required.";
        return;
      }
      const target = await resolveTargetProfile();
      if (!target) {
        if (!errEl.textContent) errEl.textContent = "No profile available to anchor the draft.";
        return;
      }
      lockButtons(true);
      saveBtn.textContent = "Saving…";
      try {
        const draft = await api.createDraft({ profileId: target, name });
        for (const o of readEdits()) {
          await api.upsertDraftKey(draft.id, o.key, o.value);
        }
        clearI18nLabelOverridesSilently();
        setEditLabelsMode(false);
      } catch (err) {
        lockButtons(false);
        saveBtn.textContent = "Save as draft";
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    applyBtn.addEventListener("click", async () => {
      if (!api) return;
      errEl.textContent = "";
      const target = await resolveTargetProfile();
      if (!target) {
        if (!errEl.textContent) errEl.textContent = "No profile available to write to.";
        return;
      }
      lockButtons(true);
      applyBtn.textContent = "Applying…";
      try {
        await api.upsertKeys(target, readEdits());
        clearI18nLabelOverridesSilently();
        setEditLabelsMode(false);
      } catch (err) {
        lockButtons(false);
        applyBtn.textContent = "Apply changes";
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    });
  }

  function wireSearch(panel: HTMLElement, tab: PanelKey): void {
    const input = panel.querySelector<HTMLInputElement>(".dtf-search input");
    if (!input) return;
    input.addEventListener("input", () => {
      tabView[tab].search = input.value;
      saveTabView(tabView);
      renderTabBody();
    });
    panel.querySelectorAll<HTMLButtonElement>(".dtf-search .seg button").forEach((b) => {
      b.addEventListener("click", () => {
        tabView[tab].view = b.dataset.view as "page" | "all";
        saveTabView(tabView);
        render();
      });
    });
    panel.querySelector('[data-action="clear-search"]')?.addEventListener("click", () => {
      tabView[tab].search = "";
      saveTabView(tabView);
      render();
    });
  }

  function renderTabBody(): void {
    const body = root.querySelector<HTMLElement>("#dtf-body");
    if (!body) return;
    if (!session) return; // unauthed is handled at the shell level (renderExpandedUnauthed)

    const api = getApi();
    if (!api) return;

    // Trigger a project refresh in the background so module gating reflects
    // dashboard state without forcing the user to reopen the panel.
    void ensureProjectLoaded(api);

    const tab = activeKey!;
    const view = tabView[tab];

    // Each panel gets a callback to update overrides count for the shell
    // to render badges + footer state.
    const setOverrideCount = (n: number) => {
      const prev = overridesByTab[tab];
      overridesByTab[tab] = n;
      // Re-render shell only when count change crosses thresholds (0 ↔ >0,
      // or affects overbar text). Easiest: re-render header bits in place.
      if ((prev === 0) !== (n === 0) || prev !== n) {
        // Keep the body intact but refresh overbar/footer + tab rail dots.
        updateOverbarFooter();
      }
    };

    switch (tab) {
      case "user":
        renderUserPanel(body, api, userState, () => render());
        break;
      case "gates":
        void renderGatesPanel(body, api, view, setOverrideCount);
        break;
      case "experiments":
        void renderExperimentsPanel(body, api, view, setOverrideCount);
        break;
      case "configs":
        void renderConfigsPanel(body, api, view, setOverrideCount);
        break;
      case "labels":
        void renderLabelsPanel(body, api, view, shadow, {
          locale: labelLocale,
          setLocale: (l) => {
            labelLocale = l;
            renderTabBody();
          },
        });
        break;
      case "feedback":
        void renderFeedbackPanel(body, api, root, {
          sub: feedbackSub,
          setSub: (s) => {
            feedbackSub = s;
            saveFeedbackSub(s);
            renderTabBody();
          },
          pendingForm: feedbackPendingForm,
          consumePendingForm: () => {
            feedbackPendingForm = null;
          },
        });
        break;
      case "events":
        renderEventsPanel(body);
        break;
    }
  }

  function updateOverbarFooter(): void {
    // Cheap re-render — only the shell pieces. We re-render the whole panel
    // for now, since most of the body state is fetched-and-cached inside the
    // panel module itself; re-running is a no-op for the user's perception.
    render();
  }

  async function ensureProjectLoaded(api: DevtoolsApi): Promise<void> {
    try {
      const p = await api.project();
      const host = window.location.host;

      // Stale-session guard. When the page declares which ShipEasy project it
      // is wired to (`<script data-project-id>` → opts.projectId), the precise
      // test for "this cached session belongs to a different customer" is a
      // project-id mismatch — authoritative, and independent of how the
      // project's `domain` happens to be configured. Sign out so the user
      // reconnects against the right project.
      if (opts.projectId && session && session.projectId !== opts.projectId) {
        clearSession();
        saveCachedProject(null);
        session = null;
        project = null;
        render();
        return;
      }

      // Domain origin-lock: a fallback heuristic for pages that carry NO
      // ShipEasy key (e.g. a bare bookmarklet on a random origin) — if the
      // project's configured domain doesn't cover this host, the cached
      // session probably belongs to a different customer, so sign out.
      //
      // A page that carries a ShipEasy client key is a legitimately wired
      // customer page (the server-side approve flow already verified it), so
      // the heuristic must NOT fire for it — otherwise a localhost dev, or a
      // prod host whose project `domain` is set to www./app./a staging host,
      // gets signed out on every load. The key arrives either in
      // `__SE_BOOTSTRAP.apiKey` (older SDKs) or — since @shipeasy/sdk 3.0.0
      // stopped embedding a bootstrap key — via the `<script
      // data-client-api-key>` attribute that lands in `opts.clientKey`.
      const isConfiguredPage = readBridgeApiKey() !== null || !!opts.clientKey;
      if (!isConfiguredPage && p.domain && !projectOwnsHost(host, p.domain)) {
        clearSession();
        saveCachedProject(null);
        session = null;
        project = null;
        // Don't touch the outer `api` cache here — `api` is shadowed by the
        // function parameter. getApi() returns null while session is null,
        // and rebuilds a fresh instance once a new session is established.
        render();
        return;
      }
      const prev = project;
      project = p;
      saveCachedProject(p);
      // If the just-active panel was disabled, fall back to the first enabled
      // tab. Re-render only when something visibly changed.
      if (activeKey && !isPanelEnabled(activeKey)) {
        const next = TABS.find((t) => isPanelEnabled(t.k))?.k ?? null;
        activeKey = next;
        saveActivePanel(next);
        render();
        return;
      }
      if (!prev || !sameModules(prev.modules, p.modules)) render();
    } catch (err) {
      // Do NOT swallow. A failed project load leaves `project` null, and
      // isPanelEnabled() then returns `!session` (false when authed) for every
      // module-gated tab — so the overlay renders empty with no error, no
      // clue. A 403 here means the authed identity's project != the project
      // this overlay was minted for (e.g. same-origin session cookie
      // overriding the SDK key). Surface it loudly so it lands in the console
      // and any log capture instead of looking like "nothing happened".
      console.error("[shipeasy devtools] project load failed — tabs will be hidden:", err);
    }
  }

  // ── Mount ───────────────────────────────────────────────────────────────
  document.documentElement.appendChild(host);
  const reattach = () => {
    if (!document.getElementById("shipeasy-devtools")) {
      document.documentElement.appendChild(host);
    }
  };
  const mo = new MutationObserver(reattach);
  mo.observe(document.documentElement, { childList: true });

  if (isEditLabelsModeActive()) {
    scanAndReplaceMarkers();
    toggleEditLabels(true, shadow, () => {
      /* re-render hook */
    });
  }

  // Default to collapsed unless the user previously expanded a panel — but
  // when the rail is hidden there is no collapsed state, so always mount
  // expanded regardless of the persisted overlay state.
  if (opts.hideRail) {
    state = { ...state, collapsed: false };
  } else if (!loadActivePanel()) {
    state = { ...state, collapsed: true };
  }
  render();

  // Refresh project meta for module gating.
  if (session) {
    const api = getApi();
    if (api) void ensureProjectLoaded(api);
  }

  // ShipEasy controls (kill-switch flags hosted in the controls project) —
  // re-render to flip admin-link visibility on changes.
  void refreshControls();
  const unsubControls = subscribeControls(() => render());

  const onWinResize = () => {
    const panel = root.querySelector<HTMLElement>(".dtf-panel");
    if (panel) applyPanelStyle(panel);
  };
  window.addEventListener("resize", onWinResize);

  // Live SDK state updates → rerender the active body
  const onStateUpdate = () => renderTabBody();
  window.addEventListener("se:state:update", onStateUpdate);

  // Any admin request that returns 401 fires this event (see api.ts). The
  // cached admin SDK key in sessionStorage is stale (revoked, expired, or KV
  // miss), so drop it and rerender — the unauthed shell prompts the user to
  // reconnect instead of leaving "Failed to load …" errors in the panels.
  const onUnauthed = () => {
    if (!session) return;
    clearSession();
    saveCachedProject(null);
    session = null;
    project = null;
    api = null;
    render();
  };
  window.addEventListener(DEVTOOLS_UNAUTHED_EVENT, onUnauthed);

  return {
    destroy() {
      window.removeEventListener("resize", onWinResize);
      window.removeEventListener("se:state:update", onStateUpdate);
      window.removeEventListener(DEVTOOLS_UNAUTHED_EVENT, onUnauthed);
      unsubControls();
      mo.disconnect();
      host.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
