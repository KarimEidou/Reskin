/**
 * Plumbing shared by every filter: output-buffer selection, selection-mask
 * blending and small numeric helpers.
 *
 * The pattern each filter follows:
 *
 * ```ts
 * const dst = beginOutput(src, mask, out); // where to write the raw result
 * ...write the unmasked result for every pixel into dst.data (reading src)...
 * return finishOutput(src, dst, mask, out); // blend by mask, land in `out`
 * ```
 *
 * Writing pixel i while reading pixel i is always safe even when `out`
 * aliases `src`; filters that read neighbours compute into scratch buffers
 * first.
 */
import { aliases, assertMask, assertPixels, createPixels, sameSize, type Mask, type Pixels } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep; a hard step when `e0 >= e1`. */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** A finite number, or the fallback. */
export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Recursively freezes plain objects and arrays (for exported defaults / presets). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/**
 * Validates inputs and picks the buffer a filter should write its raw
 * (unmasked) result into. When a mask is present and `out` aliases `src`,
 * a scratch image is returned so the original survives for blending.
 */
export function beginOutput(src: Pixels, mask: Mask | null | undefined, out: Pixels | undefined): Pixels {
  assertPixels(src, 'src');
  assertMask(mask, src.width, src.height);
  if (out) {
    assertPixels(out, 'out');
    if (!sameSize(src, out)) {
      throw new RangeError(`out is ${out.width}x${out.height}, expected ${src.width}x${src.height}`);
    }
    if (mask && aliases(src, out)) return createPixels(src.width, src.height);
    return out;
  }
  return createPixels(src.width, src.height);
}

/**
 * Blends `result` over `src` by mask coverage and returns the final image
 * (`out` when given). Blending happens in premultiplied space so partially
 * selected pixels whose alpha changed do not pick up colour fringes; when
 * alpha is unchanged it reduces to a plain per-channel lerp. Mask 0 yields
 * the original pixel exactly and 255 the result exactly.
 */
export function finishOutput(src: Pixels, result: Pixels, mask: Mask | null | undefined, out?: Pixels): Pixels {
  const dst = out ?? result;
  if (!mask) {
    if (dst !== result) dst.data.set(result.data);
    return dst;
  }
  const s = src.data;
  const r = result.data;
  const d = dst.data;
  const n = mask.length;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const m = mask[p];
    if (m === 255) {
      if (d !== r) {
        d[i] = r[i];
        d[i + 1] = r[i + 1];
        d[i + 2] = r[i + 2];
        d[i + 3] = r[i + 3];
      }
      continue;
    }
    if (m === 0) {
      d[i] = s[i];
      d[i + 1] = s[i + 1];
      d[i + 2] = s[i + 2];
      d[i + 3] = s[i + 3];
      continue;
    }
    const t = m / 255;
    const ao = s[i + 3];
    const ar = r[i + 3];
    if (ao === ar) {
      d[i] = s[i] + (r[i] - s[i]) * t;
      d[i + 1] = s[i + 1] + (r[i + 1] - s[i + 1]) * t;
      d[i + 2] = s[i + 2] + (r[i + 2] - s[i + 2]) * t;
      d[i + 3] = ao;
      continue;
    }
    const a = ao + (ar - ao) * t;
    if (a <= 0) {
      d[i] = s[i] + (r[i] - s[i]) * t;
      d[i + 1] = s[i + 1] + (r[i + 1] - s[i + 1]) * t;
      d[i + 2] = s[i + 2] + (r[i + 2] - s[i + 2]) * t;
      d[i + 3] = 0;
      continue;
    }
    const inv = 1 / a;
    d[i] = (s[i] * ao + (r[i] * ar - s[i] * ao) * t) * inv;
    d[i + 1] = (s[i + 1] * ao + (r[i + 1] * ar - s[i + 1] * ao) * t) * inv;
    d[i + 2] = (s[i + 2] * ao + (r[i + 2] * ar - s[i + 2] * ao) * t) * inv;
    d[i + 3] = a;
  }
  return dst;
}

/** Copies `src` into the output (identity filter), honouring `out`. */
export function identityOutput(src: Pixels, mask: Mask | null | undefined, out: Pixels | undefined): Pixels {
  assertPixels(src, 'src');
  assertMask(mask, src.width, src.height);
  if (!out) return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  assertPixels(out, 'out');
  if (!sameSize(src, out)) throw new RangeError(`out is ${out.width}x${out.height}, expected ${src.width}x${src.height}`);
  if (out.data !== src.data) out.data.set(src.data);
  return out;
}

/**
 * Applies a per-channel lookup table to R, G and B (alpha untouched).
 * `lut` may hold one table for all channels (256 entries) or three
 * consecutive tables (768 entries: R, G, B).
 */
export function applyRgbLut(src: Pixels, lut: Uint8ClampedArray | Uint8Array, mask: Mask | null | undefined, out: Pixels | undefined): Pixels {
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  const gOff = lut.length >= 768 ? 256 : 0;
  const bOff = lut.length >= 768 ? 512 : 0;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = lut[s[i]];
    d[i + 1] = lut[gOff + s[i + 1]];
    d[i + 2] = lut[bOff + s[i + 2]];
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}
