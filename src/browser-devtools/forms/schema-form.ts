/**
 * Schema-driven form renderer for the devtool override modal.
 *
 * Configs are JSON objects defined by a flat JSON Schema (no nested objects,
 * no arrays of objects). The schema-builder in the dashboard guarantees this
 * shape; we only render `schema.properties` at the top level.
 *
 * Field type → input mapping:
 *   string                                    → <input type="text">
 *   string with `enum`                        → <select>
 *   number / integer                          → <input type="number">
 *   boolean                                   → toggle button pair
 *   array (items.type ∈ string|number|bool)   → comma-separated text input
 */

type JsonSchemaLike = {
  type?: unknown;
  properties?: Record<string, FieldSchema>;
  required?: string[];
  description?: string;
} & Record<string, unknown>;

type FieldSchema = {
  type?: unknown;
  enum?: unknown[];
  description?: string;
  items?: { type?: unknown };
} & Record<string, unknown>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function fieldsOf(schema: JsonSchemaLike): Array<[string, FieldSchema]> {
  const properties = schema.properties ?? {};
  return Object.entries(properties);
}

function isRequired(schema: JsonSchemaLike, name: string): boolean {
  const r = schema.required;
  return Array.isArray(r) && r.includes(name);
}

function readField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

/** Replace `value[name] = next`, returning a new object. */
function writeField(value: unknown, name: string, next: unknown): Record<string, unknown> {
  const base =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { ...base, [name]: next };
}

function fieldType(field: FieldSchema): "string" | "number" | "boolean" | "array" | "enum" {
  if (Array.isArray(field.enum) && field.enum.length > 0) return "enum";
  if (field.type === "array") return "array";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "boolean") return "boolean";
  return "string";
}

function arrayItemType(field: FieldSchema): "string" | "number" | "boolean" {
  const t = field.items?.type;
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

function renderField(name: string, field: FieldSchema, value: unknown, required: boolean): string {
  const ft = fieldType(field);
  const lbl = `<label class="dtf-sf-lbl"><span class="k">${escapeHtml(name)}</span>${required ? `<span class="req">*</span>` : ""}<span class="t">${ft}</span></label>`;
  let input = "";

  if (ft === "boolean") {
    const b = value === true;
    input = `<span class="dtf-sf-bool">
      <button type="button" class="t${b ? " on" : ""}" data-bool-true>true</button>
      <button type="button" class="f${b === false ? " on" : ""}" data-bool-false>false</button>
    </span>`;
  } else if (ft === "number") {
    const n = typeof value === "number" ? String(value) : "";
    input = `<input type="number" value="${escapeAttr(n)}" data-input />`;
  } else if (ft === "enum") {
    const opts = (field.enum ?? []).map((o) => String(o));
    const cur = String(value ?? "");
    input = `<select data-input>${opts
      .map(
        (o) =>
          `<option value="${escapeAttr(o)}"${o === cur ? " selected" : ""}>${escapeHtml(o)}</option>`,
      )
      .join("")}</select>`;
  } else if (ft === "array") {
    const arr = Array.isArray(value) ? value : [];
    const text = arr.map((v) => String(v)).join(", ");
    const itemT = arrayItemType(field);
    input = `<input type="text" value="${escapeAttr(text)}" data-input data-array-items="${itemT}" placeholder="comma-separated ${itemT}s" />`;
  } else {
    const s =
      typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : String(value);
    input = `<input type="text" value="${escapeAttr(s)}" data-input />`;
  }

  const desc = field.description
    ? `<div class="dtf-sf-desc">${escapeHtml(field.description)}</div>`
    : "";

  return `<div class="dtf-sf-field" data-field="${escapeAttr(name)}">${lbl}${input}${desc}</div>`;
}

function parseArrayInput(text: string, itemType: "string" | "number" | "boolean"): unknown[] {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (itemType === "number") return parts.map((p) => Number(p)).filter((n) => !Number.isNaN(n));
  if (itemType === "boolean") return parts.map((p) => p === "true");
  return parts;
}

/**
 * Render the form into `host` and wire input handlers. Calling `setValue` from
 * outside (e.g. on Reset) will not re-render — the caller should call
 * `renderSchemaForm` again with the new value to swap inputs cleanly.
 */
export function renderSchemaForm(
  host: HTMLElement,
  schema: JsonSchemaLike,
  value: unknown,
  onChange: (next: Record<string, unknown>) => void,
): void {
  const fields = fieldsOf(schema);
  if (fields.length === 0) {
    host.innerHTML = `<div class="dtf-sf-empty">This config has no schema fields. Define fields in the dashboard to enable schema-driven editing.</div>`;
    return;
  }
  host.innerHTML = `<div class="dtf-sf">${fields
    .map(([n, f]) => renderField(n, f, readField(value, n), isRequired(schema, n)))
    .join("")}</div>`;

  for (const [name, field] of fields) {
    const fieldEl = host.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
    if (!fieldEl) continue;
    const ft = fieldType(field);

    if (ft === "boolean") {
      const tBtn = fieldEl.querySelector<HTMLButtonElement>("[data-bool-true]");
      const fBtn = fieldEl.querySelector<HTMLButtonElement>("[data-bool-false]");
      tBtn?.addEventListener("click", () => onChange(writeField(value, name, true)));
      fBtn?.addEventListener("click", () => onChange(writeField(value, name, false)));
      continue;
    }

    const input = fieldEl.querySelector<HTMLInputElement | HTMLSelectElement>("[data-input]");
    if (!input) continue;

    if (ft === "number") {
      input.addEventListener("input", () => {
        const v = (input as HTMLInputElement).value;
        if (v === "") onChange(writeField(value, name, undefined));
        else {
          const n = Number(v);
          if (!Number.isNaN(n)) onChange(writeField(value, name, n));
        }
      });
    } else if (ft === "array") {
      const itemT = (input.dataset.arrayItems ?? "string") as "string" | "number" | "boolean";
      input.addEventListener("input", () => {
        const arr = parseArrayInput((input as HTMLInputElement).value, itemT);
        onChange(writeField(value, name, arr));
      });
    } else {
      // string or enum
      input.addEventListener("input", () => onChange(writeField(value, name, input.value)));
      input.addEventListener("change", () => onChange(writeField(value, name, input.value)));
    }
  }
}
