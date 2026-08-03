// @vitest-environment jsdom
//
// Typing into the overlay must not leak keydowns to the host page. Events
// from the open shadow tree retarget to `#shipeasy-devtools` for window
// listeners, so host-app "G _" chords and similar fire mid-keystroke unless
// we stopPropagation inside the shadow.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverlay } from "../overlay";
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

afterEach(() => {
  document.getElementById("shipeasy-devtools")?.remove();
  sessionStorage.clear();
  localStorage.clear();
});

describe("overlay host-hotkey isolation", () => {
  it("stops composed keydowns from reaching window when typing in the overlay", () => {
    const { destroy } = createOverlay(opts());
    const host = document.getElementById("shipeasy-devtools");
    expect(host?.shadowRoot).toBeTruthy();

    const input = document.createElement("input");
    host!.shadowRoot!.appendChild(input);

    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true }),
    );

    expect(onWindow).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindow);
    destroy();
  });

  it("still lets Escape bubble so document-level overlay handlers can close", () => {
    const { destroy } = createOverlay(opts());
    const host = document.getElementById("shipeasy-devtools")!;
    const input = document.createElement("input");
    host.shadowRoot!.appendChild(input);

    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
    );

    expect(onWindow).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onWindow);
    destroy();
  });

  it("still lets Ctrl/Meta+Enter bubble for overlay save shortcuts", () => {
    const { destroy } = createOverlay(opts());
    const host = document.getElementById("shipeasy-devtools")!;
    const input = document.createElement("input");
    host.shadowRoot!.appendChild(input);

    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        composed: true,
        metaKey: true,
      }),
    );

    expect(onWindow).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onWindow);
    destroy();
  });
});
