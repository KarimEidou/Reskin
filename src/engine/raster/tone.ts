// Luminance-only tone changes (dodge/burn). Luminance is Rec.709 luma of the
// gamma-encoded channels (the same weights the filters use). A colour gets
// a new luminance the way the W3C "luminosity" blend mode does it (SetLum +
// ClipColor): the same offset is added to every channel, and a result
// outside the gamut is pulled back towards grey along the line of constant
// luminance, so hue is kept and the requested luminance is met exactly.

import { LUMA_B, LUMA_G, LUMA_R } from '../filters/colormath';

export type ToneRange = 'shadows' | 'midtones' | 'highlights';

export const TONE_RANGES: readonly ToneRange[] = ['shadows', 'midtones', 'highlights'];

/** Luminance (0..1) of straight 0..1 channels. */
export function luminance01(r: number, g: number, b: number): number {
  return r * LUMA_R + g * LUMA_G + b * LUMA_B;
}

/**
 * How strongly a tone range responds at luminance `l` (0..1): shadows
 * (1 − l)², midtones 4·l·(1 − l), highlights l². Each peaks at 1.
 */
export function toneRangeWeight(range: ToneRange, l: number): number {
  const v = l < 0 ? 0 : l > 1 ? 1 : l;
  switch (range) {
    case 'shadows':
      return (1 - v) * (1 - v);
    case 'highlights':
      return v * v;
    default:
      return 4 * v * (1 - v);
  }
}

/**
 * Gives the colour `rgb` (0..1 channels, modified in place) the luminance
 * `target` (0..1) while keeping its hue.
 */
export function setLuminance(rgb: Float64Array | number[], target: number): void {
  const t = target < 0 ? 0 : target > 1 ? 1 : target;
  const d = t - luminance01(rgb[0], rgb[1], rgb[2]);
  let r = rgb[0] + d;
  let g = rgb[1] + d;
  let b = rgb[2] + d;
  const l = luminance01(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0 && l - n > 1e-12) {
    const k = l / (l - n);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  if (x > 1 && x - l > 1e-12) {
    const k = (1 - l) / (x - l);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  rgb[0] = r < 0 ? 0 : r > 1 ? 1 : r;
  rgb[1] = g < 0 ? 0 : g > 1 ? 1 : g;
  rgb[2] = b < 0 ? 0 : b > 1 ? 1 : b;
}
