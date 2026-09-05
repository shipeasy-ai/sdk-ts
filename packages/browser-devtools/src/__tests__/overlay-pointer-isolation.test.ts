// @vitest-environment jsdom
//
// Clicking the overlay must not read, to the embedding app, as a click on the
// page behind it. Events from the open shadow tree retarget to
// `#shipeasy-devtools` for document listeners, so a host modal's
// outside-press handler sees a click outside itself and dismisses — while the
// devtools control the user actually aimed at never gets its turn.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverlay } from "../overlay";
import { isolateShadowEvents } from "../isolation";
import type { DevtoolsOptions } from "../types";

function opts(overrides: Partial<DevtoolsOptions> = {}): Required<DevtoolsOptions> {
  return {
    adminUrl: "https://shipeasy.ai",
    clientKey: "",
    projectId: "proj_test",
    hideAdminLinks: true,
    accentColor: "",
    seed: {},
    hideRail: true,
    onClose: () => {},
    ...overrides,
  };
}

function mountOverlay() {
  const { destroy } = createOverlay(opts());
  const host = document.getElementById("shipeasy-devtools")!;
  const btn = document.createElement("button");
  host.shadowRoot!.appendChild(btn);
  return { destroy, btn };
}

afterEach(() => {
  document.getElementById("shipeasy-devtools")?.remove();
  document.getElementById("se-popper-host")?.remove();
  sessionStorage.clear();
  localStorage.clear();
});

const POINTER_TYPES = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
  "focusin",
  "focusout",
];

describe("overlay pointer isolation", () => {
  it("stops composed pointer/click/focus events from reaching the host page", () => {
    const { destroy, btn } = mountOverlay();

    for (const type of POINTER_TYPES) {
      const onDoc = vi.fn();
      document.addEventListener(type, onDoc);
      btn.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      expect(onDoc, `${type} leaked to the host page`).not.toHaveBeenCalled();
      document.removeEventListener(type, onDoc);
    }

    destroy();
  });

  it("still fires the overlay's own capture-phase document listeners", () => {
    const { destroy, btn } = mountOverlay();

    // Outside-click detectors and drag handlers inside the overlay listen on
    // document in the capture phase, which runs before the target is reached.
    const onCapture = vi.fn();
    document.addEventListener("mousedown", onCapture, true);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(onCapture).toHaveBeenCalledTimes(1);
    document.removeEventListener("mousedown", onCapture, true);
    destroy();
  });

  it("lets clicks reach handlers inside the shadow tree", () => {
    const { destroy, btn } = mountOverlay();

    const onBtn = vi.fn();
    btn.addEventListener("click", onBtn);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onBtn).toHaveBeenCalledTimes(1);
    destroy();
  });

  it("releases every listener on teardown", () => {
    const { destroy, btn } = mountOverlay();
    destroy();

    // The node is detached with the host, so re-home it in the document to
    // prove the isolation listeners themselves are gone.
    document.body.appendChild(btn);
    const onDoc = vi.fn();
    document.addEventListener("click", onDoc);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onDoc).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", onDoc);
    btn.remove();
  });

  it("isolates any shadow root it is applied to, and stops when released", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("span");
    shadow.appendChild(inner);

    const release = isolateShadowEvents(shadow);
    const onDoc = vi.fn();
    document.addEventListener("click", onDoc);
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onDoc).not.toHaveBeenCalled();

    release();
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onDoc).toHaveBeenCalledTimes(1);

    document.removeEventListener("click", onDoc);
    host.remove();
  });
});
