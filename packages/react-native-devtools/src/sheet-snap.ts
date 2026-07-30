// Snap-point math for the devtools sheet's drag handle. Pure functions (no
// react-native import) so the gesture behaviour is unit-testable: the overlay
// only feeds them PanResponder's dy/vy and renders the returned 0…1 "grow"
// factor through an Animated interpolation.
//
//   grow = 0 → peek: the sheet is content-sized between 55% and 88% of the
//              available height (a short form stays short)
//   grow = 1 → full: min == max == 100%, so even a two-field form can be pulled
//              up to cover the app
//
// Dragging DOWN from peek is the dismiss gesture instead (there is nothing
// shorter to snap to).

/** Finger travel that spans peek → full. Deliberately shorter than the height
 *  it animates: the sheet should reach full screen in one comfortable pull. */
export const DRAG_RANGE = 160;

/** The grow factor for a drag of `dy` (RN sign convention: negative is up)
 *  starting from `from`, clamped to the snap range. */
export function growFromDrag(from: number, dy: number, range: number = DRAG_RANGE): number {
  const next = from - dy / range;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/** Where a released drag lands: a decisive flick wins over position, otherwise
 *  the nearer snap point. */
export function snapTarget(grow: number, velocityY: number): 0 | 1 {
  if (velocityY < -0.5) return 1;
  if (velocityY > 0.5) return 0;
  return grow >= 0.5 ? 1 : 0;
}

/** True when a released drag should close the sheet. Keyed on where the gesture
 *  STARTED: only a pull down from peek dismisses — dragging down from an
 *  expanded sheet just collapses it back to peek. */
export function shouldDismiss(startGrow: number, dy: number, velocityY: number): boolean {
  if (startGrow > 0) return false;
  return dy > 96 || velocityY > 0.8;
}

/** True when the gesture was a tap on the grab handle rather than a drag —
 *  the handle toggles peek ↔ full so expanding never requires a drag. */
export function isHandleTap(dx: number, dy: number): boolean {
  return Math.abs(dx) < 4 && Math.abs(dy) < 4;
}
