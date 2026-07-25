import { I } from "../icons";

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

export function timeAgo(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  if (Number.isNaN(d)) return "—";
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function loadingState(): string {
  let html = `<div class="dtf-load"><div class="topstrip"></div>`;
  for (let i = 1; i <= 6; i++) {
    const live = i <= 3 ? " live" : "";
    const w1 = 50 + ((i * 7) % 30);
    const w2 = 36 + ((i * 11) % 24);
    html += `
      <div class="skel-row${live}">
        <div class="ic"></div>
        <div class="body">
          <div class="skel" style="height:9px; width:${w1}%"></div>
          <div class="skel" style="height:7px; width:${w2}%"></div>
        </div>
        <div class="skel" style="height:10px; width:38px"></div>
        <div class="togsk"></div>
      </div>`;
  }
  return html + `</div>`;
}

interface EmptyOpts {
  title: string; // accent word can be wrapped: "Nothing fired<br/>on <em>this route.</em>"
  message: string;
  actions?: Array<{
    icon?: string;
    label: string;
    kbd?: string;
    onClick?: () => void;
    href?: string | null;
  }>;
}

export function emptyState(opts: EmptyOpts): { html: string; wire: (root: ParentNode) => void } {
  const acts = (opts.actions ?? [])
    .map((a, i) =>
      a.href
        ? `<a class="a" target="_blank" rel="noopener" href="${escapeHtml(a.href)}" data-i="${i}">
            <span class="ic">${a.icon ?? "+"}</span><span class="k">${escapeHtml(a.label)}</span>${a.kbd ? `<span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}
          </a>`
        : `<button class="a" data-i="${i}">
            <span class="ic">${a.icon ?? "+"}</span><span class="k">${escapeHtml(a.label)}</span>${a.kbd ? `<span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}
          </button>`,
    )
    .join("");
  const html = `
    <div class="dtf-empty">
      <div class="vis"><div class="ring r2"></div><div class="ring"></div><div class="core">0</div></div>
      <h3>${opts.title}</h3>
      <p>${escapeHtml(opts.message)}</p>
      ${acts ? `<div class="actions">${acts}</div>` : ""}
    </div>`;
  const wire = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(".dtf-empty .actions [data-i]").forEach((el) => {
      const i = Number(el.dataset.i!);
      const a = opts.actions?.[i];
      if (a?.onClick) el.addEventListener("click", a.onClick);
    });
  };
  return { html, wire };
}

export function searchEmptyState(query: string): string {
  return `
    <div class="dtf-empty search">
      <div class="glyph"><span>[</span><span class="core"></span><span>]</span></div>
      <h3>No match for<br/><em style="font-family:var(--mono);font-style:normal;font-size:14px;color:var(--fg-3)">"${escapeHtml(query)}"</em></h3>
      <p>Nothing in your project shares that key.</p>
    </div>`;
}

/** Renders a copy-icon button. Wires by attaching a click handler that copies `getValue()`. */
export function copyButton(id: string, title = "Copy value"): string {
  return `<button class="dtf-copy" data-copy="${id}" title="${escapeHtml(title)}">${I.copy}</button>`;
}

export function wireCopyButtons(root: ParentNode, values: Record<string, () => string>): void {
  root.querySelectorAll<HTMLButtonElement>(".dtf-copy[data-copy]").forEach((btn) => {
    const id = btn.dataset.copy!;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const val = values[id]?.();
      if (val == null) return;
      try {
        await navigator.clipboard.writeText(val);
      } catch {
        /* ignore */
      }
      btn.classList.add("done");
      btn.innerHTML = I.check;
      setTimeout(() => {
        btn.classList.remove("done");
        btn.innerHTML = I.copy;
      }, 900);
    });
  });
}
