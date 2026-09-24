/**
 * Clipping an icon to a shape: arbitrary coverage masks, backdrop shapes,
 * and rounded (circular or squircle-style) corners, all anti-aliased.
 */
import { backdropCoverage } from '../backdrop/render';
import { circleSdf, superellipseSdf, type Sdf } from '../backdrop/shapes';
import type { BackdropSpecInput } from '../backdrop/spec';
import { assertPixels, type Mask, type Pixels } from '../filters/types';
import { beginOutput, finishOutput, identityOutput } from '../filters/util';

/**
 * What to clip to: a byte mask (0..255, `Uint8Array` or
 * `Uint8ClampedArray`), a float coverage (0..1) — all width × height — or a
 * backdrop shape description (shape, inset, cornerRadius, …) rendered at
 * the image's size.
 */
export type ShapeClip = Uint8Array | Uint8ClampedArray | Float32Array | BackdropSpecInput;

/** Multiplies alpha by the coverage of `shape`. */
export function fitToShape(src: Pixels, shape: ShapeClip, mask?: Mask | null): Pixels {
  assertPixels(src, 'src');
  const { width: w, height: h } = src;
  const n = w * h;
  let cov: Float32Array | Uint8Array | Uint8ClampedArray;
  let scale: number;
  if (shape instanceof Uint8Array || shape instanceof Uint8ClampedArray || shape instanceof Float32Array) {
    if (shape.length !== n) throw new RangeError(`shape mask has ${shape.length} entries, expected ${n}`);
    cov = shape;
    scale = shape instanceof Float32Array ? 1 : 1 / 255;
  } else {
    if (n === 0) return identityOutput(src, mask, undefined);
    cov = backdropCoverage({ inset: 0, ...shape }, w, h);
    scale = 1;
  }
  const dst = beginOutput(src, mask, undefined);
  const s = src.data;
  const d = dst.data;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let k = cov[p] * scale;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    d[i] = s[i];
    d[i + 1] = s[i + 1];
    d[i + 2] = s[i + 2];
    d[i + 3] = s[i + 3] * k;
  }
  return finishOutput(src, dst, mask);
}

export type CornerStyle = 'circular' | 'squircle';

export interface RoundCornersOptions {
  /** 'circular' arcs or smoother superellipse ('squircle') corners. Default 'circular'. */
  style?: CornerStyle;
}

/** Superellipse exponent used for squircle-style corners. */
const CORNER_EXPONENT = 4;

/**
 * Rounds the image's corners: `radiusRatio` (0..0.5) of the shorter side.
 * Only the four corner squares are touched; coverage is anti-aliased.
 */
export function roundCorners(src: Pixels, radiusRatio: number, opts: RoundCornersOptions = {}, mask?: Mask | null): Pixels {
  assertPixels(src, 'src');
  const { width: w, height: h } = src;
  const ratio = Number.isFinite(radiusRatio) ? Math.max(0, Math.min(0.5, radiusRatio)) : 0;
  const r = ratio * Math.min(w, h);
  if (r <= 0) return identityOutput(src, mask, undefined);
  const squircle = opts.style === 'squircle';
  const dst = beginOutput(src, mask, undefined);
  dst.data.set(src.data);
  const d = dst.data;
  const span = Math.ceil(r);
  // [arc centre x, arc centre y, left?, top?]
  const corners: [number, number, boolean, boolean][] = [
    [r, r, true, true],
    [w - r, r, false, true],
    [r, h - r, true, false],
    [w - r, h - r, false, false],
  ];
  for (const [cx, cy, left, top] of corners) {
    const sdf: Sdf = squircle ? superellipseSdf(cx, cy, r, r, CORNER_EXPONENT) : circleSdf(cx, cy, r);
    const x0 = left ? 0 : Math.max(0, w - span);
    const y0 = top ? 0 : Math.max(0, h - span);
    const x1 = Math.min(w, x0 + span);
    const y1 = Math.min(h, y0 + span);
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5;
      // Only the part of the corner square beyond the arc's centre is curved
      // (strict on one side so pixels on a shared centre line are visited once).
      if (top ? py > cy : py <= cy) continue;
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5;
        if (left ? px > cx : px <= cx) continue;
        const cov = 0.5 - sdf(px, py, 1);
        if (cov >= 1) continue;
        const i = (y * w + x) * 4 + 3;
        d[i] = cov <= 0 ? 0 : d[i] * cov;
      }
    }
  }
  return finishOutput(src, dst, mask);
}
