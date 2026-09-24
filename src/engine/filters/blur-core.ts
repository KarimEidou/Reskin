/**
 * Gaussian blur approximated by three box passes per axis, on interleaved
 * float data (any channel count), plus premultiplied-alpha conversions.
 *
 * Box widths are *fractional*: each pass is a box of integer radius R plus
 * a partial tap of weight f at ±(R+1), chosen so that the three passes
 * together have exactly the requested variance σ². The blur therefore
 * changes smoothly with σ (no stepping while a slider moves). Each pass is
 * a running sum, so cost is independent of the radius. Edges clamp
 * (extend the border pixel), so opaque images keep opaque borders.
 */
import type { Pixels } from './types';

/** One box pass: integer radius `r` plus edge taps of weight `f` (0 ≤ f < 1). */
export interface BoxPass {
  r: number;
  f: number;
}

/** The box that gives `passes` passes a combined variance of `sigma²`. */
export function boxForSigma(sigma: number, passes = 3): BoxPass {
  const v = sigma > 0 ? (sigma * sigma) / passes : 0;
  // Largest integer radius whose plain box variance R(R+1)/3 does not exceed v.
  let r = Math.floor((-1 + Math.sqrt(1 + 12 * v)) / 2);
  if (r < 0) r = 0;
  while ((r + 1) * (r + 2) <= 3 * v) r++;
  while (r > 0 && r * (r + 1) > 3 * v) r--;
  const twoS2 = (r * (r + 1) * (2 * r + 1)) / 3;
  const denom = 2 * ((r + 1) * (r + 1) - v);
  let f = denom > 0 ? (v * (2 * r + 1) - twoS2) / denom : 0;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  return { r, f };
}

/** Variance of a single (fractional) box pass; exposed for tests. */
export function boxVariance({ r, f }: BoxPass): number {
  const twoS2 = (r * (r + 1) * (2 * r + 1)) / 3;
  return (twoS2 + 2 * f * (r + 1) * (r + 1)) / (2 * r + 1 + 2 * f);
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, ch: number, r: number, f: number): void {
  const norm = 1 / (2 * r + 1 + 2 * f);
  const last = w - 1;
  const rowLen = w * ch;
  for (let y = 0; y < h; y++) {
    const row = y * rowLen;
    for (let c = 0; c < ch; c++) {
      const base = row + c;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + (k < 0 ? 0 : k > last ? last : k) * ch];
      for (let x = 0; x < w; x++) {
        const lo = x - r - 1;
        const hi = x + r + 1;
        const rm = x - r;
        const eL = src[base + (lo < 0 ? 0 : lo) * ch];
        const eH = src[base + (hi > last ? last : hi) * ch];
        dst[base + x * ch] = (sum + f * (eL + eH)) * norm;
        sum += eH - src[base + (rm < 0 ? 0 : rm) * ch];
      }
    }
  }
}

/** `boxH` specialised for interleaved RGBA: one pass with four running sums. */
function boxH4(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, f: number): void {
  const norm = 1 / (2 * r + 1 + 2 * f);
  const last = w - 1;
  const rowLen = w * 4;
  for (let y = 0; y < h; y++) {
    const row = y * rowLen;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let k = -r; k <= r; k++) {
      const i = row + (k < 0 ? 0 : k > last ? last : k) * 4;
      s0 += src[i];
      s1 += src[i + 1];
      s2 += src[i + 2];
      s3 += src[i + 3];
    }
    for (let x = 0; x < w; x++) {
      const lo = x - r - 1;
      const hi = x + r + 1;
      const rm = x - r;
      const iL = row + (lo < 0 ? 0 : lo) * 4;
      const iH = row + (hi > last ? last : hi) * 4;
      const iR = row + (rm < 0 ? 0 : rm) * 4;
      const o = row + x * 4;
      const h0 = src[iH];
      const h1 = src[iH + 1];
      const h2 = src[iH + 2];
      const h3 = src[iH + 3];
      dst[o] = (s0 + f * (src[iL] + h0)) * norm;
      dst[o + 1] = (s1 + f * (src[iL + 1] + h1)) * norm;
      dst[o + 2] = (s2 + f * (src[iL + 2] + h2)) * norm;
      dst[o + 3] = (s3 + f * (src[iL + 3] + h3)) * norm;
      s0 += h0 - src[iR];
      s1 += h1 - src[iR + 1];
      s2 += h2 - src[iR + 2];
      s3 += h3 - src[iR + 3];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, ch: number, r: number, f: number, acc: Float64Array): void {
  const norm = 1 / (2 * r + 1 + 2 * f);
  const last = h - 1;
  const rowLen = w * ch;
  acc.fill(0);
  for (let k = -r; k <= r; k++) {
    const base = (k < 0 ? 0 : k > last ? last : k) * rowLen;
    for (let j = 0; j < rowLen; j++) acc[j] += src[base + j];
  }
  for (let y = 0; y < h; y++) {
    const lo = y - r - 1;
    const hi = y + r + 1;
    const rm = y - r;
    const bL = (lo < 0 ? 0 : lo) * rowLen;
    const bH = (hi > last ? last : hi) * rowLen;
    const bR = (rm < 0 ? 0 : rm) * rowLen;
    const o = y * rowLen;
    for (let j = 0; j < rowLen; j++) {
      const eH = src[bH + j];
      dst[o + j] = (acc[j] + f * (src[bL + j] + eH)) * norm;
      acc[j] += eH - src[bR + j];
    }
  }
}

/**
 * Blurs `data` (w×h, `channels` interleaved floats) in place with a Gaussian
 * of standard deviation `sigmaX` / `sigmaY` px (CSS `blur()` semantics).
 */
export function gaussianBlur(data: Float32Array, width: number, height: number, channels: number, sigmaX: number, sigmaY = sigmaX): void {
  if (width === 0 || height === 0) return;
  if (data.length < width * height * channels) throw new RangeError('blur buffer too small');
  const bx = boxForSigma(sigmaX);
  const by = boxForSigma(sigmaY);
  const doX = bx.r > 0 || bx.f > 1e-6;
  const doY = by.r > 0 || by.f > 1e-6;
  if (!doX && !doY) return;
  const tmp = new Float32Array(width * height * channels);
  if (doX) {
    const pass = channels === 4 ? (a: Float32Array, b: Float32Array) => boxH4(a, b, width, height, bx.r, bx.f) : (a: Float32Array, b: Float32Array) => boxH(a, b, width, height, channels, bx.r, bx.f);
    pass(data, tmp);
    pass(tmp, data);
    pass(data, tmp);
  }
  // Three X passes ping-pong data → tmp → data → tmp, so the result is in
  // `tmp` (or still in `data` when X was skipped).
  let cur = doX ? tmp : data;
  let other = doX ? data : tmp;
  if (doY) {
    const acc = new Float64Array(width * channels);
    for (let i = 0; i < 3; i++) {
      boxV(cur, other, width, height, channels, by.r, by.f, acc);
      const t = cur;
      cur = other;
      other = t;
    }
  }
  if (cur !== data) data.set(cur);
}

/**
 * Straight RGBA8 → premultiplied float RGBA (0..255 scale): colour channels
 * become c·a/255, alpha stays a.
 */
export function toPremultiplied(src: Pixels, out?: Float32Array): Float32Array {
  const s = src.data;
  const buf = out ?? new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3];
    const k = a / 255;
    buf[i] = s[i] * k;
    buf[i + 1] = s[i + 1] * k;
    buf[i + 2] = s[i + 2] * k;
    buf[i + 3] = a;
  }
  return buf;
}

/** Premultiplied float RGBA (0..255 scale) → straight RGBA8 in `dst`. */
export function fromPremultiplied(buf: Float32Array, dst: Uint8ClampedArray): void {
  for (let i = 0; i < dst.length; i += 4) {
    const a = buf[i + 3];
    if (a <= 1e-4) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
      continue;
    }
    const k = 255 / a;
    dst[i] = buf[i] * k;
    dst[i + 1] = buf[i + 1] * k;
    dst[i + 2] = buf[i + 2] * k;
    dst[i + 3] = a;
  }
}

/** Blurs straight RGBA8 pixels (in premultiplied space) and returns premultiplied floats. */
export function blurPremultiplied(src: Pixels, sigma: number): Float32Array {
  const buf = toPremultiplied(src);
  gaussianBlur(buf, src.width, src.height, 4, sigma);
  return buf;
}
