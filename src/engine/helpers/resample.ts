/**
 * Cropping and resizing. Smooth resizing is separable and runs on
 * premultiplied data: area-averaging (box filter with fractional coverage)
 * when shrinking an axis, bilinear when enlarging it, so neither direction
 * darkens semi-transparent edges.
 */
import { fromPremultiplied, toPremultiplied } from '../filters/blur-core';
import { assertPixels, createPixels, type Pixels, type Rect } from '../filters/types';

export type Resampling = 'smooth' | 'nearest';

interface AxisPlan {
  /** Source indices, `taps` per destination sample. */
  idx: Int32Array;
  /** Matching weights (sum to 1 per destination sample). */
  wts: Float32Array;
  taps: number;
}

function planAxis(srcN: number, dstN: number): AxisPlan {
  const scale = dstN / srcN;
  if (scale < 1) {
    const span = srcN / dstN;
    const taps = Math.ceil(span) + 1;
    const idx = new Int32Array(dstN * taps);
    const wts = new Float32Array(dstN * taps);
    for (let d = 0; d < dstN; d++) {
      const s0 = d * span;
      const s1 = s0 + span;
      let k = 0;
      for (let i = Math.floor(s0); i < s1 && i < srcN && k < taps; i++, k++) {
        const lo = i > s0 ? i : s0;
        const hi = i + 1 < s1 ? i + 1 : s1;
        idx[d * taps + k] = i;
        wts[d * taps + k] = (hi - lo) / span;
      }
    }
    return { idx, wts, taps };
  }
  const taps = 2;
  const idx = new Int32Array(dstN * taps);
  const wts = new Float32Array(dstN * taps);
  for (let d = 0; d < dstN; d++) {
    let s = (d + 0.5) / scale - 0.5;
    if (s < 0) s = 0;
    if (s > srcN - 1) s = srcN - 1;
    const i0 = Math.floor(s);
    const i1 = i0 + 1 < srcN ? i0 + 1 : i0;
    const f = s - i0;
    idx[d * 2] = i0;
    idx[d * 2 + 1] = i1;
    wts[d * 2] = 1 - f;
    wts[d * 2 + 1] = f;
  }
  return { idx, wts, taps };
}

/** Resizes to exactly width × height (aspect is not preserved; see `fitAndCenter`). */
export function resizePixels(src: Pixels, width: number, height: number, mode: Resampling = 'smooth'): Pixels {
  assertPixels(src, 'src');
  const out = createPixels(width, height);
  const { width: sw, height: sh } = src;
  if (width === 0 || height === 0 || sw === 0 || sh === 0) return out;
  if (width === sw && height === sh) {
    out.data.set(src.data);
    return out;
  }
  const s = src.data;
  const d = out.data;
  if (mode === 'nearest') {
    const mapX = new Int32Array(width);
    for (let x = 0; x < width; x++) mapX[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / width));
    for (let y = 0, o = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / height));
      const row = sy * sw;
      for (let x = 0; x < width; x++, o += 4) {
        const i = (row + mapX[x]) * 4;
        d[o] = s[i];
        d[o + 1] = s[i + 1];
        d[o + 2] = s[i + 2];
        d[o + 3] = s[i + 3];
      }
    }
    return out;
  }
  const pm = toPremultiplied(src);
  const px = planAxis(sw, width);
  const py = planAxis(sh, height);
  // Horizontal: sw × sh → width × sh
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srow = y * sw;
    const trow = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0, j = x * px.taps; k < px.taps; k++, j++) {
        const w = px.wts[j];
        if (w === 0) continue;
        const i = (srow + px.idx[j]) * 4;
        r += pm[i] * w;
        g += pm[i + 1] * w;
        b += pm[i + 2] * w;
        a += pm[i + 3] * w;
      }
      const o = (trow + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  // Vertical: width × sh → width × height
  const res = new Float32Array(width * height * 4);
  const rowLen = width * 4;
  for (let y = 0; y < height; y++) {
    const o = y * rowLen;
    for (let k = 0, j = y * py.taps; k < py.taps; k++, j++) {
      const w = py.wts[j];
      if (w === 0) continue;
      const t = py.idx[j] * rowLen;
      for (let c = 0; c < rowLen; c++) res[o + c] += tmp[t + c] * w;
    }
  }
  fromPremultiplied(res, d);
  return out;
}

/** Copies `rect` out of `src`; parts of the rect outside the image are transparent. */
export function cropPixels(src: Pixels, rect: Rect): Pixels {
  assertPixels(src, 'src');
  const out = createPixels(Math.max(0, Math.round(rect.width)), Math.max(0, Math.round(rect.height)));
  const rx = Math.round(rect.x);
  const ry = Math.round(rect.y);
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(src.width, rx + out.width);
  const y1 = Math.min(src.height, ry + out.height);
  if (x1 <= x0 || y1 <= y0) return out;
  for (let y = y0; y < y1; y++) {
    const from = (y * src.width + x0) * 4;
    out.data.set(src.data.subarray(from, from + (x1 - x0) * 4), ((y - ry) * out.width + (x0 - rx)) * 4);
  }
  return out;
}

/** Draws `src` into `dst` at integer offset (x, y), replacing pixels (no blending); clipped to `dst`. */
export function blitPixels(src: Pixels, dst: Pixels, x: number, y: number): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dst.width, x + src.width);
  const y1 = Math.min(dst.height, y + src.height);
  if (x1 <= x0 || y1 <= y0) return;
  for (let yy = y0; yy < y1; yy++) {
    const from = ((yy - y) * src.width + (x0 - x)) * 4;
    dst.data.set(src.data.subarray(from, from + (x1 - x0) * 4), (yy * dst.width + x0) * 4);
  }
}
