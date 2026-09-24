/**
 * Colour maths used by the filters, helpers and backdrop generator:
 * CSS-style colour parsing, Rec.709 luma, and HSL conversion.
 */

/** Straight RGBA, each channel 0..255. */
export type Rgba = [number, number, number, number];

/** Rec.709 luma weights (applied to the gamma-encoded channels, as editors do). */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

// The same weights in 1/32768 units; they sum to exactly 32768 so a grey
// pixel keeps its value and the result is an exact, rounded integer.
const LR = 6966;
const LG = 23436;
const LB = 2366;

/** Rec.709 luma rounded to an integer 0..255 (grey v → v exactly). */
export function lumaInt(r: number, g: number, b: number): number {
  return (r * LR + g * LG + b * LB + 16384) >> 15;
}

/** Rec.709 luma as a float in the channels' own scale. */
export function luma(r: number, g: number, b: number): number {
  return r * LUMA_R + g * LUMA_G + b * LUMA_B;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([^)]*)\)$/i;

function channel(token: string, alpha: boolean): number | null {
  const t = token.trim();
  if (t === '') return null;
  const pct = t.endsWith('%');
  const v = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(v)) return null;
  if (alpha) return Math.round(Math.min(1, Math.max(0, pct ? v / 100 : v)) * 255);
  return Math.round(Math.min(255, Math.max(0, pct ? (v / 100) * 255 : v)));
}

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)`,
 * `rgb(r, g, b)`, `rgba(r, g, b, a)` and `transparent`. Returns null when
 * the string is not a colour.
 */
export function parseColor(input: string): Rgba | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.toLowerCase() === 'transparent') return [0, 0, 0, 0];
  const hex = HEX.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length <= 4) {
      const v = [...h].map((c) => parseInt(c + c, 16));
      return [v[0], v[1], v[2], v.length === 4 ? v[3] : 255];
    }
    const v: number[] = [];
    for (let i = 0; i < h.length; i += 2) v.push(parseInt(h.slice(i, i + 2), 16));
    return [v[0], v[1], v[2], v.length === 4 ? v[3] : 255];
  }
  const fn = FUNC.exec(s);
  if (fn) {
    const body = fn[1];
    let parts: string[];
    let alphaPart: string | undefined;
    if (body.includes(',')) {
      parts = body.split(',');
      if (parts.length === 4) alphaPart = parts.pop();
    } else {
      const [rgb, a] = body.split('/');
      parts = rgb.trim().split(/\s+/);
      alphaPart = a;
    }
    if (parts.length !== 3) return null;
    const r = channel(parts[0], false);
    const g = channel(parts[1], false);
    const b = channel(parts[2], false);
    const a = alphaPart === undefined ? 255 : channel(alphaPart, true);
    if (r === null || g === null || b === null || a === null) return null;
    return [r, g, b, a];
  }
  return null;
}

/** True when `parseColor` accepts the string. */
export function isColor(input: unknown): input is string {
  return typeof input === 'string' && parseColor(input) !== null;
}

/** Parses a colour, falling back to `fallback` (which must itself be valid). */
export function colorOr(input: unknown, fallback: string): Rgba {
  const c = typeof input === 'string' ? parseColor(input) : null;
  return c ?? (parseColor(fallback) as Rgba);
}

function hex2(v: number): string {
  return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
}

/** `#rrggbb`, or `#rrggbbaa` when alpha < 255. */
export function toHex(r: number, g: number, b: number, a = 255): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${Math.round(a) < 255 ? hex2(a) : ''}`;
}

/**
 * RGB (0..1) → HSL written into `out` as [h (degrees 0..360), s (0..1), l (0..1)].
 * Achromatic colours get h = 0, s = 0.
 */
export function rgbToHsl(r: number, g: number, b: number, out: Float64Array | number[]): void {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = l;
    return;
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  out[0] = h * 60;
  out[1] = s;
  out[2] = l;
}

function hueChannel(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL (h in degrees, any range; s, l 0..1) → RGB (0..1) written into `out`. */
export function hslToRgb(h: number, s: number, l: number, out: Float64Array | number[]): void {
  if (s <= 0) {
    out[0] = l;
    out[1] = l;
    out[2] = l;
    return;
  }
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hueChannel(p, q, hh + 1 / 3);
  out[1] = hueChannel(p, q, hh);
  out[2] = hueChannel(p, q, hh - 1 / 3);
}
