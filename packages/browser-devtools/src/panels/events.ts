import { escapeHtml, emptyState } from "./common";

type EventKind = "evaluate" | "override" | "poll" | "update";

interface EventEntry {
  ts: number;
  kind: EventKind;
  /** The subject of the event, e.g. "gate feature_pricing". */
  subject: string;
  /** The resolved value/result, e.g. "true", "control", "2 changed". */
  value: string;
}

const RING_SIZE = 200;
const ring: EventEntry[] = [];

function fmtValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/**
 * Turn a raw `se:state:update` detail into a structured row. The SDK (and the
 * landing demo's synthetic stream) tag details with one of `evaluate` /
 * `override` / `poll`; anything else is shown as a generic state update.
 */
function classify(detail: unknown): { kind: EventKind; subject: string; value: string } {
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.evaluate === "string") {
      return {
        kind: "evaluate",
        subject: `${d.evaluate} ${d.key ?? ""}`.trim(),
        value: fmtValue(d.value ?? d.result ?? d.group),
      };
    }
    if (typeof d.override === "string") {
      return {
        kind: "override",
        subject: `${d.override} ${d.key ?? ""}`.trim(),
        value: fmtValue(d.value ?? d.group) || "set",
      };
    }
    if (typeof d.poll === "string") {
      return {
        kind: "poll",
        subject: `poll ${d.poll}`,
        value: `${fmtValue(d.changed ?? 0)} changed`,
      };
    }
    return { kind: "update", subject: "state update", value: fmtValue(d).slice(0, 120) };
  }
  return { kind: "update", subject: "state update", value: fmtValue(detail) };
}

// Capture SDK state-update events so the panel can replay them when opened.
// The SDK fires `se:state:update` after every identify / override / poll, with
// `detail` describing what changed.
function pushEvent(detail: unknown): void {
  ring.push({ ts: Date.now(), ...classify(detail) });
  if (ring.length > RING_SIZE) ring.shift();
}

if (typeof window !== "undefined") {
  window.addEventListener("se:state:update", (e) => {
    pushEvent((e as CustomEvent<unknown>).detail);
  });
}

function relTs(now: number, ts: number): string {
  const ms = now - ts;
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

const KIND_LABEL: Record<EventKind, string> = {
  evaluate: "eval",
  override: "set",
  poll: "poll",
  update: "sdk",
};

export function renderEventsPanel(container: HTMLElement): void {
  if (ring.length === 0) {
    const { html, wire } = emptyState({
      title: "No <em>events</em> yet",
      message:
        "SDK evaluations and overrides will stream here as the page interacts with ShipEasy.",
    });
    container.innerHTML = html;
    wire(container);
    return;
  }
  const now = Date.now();
  const reversed = ring.slice().reverse();
  container.innerHTML =
    `<div class="dtf-group">Live event stream<span class="pulse"><span class="d"></span>${reversed.length} captured</span></div>` +
    reversed
      .map(
        (e) => `
      <div class="dtf-event" data-kind="${e.kind}">
        <span class="ev-kind ${e.kind}">${KIND_LABEL[e.kind]}</span>
        <span class="ev-subject">${escapeHtml(e.subject)}</span>
        <span class="ev-value">${escapeHtml(e.value)}</span>
        <span class="ev-ts">${relTs(now, e.ts)}</span>
      </div>`,
      )
      .join("");
}
