import type { DevtoolsApi } from "../api";
import { I } from "../icons";
import type { ShipeasySdkBridge } from "../types";
import { escapeHtml, emptyState } from "./common";

export interface UserPanelState {
  /** Editable property values keyed by `id`, `email`, etc. */
  props: Record<string, string>;
  /** Set when the user has typed into a field — used to drive the Re-evaluate CTA. */
  dirty: Record<string, boolean>;
}

interface BridgeUser {
  id?: string;
  email?: string;
  [key: string]: unknown;
}

/** Read-only properties that come from the request context, not the user. */
const CTX_PROPS: Array<{ k: string; get: () => string }> = [
  { k: "ctx.route", get: () => `"${window.location.pathname}"` },
  { k: "ctx.user_agent", get: () => `"${(navigator.userAgent ?? "").slice(0, 64)}"` },
  { k: "ctx.viewport", get: () => `${window.innerWidth}x${window.innerHeight}` },
];

/** Try to pick up the customer's identify() payload from the SDK bridge. */
function readBridgeUser(): BridgeUser | null {
  const b = (window as unknown as { __shipeasy?: ShipeasySdkBridge & { user?: BridgeUser } })
    .__shipeasy;
  if (!b) return null;
  const u = (b as { user?: BridgeUser }).user;
  return u && typeof u === "object" ? u : null;
}

function avatarLetter(text: string): string {
  const ch = text.trim().charAt(0).toUpperCase();
  return ch || "?";
}

export function renderUserPanel(
  container: HTMLElement,
  _api: DevtoolsApi,
  state: UserPanelState,
  reevaluate: () => void,
): void {
  const u = readBridgeUser();
  if (!u && Object.keys(state.props).length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>identified user</em>",
      message:
        "The host app hasn't called shipeasy.identify() yet. Once it does, the user's properties will show here and you can simulate other users.",
      actions: [],
    });
    container.innerHTML = html;
    wire(container);
    return;
  }

  // `$`-prefixed keys are devtools sentinels, not real attributes — `$mock`
  // marks a simulated/demo user so we can badge it instead of rendering it.
  const isMock = !!(u && (u as Record<string, unknown>).$mock);

  const merged: Record<string, string> = {};
  if (u) {
    for (const [k, v] of Object.entries(u)) {
      if (k.startsWith("$") || v == null || typeof v === "object") continue;
      merged[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(state.props)) merged[k] = v;

  const idVal = merged.id || merged.userId || "—";
  const emailVal = merged.email || merged.user_email || "";
  const av = emailVal || idVal;

  const propRows = Object.entries(merged)
    .map(([k, v]) => {
      const dirty = state.dirty[k]
        ? `<span class="changed"></span>`
        : `<span style="width:5px"></span>`;
      return `<div class="dtf-prop">
        <span class="k">user.${escapeHtml(k)}</span>
        <span class="v"><input data-prop="${escapeHtml(k)}" value="${escapeAttr(v)}"/></span>
        ${dirty}
      </div>`;
    })
    .join("");

  const ctxRows = CTX_PROPS.map(
    (p) => `<div class="dtf-prop">
      <span class="k">${escapeHtml(p.k)}</span>
      <span class="v" style="color:var(--accent)">${escapeHtml(p.get())}</span>
      <span style="width:5px"></span>
    </div>`,
  ).join("");

  const dirtyCount = Object.values(state.dirty).filter(Boolean).length;

  container.innerHTML = `
    <div class="dtf-user">
      <div class="who">
        <div class="av">${escapeHtml(avatarLetter(av))}</div>
        <div class="info">
          <div class="e">${escapeHtml(emailVal || idVal)}${isMock ? `<span class="dtf-mock-badge" title="Simulated demo user — not a real identity">mock</span>` : ""}</div>
          <div class="id">${escapeHtml(idVal)}</div>
        </div>
      </div>
      <div class="dtf-group">User properties<span class="c">${isMock ? "mock data · edit to simulate" : "edit to simulate"}</span></div>
      <div style="flex:1; overflow-y:auto">
        ${propRows || `<div class="se-empty">No user properties yet.</div>`}
        <div class="dtf-group">Request context<span class="c">read-only</span></div>
        ${ctxRows}
      </div>
      <div class="dtf-evalbar">
        <button class="b" data-action="reeval">${I.play} Re-evaluate ${dirtyCount > 0 ? "with changes" : ""}</button>
        <button class="b g" data-action="reset">Reset</button>
      </div>
    </div>`;

  container.querySelectorAll<HTMLInputElement>("input[data-prop]").forEach((input) => {
    input.addEventListener("input", () => {
      const k = input.dataset.prop!;
      state.props[k] = input.value;
      state.dirty[k] = (u ? String((u as Record<string, unknown>)[k] ?? "") : "") !== input.value;
    });
  });
  container.querySelector('[data-action="reeval"]')!.addEventListener("click", () => reevaluate());
  container.querySelector('[data-action="reset"]')!.addEventListener("click", () => {
    state.props = {};
    state.dirty = {};
    reevaluate();
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
