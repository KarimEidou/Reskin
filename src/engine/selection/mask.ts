// Selection masks: one byte of coverage per document pixel (0 = outside,
// 255 = fully selected; anything between is a soft/feathered edge).
//
// A document's `selection` is `null` when nothing is selected, which means
// "everything is editable". Operations that would produce an empty mask
// return `null` too, so there is exactly one representation of "no
// selection". New selection shapes (rect, ellipse, polygon now; lasso and
// magic wand later) all produce a mask and are merged with `combineMasks`.

import type { Polygon } from '../geometry/rasterize';
import { rasterizePolygons } from '../geometry/rasterize';
import { ellipsePolygon, rectPolygon } from '../geometry/shapes';
import type { Affine } from '../geometry/affine';
import { invert, apply } from '../geometry/affine';
import { gaussianBlurPlane } from '../raster/blur';
import type { Rect } from '../util/rect';

export interface SelectionMask {
  width: number;
  height: number;
  /** width·height coverage bytes. */
  data: Uint8Array;
}

export type SelectionOp = 'replace' | 'add' | 'subtract' | 'intersect';

export function createMask(width: number, height: number, fill = 0): SelectionMask {
  const data = new Uint8Array(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function cloneMask(m: SelectionMask): SelectionMask {
  return { width: m.width, height: m.height, data: m.data.slice() };
}

export function selectAllMask(width: number, height: number): SelectionMask {
  return createMask(width, height, 255);
}

/** Mask from closed polygons (nonzero rule). */
export function polygonMask(
  width: number,
  height: number,
  polys: readonly Polygon[],
  antialias = true,
): SelectionMask {
  const m = createMask(width, height);
  const cov = rasterizePolygons(polys, {
    clip: { x: 0, y: 0, w: width, h: height },
    antialias,
  });
  if (!cov) return m;
  for (let y = 0; y < cov.h; y++) {
    const row = (cov.y + y) * width + cov.x;
    for (let x = 0; x < cov.w; x++) {
      const v = cov.data[y * cov.w + x];
      if (v > 0) m.data[row + x] = Math.round(v * 255);
    }
  }
  return m;
}

/** Rectangle selection (float coordinates; soft edges when not pixel aligned and `antialias`). */
export function rectMask(width: number, height: number, r: Rect, antialias = false): SelectionMask {
  return polygonMask(width, height, [rectPolygon(r)], antialias);
}

export function ellipseMask(width: number, height: number, r: Rect, antialias = true): SelectionMask {
  return polygonMask(width, height, [ellipsePolygon(r)], antialias);
}

export function isMaskEmpty(m: SelectionMask): boolean {
  const d = m.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
  return true;
}

/**
 * Merges `shape` into `current`. Returns null when the result is empty.
 * Without a current selection every op except `subtract` behaves like
 * `replace` (subtracting from nothing leaves nothing).
 */
export function combineMasks(
  current: SelectionMask | null,
  shape: SelectionMask,
  op: SelectionOp,
): SelectionMask | null {
  let out: SelectionMask;
  if (op === 'replace' || !current) {
    if (op === 'subtract') return null;
    out = cloneMask(shape);
  } else {
    if (current.width !== shape.width || current.height !== shape.height) {
      throw new RangeError('Selection masks differ in size');
    }
    out = createMask(shape.width, shape.height);
    const a = current.data;
    const b = shape.data;
    const d = out.data;
    for (let i = 0; i < d.length; i++) {
      switch (op) {
        case 'add':
          d[i] = a[i] + b[i] - Math.round((a[i] * b[i]) / 255); // union of coverages
          break;
        case 'subtract':
          d[i] = Math.round((a[i] * (255 - b[i])) / 255);
          break;
        case 'intersect':
          d[i] = Math.round((a[i] * b[i]) / 255);
          break;
      }
    }
  }
  return isMaskEmpty(out) ? null : out;
}

/** Inverts a mask; inverting "no selection" selects nothing (null). */
export function invertMask(m: SelectionMask | null, width: number, height: number): SelectionMask | null {
  if (!m) return null;
  const out = createMask(width, height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - m.data[i];
  return isMaskEmpty(out) ? null : out;
}

/** Softens the edge with a Gaussian of radius ≈ 2σ px. */
export function featherMask(m: SelectionMask, radius: number): SelectionMask | null {
  if (radius <= 0) return cloneMask(m);
  const plane = new Float32Array(m.data.length);
  for (let i = 0; i < plane.length; i++) plane[i] = m.data[i] / 255;
  gaussianBlurPlane(plane, m.width, m.height, radius / 2);
  const out = createMask(m.width, m.height);
  for (let i = 0; i < plane.length; i++) out.data[i] = Math.round(Math.min(1, plane[i]) * 255);
  return isMaskEmpty(out) ? null : out;
}

/** Bounds of pixels with coverage > threshold. */
export function maskBounds(m: SelectionMask, threshold = 0): Rect | null {
  let minX = m.width, minY = m.height, maxX = -1, maxY = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (m.data[row + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Coverage 0..1 at a pixel; 1 everywhere when there is no selection. */
export function maskCoverage(m: SelectionMask | null, x: number, y: number): number {
  if (!m) return 1;
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return 0;
  return m.data[y * m.width + x] / 255;
}

/** Resamples a mask through `forward` (source → destination), bilinear. */
export function transformMask(m: SelectionMask, forward: Affine): SelectionMask | null {
  const inv = invert(forward);
  const out = createMask(m.width, m.height);
  if (!inv) return null;
  const { width: w, height: h, data } = m;
  for (let y = 0; y < h; y++) {
    // Walk the row incrementally in source space (no per-pixel allocation).
    const start = apply(inv, 0.5, y + 0.5);
    for (let x = 0; x < w; x++) {
      const fx = start.x + inv[0] * x - 0.5;
      const fy = start.y + inv[1] * x - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let v = 0;
      for (let j = 0; j < 2; j++) {
        const yy = y0 + j;
        if (yy < 0 || yy >= h) continue;
        const wy = j ? ty : 1 - ty;
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          if (xx < 0 || xx >= w) continue;
          v += data[yy * w + xx] * (i ? tx : 1 - tx) * wy;
        }
      }
      out.data[y * w + x] = Math.round(v);
    }
  }
  return isMaskEmpty(out) ? null : out;
}

/** Nearest-neighbour rescale (used when the document is resized). */
export function resizeMask(m: SelectionMask, width: number, height: number): SelectionMask | null {
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / width));
      out.data[y * width + x] = m.data[sy * m.width + sx];
    }
  }
  return isMaskEmpty(out) ? null : out;
}

export function masksEqual(a: SelectionMask | null, b: SelectionMask | null): boolean {
  if (!a || !b) return a === b;
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}
