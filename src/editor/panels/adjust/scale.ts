// Pixel-size settings of the adjustments (px sliders: blur and glow radii,
// block sizes, relief heights, offsets, feathering) are tuned for the 512 px
// master. A pixel-art document (16–64 px) gets them scaled to its size, so
// an adjustment looks the same at every size: the default and the slider's
// range shrink with the document, snapped to the slider's step and never
// below the smallest value that still changes the picture.

import { MASTER_SIZE } from '$engine/doc/types';
import type { ControlSpec } from './helper-defs';

/** Rounds `v` to the slider's step grid (from `min`), without float noise. */
function snap(v: number, min: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number((min + Math.round((v - min) / step) * step).toFixed(decimals));
}

/**
 * The smallest px value that changes anything: one step above a positive
 * minimum (a block size or height of 1 px leaves the image as it is), one
 * step above zero otherwise.
 */
function smallestEffect(min: number, step: number): number {
  return min > 0 ? snap(min + step, min, step) : step;
}

/** `params` for a document of `size` px (unchanged at the master size and above). */
export function scaleParams(params: readonly ControlSpec[], size: number): ControlSpec[] {
  const k = size / MASTER_SIZE;
  if (!(k > 0 && k < 1)) return [...params];
  return params.map((p) => {
    if (p.kind !== 'slider' || p.unit !== 'px') return p;
    const least = smallestEffect(p.min, p.step);
    const max = Math.min(p.max, Math.max(least, snap(p.max * k, p.min, p.step)));
    // A default that does nothing (0 px) stays off.
    const value = p.default <= p.min ? p.default : Math.min(max, Math.max(least, snap(p.default * k, p.min, p.step)));
    return { ...p, max, default: value };
  });
}
