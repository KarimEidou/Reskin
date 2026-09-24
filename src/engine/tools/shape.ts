// Shape tool: drag out a rect, rounded rect, ellipse, line, arrow, regular
// polygon, star, heart or squircle; filled and/or stroked, rasterized with
// anti-aliased coverage (aliased in pixel-art documents). Shift constrains
// (1:1 box, or 15° line angles); Alt draws from the centre.
//
// Colours: fill = primary; stroke = secondary when both fill and stroke are
// on, otherwise primary. Lines and arrows are stroke-only (primary).

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { ShapeKind } from '../geometry/shapes';
import { shapeGeometry } from '../geometry/shapes';
import { rasterizePolygons } from '../geometry/rasterize';
import type { PixelTransaction } from '../history/pixel-transaction';
import { compositeCoverage } from './paint';
import type { Point } from '../geometry/affine';
import type { OverlayPainter } from '../render/overlay';
import type { Rgba } from '../color/color';

export interface ShapeOptions {
  kind: ShapeKind;
  fill: boolean;
  stroke: boolean;
  /** Document px. */
  strokeWidth: number;
  /** roundedRect corner radius, document px. */
  cornerRadius: number;
  /** Polygon sides / star points (3..64 / 2..64). */
  sides: number;
  /** Star inner radius ratio (0.05..1). */
  innerRatio: number;
  /** 0..1 */
  opacity: number;
}

export function defaultShapeOptions(): ShapeOptions {
  return {
    kind: 'roundedRect',
    fill: true,
    stroke: false,
    strokeWidth: 8,
    cornerRadius: 64,
    sides: 6,
    innerRatio: 0.5,
    opacity: 1,
  };
}

interface Drag {
  tx: PixelTransaction;
  start: Point;
  end: Point;
  /** Constrained/centred drag box actually drawn. */
  from: Point;
  to: Point;
}

const LINE_KINDS: readonly ShapeKind[] = ['line', 'arrow'];

/** Applies Shift (constrain) and Alt (from centre) to a drag. */
export function shapeDragBox(
  kind: ShapeKind,
  start: Point,
  end: Point,
  constrain: boolean,
  fromCenter: boolean,
): { from: Point; to: Point } {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (constrain) {
    if (LINE_KINDS.includes(kind)) {
      const len = Math.hypot(dx, dy);
      const step = Math.PI / 12;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      dx = Math.cos(a) * len;
      dy = Math.sin(a) * len;
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * m;
      dy = (dy < 0 ? -1 : 1) * m;
    }
  }
  if (fromCenter) {
    return { from: { x: start.x - dx, y: start.y - dy }, to: { x: start.x + dx, y: start.y + dy } };
  }
  return { from: start, to: { x: start.x + dx, y: start.y + dy } };
}

/** Rasterizes and composites a shape into an open transaction (from its base). */
export function drawShape(
  tx: PixelTransaction,
  o: ShapeOptions,
  from: Point,
  to: Point,
  colors: { fill: Rgba; stroke: Rgba },
  aliased: boolean,
  selection: ToolContext['doc']['selection'],
): void {
  const isLine = LINE_KINDS.includes(o.kind);
  const stroke = isLine || o.stroke;
  const geo = shapeGeometry({
    kind: o.kind,
    x0: from.x,
    y0: from.y,
    x1: to.x,
    y1: to.y,
    cornerRadius: o.cornerRadius,
    sides: o.sides,
    innerRatio: o.innerRatio,
    strokeWidth: o.strokeWidth,
    stroke,
  });
  const clip = { x: 0, y: 0, w: tx.width, h: tx.height };
  const opacity = Math.min(1, Math.max(0, o.opacity));
  let fromBase = true;
  if (!isLine && o.fill && geo.fill.length) {
    const cov = rasterizePolygons(geo.fill, { clip, antialias: !aliased });
    if (cov) {
      compositeCoverage(tx, cov, colors.fill, opacity, selection, true);
      fromBase = false;
    }
  }
  if (stroke && geo.stroke.length) {
    const cov = rasterizePolygons(geo.stroke, { clip, antialias: !aliased });
    if (cov) compositeCoverage(tx, cov, colors.stroke, opacity, selection, fromBase);
  }
}

export class ShapeTool implements Tool<ShapeOptions> {
  readonly id = 'shape' as const;
  readonly label = 'Shapes';
  readonly shortcut = 'U';
  readonly icon = 'shapes';
  readonly usesSymmetry = false;
  private drag: Drag | null = null;

  defaultOptions(): ShapeOptions {
    return defaultShapeOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput): void {
    this.cancel(ctx);
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const start = { x: p.x, y: p.y };
    this.drag = { tx: ctx.beginPixels(layer), start, end: start, from: start, to: start };
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: ShapeOptions): void {
    const d = this.drag;
    if (!d) return;
    this.update(ctx, d, p, o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: ShapeOptions): void {
    const d = this.drag;
    if (!d) return;
    this.update(ctx, d, p, o);
    this.drag = null;
    if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 1) ctx.cancelPixels(d.tx);
    else ctx.commitPixels(d.tx, shapeLabel(o.kind));
    ctx.overlayChanged();
  }

  cancel(ctx: ToolContext): void {
    if (!this.drag) return;
    ctx.cancelPixels(this.drag.tx);
    this.drag = null;
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter, _ctx: ToolContext, o: ShapeOptions): void {
    const d = this.drag;
    if (!d || LINE_KINDS.includes(o.kind)) return;
    const x = Math.min(d.from.x, d.to.x);
    const y = Math.min(d.from.y, d.to.y);
    painter.rect(x, y, Math.abs(d.to.x - d.from.x), Math.abs(d.to.y - d.from.y), { dash: [4, 4] });
  }

  private update(ctx: ToolContext, d: Drag, p: PointerInput, o: ShapeOptions): void {
    d.end = { x: p.x, y: p.y };
    const box = shapeDragBox(o.kind, d.start, d.end, p.modifiers.shift, p.modifiers.alt);
    d.from = box.from;
    d.to = box.to;
    d.tx.restoreAll();
    const both = o.fill && o.stroke && !LINE_KINDS.includes(o.kind);
    drawShape(
      d.tx,
      o,
      d.from,
      d.to,
      { fill: ctx.primary, stroke: both ? ctx.secondary : ctx.primary },
      ctx.doc.pixelArt !== null,
      ctx.doc.selection,
    );
    ctx.pixelsChanged(d.tx);
    ctx.overlayChanged();
  }
}

function shapeLabel(kind: ShapeKind): string {
  const names: Record<ShapeKind, string> = {
    rect: 'Rectangle',
    roundedRect: 'Rounded rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
    arrow: 'Arrow',
    polygon: 'Polygon',
    star: 'Star',
    heart: 'Heart',
    squircle: 'Squircle',
  };
  return names[kind];
}

export function createShapeTool(): ShapeTool {
  return new ShapeTool();
}
