// WCAG 2.x relative luminance and contrast helpers.

import type { Rgba } from './color';
import { BLACK, WHITE } from './color';

function linear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Composites `c` over an opaque `backdrop` (alpha < 1 colours). */
export function flattenOver(c: Rgba, backdrop: Rgba = WHITE): Rgba {
  const a = c.a;
  return {
    r: c.r * a + backdrop.r * (1 - a),
    g: c.g * a + backdrop.g * (1 - a),
    b: c.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

/** Relative luminance 0..1 of an opaque colour (alpha is ignored). */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/**
 * WCAG contrast ratio 1..21. Translucent colours are first flattened over
 * `backdrop` (white by default).
 */
export function contrastRatio(a: Rgba, b: Rgba, backdrop: Rgba = WHITE): number {
  const la = relativeLuminance(a.a < 1 ? flattenOver(a, backdrop) : a);
  const lb = relativeLuminance(b.a < 1 ? flattenOver(b, backdrop) : b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

/** Grade for normal-size text. */
export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

/** Black or white, whichever reads better on `bg`. */
export function readableTextColor(bg: Rgba): Rgba {
  return contrastRatio(bg, BLACK) >= contrastRatio(bg, WHITE) ? { ...BLACK } : { ...WHITE };
}

/** True when `c` is perceptually light (useful for overlay/keyline colours). */
export function isLight(c: Rgba): boolean {
  return relativeLuminance(c) > 0.179;
}
