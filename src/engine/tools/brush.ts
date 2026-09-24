// Brush and eraser: round dabs placed along the (optionally 1€-smoothed)
// pointer path at a spacing relative to the brush size, with pressure
// driving size and/or flow, replicated through the symmetry transforms.

import type { CursorHint, Tool, ToolContext, ToolId } from './types';
import type { DabShape, StrokeMode } from './paint';
import { compositeStroke, stampDab } from './paint';
import type { PointerInput } from '../input/pointer';
import type { Dab, StrokePoint } from '../input/stroke-sampler';
import { StrokeSampler } from '../input/stroke-sampler';
import { OneEuroFilter2D, smoothingToOneEuro } from '../input/one-euro';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { Affine, Point } from '../geometry/affine';
import { IDENTITY, apply } from '../geometry/affine';
import { symmetryTransforms } from '../symmetry/symmetry';
import type { Rgba } from '../color/color';
import type { SelectionMask } from '../selection/mask';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';
import type { OverlayPainter } from '../render/overlay';

export interface BrushOptions {
  /** Diameter, document px (1..512). */
  size: number;
  /** 0 soft … 1 hard. */
  hardness: number;
  /** Distance between dabs as a fraction of the diameter (0.01..2). */
  spacing: number;
  /** Per-dab strength, 0..1 (builds up within a stroke). */
  flow: number;
  /** Maximum stroke opacity, 0..1. */
  opacity: number;
  /** Pen pressure scales the size (down to `minSize`). */
  pressureSize: boolean;
  /** Pen pressure scales the flow. */
  pressureOpacity: boolean;
  /** Size at zero pressure, as a fraction of `size` (0..1). */
  minSize: number;
  /** 1€ smoothing amount, 0 (off) … 1. */
  smoothing: number;
  /** With smoothing, finish the stroke at the real pointer position. */
  catchUp: boolean;
}

export function defaultBrushOptions(): BrushOptions {
  return {
    size: 24,
    hardness: 0.8,
    spacing: 0.15,
    flow: 1,
    opacity: 1,
    pressureSize: true,
    pressureOpacity: false,
    minSize: 0.2,
    smoothing: 0.3,
    catchUp: true,
  };
}

interface Stroke {
  tx: PixelTransaction;
  alpha: Float32Array;
  color: Rgba;
  selection: SelectionMask | null;
  transforms: Affine[];
  sampler: StrokeSampler;
  filter: OneEuroFilter2D | null;
  aliased: boolean;
  last: PointerInput;
}

/** Radius for a dab at `pressure`. */
export function brushRadius(o: BrushOptions, pressure: number): number {
  const size = Math.max(1, o.size);
  const k = o.pressureSize ? o.minSize + (1 - o.minSize) * pressure : 1;
  return (size * Math.max(0.01, k)) / 2;
}

export class BrushTool implements Tool<BrushOptions> {
  readonly usesSymmetry = true;
  private stroke: Stroke | null = null;

  constructor(
    readonly id: ToolId,
    readonly label: string,
    readonly shortcut: string,
    private readonly mode: StrokeMode,
  ) {}

  defaultOptions(): BrushOptions {
    return this.mode === 'erase' ? { ...defaultBrushOptions(), hardness: 0.9 } : defaultBrushOptions();
  }

  cursor(o: BrushOptions): CursorHint {
    return { css: 'crosshair', radius: Math.max(1, o.size) / 2 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: BrushOptions): void {
    this.cancel(ctx);
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    const smoothing = smoothingToOneEuro(o.smoothing);
    const stroke: Stroke = {
      tx: ctx.beginPixels(layer),
      alpha: ctx.scratch.floatPlane(doc.width * doc.height),
      color: p.button === 2 ? ctx.secondary : ctx.primary,
      selection: doc.selection,
      transforms: this.usesSymmetry ? symmetryTransforms(ctx.symmetry, doc.width, doc.height) : [IDENTITY],
      sampler: new StrokeSampler((d) => Math.max(0.5, o.spacing * 2 * brushRadius(o, d.pressure))),
      filter: smoothing ? new OneEuroFilter2D(smoothing) : null,
      aliased: doc.pixelArt !== null,
      last: p,
    };
    this.stroke = stroke;
    this.paint(ctx, stroke, stroke.sampler.begin(this.filtered(stroke, p)), o);
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: BrushOptions): void {
    const s = this.stroke;
    if (!s) return;
    s.last = p;
    this.paint(ctx, s, s.sampler.add(this.filtered(s, p)), o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: BrushOptions): void {
    const s = this.stroke;
    if (!s) return;
    // Pens usually report zero pressure on release; keep the last pressure.
    const end: PointerInput = { ...p, pressure: s.last.pressure, tiltX: s.last.tiltX, tiltY: s.last.tiltY };
    this.pointerMove(ctx, end, o);
    if (s.filter && o.catchUp) this.paint(ctx, s, s.sampler.add(toStrokePoint(end)), o);
    this.stroke = null;
    ctx.commitPixels(s.tx, this.mode === 'erase' ? 'Eraser' : 'Brush');
  }

  cancel(ctx: ToolContext): void {
    if (!this.stroke) return;
    ctx.cancelPixels(this.stroke.tx);
    this.stroke = null;
  }

  drawOverlay(painter: OverlayPainter, _ctx: ToolContext, o: BrushOptions, hover: Point | null): void {
    if (!hover) return;
    const r = brushRadius(o, 1);
    if (r * painter.scale >= 3) painter.ellipse(hover.x, hover.y, r, r);
  }

  private filtered(s: Stroke, p: PointerInput): StrokePoint {
    const pt = toStrokePoint(p);
    if (!s.filter) return pt;
    const f = s.filter.filter(p.x, p.y, p.time);
    return { ...pt, x: f.x, y: f.y };
  }

  private paint(ctx: ToolContext, s: Stroke, dabs: Dab[], o: BrushOptions): void {
    if (dabs.length === 0) return;
    const { width: w, height: h } = ctx.doc;
    // One dirty rect per symmetric copy keeps the recomposite area tight.
    const rects: (Rect | null)[] = s.transforms.map(() => null);
    for (const d of dabs) {
      const shape: DabShape = { radius: brushRadius(o, d.pressure), hardness: o.hardness, aliased: s.aliased };
      const flow = Math.min(1, Math.max(0, o.flow)) * (o.pressureOpacity ? d.pressure : 1);
      for (let t = 0; t < s.transforms.length; t++) {
        const q = apply(s.transforms[t], d.x, d.y);
        rects[t] = unionRect(rects[t], stampDab(s.alpha, w, h, q.x, q.y, shape, flow));
      }
    }
    for (const r of rects) {
      if (r) compositeStroke(s.tx, s.alpha, r, s.color, Math.min(1, Math.max(0, o.opacity)), this.mode, s.selection);
    }
    ctx.pixelsChanged(s.tx);
  }
}

function toStrokePoint(p: PointerInput): StrokePoint {
  return { x: p.x, y: p.y, pressure: p.pressure, tiltX: p.tiltX, tiltY: p.tiltY };
}

export function createBrushTool(): BrushTool {
  return new BrushTool('brush', 'Brush', 'B', 'paint');
}

export function createEraserTool(): BrushTool {
  return new BrushTool('eraser', 'Eraser', 'E', 'erase');
}
