import { Validator } from "@cfworker/json-schema";
import { see } from "../../devtools/self-report";
import type { DevtoolsApi } from "../api";
import { getConfigOverride, setConfigOverride } from "../overrides";
import type { ConfigRecord, ShipeasySdkBridge } from "../types";
import { I } from "../icons";
import { renderSchemaForm } from "../forms/schema-form";
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

function jsonType(
  v: unknown,
): "null" | "array" | "object" | "string" | "number" | "boolean" | "undefined" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as "string" | "number" | "boolean" | "object" | "undefined";
}

function valEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

function summarizeVal(v: unknown): string {
  const t = jsonType(v);
  if (t === "object") return `{${Object.keys(v as object).length} keys}`;
  if (t === "array") return `[${(v as unknown[]).length}]`;
  if (t === "string") {
    const s = v as string;
    return `"${s.length > 22 ? s.slice(0, 22) + "…" : s}"`;
  }
  if (t === "null") return "null";
  return String(v);
}

interface RenderRow {
  name: string;
  real: unknown;
  override: unknown; // undefined = no override
  effective: unknown;
  live: unknown;
  updatedAt: string;
  schema: Record<string, unknown>;
}

function buildRow(c: ConfigRecord): RenderRow {
  const ov = getConfigOverride(c.name);
  const live = bridge()?.getConfig(c.name);
  const effective = ov !== undefined ? ov : live !== undefined ? live : c.valueJson;
  return {
    name: c.name,
    real: c.valueJson,
    override: ov,
    live,
    effective,
    updatedAt: c.updatedAt,
    schema: c.schema,
  };
}

function renderRow(r: RenderRow, expandedKey: string | null): string {
  const isOpen = expandedKey === r.name;
  const overridden = r.override !== undefined;
  const t = jsonType(r.effective);

  const desc = `config · ${t} · updated ${timeAgo(r.updatedAt)}`;
  const val = `<span class="val${overridden ? " over" : ""}" style="grid-column:3 / span 2; justify-self:end">${escapeHtml(summarizeVal(r.effective))}</span>`;

  const detail = `
    <div class="crumbs">
      <div><span class="pass">●</span> ${escapeHtml(r.name)}
        <span style="color:var(--fg-4)">=</span>
        <span style="color:var(--fg-2)">${escapeHtml(summarizeVal(r.effective))}</span>
        <span style="color:var(--fg-4)">· ${t}</span>
      </div>
    </div>
    <div class="mini">
      <span class="lbl">override</span><span class="v">${overridden ? "yes" : "none"}</span>
      <span class="lbl">updated</span><span class="v">${timeAgo(r.updatedAt)}</span>
    </div>
    <div class="actions">
      <button class="primary" data-edit="${escapeAttr(r.name)}">⤢ ${overridden ? "Edit override" : "Override value"}</button>
      ${overridden ? `<button data-clear="${escapeAttr(r.name)}">↺ Reset</button>` : ""}
    </div>`;

  return `
    <div class="dtf-row${isOpen ? " expanded" : ""}" data-row="${escapeAttr(r.name)}">
      <div class="ic"><span style="color:var(--accent)">${I.sliders}</span></div>
      <div class="meta">
        <div class="k">
          <span class="name">${escapeHtml(r.name)}</span>
          ${copyButton("c:" + r.name, "Copy config name")}
          ${overridden ? `<span class="override-tag">forced</span>` : ""}
        </div>
        <div class="v">${escapeHtml(desc)}</div>
      </div>
      ${val}
    </div>
    <div class="dtf-detail${isOpen ? " open" : ""}">
      <div class="inner"><div class="pad">${detail}</div></div>
    </div>`;
}

export async function renderConfigsPanel(
  container: HTMLElement,
  api: DevtoolsApi,
  view: ViewOpts,
  setOverrideCount: (n: number) => void,
): Promise<void> {
  container.innerHTML = loadingState();
  let configs: ConfigRecord[];
  try {
    configs = await api.configs();
  } catch (err) {
    container.innerHTML = `<div class="se-empty" style="color:var(--danger)">Failed to load configs: ${escapeHtml(String(err))}</div>`;
    see(err).causes_the("config list").to("fail to load");
    return;
  }
  if (configs.length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>configs</em> yet",
      message: "Remote config values you can tweak per-session without redeploying.",
      actions: api.hideAdminLinks
        ? []
        : [
            {
              icon: "+",
              label: "Create new config",
              href: `${api.adminUrl}/dashboard/configs/values/new`,
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
    const filtered = q ? configs.filter((c) => c.name.toLowerCase().includes(q)) : configs;
    const rows = filtered.map(buildRow);
    setOverrideCount(rows.filter((r) => r.override !== undefined).length);

    if (rows.length === 0) {
      container.innerHTML = searchEmptyState(view.search);
      return;
    }

    if (view.view === "page") {
      // Without a way to detect "read on this page" we treat overridden +
      // bridge-known configs as active.
      const active = rows.filter((r) => r.override !== undefined || r.live !== undefined);
      const inactive = rows.filter((r) => !active.includes(r));
      container.innerHTML =
        `<div class="dtf-group">Active on this page<span class="pulse"><span class="d"></span>${active.length} loaded</span></div>` +
        (active.length
          ? active.map((r) => renderRow(r, expanded)).join("")
          : `<div class="se-empty">No configs read on this page yet.</div>`) +
        (inactive.length
          ? `<div class="dtf-group">Other<span class="c">${inactive.length}</span></div>` +
            inactive.map((r) => renderRow(r, expanded)).join("")
          : "");
    } else {
      container.innerHTML =
        `<div class="dtf-group">All configs<span class="c">${rows.length}</span></div>` +
        rows.map((r) => renderRow(r, expanded)).join("");
    }

    container.querySelectorAll<HTMLElement>(".dtf-row").forEach((rowEl) => {
      rowEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".dtf-copy")) return;
        const name = rowEl.dataset.row!;
        expanded = expanded === name ? null : name;
        paint();
      });
    });

    container.querySelectorAll<HTMLElement>("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = btn.getAttribute("data-edit")!;
        const r = rows.find((x) => x.name === name)!;
        openOverrideEditor(container, r, () => paint());
      });
    });
    container.querySelectorAll<HTMLElement>("[data-clear]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setConfigOverride(btn.getAttribute("data-clear")!, null);
      });
    });

    wireCopyButtons(container, Object.fromEntries(rows.map((r) => ["c:" + r.name, () => r.name])));
  }

  paint();
}

// ── Inline override editor ──────────────────────────────────────────────────
// Renders a compact editor in place of the configs list — same panel chrome,
// no full-page modal scrim. Mirrors the inline-form pattern used by the
// feedback panel.

function clone<T>(v: T): T {
  return v == null || typeof v !== "object" ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string | null {
  try {
    const v = new Validator(schema as object, "2020-12", false);
    const result = v.validate(value ?? {});
    if (result.valid) return null;
    return result.errors
      .slice(0, 3)
      .map((e) => `${e.instanceLocation || "/"}: ${e.error}`)
      .join("; ");
  } catch (err) {
    return (err as Error).message;
  }
}

function openOverrideEditor(
  container: HTMLElement,
  row: {
    name: string;
    real: unknown;
    override: unknown;
    schema: Record<string, unknown>;
  },
  onClose: () => void,
): void {
  // Devtool can't edit schemas — only values. Schema is used purely to drive
  // the form layout and validation. Coerce primitive legacy values to {} so
  // the form has an object to render against.
  const initialRaw = row.override !== undefined ? row.override : row.real;
  const initial =
    initialRaw !== null && typeof initialRaw === "object" && !Array.isArray(initialRaw)
      ? (initialRaw as Record<string, unknown>)
      : {};
  let draft: Record<string, unknown> = clone(initial);

  function close(): void {
    document.removeEventListener("keydown", onKey);
    onClose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  }
  function save(): void {
    const err = validateAgainstSchema(draft, row.schema);
    if (err) {
      paintError(err);
      return;
    }
    setConfigOverride(row.name, draft);
    close();
  }
  function paintError(message: string | null): void {
    const errEl = container.querySelector<HTMLElement>("[data-error]");
    if (errEl) errEl.textContent = message ?? "";
  }
  function paint(): void {
    const dirty = !valEqual(draft, row.real);
    container.innerHTML = `
      <div class="dtf-inline-form">
        <div class="hd">
          <button class="back" data-action="close" title="Back (Esc)">${I.arrowLeft} Back</button>
          <span class="k" style="margin-left:8px">${escapeHtml(row.name)}</span>
          <span class="type-tag t-object">object</span>
        </div>
        <div class="bd">
          <div data-form></div>
          <div class="dtf-sf-error" data-error></div>
        </div>
        <div class="ft">
          <button class="ghost" data-action="reset" ${dirty ? "" : "disabled"} style="${dirty ? "" : "opacity:.4"}">↺ Reset</button>
          <span class="sp"></span>
          <button data-action="cancel">Cancel</button>
          <button class="primary" data-action="save">Save <span style="opacity:.6;margin-left:4px">⌘⏎</span></button>
        </div>
      </div>`;

    const formHost = container.querySelector<HTMLElement>("[data-form]")!;
    renderSchemaForm(formHost, row.schema, draft, (next) => {
      draft = next;
      // Live-validate to clear stale errors as the user types.
      paintError(null);
      // Re-render only on dirty toggle to refresh the Reset button state.
      const nowDirty = !valEqual(draft, row.real);
      const resetBtn = container.querySelector<HTMLButtonElement>('[data-action="reset"]');
      if (resetBtn) {
        resetBtn.disabled = !nowDirty;
        resetBtn.style.opacity = nowDirty ? "" : ".4";
      }
    });

    container.querySelector('[data-action="close"]')!.addEventListener("click", close);
    container.querySelector('[data-action="cancel"]')!.addEventListener("click", close);
    container.querySelector('[data-action="save"]')!.addEventListener("click", save);
    container.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
      const realObj =
        row.real !== null && typeof row.real === "object" && !Array.isArray(row.real)
          ? (row.real as Record<string, unknown>)
          : {};
      draft = clone(realObj);
      paint();
    });
  }

  document.addEventListener("keydown", onKey);
  paint();
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
