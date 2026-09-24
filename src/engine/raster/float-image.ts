// FloatImage: premultiplied RGBA in 0..1 floats. The working format for
// compositing, resampling and filters (see surface.ts for why storage is
// straight 8-bit). `toSurface` is the single place float → 8-bit rounding
// happens, which keeps quality high across multi-step pipelines like export.

import { Surface } from './surface';
import type { Rect } from '../util/rect';

export interface FloatImage {
  width: number;
  height: number;
  /** Premultiplied RGBA, 0..1, row-major. */
  data: Float32Array;
}

export function createFloatImage(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 4) };
}

export function cloneFloatImage(img: FloatImage): FloatImage {
  return { width: img.width, height: img.height, data: img.data.slice() };
}

const INV255 = 1 / 255;

/** Straight 8-bit → premultiplied float. Reuses `out` when it has the right size. */
export function surfaceToFloat(src: Surface, out?: FloatImage): FloatImage {
  const img =
    out && out.width === src.width && out.height === src.height
      ? out
      : createFloatImage(src.width, src.height);
  const s = src.data;
  const d = img.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3] * INV255;
    if (a === 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      continue;
    }
    const k = a * INV255;
    d[i] = s[i] * k;
    d[i + 1] = s[i + 1] * k;
    d[i + 2] = s[i + 2] * k;
    d[i + 3] = a;
  }
  return img;
}

/**
 * Premultiplied float → straight 8-bit (rounded, clamped). Fully
 * transparent results become (0,0,0,0).
 */
export function floatToSurface(src: FloatImage, out?: Surface): Surface {
  const surf =
    out && out.width === src.width && out.height === src.height
      ? out
      : new Surface(src.width, src.height);
  writeFloatToPixels(src.data, surf.data, 0, src.data.length);
  return surf;
}

/** Converts only `area` of a float image into an existing surface of equal size. */
export function floatToSurfaceRect(src: FloatImage, dst: Surface, area: Rect): void {
  for (let y = area.y; y < area.y + area.h; y++) {
    const start = (y * src.width + area.x) * 4;
    writeFloatToPixels(src.data, dst.data, start, start + area.w * 4);
  }
}

function writeFloatToPixels(s: Float32Array, d: Uint8ClampedArray, from: number, to: number): void {
  for (let i = from; i < to; i += 4) {
    const a = s[i + 3];
    // Below half an 8-bit step the pixel rounds to fully transparent.
    if (a < 0.5 / 255) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    d[i] = s[i] * k;
    d[i + 1] = s[i + 1] * k;
    d[i + 2] = s[i + 2] * k;
    d[i + 3] = a * 255;
  }
}

/** Clamps channels to 0..1 and colour to ≤ alpha (valid premultiplied data). */
export function sanitizePremultiplied(img: FloatImage): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let a = d[i + 3];
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    d[i + 3] = a;
    for (let c = 0; c < 3; c++) {
      const v = d[i + c];
      d[i + c] = v < 0 ? 0 : v > a ? a : v;
    }
  }
}

/** Extracts the alpha channel of a straight surface as a 0..1 plane. */
export function alphaPlane(src: Surface, out?: Float32Array): Float32Array {
  const n = src.width * src.height;
  const plane = out && out.length === n ? out : new Float32Array(n);
  const d = src.data;
  for (let i = 0; i < n; i++) plane[i] = d[i * 4 + 3] * INV255;
  return plane;
}
