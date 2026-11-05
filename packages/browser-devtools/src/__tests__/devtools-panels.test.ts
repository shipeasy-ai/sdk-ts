// @vitest-environment jsdom
//
// shipeasy #271: the Killswitches panel exists, experiment variant weights are
// basis points rendered as real percentages, and the User panel states which
// project the overlay is bound to. #71: the attachments field is a dropzone.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentRecord, KillswitchRecord } from "../types";
import { fmtWeightPct, variantRows } from "../panels/experiments";
import { boundProjectHtml } from "../panels/user";
import { buildKillswitchRow, renderKillswitchesPanel } from "../panels/killswitches";
import { ATTACHMENTS_FIELD_HTML, wireAttachments } from "../panels/feedback";

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { __shipeasy?: unknown }).__shipeasy;
});

const exp = (groups: Array<{ name: string; weight: number }>): ExperimentRecord => ({
  id: "e1",
  name: "checkout",
  universe: "default",
  status: "running",
  groups,
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("experiment variant percentages", () => {
  it("renders basis points as percentages, not x100", () => {
    expect(fmtWeightPct(5000)).toBe("50%");
    expect(fmtWeightPct(2500)).toBe("25%");
    expect(fmtWeightPct(2050)).toBe("20.5%");
  });

  it("gives control the remainder when it is not stored", () => {
    const rows = variantRows(exp([{ name: "treatment", weight: 5000 }]));
    expect(rows).toEqual([
      { name: "control", weight: 5000 },
      { name: "treatment", weight: 5000 },
    ]);
  });

  it("keeps a stored control weight", () => {
    const rows = variantRows(
      exp([
        { name: "control", weight: 7000 },
        { name: "treatment", weight: 3000 },
      ]),
    );
    expect(rows[0]).toEqual({ name: "control", weight: 7000 });
  });
});

describe("User panel project binding", () => {
  it("states the bound project and flags a differing user.project_id", () => {
    const html = boundProjectHtml("p-platform", "shipeasy", { project_id: "p-probe" });
    expect(html).toContain("shipeasy (p-platform)");
    expect(html).toContain("data-project-mismatch");
    expect(html).toContain("p-probe");
  });

  it("is quiet when the ids agree", () => {
    const html = boundProjectHtml("p1", "Acme", { project_id: "p1" });
    expect(html).not.toContain("data-project-mismatch");
  });
});

const ks = (name: string, value: boolean): KillswitchRecord => ({
  id: name,
  name,
  description: null,
  updatedAt: "2026-01-01T00:00:00Z",
  envs: { prod: { value, version: 1, publishedAt: "2026-01-01T00:00:00Z" } },
});

describe("Killswitches panel", () => {
  it("prefers the live SDK value over the published one", () => {
    (window as unknown as { __shipeasy: unknown }).__shipeasy = {
      getFlag: () => false,
      getExperiment: () => undefined,
      getConfig: () => undefined,
      getKillswitch: (n: string) => n === "payments.kill",
    };
    expect(buildKillswitchRow(ks("payments.kill", false)).effective).toBe(true);
    // Published killed, but the page's SDK serves live: the page wins.
    expect(buildKillswitchRow(ks("search.kill", true)).effective).toBe(false);
  });

  it("falls back to the published value without a bridge", () => {
    expect(buildKillswitchRow(ks("search.kill", true)).effective).toBe(true);
    expect(buildKillswitchRow(ks("other.kill", false)).effective).toBe(false);
  });

  it("renders a row per killswitch with KILLED / LIVE state", async () => {
    const container = document.createElement("div");
    const api = {
      killswitches: async () => [ks("payments.kill", true), ks("search.kill", false)],
      hideAdminLinks: true,
    };
    await renderKillswitchesPanel(
      container,
      api as never,
      { view: "all", search: "" },
      vi.fn(),
    );
    expect(container.querySelectorAll(".dtf-row")).toHaveLength(2);
    expect(container.textContent).toContain("payments.kill");
    expect(container.textContent).toContain("KILLED");
    expect(container.textContent).toContain("LIVE");
  });
});

describe("attachments dropzone", () => {
  function mount() {
    const modal = document.createElement("div");
    modal.innerHTML = ATTACHMENTS_FIELD_HTML;
    document.body.appendChild(modal);
    const shadow = document.createElement("div").attachShadow({ mode: "open" });
    const result = wireAttachments(modal, shadow, modal, vi.fn());
    return { modal, ...result };
  }

  function dropEvent(type: string, files: File[]): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", {
      value: { types: ["Files"], files, dropEffect: "none" },
    });
    return e;
  }

  it("adds dropped files as attachments and highlights while dragging", () => {
    const { modal, attachments } = mount();
    const zone = modal.querySelector<HTMLElement>("[data-attach-drop]")!;
    zone.dispatchEvent(dropEvent("dragenter", []));
    expect(zone.classList.contains("dropping")).toBe(true);

    const png = new File(["x"], "shot.png", { type: "image/png" });
    const pdf = new File(["y"], "notes.pdf", { type: "application/pdf" });
    const drop = dropEvent("drop", [png, pdf]);
    zone.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(zone.classList.contains("dropping")).toBe(false);
    expect(attachments.map((a) => [a.filename, a.kind])).toEqual([
      ["shot.png", "screenshot"],
      ["notes.pdf", "file"],
    ]);
  });

  it("ignores drags that carry no files", () => {
    const { modal, attachments } = mount();
    const zone = modal.querySelector<HTMLElement>("[data-attach-drop]")!;
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
    zone.dispatchEvent(e);
    expect(attachments).toHaveLength(0);
  });
});
