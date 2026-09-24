// Rectangle and ellipse marquee tools. Modifiers held at pointer-down pick
// the operation (Shift add, Alt subtract, Shift+Alt intersect; otherwise
// the option's mode); during the drag Shift constrains to a square/circle
// and Alt draws from the centre. A click without a drag deselects.

import type { CursorHint, Tool, ToolContext, ToolId } from './types';
import type { PointerInput } from '../input/pointer';
import type { SelectionOp } from '../selection/mask';
import { combineMasks, ellipseMask, featherMask, rectMask } from '../selection/mask';
import type { Point } from '../geometry/affine';
import type { OverlayPainter } from '../render/overlay';
import { shapeDragBox } from './shape';

export interface SelectOptions {
  mode: SelectionOp;
  /** Soft edge (ellipse always anti-aliases unless false). */
  antialias: boolean;
  /** Feather radius, document px. */
  feather: number;
}

export function defaultSelectOptions(): SelectOptions {
  return { mode: 'replace', antialias: true, feather: 0 };
}

export function selectionOpFor(p: PointerInput, fallback: SelectionOp): SelectionOp {
  const { shift, alt } = p.modifiers;
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return fallback;
}

interface Drag {
  op: SelectionOp;
  start: Point;
  from: Point;
  to: Point;
}

export class MarqueeTool implements Tool<SelectOptions> {
  readonly usesSymmetry = false;
  private drag: Drag | null = null;

  constructor(
    readonly id: ToolId,
    readonly label: string,
    readonly shortcut: string,
    private readonly shape: 'rect' | 'ellipse',
  ) {}

  defaultOptions(): SelectOptions {
    return defaultSelectOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(_ctx: ToolContext, p: PointerInput, o: SelectOptions): void {
    const start = { x: p.x, y: p.y };
    this.drag = { op: selectionOpFor(p, o.mode), start, from: start, to: start };
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    const d = this.drag;
    if (!d) return;
    // Modifiers that chose the op at pointer-down do not also constrain.
    const constrain = p.modifiers.shift && d.op !== 'add' && d.op !== 'intersect';
    const centred = p.modifiers.alt && d.op !== 'subtract' && d.op !== 'intersect';
    const box = shapeDragBox(this.shape === 'rect' ? 'rect' : 'ellipse', d.start, { x: p.x, y: p.y }, constrain, centred);
    d.from = box.from;
    d.to = box.to;
    ctx.overlayChanged();
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: SelectOptions): void {
    const d = this.drag;
    if (!d) return;
    this.pointerMove(ctx, p);
    this.drag = null;
    ctx.overlayChanged();
    const { doc } = ctx;
    const x = Math.min(d.from.x, d.to.x);
    const y = Math.min(d.from.y, d.to.y);
    const w = Math.abs(d.to.x - d.from.x);
    const h = Math.abs(d.to.y - d.from.y);
    if (w < 1 || h < 1) {
      if (d.op === 'replace' && doc.selection) ctx.setSelection(null, 'Deselect');
      return;
    }
    // Rectangles snap to whole pixels (crisp edges) unless anti-aliased.
    const r =
      this.shape === 'rect' && !o.antialias
        ? { x: Math.round(x), y: Math.round(y), w: Math.round(x + w) - Math.round(x), h: Math.round(y + h) - Math.round(y) }
        : { x, y, w, h };
    let shape =
      this.shape === 'rect'
        ? rectMask(doc.width, doc.height, r, o.antialias)
        : ellipseMask(doc.width, doc.height, r, o.antialias);
    if (o.feather > 0) shape = featherMask(shape, o.feather) ?? shape;
    ctx.setSelection(combineMasks(doc.selection, shape, d.op), this.label);
  }

  cancel(ctx: ToolContext): void {
    if (!this.drag) return;
    this.drag = null;
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter): void {
    const d = this.drag;
    if (!d) return;
    const x = Math.min(d.from.x, d.to.x);
    const y = Math.min(d.from.y, d.to.y);
    const w = Math.abs(d.to.x - d.from.x);
    const h = Math.abs(d.to.y - d.from.y);
    if (this.shape === 'rect') painter.rect(x, y, w, h, { dash: [4, 4] });
    else painter.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, { dash: [4, 4] });
  }
}

export function createRectSelectTool(): MarqueeTool {
  return new MarqueeTool('selectRect', 'Rectangle select', 'M', 'rect');
}

export function createEllipseSelectTool(): MarqueeTool {
  return new MarqueeTool('selectEllipse', 'Ellipse select', 'Shift+M', 'ellipse');
}
