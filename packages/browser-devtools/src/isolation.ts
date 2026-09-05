// Event isolation for the overlay's shadow trees.
//
// Every event that originates inside an *open* shadow tree retargets to the
// shadow host (`#shipeasy-devtools`, `#se-popper-host`) once it crosses the
// boundary, so window/document listeners in the embedding app see a click
// "on a div in the body" — outside whatever modal, popover or menu is open.
// The app then does the obvious thing: dismisses it. The devtools panel is
// chrome layered over someone else's page; interacting with it must not move
// the page underneath.
//
// The rule: pointer, click and focus events stop at the shadow root, so the
// host page never learns the user touched the overlay. Keyboard events stop
// too (host hotkey guards only check INPUT/TEXTAREA and so fire mid-keystroke
// on a retargeted div), with two exceptions — Escape and ⌘/Ctrl+Enter still
// bubble, because the overlay's own document-level handlers (inline config
// editor, feedback modals, i18n popper) listen for them there.
//
// Only the *bubble* phase is stopped. Capture-phase document listeners run
// before the target is reached and so are untouched — which is what the
// overlay's own outside-click detectors and drag handlers rely on.

/** Pointer/click/focus events that must not escape the shadow tree. */
const POINTER_EVENTS = [
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
] as const;

const KEY_EVENTS = ["keydown", "keyup"] as const;

// Typed as `Event`, not KeyboardEvent: ShadowRoot only overloads
// addEventListener for "slotchange", so every other type falls through to the
// plain `EventListener` signature.
function isolateHostHotkeys(evt: Event): void {
  const e = evt as KeyboardEvent;
  if (e.key === "Escape") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") return;
  e.stopPropagation();
}

function isolatePointer(evt: Event): void {
  evt.stopPropagation();
}

/**
 * Keep the host page from seeing interactions with an overlay shadow tree.
 * Returns a teardown that removes every listener it added.
 */
export function isolateShadowEvents(shadow: ShadowRoot): () => void {
  for (const type of KEY_EVENTS) shadow.addEventListener(type, isolateHostHotkeys);
  for (const type of POINTER_EVENTS) shadow.addEventListener(type, isolatePointer);
  return () => {
    for (const type of KEY_EVENTS) shadow.removeEventListener(type, isolateHostHotkeys);
    for (const type of POINTER_EVENTS) shadow.removeEventListener(type, isolatePointer);
  };
}
