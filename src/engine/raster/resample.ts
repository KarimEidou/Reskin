// Resampling of premultiplied float images (premultiplied, so transparent
// neighbours never bleed dark or wrong colours into edges).
//
// - `resize`: separable; box/area filter on axes that shrink, bilinear (tent)
//   on axes that grow. The general-purpose high quality path.
// - `resizeNearest` / `resizeBilinear`: explicit filters.
// - `halve` / `downsampleStepwise`: 2×2 box halving then a final area pass —
//   the icon export path (crisp, no moiré, correct alpha).
// - integer nearest upscale / box downscale + centring for pixel art.
// - `affineResample`: arbitrary transforms (move/scale/rotate commit).

import type { FloatImage } from './float-image';
import { createFloatImage, floatToSurface, surfaceToFloat } from './float-image';
import { sampleBilinear, sampleNearest } from './sample';
import type { Surface } from './surface';
import type { Affine } from '../geometry/affine';
import { apply, invert } from '../geometry/affine';
import type { Rect } from '../util/rect';

export type ResampleFilter = 'nearest' | 'bilinear' | 'area';

interface Contribution {
  start: number;
  weights: Float32Array;
}

/** Per-destination-index source weights along one axis. */
function contributions(src: number, dst: number): Contribution[] {
  const out: Contribution[] = new Array(dst);
  if (dst <= src) {
    // Box filter: dst pixel i covers source [i·r, (i+1)·r).
    const r = src / dst;
    for (let i = 0; i < dst; i++) {
      const lo = i * r;
      const hi = lo + r;
      const start = Math.floor(lo);
      const end = Math.min(src, Math.ceil(hi - 1e-9));
      const weights = new Float32Array(end - start);
      for (let k = start; k < end; k++) {
        weights[k - start] = (Math.min(k + 1, hi) - Math.max(k, lo)) / r;
      }
      out[i] = { start, weights };
    }
  } else {
    // Tent filter (bilinear), edges clamped.
    const scale = src / dst;
    for (let i = 0; i < dst; i++) {
      const s = (i + 0.5) * scale - 0.5;
      let i0 = Math.floor(s);
      let t = s - i0;
      if (i0 < 0) {
        i0 = 0;
        t = 0;
      }
      if (i0 >= src - 1) {
        out[i] = { start: src - 1, weights: Float32Array.of(1) };
        continue;
      }
      out[i] = { start: i0, weights: Float32Array.of(1 - t, t) };
    }
  }
  return out;
}

/** High-quality separable resize (area when shrinking, bilinear when growing). */
export function resize(src: FloatImage, dw: number, dh: number): FloatImage {
  if (dw === src.width && dh === src.height) return { ...src, data: src.data.slice() };
  const sw = src.width;
  const sh = src.height;
  const cx = contributions(sw, dw);
  const cy = contributions(sh, dh);
  // Horizontal pass: sw×sh → dw×sh.
  const tmp = new Float32Array(dw * sh * 4);
  const s = src.data;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    const orow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const { start, weights } = cx[x];
      let r = 0, g = 0, b = 0, a = 0;
      let p = row + start * 4;
      for (let k = 0; k < weights.length; k++, p += 4) {
        const wt = weights[k];
        r += s[p] * wt;
        g += s[p + 1] * wt;
        b += s[p + 2] * wt;
        a += s[p + 3] * wt;
      }
      const o = orow + x * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  // Vertical pass: dw×sh → dw×dh.
  const out = createFloatImage(dw, dh);
  const d = out.data;
  const stride = dw * 4;
  for (let y = 0; y < dh; y++) {
    const { start, weights } = cy[y];
    const orow = y * stride;
    for (let x = 0; x < stride; x++) {
      let v = 0;
      let p = start * stride + x;
      for (let k = 0; k < weights.length; k++, p += stride) v += tmp[p] * weights[k];
      d[orow + x] = v;
    }
  }
  return out;
}

export function resizeNearest(src: FloatImage, dw: number, dh: number): FloatImage {
  const out = createFloatImage(dw, dh);
  const sx = src.width / dw;
  const sy = src.height / dh;
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < dh; y++) {
    const yy = Math.min(src.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < dw; x++) {
      const xx = Math.min(src.width - 1, Math.floor((x + 0.5) * sx));
      const p = (yy * src.width + xx) * 4;
      const o = (y * dw + x) * 4;
      d[o] = s[p];
      d[o + 1] = s[p + 1];
      d[o + 2] = s[p + 2];
      d[o + 3] = s[p + 3];
    }
  }
  return out;
}

export function resizeBilinear(src: FloatImage, dw: number, dh: number): FloatImage {
  const out = createFloatImage(dw, dh);
  const sx = src.width / dw;
  const sy = src.height / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      sampleBilinear(src, (x + 0.5) * sx, (y + 0.5) * sy, out.data, (y * dw + x) * 4, 'clamp');
    }
  }
  return out;
}

export function resizeWith(src: FloatImage, dw: number, dh: number, filter: ResampleFilter): FloatImage {
  switch (filter) {
    case 'nearest':
      return resizeNearest(src, dw, dh);
    case 'bilinear':
      return resizeBilinear(src, dw, dh);
    case 'area':
      return resize(src, dw, dh);
  }
}

/** 2×2 box average. Odd sizes fall back to an area resize to half (rounded down, ≥1). */
export function halve(src: FloatImage): FloatImage {
  const w = src.width;
  const h = src.height;
  if (w % 2 !== 0 || h % 2 !== 0) {
    return resize(src, Math.max(1, w >> 1), Math.max(1, h >> 1));
  }
  const dw = w >> 1;
  const dh = h >> 1;
  const out = createFloatImage(dw, dh);
  const s = src.data;
  const d = out.data;
  const row = w * 4;
  for (let y = 0; y < dh; y++) {
    let p = y * 2 * row;
    let o = y * dw * 4;
    for (let x = 0; x < dw; x++, p += 8, o += 4) {
      d[o] = (s[p] + s[p + 4] + s[p + row] + s[p + row + 4]) * 0.25;
      d[o + 1] = (s[p + 1] + s[p + 5] + s[p + row + 1] + s[p + row + 5]) * 0.25;
      d[o + 2] = (s[p + 2] + s[p + 6] + s[p + row + 2] + s[p + row + 6]) * 0.25;
      d[o + 3] = (s[p + 3] + s[p + 7] + s[p + row + 3] + s[p + row + 7]) * 0.25;
    }
  }
  return out;
}

/**
 * Downscale by repeated halving while the result stays ≥ the target, then a
 * final area resample to exactly `dw`×`dh`. Upscales fall back to `resize`.
 */
export function downsampleStepwise(src: FloatImage, dw: number, dh: number = dw): FloatImage {
  let img = src;
  while (img.width >= dw * 2 && img.height >= dh * 2) img = halve(img);
  if (img.width === dw && img.height === dh) return img === src ? { ...src, data: src.data.slice() } : img;
  return resize(img, dw, dh);
}

/** Nearest-neighbour upscale by an integer factor. */
export function upscaleInteger(src: FloatImage, k: number): FloatImage {
  if (k === 1) return { ...src, data: src.data.slice() };
  const dw = src.width * k;
  const dh = src.height * k;
  const out = createFloatImage(dw, dh);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < dh; y++) {
    const srow = ((y / k) | 0) * src.width * 4;
    let o = y * dw * 4;
    for (let x = 0; x < dw; x++, o += 4) {
      const p = srow + ((x / k) | 0) * 4;
      d[o] = s[p];
      d[o + 1] = s[p + 1];
      d[o + 2] = s[p + 2];
      d[o + 3] = s[p + 3];
    }
  }
  return out;
}

/**
 * Integer box downscale: every output pixel is the mean of a k×k block
 * (trailing partial blocks are dropped). Grid-aligned, no sub-pixel blur.
 */
export function downscaleInteger(src: FloatImage, k: number): FloatImage {
  if (k === 1) return { ...src, data: src.data.slice() };
  const dw = Math.max(1, Math.floor(src.width / k));
  const dh = Math.max(1, Math.floor(src.height / k));
  const out = createFloatImage(dw, dh);
  const s = src.data;
  const d = out.data;
  const inv = 1 / (k * k);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < k; j++) {
        let p = ((y * k + j) * src.width + x * k) * 4;
        for (let i = 0; i < k; i++, p += 4) {
          r += s[p];
          g += s[p + 1];
          b += s[p + 2];
          a += s[p + 3];
        }
      }
      const o = (y * dw + x) * 4;
      d[o] = r * inv;
      d[o + 1] = g * inv;
      d[o + 2] = b * inv;
      d[o + 3] = a * inv;
    }
  }
  return out;
}

/** Places `src` centred (offset rounded down) on a transparent `dw`×`dh` canvas; crops if larger. */
export function padCentered(src: FloatImage, dw: number, dh: number = dw): FloatImage {
  const out = createFloatImage(dw, dh);
  const ox = Math.floor((dw - src.width) / 2);
  const oy = Math.floor((dh - src.height) / 2);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dw, ox + src.width);
  const y1 = Math.min(dh, oy + src.height);
  if (x1 <= x0 || y1 <= y0) return out;
  const n = (x1 - x0) * 4;
  for (let y = y0; y < y1; y++) {
    const p = ((y - oy) * src.width + (x0 - ox)) * 4;
    out.data.set(src.data.subarray(p, p + n), (y * dw + x0) * 4);
  }
  return out;
}

/**
 * Renders `src` through `forward` (source → destination coordinates) into a
 * `dw`×`dh` image. Only `area` (destination rect, default everything) is
 * computed; the rest stays transparent. Outside the source is transparent.
 */
export function affineResample(
  src: FloatImage,
  forward: Affine,
  dw: number,
  dh: number,
  filter: 'nearest' | 'bilinear' = 'bilinear',
  area?: Rect | null,
): FloatImage {
  const out = createFloatImage(dw, dh);
  const inv = invert(forward);
  if (!inv) return out;
  const x0 = Math.max(0, area?.x ?? 0);
  const y0 = Math.max(0, area?.y ?? 0);
  const x1 = Math.min(dw, area ? area.x + area.w : dw);
  const y1 = Math.min(dh, area ? area.y + area.h : dh);
  const sample = filter === 'nearest' ? sampleNearest : sampleBilinear;
  const d = out.data;
  for (let y = y0; y < y1; y++) {
    // Walk the row incrementally in source space.
    const start = apply(inv, x0 + 0.5, y + 0.5);
    let sx = start.x;
    let sy = start.y;
    for (let x = x0; x < x1; x++) {
      sample(src, sx, sy, d, (y * dw + x) * 4, 'transparent');
      sx += inv[0];
      sy += inv[1];
    }
  }
  return out;
}

/** Convenience: resize a straight 8-bit surface. */
export function resizeSurface(src: Surface, dw: number, dh: number, filter: ResampleFilter = 'area'): Surface {
  return floatToSurface(resizeWith(surfaceToFloat(src), dw, dh, filter));
}
