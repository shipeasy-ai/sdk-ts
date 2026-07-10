// Minimal screenshot annotator. Draws over a captured image with freehand
// pen, arrow, rectangle, or text shapes. The export merges the source image
// with the annotation overlay into a single PNG blob.
//
// Tooling is intentionally bare: pick a tool, drag (or click for text), undo
// or clear if needed, save. No selection/move/edit — power users can re-take
// the screenshot.

type Tool = "pen" | "arrow" | "rect" | "text";

type Shape =
  | { tool: "pen"; color: string; points: { x: number; y: number }[] }
  | { tool: "arrow"; color: string; x1: number; y1: number; x2: number; y2: number }
  | { tool: "rect"; color: string; x1: number; y1: number; x2: number; y2: number }
  | { tool: "text"; color: string; x1: number; y1: number; text: string };

export interface Annotator {
  root: HTMLElement;
  /** Returns the merged source + annotations as a PNG blob. */
  export(): Promise<Blob>;
}

const COLORS = ["#f87171", "#fbbf24", "#4ade80", "#60a5fa"];

export async function createAnnotator(source: Blob): Promise<Annotator> {
  const url = URL.createObjectURL(source);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot for annotation."));
    img.src = url;
  });

  const root = document.createElement("div");
  root.className = "se-annot";

  const toolbar = document.createElement("div");
  toolbar.className = "se-annot-toolbar";
  root.appendChild(toolbar);

  let tool: Tool = "pen";
  let color = COLORS[0];
  const shapes: Shape[] = [];

  function setTool(t: Tool) {
    tool = t;
    toolbar
      .querySelectorAll<HTMLButtonElement>("[data-tool]")
      .forEach((x) => x.classList.toggle("on", x.dataset.tool === t));
  }

  function makeToolBtn(t: Tool, label: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "se-annot-btn";
    b.dataset.tool = t;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => setTool(t));
    return b;
  }
  toolbar.appendChild(makeToolBtn("pen", "✎ draw", "Freehand draw (P)"));
  toolbar.appendChild(makeToolBtn("arrow", "↗ arrow", "Arrow (A)"));
  toolbar.appendChild(makeToolBtn("rect", "▭ rect", "Rectangle (R)"));
  toolbar.appendChild(makeToolBtn("text", "T text", "Text (T)"));
  setTool("pen");

  const sep = document.createElement("span");
  sep.className = "se-annot-sep";
  toolbar.appendChild(sep);

  for (const c of COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "se-annot-swatch";
    sw.dataset.color = c;
    sw.style.background = c;
    if (c === color) sw.classList.add("on");
    sw.addEventListener("click", () => {
      color = c;
      toolbar
        .querySelectorAll<HTMLButtonElement>("[data-color]")
        .forEach((x) => x.classList.toggle("on", x.dataset.color === c));
    });
    toolbar.appendChild(sw);
  }

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "se-annot-btn";
  undoBtn.textContent = "↶ undo";
  undoBtn.title = "Undo (Ctrl/Cmd+Z)";
  undoBtn.addEventListener("click", () => {
    shapes.pop();
    redraw();
  });
  toolbar.appendChild(undoBtn);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "se-annot-btn";
  clearBtn.textContent = "clear";
  clearBtn.addEventListener("click", () => {
    shapes.length = 0;
    redraw();
  });
  toolbar.appendChild(clearBtn);

  // ── Stage ──────────────────────────────────────────────────────────────────
  const stage = document.createElement("div");
  stage.className = "se-annot-stage";
  root.appendChild(stage);

  // Single canvas that re-renders source + shapes on every interaction —
  // simpler and avoids the overlay/bg sub-pixel alignment issues that crop
  // up when the stage is CSS-scaled to fit the modal.
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.className = "se-annot-canvas";
  canvas.style.cursor = "crosshair";
  canvas.style.touchAction = "none";
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  // Track last pointer pos in canvas space so the T hotkey can spawn a text
  // input where the cursor is rather than at a fixed location.
  let lastCanvasPoint: { x: number; y: number } | null = null;

  function imagePoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }

  function strokeWidth(): number {
    return Math.max(2, Math.round(image.naturalWidth / 400));
  }

  function fontSize(): number {
    return Math.max(14, Math.round(image.naturalWidth / 60));
  }

  function drawShape(s: Shape) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = strokeWidth();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "rect") {
      const x = Math.min(s.x1, s.x2);
      const y = Math.min(s.y1, s.y2);
      const w = Math.abs(s.x2 - s.x1);
      const h = Math.abs(s.y2 - s.y1);
      ctx.strokeRect(x, y, w, h);
    } else if (s.tool === "arrow") {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = strokeWidth() * 5;
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(
        s.x2 - head * Math.cos(angle - Math.PI / 6),
        s.y2 - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        s.x2 - head * Math.cos(angle + Math.PI / 6),
        s.y2 - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    } else if (s.tool === "pen") {
      if (s.points.length < 2) {
        if (s.points.length === 1) {
          const p = s.points[0];
          ctx.beginPath();
          ctx.arc(p.x, p.y, strokeWidth() / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x, s.points[i].y);
        }
        ctx.stroke();
      }
    } else if (s.tool === "text" && s.text) {
      const fs = fontSize();
      ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const padding = fs * 0.3;
      const metrics = ctx.measureText(s.text);
      const w = metrics.width + padding * 2;
      const h = fs + padding * 2;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(s.x1, s.y1, w, h);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x1 + padding, s.y1 + padding);
    }
    ctx.restore();
  }

  function redraw(preview?: Shape) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    for (const s of shapes) drawShape(s);
    if (preview) drawShape(preview);
  }
  redraw();

  // ── Inline text input ──────────────────────────────────────────────────────
  // Click (with text tool) or T hotkey spawns an editable input positioned
  // over the canvas. Enter / blur commits, Escape cancels.
  let activeTextInput: HTMLInputElement | null = null;

  function spawnTextInput(canvasX: number, canvasY: number) {
    if (activeTextInput) {
      activeTextInput.blur();
    }
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;
    const fs = fontSize() * scaleX;
    const padding = fs * 0.3;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "se-annot-text-input";
    input.style.position = "absolute";
    input.style.left = `${canvasRect.left - stageRect.left + canvasX * scaleX}px`;
    input.style.top = `${canvasRect.top - stageRect.top + canvasY * scaleY}px`;
    input.style.color = color;
    input.style.background = "rgba(0,0,0,0.55)";
    input.style.border = `1px dashed ${color}`;
    input.style.outline = "none";
    input.style.padding = `${padding}px`;
    input.style.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    input.style.minWidth = `${fs * 4}px`;
    input.style.lineHeight = "1";
    input.placeholder = "type…";

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      input.remove();
      activeTextInput = null;
      if (text) {
        shapes.push({ tool: "text", color, x1: canvasX, y1: canvasY, text });
        redraw();
      }
    }
    function cancel() {
      if (committed) return;
      committed = true;
      input.remove();
      activeTextInput = null;
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
      // Don't let typed letters (T, R, A, P) leak to the document hotkey
      // listener and switch tools mid-sentence.
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);

    stage.appendChild(input);
    activeTextInput = input;
    setTimeout(() => input.focus(), 0);
  }

  // ── Pointer interactions ──────────────────────────────────────────────────
  // pen: append-on-move; arrow/rect: drag preview; text: click to place input.
  let dragging:
    | { kind: "pen"; shape: Shape & { tool: "pen" } }
    | { kind: "shape"; x1: number; y1: number }
    | null = null;

  canvas.addEventListener("pointermove", (e) => {
    lastCanvasPoint = imagePoint(e);
    if (!dragging) return;
    if (dragging.kind === "pen") {
      dragging.shape.points.push(lastCanvasPoint);
      redraw();
    } else {
      redraw({
        tool: tool === "text" ? "rect" : (tool as "arrow" | "rect"),
        color,
        x1: dragging.x1,
        y1: dragging.y1,
        x2: lastCanvasPoint.x,
        y2: lastCanvasPoint.y,
      });
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = imagePoint(e);
    lastCanvasPoint = p;
    if (tool === "text") {
      spawnTextInput(p.x, p.y);
      return;
    }
    if (tool === "pen") {
      const shape: Shape & { tool: "pen" } = { tool: "pen", color, points: [p] };
      shapes.push(shape);
      dragging = { kind: "pen", shape };
      canvas.setPointerCapture(e.pointerId);
      redraw();
      return;
    }
    dragging = { kind: "shape", x1: p.x, y1: p.y };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    const p = imagePoint(e);
    if (dragging.kind === "shape") {
      const dx = Math.abs(p.x - dragging.x1);
      const dy = Math.abs(p.y - dragging.y1);
      if ((dx > 4 || dy > 4) && (tool === "arrow" || tool === "rect")) {
        shapes.push({ tool, color, x1: dragging.x1, y1: dragging.y1, x2: p.x, y2: p.y });
      }
    }
    dragging = null;
    redraw();
  });

  // ── Hotkeys ───────────────────────────────────────────────────────────────
  // Listen on document so the user doesn't have to focus the canvas first.
  // Auto-noop after the modal closes (root detaches from the tree).
  function isTypingTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!root.isConnected) {
      document.removeEventListener("keydown", onKeyDown, true);
      return;
    }
    if (isTypingTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      shapes.pop();
      redraw();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (key === "t") {
      e.preventDefault();
      setTool("text");
      const p = lastCanvasPoint ?? { x: canvas.width / 2, y: canvas.height / 2 };
      spawnTextInput(p.x, p.y);
    } else if (key === "p") {
      setTool("pen");
    } else if (key === "a") {
      setTool("arrow");
    } else if (key === "r") {
      setTool("rect");
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  return {
    root,
    async export(): Promise<Blob> {
      // If the user hits Save with a text input still open, commit it first
      // so its content lands in the export.
      if (activeTextInput) activeTextInput.blur();
      // toBlob is async; give the commit's redraw a tick to land.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      });
      URL.revokeObjectURL(url);
      document.removeEventListener("keydown", onKeyDown, true);
      return blob;
    },
  };
}
