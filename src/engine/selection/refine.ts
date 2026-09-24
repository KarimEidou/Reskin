// Selection refinement and region masks: grow, shrink and border (built on
// the exact distance transform in raster/distance.ts), masks from a layer's
// alpha, magic-wand regions and their anti-aliased edges.
//
// Like everything in ./mask.ts these return a NEW mask, or null when the
// result is empty (the single representation of "nothing selected").
// Canvas edges never count as selection edges: shrinking a selection that
// touches the border of the document does not pull it away from the border.

import type { SelectionMask } from './mask';
import { cloneMask, createMask, isMaskEmpty } from './mask';
import { dilate, erode } from '../raster/distance';
import type { FloodOptions } from '../raster/flood';
import { floodFill } from '../raster/flood';
import type { Surface } from '../raster/surface';
import type { Rect } from '../util/rect';

export interface RefineOptions {
  /**
   * Whole-pixel result (pixel-art documents): every pixel is fully in or
   * out, thresholded at 50 % coverage.
   */
  binary?: boolean;
}

function toPlane(m: SelectionMask): Float32Array {
  const plane = new Float32Array(m.data.length);
  for (let i = 0; i < plane.length; i++) plane[i] = m.data[i] / 255;
  return plane;
}

function fromPlane(plane: Float32Array, width: number, height: number, binary: boolean): SelectionMask | null {
  const out = createMask(width, height);
  const d = out.data;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    d[i] = binary ? (v >= 0.5 ? 255 : 0) : Math.round((v <= 0 ? 0 : v >= 1 ? 1 : v) * 255);
  }
  return isMaskEmpty(out) ? null : out;
}

/**
 * Expands the selection by `px` document px (anti-aliased; convex corners
 * round off like Photoshop's Expand). `px <= 0` returns a copy.
 */
export function growMask(m: SelectionMask, px: number, opts: RefineOptions = {}): SelectionMask | null {
  if (!(px > 0)) return isMaskEmpty(m) ? null : cloneMask(m);
  const r = opts.binary ? Math.round(px) : px;
  return fromPlane(dilate(toPlane(m), m.width, m.height, r), m.width, m.height, !!opts.binary);
}

/** Contracts the selection by `px` document px. `px <= 0` returns a copy. */
export function shrinkMask(m: SelectionMask, px: number, opts: RefineOptions = {}): SelectionMask | null {
  if (!(px > 0)) return isMaskEmpty(m) ? null : cloneMask(m);
  const r = opts.binary ? Math.round(px) : px;
  return fromPlane(erode(toPlane(m), m.width, m.height, r), m.width, m.height, !!opts.binary);
}

/**
 * A band `px` wide centred on the selection's edge: half outside, half
 * inside (in whole-pixel mode the extra pixel of an odd width goes
 * outside). Returns null when the selection has no edge inside the canvas.
 */
export function borderMask(m: SelectionMask, px: number, opts: RefineOptions = {}): SelectionMask | null {
  if (!(px > 0)) return null;
  const binary = !!opts.binary;
  const width = binary ? Math.max(1, Math.round(px)) : px;
  const outR = binary ? Math.ceil(width / 2) : width / 2;
  const inR = binary ? Math.floor(width / 2) : width / 2;
  const plane = toPlane(m);
  const outer = dilate(plane, m.width, m.height, outR);
  const inner = inR > 0 ? erode(plane, m.width, m.height, inR) : plane;
  const band = new Float32Array(plane.length);
  for (let i = 0; i < band.length; i++) {
    // A pixel counts as "inside" only when it is at least half selected
    // (whole-pixel mode), or by its coverage otherwise.
    const inside = binary ? (inner[i] >= 0.5 ? 1 : 0) : inner[i];
    band[i] = outer[i] * (1 - inside);
  }
  return fromPlane(band, m.width, m.height, binary);
}

/** Selection from a surface's alpha ("select layer pixels"). */
export function alphaMask(src: Surface, opts: RefineOptions = {}): SelectionMask | null {
  const out = createMask(src.width, src.height);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) {
    const a = s[i * 4 + 3];
    d[i] = opts.binary ? (a >= 128 ? 255 : 0) : a;
  }
  return isMaskEmpty(out) ? null : out;
}

/**
 * Anti-aliased coverage for a hard region (`region[i]` = 1 inside, 0
 * outside). The binary region is smoothed with a separable [1 2 1]/4 tent
 * filter (canvas edges extend the border pixel) and remapped so pixels of
 * the region stay at ≥ 50 % coverage and pixels outside stay below it:
 * the marching ants trace exactly the same outline, but a straight edge
 * becomes a 7/8 – 1/8 ramp instead of a stair step. Only `bounds` ± 1 px
 * is processed.
 */
export function antialiasRegion(region: Uint8Array, width: number, height: number, bounds: Rect): Uint8Array {
  const out = new Uint8Array(width * height);
  const x0 = Math.max(0, bounds.x - 1);
  const y0 = Math.max(0, bounds.y - 1);
  const x1 = Math.min(width - 1, bounds.x + bounds.w);
  const y1 = Math.min(height - 1, bounds.y + bounds.h);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Horizontal pass into a band buffer (values ×4), then vertical (×16 total).
  const tmp = new Uint16Array(bw * (bh + 2));
  const rowAt = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);
  for (let j = -1; j <= bh; j++) {
    const y = rowAt(y0 + j);
    const row = y * width;
    for (let i = 0; i < bw; i++) {
      const x = x0 + i;
      const l = region[row + (x > 0 ? x - 1 : 0)];
      const c = region[row + x];
      const r = region[row + (x < width - 1 ? x + 1 : width - 1)];
      tmp[(j + 1) * bw + i] = l + 2 * c + r;
    }
  }
  for (let j = 0; j < bh; j++) {
    const y = y0 + j;
    for (let i = 0; i < bw; i++) {
      const f = tmp[j * bw + i] + 2 * tmp[(j + 1) * bw + i] + tmp[(j + 2) * bw + i]; // 0..16
      const idx = y * width + x0 + i;
      // Inside: 50 %…100 %; outside: 0…<50 %.
      const v = region[idx] ? 8 + f / 2 : f / 2; // in 1/16 units
      out[idx] = Math.round((v * 255) / 16);
    }
  }
  return out;
}

export interface WandOptions extends FloodOptions {
  /** Soft edge (see `antialiasRegion`). */
  antialias: boolean;
}

/**
 * Magic-wand region seeded at pixel (x, y) of straight RGBA `data`
 * (width×height): a scanline flood (contiguous) or a global colour match,
 * with the paint bucket's tolerance metric (max premultiplied channel
 * difference, see raster/flood.ts). Null when the seed is outside.
 */
export function wandMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  opts: WandOptions,
): SelectionMask | null {
  const region = floodFill(data, width, height, x, y, opts);
  if (!region.bounds) return null;
  const m = createMask(width, height);
  if (opts.antialias) {
    m.data.set(antialiasRegion(region.mask, width, height, region.bounds));
  } else {
    const src = region.mask;
    const d = m.data;
    for (let i = 0; i < d.length; i++) if (src[i]) d[i] = 255;
  }
  return m;
}
