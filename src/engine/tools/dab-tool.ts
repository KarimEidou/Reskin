// Shared machinery of the dab-based retouching and spray tools: dabs are
// placed along the pointer path by a StrokeSampler at a tool-defined
// spacing, replicated through the symmetry transforms, clipped to the
// selection, and the whole stroke is recorded as ONE history entry
// (`PixelTransaction`, only the changed tiles are stored). Pixel-art
// documents get aliased footprints.
//
// Subclasses implement `paint()` for a batch of dabs; every batch touches
// only the footprints of its dabs, so the cost of a stroke segment does not
// depend on the document size.

import type { CursorHint, Tool, ToolContext, ToolGroup, ToolId } from './types';
import type { DabShape } from './paint';
import { dabCoverage } from './paint';
import type { PointerInput } from '../input/pointer';
import type { Dab, StrokePoint } from '../input/stroke-sampler';
import { StrokeSampler } from '../input/stroke-sampler';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { Affine, Point } from '../geometry/affine';
import { symmetryTransforms } from '../symmetry/symmetry';
import type { SelectionMask } from '../selection/mask';
import type { OverlayPainter } from '../render/overlay';
import type { Rect } from '../util/rect';
import { clipRect } from '../util/rect';

/** Per-stroke state every dab tool has. */
export interface DabStroke {
  tx: PixelTransaction;
  /** Symmetry transforms, identity first. */
  transforms: Affine[];
  selection: SelectionMask | null;
  /** Pixel-art document: whole-pixel footprints. */
  aliased: boolean;
  sampler: StrokeSampler;
  /** Last pointer sample (pens report zero pressure on release). */
  last: PointerInput;
  /** Button that started the stroke (2 = secondary colour). */
  button: number;
}

/** Integer rect a round dab of `radius` at (x, y) can touch, clipped; null when off-canvas. */
export function dabFootprint(x: number, y: number, radius: number, width: number, height: number): Rect | null {
  const reach = Math.max(radius, 0.5) + 1;
  const x0 = Math.floor(x - reach);
  const y0 = Math.floor(y - reach);
  return clipRect({ x: x0, y: y0, w: Math.ceil(x + reach) - x0, h: Math.ceil(y + reach) - y0 }, width, height);
}

/**
 * Coverage (0..1) of pixel (px, py) by a dab centred at (x, y), times the
 * selection. Aliased dabs always cover the pixel under their centre, like
 * `stampDab`.
 */
export function dabPixelCoverage(
  px: number,
  py: number,
  x: number,
  y: number,
  shape: DabShape,
  selection: Uint8Array | null,
  width: number,
): number {
  const dx = px + 0.5 - x;
  const dy = py + 0.5 - y;
  let c = dabCoverage(Math.sqrt(dx * dx + dy * dy), shape);
  if (shape.aliased && c === 0 && px === Math.floor(x) && py === Math.floor(y)) c = 1;
  if (c > 0 && selection) c *= selection[py * width + px] / 255;
  return c;
}

export function toStrokePoint(p: PointerInput): StrokePoint {
  return { x: p.x, y: p.y, pressure: p.pressure, tiltX: p.tiltX, tiltY: p.tiltY };
}

/**
 * An option value clamped into [lo, hi]; `fallback` when it is not a finite
 * number (options come straight from UI controls).
 */
export function optionIn(v: number, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

export abstract class DabTool<O extends object, S extends DabStroke = DabStroke> implements Tool<O> {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  abstract readonly shortcut: string;
  abstract readonly icon: string;
  readonly group?: ToolGroup;
  readonly usesSymmetry = true;
  protected stroke: S | null = null;

  abstract defaultOptions(): O;
  /** Footprint radius at full pressure, document px (cursor ring, overlay). */
  protected abstract footprintRadius(o: O): number;
  /** Distance from `dab` to the next one, document px. */
  protected abstract dabSpacing(o: O, dab: Dab): number;
  /** Builds the tool's stroke state on top of the shared part. */
  protected abstract createStroke(ctx: ToolContext, base: DabStroke, o: O): S;
  /** Applies a batch of dabs (every symmetric copy); marks what it changes with `tx.touch`. */
  protected abstract paint(ctx: ToolContext, s: S, dabs: Dab[], o: O): void;
  /** History label of the finished stroke. */
  protected abstract historyLabel(s: S, o: O): string;

  cursor(o: O): CursorHint {
    return { css: 'crosshair', radius: this.footprintRadius(o) };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: O): void {
    this.cancel(ctx);
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    const base: DabStroke = {
      tx: ctx.beginPixels(layer),
      transforms: symmetryTransforms(ctx.symmetry, doc.width, doc.height),
      selection: doc.selection,
      aliased: doc.pixelArt !== null,
      sampler: new StrokeSampler((d) => this.dabSpacing(o, d)),
      last: p,
      button: p.button,
    };
    const s = this.createStroke(ctx, base, o);
    this.stroke = s;
    this.apply(ctx, s, s.sampler.begin(toStrokePoint(p)), o);
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: O): void {
    const s = this.stroke;
    if (!s) return;
    s.last = p;
    this.apply(ctx, s, s.sampler.add(toStrokePoint(p)), o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: O): void {
    const s = this.stroke;
    if (!s) return;
    // Pens usually report zero pressure on release; keep the last pressure.
    this.pointerMove(ctx, { ...p, pressure: s.last.pressure, tiltX: s.last.tiltX, tiltY: s.last.tiltY }, o);
    this.stroke = null;
    ctx.commitPixels(s.tx, this.historyLabel(s, o));
  }

  cancel(ctx: ToolContext): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    ctx.cancelPixels(s.tx);
  }

  drawOverlay(painter: OverlayPainter, _ctx: ToolContext, o: O, hover: Point | null): void {
    if (!hover) return;
    const r = this.footprintRadius(o);
    if (r * painter.scale >= 3) painter.ellipse(hover.x, hover.y, r, r);
  }

  private apply(ctx: ToolContext, s: S, dabs: Dab[], o: O): void {
    if (dabs.length === 0) return;
    this.paint(ctx, s, dabs, o);
    ctx.pixelsChanged(s.tx);
  }
}
