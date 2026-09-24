// Anti-aliased polygon coverage rasterizer.
//
// Scanline algorithm with exact nonzero/even-odd winding: each pixel row is
// sampled at `subsamples` sub-scanlines; on each one the edge crossings are
// sorted and the inside spans get their exact horizontal coverage
// (fractional at both ends). The result is a float coverage map (0..1) over
// the shape's integer bounding box.
//
// Because inside/outside is decided by the winding number (not by summing
// per-polygon coverage), overlapping pieces of one shape union cleanly —
// strokes are built from many overlapping quads and wedges (./shapes.ts),
// all oriented the same way, and still get correct anti-aliased edges.

import type { Rect } from '../util/rect';
import { intersectRect } from '../util/rect';

/** Flat closed polygon: [x0, y0, x1, y1, …] (the last point connects to the first). */
export type Polygon = ArrayLike<number>;

export type FillRule = 'nonzero' | 'evenodd';

export interface Coverage {
  /** Integer bounds of the coverage map in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** w·h values in 0..1. */
  data: Float32Array;
}

export interface RasterizeOptions {
  fillRule?: FillRule;
  /** Canvas bounds; coverage outside is dropped. */
  clip?: Rect;
  /** false = aliased: a pixel is in when its centre is (crisp pixel art). */
  antialias?: boolean;
  /** Sub-scanlines per pixel row when anti-aliasing (default 16). */
  subsamples?: number;
}

interface Edge {
  y0: number; // top
  y1: number; // bottom (exclusive)
  x0: number; // x at y0
  dxdy: number;
  dir: number; // +1 downwards, -1 upwards
}

/** Signed area (positive = clockwise on a y-down canvas). */
export function signedArea(poly: Polygon): number {
  const n = poly.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1];
  }
  return a / 2;
}

/** Returns the polygon with positive (clockwise, y-down) orientation. */
export function orientPositive(poly: Polygon): number[] {
  const pts = Array.from(poly);
  if (signedArea(poly) >= 0) return pts;
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

export function polygonBounds(polys: readonly Polygon[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

export function rasterizePolygons(polys: readonly Polygon[], opts: RasterizeOptions = {}): Coverage | null {
  const fillRule = opts.fillRule ?? 'nonzero';
  const aa = opts.antialias ?? true;
  const samples = aa ? Math.max(1, Math.floor(opts.subsamples ?? 16)) : 1;

  const b = polygonBounds(polys);
  if (!b) return null;
  let area: Rect | null = {
    x: Math.floor(b.x0),
    y: Math.floor(b.y0),
    w: Math.ceil(b.x1) - Math.floor(b.x0) + 1,
    h: Math.ceil(b.y1) - Math.floor(b.y0) + 1,
  };
  if (opts.clip) area = intersectRect(area, opts.clip);
  if (!area) return null;

  const edges: Edge[] = [];
  for (const p of polys) {
    const n = p.length >> 1;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], ay = p[i * 2 + 1];
      const bx = p[j * 2], by = p[j * 2 + 1];
      if (ay === by || !Number.isFinite(ax + ay + bx + by)) continue;
      if (ay < by) edges.push({ y0: ay, y1: by, x0: ax, dxdy: (bx - ax) / (by - ay), dir: 1 });
      else edges.push({ y0: by, y1: ay, x0: bx, dxdy: (ax - bx) / (ay - by), dir: -1 });
    }
  }
  if (edges.length === 0) return null;
  edges.sort((e1, e2) => e1.y0 - e2.y0);

  const { x: ox, y: oy, w, h } = area;
  const data = new Float32Array(w * h);
  const diff = new Float32Array(w + 1);
  const wgt = 1 / samples;
  const xs: number[] = [];
  const dirs: number[] = [];
  const order: number[] = [];
  const active: Edge[] = [];
  let next = 0;

  for (let row = 0; row < h; row++) {
    const py = oy + row;
    const out = row * w;
    diff.fill(0);
    let any = false;
    for (let s = 0; s < samples; s++) {
      const sy = aa ? py + (s + 0.5) * wgt : py + 0.5;
      while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++]);
      if (active.length === 0) continue;
      // Drop finished edges in place and collect crossings.
      xs.length = 0;
      dirs.length = 0;
      let kept = 0;
      for (let i = 0; i < active.length; i++) {
        const e = active[i];
        if (e.y1 <= sy) continue;
        active[kept++] = e;
        xs.push(e.x0 + (sy - e.y0) * e.dxdy);
        dirs.push(e.dir);
      }
      active.length = kept;
      const n = xs.length;
      if (n < 2) continue;
      order.length = n;
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((i, j) => xs[i] - xs[j]);
      let wind = 0;
      for (let k = 0; k < n - 1; k++) {
        const idx = order[k];
        wind += dirs[idx];
        const inside = fillRule === 'nonzero' ? wind !== 0 : (wind & 1) !== 0;
        if (!inside) continue;
        let xa = xs[idx] - ox;
        let xb = xs[order[k + 1]] - ox;
        if (xb <= xa) continue;
        if (xa < 0) xa = 0;
        if (xb > w) xb = w;
        if (xb <= xa) continue;
        any = true;
        if (aa) {
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          if (ia === ib) {
            data[out + ia] += (xb - xa) * wgt;
          } else {
            data[out + ia] += (ia + 1 - xa) * wgt;
            diff[ia + 1] += wgt;
            diff[ib] -= wgt;
            if (ib < w) data[out + ib] += (xb - ib) * wgt;
          }
        } else {
          // Pixel i is in when its centre i + 0.5 lies in [xa, xb).
          const ia = Math.ceil(xa - 0.5);
          const ib = Math.ceil(xb - 0.5);
          if (ib > ia) {
            diff[ia] += 1;
            diff[ib] -= 1;
          }
        }
      }
    }
    if (!any) continue;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += diff[x];
      const v = data[out + x] + run;
      data[out + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  }
  return { x: ox, y: oy, w, h, data };
}

/** Sum of coverage (the shape's area in px²). */
export function coverageArea(c: Coverage | null): number {
  if (!c) return 0;
  let s = 0;
  for (let i = 0; i < c.data.length; i++) s += c.data[i];
  return s;
}

/** Coverage value at a canvas pixel (0 outside the map). */
export function coverageAt(c: Coverage, x: number, y: number): number {
  const lx = x - c.x;
  const ly = y - c.y;
  if (lx < 0 || ly < 0 || lx >= c.w || ly >= c.h) return 0;
  return c.data[ly * c.w + lx];
}
