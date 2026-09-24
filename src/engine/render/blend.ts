// W3C Compositing and Blending Level 1: the 12 separable blend modes and
// source-over compositing with blending, on premultiplied float pixels.
//
// For backdrop Cb/αb and source Cs/αs (straight colours):
//   Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)
//   co  = αs·Cs' + (1 − αs)·αb·Cb          (premultiplied result)
//   αo  = αs + αb·(1 − αs)

import type { BlendMode } from '../doc/types';

export type BlendFn = (cb: number, cs: number) => number;

function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1);
}

function softLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
}

export const BLEND_FUNCTIONS: Readonly<Record<BlendMode, BlendFn>> = {
  normal: (_cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  overlay: (cb, cs) => hardLight(cs, cb),
  darken: (cb, cs) => (cb < cs ? cb : cs),
  lighten: (cb, cs) => (cb > cs ? cb : cs),
  'color-dodge': (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))),
  'color-burn': (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)),
  'hard-light': hardLight,
  'soft-light': softLight,
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
};

/** Canvas 2D `globalCompositeOperation` for each mode (for the interactive view). */
export const CANVAS_COMPOSITE_OP: Readonly<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
};

/**
 * Blends one premultiplied source pixel onto a premultiplied backdrop pixel
 * (both [r, g, b, a] in 0..1) with an extra opacity. Reference
 * implementation; `blendInto` is the fast bulk version.
 */
export function blendPixel(
  mode: BlendMode,
  backdrop: readonly number[],
  source: readonly number[],
  opacity = 1,
): [number, number, number, number] {
  // Float32 like the bulk path, so both stay monomorphic and agree exactly.
  const acc = Float32Array.from(backdrop);
  blendInto(acc, Float32Array.from(source), mode, opacity, 0, 1);
  return [acc[0], acc[1], acc[2], acc[3]];
}

/**
 * Composites premultiplied `src` onto premultiplied `acc` in place for
 * pixels [from, to) (pixel indices), applying `opacity` to the source.
 */
export function blendInto(
  acc: Float32Array,
  src: Float32Array,
  mode: BlendMode,
  opacity: number,
  from = 0,
  to = acc.length >> 2,
): void {
  if (opacity <= 0) return;
  if (mode === 'normal') {
    for (let p = from * 4, end = to * 4; p < end; p += 4) {
      const as = src[p + 3] * opacity;
      if (as <= 0) continue;
      const k = 1 - as;
      acc[p] = src[p] * opacity + acc[p] * k;
      acc[p + 1] = src[p + 1] * opacity + acc[p + 1] * k;
      acc[p + 2] = src[p + 2] * opacity + acc[p + 2] * k;
      acc[p + 3] = as + acc[p + 3] * k;
    }
    return;
  }
  const B = BLEND_FUNCTIONS[mode];
  for (let p = from * 4, end = to * 4; p < end; p += 4) {
    const sa = src[p + 3];
    const as = sa * opacity;
    if (as <= 0) continue;
    const ab = acc[p + 3];
    const invSa = 1 / sa;
    const invAb = ab > 0 ? 1 / ab : 0;
    for (let c = 0; c < 3; c++) {
      const cs = src[p + c] * invSa; // straight source colour
      const cb = acc[p + c] * invAb; // straight backdrop colour
      const mixed = (1 - ab) * cs + ab * B(cb, cs);
      acc[p + c] = as * mixed + (1 - as) * acc[p + c];
    }
    acc[p + 3] = as + ab * (1 - as);
  }
}

const INV255 = 1 / 255;

/**
 * `blendInto` for a straight-alpha 8-bit source (a layer surface), without
 * converting it to a float image first. Same formulas.
 */
export function blendStraightInto(acc: Float32Array, src: Uint8ClampedArray, mode: BlendMode, opacity: number): void {
  if (opacity <= 0) return;
  const k = opacity * INV255;
  if (mode === 'normal') {
    for (let p = 0; p < acc.length; p += 4) {
      const as = src[p + 3] * k;
      if (as <= 0) continue;
      const inv = 1 - as;
      const m = as * INV255;
      acc[p] = src[p] * m + acc[p] * inv;
      acc[p + 1] = src[p + 1] * m + acc[p + 1] * inv;
      acc[p + 2] = src[p + 2] * m + acc[p + 2] * inv;
      acc[p + 3] = as + acc[p + 3] * inv;
    }
    return;
  }
  const B = BLEND_FUNCTIONS[mode];
  for (let p = 0; p < acc.length; p += 4) {
    const as = src[p + 3] * k;
    if (as <= 0) continue;
    const ab = acc[p + 3];
    const invAb = ab > 0 ? 1 / ab : 0;
    for (let c = 0; c < 3; c++) {
      const cs = src[p + c] * INV255;
      const cb = acc[p + c] * invAb;
      const mixed = (1 - ab) * cs + ab * B(cb, cs);
      acc[p + c] = as * mixed + (1 - as) * acc[p + c];
    }
    acc[p + 3] = as + ab * (1 - as);
  }
}
