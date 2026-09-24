// Maths for the compact HSV colour picker (unit tested).

import { hsvToRgb, parseColor, rgbToHsv, toHex, type Hsva, type Rgba } from '$engine/index';

/** Saturation / value under a point of the SV square (clamped to it). */
export function svFromPoint(x: number, y: number, width: number, height: number): { s: number; v: number } {
  const s = width > 0 ? x / width : 0;
  const v = height > 0 ? 1 - y / height : 0;
  return { s: clamp01(s), v: clamp01(v) };
}

/**
 * HSV for a colour, keeping `hue` (and saturation) when the colour has
 * none of its own — so dragging to black or grey does not lose the hue.
 */
export function toHsv(c: Rgba, keep: { h: number; s: number } | null = null): Hsva {
  const hsv = rgbToHsv(c);
  if (keep) {
    if (hsv.v === 0) return { h: keep.h, s: keep.s, v: 0, a: hsv.a };
    if (hsv.s === 0) return { h: keep.h, s: 0, v: hsv.v, a: hsv.a };
  }
  return hsv;
}

/** Straight RGBA (0..255, rounded) for HSV. */
export function fromHsv(hsv: Hsva): Rgba {
  const c = hsvToRgb(hsv);
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: Math.round(clamp01(hsv.a) * 1000) / 1000 };
}

/** `#rrggbb` or `#rrggbbaa` (lower case), as recent colours are stored. */
export function hexOf(c: Rgba): string {
  return toHex(c, 'auto');
}

/** Parses what the user typed in the hex field (also rgb(), names…). */
export function parseColorInput(text: string): Rgba | null {
  const t = text.trim();
  if (!t) return null;
  return parseColor(/^[0-9a-f]{3,8}$/i.test(t) ? `#${t}` : t);
}

/** Moves `hex` to the front of the recent list (no duplicates, capped). */
export function pushRecent(list: readonly string[], hex: string, max: number): string[] {
  const h = hex.toLowerCase();
  return [h, ...list.filter((c) => c.toLowerCase() !== h)].slice(0, Math.max(0, max));
}

/** CSS colour of a pure hue (for the SV square background). */
export function hueCss(h: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} 100% 50%)`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
