// Shared painting primitives.
//
// Strokes accumulate into a per-pixel "stroke alpha" plane:
//   a ← min(a + dab·flow·(1 − a), max(a, ceiling))
// and the layer is then recomputed FROM THE TRANSACTION BASE as
//   pixel = base  over  colour × (a · opacity · selection)
// so overlapping dabs build up smoothly with flow but never exceed the
// stroke opacity (like Photoshop's opacity/flow), and the result is exactly
// reproducible for the same input. The per-dab `ceiling` (pen pressure →
// opacity) caps how far a dab can raise the stroke alpha without ever
// lowering what earlier dabs laid down, so a light touch stays light however
// many dabs overlap.

import type { Rect } from '../util/rect';
import { clipRect } from '../util/rect';
import type { SelectionMask } from '../selection/mask';
import { erasePixel, overPixel } from '../raster/blit';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { Rgba } from '../color/color';

export interface DabShape {
  /** Radius in document px. */
  radius: number;
  /** 0 = soft falloff from the centre … 1 = hard edge. */
  hardness: number;
  /** Aliased (pixel-art) footprint: every pixel is fully in or out. */
  aliased: boolean;
}

/** Coverage (0..1) of a round dab at distance `d` from its centre. */
export function dabCoverage(d: number, shape: DabShape): number {
  const r = shape.radius;
  if (shape.aliased) return d <= Math.max(r, 0.5) ? 1 : 0;
  // Anti-aliased edge (sub-pixel radii keep their area).
  const rr = Math.max(r, 0.5);
  const edge = rr + 0.5 - d;
  if (edge <= 0) return 0;
  let c = edge >= 1 ? 1 : edge;
  // Soft falloff from the hard core out to the anti-aliased rim.
  const inner = Math.min(1, Math.max(0, shape.hardness)) * rr;
  if (d > inner) {
    const t = (d - inner) / (rr + 0.5 - inner);
    const f = t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
    if (f < c) c = f;
  }
  return r < 0.5 ? c * (r / 0.5) * (r / 0.5) : c;
}

/**
 * Accumulates one dab centred at (x, y) into `alpha` (w×h plane) with
 * strength `flow`, raising no pixel above `ceiling` (0..1). Returns the
 * affected pixel rect (clipped) or null.
 */
export function stampDab(
  alpha: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  shape: DabShape,
  flow: number,
  ceiling = 1,
): Rect | null {
  if (flow <= 0 || ceiling <= 0) return null;
  const reach = Math.max(shape.radius, 0.5) + 1;
  const area = clipRect(
    {
      x: Math.floor(x - reach),
      y: Math.floor(y - reach),
      w: Math.ceil(x + reach) - Math.floor(x - reach),
      h: Math.ceil(y + reach) - Math.floor(y - reach),
    },
    w,
    h,
  );
  if (!area) return null;
  let touched = false;
  const containsX = Math.floor(x);
  const containsY = Math.floor(y);
  for (let py = area.y; py < area.y + area.h; py++) {
    const dy = py + 0.5 - y;
    for (let px = area.x; px < area.x + area.w; px++) {
      const dx = px + 0.5 - x;
      let c = dabCoverage(Math.sqrt(dx * dx + dy * dy), shape);
      // A pixel-art dab always covers the pixel under its centre.
      if (shape.aliased && c === 0 && px === containsX && py === containsY) c = 1;
      if (c <= 0) continue;
      const i = py * w + px;
      const a = alpha[i];
      if (a >= ceiling) continue;
      const next = a + c * flow * (1 - a);
      alpha[i] = next > ceiling ? ceiling : next;
      touched = true;
    }
  }
  return touched ? area : null;
}

export type StrokeMode = 'paint' | 'erase';

/**
 * Recomputes `rect` of the transaction's surface from its base and the
 * stroke alpha plane.
 */
export function compositeStroke(
  tx: PixelTransaction,
  alpha: Float32Array,
  rect: Rect,
  color: Rgba,
  opacity: number,
  mode: StrokeMode,
  selection: SelectionMask | null,
): void {
  const c = tx.touch(rect);
  if (!c) return;
  const w = tx.width;
  const base = tx.base;
  const out = tx.surface.data;
  const r = color.r;
  const g = color.g;
  const b = color.b;
  const k = opacity * (mode === 'paint' ? color.a : 1);
  const sel = selection?.data ?? null;
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      const i = y * w + x;
      let s = alpha[i] * k;
      if (sel) s *= sel[i] / 255;
      const p = i * 4;
      if (s <= 0) {
        out[p] = base[p];
        out[p + 1] = base[p + 1];
        out[p + 2] = base[p + 2];
        out[p + 3] = base[p + 3];
      } else if (mode === 'paint') {
        overPixel(base, out, p, r, g, b, s);
      } else {
        erasePixel(base, out, p, s);
      }
    }
  }
}

/** Composites a float coverage map (e.g. a rasterized shape) over the surface. */
export function compositeCoverage(
  tx: PixelTransaction,
  cov: { x: number; y: number; w: number; h: number; data: Float32Array },
  color: Rgba,
  opacity: number,
  selection: SelectionMask | null,
  fromBase: boolean,
): void {
  const c = tx.touch({ x: cov.x, y: cov.y, w: cov.w, h: cov.h });
  if (!c) return;
  const w = tx.width;
  const src = fromBase ? tx.base : tx.surface.data;
  const out = tx.surface.data;
  const k = opacity * color.a;
  const sel = selection?.data ?? null;
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      let s = cov.data[(y - cov.y) * cov.w + (x - cov.x)] * k;
      const i = y * w + x;
      if (sel) s *= sel[i] / 255;
      const p = i * 4;
      if (s > 0) overPixel(src, out, p, color.r, color.g, color.b, s);
      else if (fromBase) {
        out[p] = src[p];
        out[p + 1] = src[p + 1];
        out[p + 2] = src[p + 2];
        out[p + 3] = src[p + 3];
      }
    }
  }
}
