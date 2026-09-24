// Straight-alpha pixel blending helpers used by the painting tools.

import type { Surface } from './surface';
import type { Rect } from '../util/rect';
import { clipRect } from '../util/rect';

const INV255 = 1 / 255;

/**
 * Source-over of a single colour with coverage `s` (0..1, already including
 * the colour's own alpha) onto the straight RGBA8 pixel at `i` of `base`,
 * written to `out[i]`. `base` and `out` may be the same buffer.
 */
export function overPixel(
  base: Uint8ClampedArray,
  out: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
  s: number,
): void {
  const ba = base[i + 3] * INV255;
  if (s <= 0) {
    if (base !== out) {
      out[i] = base[i];
      out[i + 1] = base[i + 1];
      out[i + 2] = base[i + 2];
      out[i + 3] = base[i + 3];
    }
    return;
  }
  const oa = s + ba * (1 - s);
  const kb = (ba * (1 - s)) / oa;
  const ks = s / oa;
  out[i] = r * ks + base[i] * kb;
  out[i + 1] = g * ks + base[i + 1] * kb;
  out[i + 2] = b * ks + base[i + 2] * kb;
  out[i + 3] = oa * 255;
}

/** Destination-out: reduces the alpha of `base[i]` by coverage `s`, into `out[i]`. */
export function erasePixel(base: Uint8ClampedArray, out: Uint8ClampedArray, i: number, s: number): void {
  out[i] = base[i];
  out[i + 1] = base[i + 1];
  out[i + 2] = base[i + 2];
  out[i + 3] = base[i + 3] * (1 - s);
}

/**
 * Source-over of `src` onto `dst` at (dx, dy) with an extra opacity, both
 * straight RGBA8. Returns the affected destination rect.
 */
export function blitOver(dst: Surface, src: Surface, dx = 0, dy = 0, opacity = 1): Rect | null {
  const area = clipRect({ x: dx, y: dy, w: src.width, h: src.height }, dst.width, dst.height);
  if (!area || opacity <= 0) return null;
  const s = src.data;
  const d = dst.data;
  for (let y = area.y; y < area.y + area.h; y++) {
    let si = ((y - dy) * src.width + (area.x - dx)) * 4;
    let di = (y * dst.width + area.x) * 4;
    for (let x = 0; x < area.w; x++, si += 4, di += 4) {
      const sa = s[si + 3] * INV255 * opacity;
      if (sa > 0) overPixel(d, d, di, s[si], s[si + 1], s[si + 2], sa);
    }
  }
  return area;
}
