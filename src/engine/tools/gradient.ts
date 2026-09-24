// Gradient tool: drag to set the gradient line; linear, radial or conic,
// multi-stop, with pad/repeat/reflect spread. The preview re-renders from
// the transaction base on every move. Output is ordered-dithered (8×8
// Bayer, strictly within ±0.5 LSB) so smooth ramps do not band, while exact
// stop colours still land exactly on their 8-bit values.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { GradientKind, GradientSpec, GradientSpread, GradientStop } from '../color/gradient';
import { applySpread, gradientLut, gradientParam, normalizeStops } from '../color/gradient';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { SelectionMask } from '../selection/mask';
import { maskBounds } from '../selection/mask';
import type { Rect } from '../util/rect';
import { fullRect } from '../util/rect';
import type { OverlayPainter } from '../render/overlay';
import type { Point } from '../geometry/affine';

export interface GradientToolOptions {
  kind: GradientKind;
  spread: GradientSpread;
  /** 'colors': primary → secondary; 'custom': `stops`. */
  source: 'colors' | 'custom';
  stops: GradientStop[];
  reverse: boolean;
  /** 0..1 */
  opacity: number;
  dither: boolean;
}

export function defaultGradientOptions(): GradientToolOptions {
  return {
    kind: 'linear',
    spread: 'pad',
    source: 'colors',
    stops: [
      { offset: 0, color: { r: 124, g: 92, b: 255, a: 1 } },
      { offset: 0.5, color: { r: 79, g: 125, b: 255, a: 1 } },
      { offset: 1, color: { r: 31, g: 200, b: 227, a: 1 } },
    ],
    reverse: false,
    opacity: 1,
    dither: true,
  };
}

/** 8×8 Bayer matrix. */
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62,
  30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31,
  55, 23, 61, 29, 53, 21,
];
/** Bayer thresholds mapped to (−0.5, 0.5). */
const DITHER = Float32Array.from(BAYER8, (v) => (v + 0.5) / 64 - 0.5);

const LUT_SIZE = 2048;

export interface GradientRender {
  spec: GradientSpec;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  opacity: number;
  dither: boolean;
  selection: SelectionMask | null;
}

/**
 * Renders a gradient over `base` into `out` (straight RGBA8, same size) for
 * `area`. `base` and `out` may be the same buffer.
 */
export function renderGradient(
  base: Uint8ClampedArray,
  out: Uint8ClampedArray,
  width: number,
  area: Rect,
  g: GradientRender,
): void {
  const lut = gradientLut(normalizeStops(g.spec.stops), LUT_SIZE);
  const last = LUT_SIZE - 1;
  const sel = g.selection?.data ?? null;
  const op = Math.min(1, Math.max(0, g.opacity));
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) {
      const i = y * width + x;
      const p = i * 4;
      let s = op;
      if (sel) s *= sel[i] / 255;
      if (s <= 0) {
        if (base !== out) {
          out[p] = base[p];
          out[p + 1] = base[p + 1];
          out[p + 2] = base[p + 2];
          out[p + 3] = base[p + 3];
        }
        continue;
      }
      const t = applySpread(g.spec.spread, gradientParam(g.spec.kind, x + 0.5, y + 0.5, g.x0, g.y0, g.x1, g.y1));
      const l = Math.round(t * last) * 4;
      // Source (premultiplied, scaled by strength) over the base pixel.
      const sa = lut[l + 3] * s;
      const ba = base[p + 3] / 255;
      const oa = sa + ba * (1 - sa);
      if (oa <= 0) {
        out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
        continue;
      }
      const kb = (ba * (1 - sa)) / 255;
      const d = g.dither ? DITHER[((y & 7) << 3) | (x & 7)] : 0;
      out[p] = ((lut[l] * s + base[p] * kb) / oa) * 255 + d;
      out[p + 1] = ((lut[l + 1] * s + base[p + 1] * kb) / oa) * 255 + d;
      out[p + 2] = ((lut[l + 2] * s + base[p + 2] * kb) / oa) * 255 + d;
      out[p + 3] = oa * 255 + d;
    }
  }
}

/** The spec a drag renders with these options and colours. */
export function gradientSpecFor(o: GradientToolOptions, ctx: Pick<ToolContext, 'primary' | 'secondary'>): GradientSpec {
  let stops: GradientStop[] =
    o.source === 'colors'
      ? [
          { offset: 0, color: { ...ctx.primary } },
          { offset: 1, color: { ...ctx.secondary } },
        ]
      : o.stops.map((s) => ({ offset: s.offset, color: { ...s.color } }));
  if (stops.length === 0) stops = [{ offset: 0, color: { ...ctx.primary } }];
  if (o.reverse) stops = stops.map((s) => ({ offset: 1 - s.offset, color: s.color })).reverse();
  return { kind: o.kind, spread: o.spread, stops };
}

interface Drag {
  tx: PixelTransaction;
  start: Point;
  end: Point;
  area: Rect;
}

export class GradientTool implements Tool<GradientToolOptions> {
  readonly id = 'gradient' as const;
  readonly label = 'Gradient';
  readonly shortcut = 'Shift+G';
  readonly usesSymmetry = false;
  private drag: Drag | null = null;

  defaultOptions(): GradientToolOptions {
    return defaultGradientOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, _o: GradientToolOptions): void {
    this.cancel(ctx);
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    const area = doc.selection ? maskBounds(doc.selection) : fullRect(doc.width, doc.height);
    if (!area) return;
    this.drag = { tx: ctx.beginPixels(layer), start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y }, area };
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: GradientToolOptions): void {
    const d = this.drag;
    if (!d) return;
    d.end = constrain(d.start, { x: p.x, y: p.y }, p.modifiers.shift);
    this.render(ctx, d, o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: GradientToolOptions): void {
    const d = this.drag;
    if (!d) return;
    d.end = constrain(d.start, { x: p.x, y: p.y }, p.modifiers.shift);
    this.drag = null;
    if (Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) < 1) {
      ctx.cancelPixels(d.tx);
      ctx.overlayChanged();
      return;
    }
    this.render(ctx, d, o);
    ctx.commitPixels(d.tx, 'Gradient');
    ctx.overlayChanged();
  }

  cancel(ctx: ToolContext): void {
    if (!this.drag) return;
    ctx.cancelPixels(this.drag.tx);
    this.drag = null;
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter): void {
    const d = this.drag;
    if (!d) return;
    painter.line(d.start.x, d.start.y, d.end.x, d.end.y);
    painter.handle(d.start.x, d.start.y, 'circle');
    painter.handle(d.end.x, d.end.y, 'square');
  }

  private render(ctx: ToolContext, d: Drag, o: GradientToolOptions): void {
    if (Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) < 1) return;
    d.tx.touch(d.area);
    renderGradient(d.tx.base, d.tx.surface.data, d.tx.width, d.area, {
      spec: gradientSpecFor(o, ctx),
      x0: d.start.x,
      y0: d.start.y,
      x1: d.end.x,
      y1: d.end.y,
      opacity: o.opacity,
      dither: o.dither,
      selection: ctx.doc.selection,
    });
    ctx.pixelsChanged(d.tx);
    ctx.overlayChanged();
  }
}

/** Shift snaps the drag direction to 15° steps. */
function constrain(a: Point, b: Point, snap: boolean): Point {
  if (!snap) return b;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.PI / 12;
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

export function createGradientTool(): GradientTool {
  return new GradientTool();
}
