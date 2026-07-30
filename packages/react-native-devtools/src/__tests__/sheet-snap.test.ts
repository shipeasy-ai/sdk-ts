import { describe, expect, it } from "vitest";
import { DRAG_RANGE, growFromDrag, isHandleTap, shouldDismiss, snapTarget } from "../sheet-snap";

describe("growFromDrag", () => {
  it("grows on an upward drag (negative dy)", () => {
    expect(growFromDrag(0, -DRAG_RANGE / 2)).toBeCloseTo(0.5);
    expect(growFromDrag(0, -DRAG_RANGE)).toBe(1);
  });

  it("shrinks on a downward drag", () => {
    expect(growFromDrag(1, DRAG_RANGE / 4)).toBeCloseTo(0.75);
    expect(growFromDrag(1, DRAG_RANGE)).toBe(0);
  });

  it("clamps past both snap points", () => {
    expect(growFromDrag(1, -600)).toBe(1);
    expect(growFromDrag(0, 600)).toBe(0);
  });
});

describe("snapTarget", () => {
  it("follows a decisive flick over position", () => {
    expect(snapTarget(0.1, -1.2)).toBe(1);
    expect(snapTarget(0.9, 1.2)).toBe(0);
  });

  it("otherwise lands on the nearer point", () => {
    expect(snapTarget(0.49, 0)).toBe(0);
    expect(snapTarget(0.5, 0)).toBe(1);
  });
});

describe("shouldDismiss", () => {
  it("dismisses a deliberate pull or flick down from peek", () => {
    expect(shouldDismiss(0, 120, 0.1)).toBe(true);
    expect(shouldDismiss(0, 20, 1.4)).toBe(true);
  });

  it("ignores a short drag", () => {
    expect(shouldDismiss(0, 40, 0.2)).toBe(false);
  });

  it("never dismisses a drag that STARTED expanded — that one just collapses", () => {
    expect(shouldDismiss(0.4, 400, 2)).toBe(false);
    expect(shouldDismiss(1, 400, 2)).toBe(false);
  });
});

describe("isHandleTap", () => {
  it("treats a travel-free press as a tap (toggles peek ↔ full)", () => {
    expect(isHandleTap(0, 0)).toBe(true);
    expect(isHandleTap(2, -3)).toBe(true);
  });

  it("treats real travel as a drag", () => {
    expect(isHandleTap(0, -12)).toBe(false);
  });
});
