// Colour types, conversions, parsing and formatting.
//
// `Rgba` is the engine's canonical colour: straight (non-premultiplied)
// sRGB with r/g/b in 0..255 (fractional values allowed) and alpha in 0..1,
// matching CSS. Conversions return exact floats — callers round at the
// boundary (`toRgba8`, the formatters) — so rgb → hsv/hsl → rgb round-trips
// bit-exactly after rounding.

import { NAMED_COLORS } from './named';
import { clamp, clamp01, mod } from '../util/math';

export interface Rgba {
  /** 0..255 */
  r: number;
  /** 0..255 */
  g: number;
  /** 0..255 */
  b: number;
  /** 0..1 */
  a: number;
}

/** Hue 0..360, saturation/value 0..1, alpha 0..1. */
export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

/** Hue 0..360, saturation/lightness 0..1, alpha 0..1. */
export interface Hsla {
  h: number;
  s: number;
  l: number;
  a: number;
}

/** A packed straight-alpha pixel, all channels 0..255 integers. */
export type Rgba8 = [r: number, g: number, b: number, a: number];

export function rgba(r: number, g: number, b: number, a = 1): Rgba {
  return { r, g, b, a };
}

export const BLACK: Readonly<Rgba> = Object.freeze(rgba(0, 0, 0, 1));
export const WHITE: Readonly<Rgba> = Object.freeze(rgba(255, 255, 255, 1));
export const TRANSPARENT: Readonly<Rgba> = Object.freeze(rgba(0, 0, 0, 0));

/** Rounds and clamps to 8-bit channels (alpha scaled to 0..255). */
export function toRgba8(c: Rgba): Rgba8 {
  return [
    Math.round(clamp(c.r, 0, 255)),
    Math.round(clamp(c.g, 0, 255)),
    Math.round(clamp(c.b, 0, 255)),
    Math.round(clamp01(c.a) * 255),
  ];
}

export function fromRgba8(r: number, g: number, b: number, a8: number): Rgba {
  return { r, g, b, a: a8 / 255 };
}

/** Rounds r/g/b to integers and alpha to the nearest 8-bit step. */
export function roundRgba(c: Rgba): Rgba {
  const [r, g, b, a] = toRgba8(c);
  return { r, g, b, a: a / 255 };
}

export function colorsEqual(a: Rgba, b: Rgba, eps = 1e-6): boolean {
  return (
    Math.abs(a.r - b.r) <= eps &&
    Math.abs(a.g - b.g) <= eps &&
    Math.abs(a.b - b.b) <= eps &&
    Math.abs(a.a - b.a) <= eps
  );
}

export function withAlpha(c: Rgba, a: number): Rgba {
  return { r: c.r, g: c.g, b: c.b, a: clamp01(a) };
}

/** Interpolates in premultiplied space (no dark fringes towards transparent). */
export function mixColors(from: Rgba, to: Rgba, t: number): Rgba {
  const a = from.a + (to.a - from.a) * t;
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const pr = from.r * from.a + (to.r * to.a - from.r * from.a) * t;
  const pg = from.g * from.a + (to.g * to.a - from.g * from.a) * t;
  const pb = from.b * from.a + (to.b * to.a - from.b * from.a) * t;
  return { r: pr / a, g: pg / a, b: pb / a, a };
}

// ---------------------------------------------------------------------------
// HSV / HSL
// ---------------------------------------------------------------------------

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function rgbToHsv(c: Rgba): Hsva {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  return { h: hueOf(r, g, b, max, d), s: max === 0 ? 0 : d / max, v: max, a: c.a };
}

function fromChroma(h: number, c: number, m: number, a: number): Rgba {
  const hp = mod(h, 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

export function hsvToRgb(c: Hsva): Rgba {
  const s = clamp01(c.s);
  const v = clamp01(c.v);
  const chroma = v * s;
  return fromChroma(c.h, chroma, v - chroma, c.a);
}

export function rgbToHsl(c: Rgba): Hsla {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hueOf(r, g, b, max, d), s, l, a: c.a };
}

export function hslToRgb(c: Hsla): Rgba {
  const s = clamp01(c.s);
  const l = clamp01(c.l);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  return fromChroma(c.h, chroma, l - chroma / 2, c.a);
}

export function hsvToHsl(c: Hsva): Hsla {
  const l = c.v * (1 - c.s / 2);
  const s = l === 0 || l === 1 ? 0 : (c.v - l) / Math.min(l, 1 - l);
  return { h: c.h, s, l, a: c.a };
}

export function hslToHsv(c: Hsla): Hsva {
  const v = c.l + c.s * Math.min(c.l, 1 - c.l);
  const s = v === 0 ? 0 : 2 * (1 - c.l / v);
  return { h: c.h, s, v, a: c.a };
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

export type HexAlpha = 'auto' | 'always' | 'never';

/**
 * `#rrggbb` or `#rrggbbaa` (lower case). With `'auto'` the alpha byte is
 * only written when the colour is not fully opaque.
 */
export function toHex(c: Rgba, alpha: HexAlpha = 'auto'): string {
  const [r, g, b, a] = toRgba8(c);
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  if (alpha === 'never' || (alpha === 'auto' && a === 255)) return base;
  return base + hex2(a);
}

const HEX_RE = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` is optional). */
export function parseHex(text: string): Rgba | null {
  const m = HEX_RE.exec(text.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

// ---------------------------------------------------------------------------
// CSS-style functional notation
// ---------------------------------------------------------------------------

/** Formats a number with at most `digits` decimals, trailing zeros trimmed. */
function num(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function alphaPart(a: number): string {
  return num(clamp01(a), 4);
}

/** `rgb(r, g, b)` or `rgba(r, g, b, a)` — the form canvas `fillStyle` accepts everywhere. */
export function toCssRgb(c: Rgba): string {
  const [r, g, b] = toRgba8(c);
  return c.a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alphaPart(c.a)})`;
}

export function toCssHsl(c: Rgba): string {
  const h = rgbToHsl(c);
  const body = `${num(h.h, 2)} ${num(h.s * 100, 2)}% ${num(h.l * 100, 2)}%`;
  return c.a >= 1 ? `hsl(${body})` : `hsl(${body} / ${alphaPart(c.a)})`;
}

/** `hsv(h s% v%)` — not CSS, but understood by `parseColor`. */
export function toHsvString(c: Rgba): string {
  const h = rgbToHsv(c);
  const body = `${num(h.h, 2)} ${num(h.s * 100, 2)}% ${num(h.v * 100, 2)}%`;
  return c.a >= 1 ? `hsv(${body})` : `hsv(${body} / ${alphaPart(c.a)})`;
}

interface Token {
  value: number;
  unit: '' | '%' | 'deg' | 'rad' | 'grad' | 'turn';
}

const TOKEN_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i;

function parseToken(t: string): Token | null {
  if (t.toLowerCase() === 'none') return { value: 0, unit: '' };
  const m = TOKEN_RE.exec(t);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: (m[2]?.toLowerCase() ?? '') as Token['unit'] };
}

function hueValue(t: Token): number | null {
  switch (t.unit) {
    case '':
    case 'deg':
      return t.value;
    case 'rad':
      return (t.value * 180) / Math.PI;
    case 'grad':
      return t.value * 0.9;
    case 'turn':
      return t.value * 360;
    default:
      return null;
  }
}

/** Percent, or a bare number interpreted as a percentage (CSS Color 4). */
function percentValue(t: Token): number | null {
  if (t.unit === '%' || t.unit === '') return clamp01(t.value / 100);
  return null;
}

function channelValue(t: Token): number | null {
  if (t.unit === '%') return clamp((t.value / 100) * 255, 0, 255);
  if (t.unit === '') return clamp(t.value, 0, 255);
  return null;
}

function alphaValue(t: Token | undefined): number | null {
  if (!t) return 1;
  if (t.unit === '%') return clamp01(t.value / 100);
  if (t.unit === '') return clamp01(t.value);
  return null;
}

const FUNC_RE = /^(rgba?|hsla?|hsva?)\(\s*([^)]*)\)$/i;

function parseFunctional(text: string): Rgba | null {
  const m = FUNC_RE.exec(text);
  if (!m) return null;
  const fn = m[1].toLowerCase().replace(/a$/, '');
  const [main, alphaText, extra] = m[2].split('/');
  if (extra !== undefined) return null;
  const parts = main.trim().split(/[\s,]+/).filter(Boolean);
  if (alphaText !== undefined) {
    if (parts.length !== 3) return null;
    parts.push(alphaText.trim());
  }
  if (parts.length !== 3 && parts.length !== 4) return null;
  const tokens = parts.map(parseToken);
  if (tokens.some((t) => t === null)) return null;
  const [t0, t1, t2, t3] = tokens as Token[];
  const a = alphaValue(t3);
  if (a === null) return null;
  if (fn === 'rgb') {
    const r = channelValue(t0);
    const g = channelValue(t1);
    const b = channelValue(t2);
    if (r === null || g === null || b === null) return null;
    return { r, g, b, a };
  }
  const h = hueValue(t0);
  const s = percentValue(t1);
  const x = percentValue(t2);
  if (h === null || s === null || x === null) return null;
  return fn === 'hsl' ? hslToRgb({ h, s, l: x, a }) : hsvToRgb({ h, s, v: x, a });
}

/**
 * Parses hex (`#rgb[a]`, `#rrggbb[aa]`, `#` optional), `rgb()/rgba()`,
 * `hsl()/hsla()`, `hsv()/hsva()` (comma or space syntax, `/ alpha`,
 * percentages, hue units), CSS named colours and `transparent`.
 * Returns `null` when the text is not a colour.
 */
export function parseColor(text: string): Rgba | null {
  const s = text.trim().toLowerCase();
  if (s === '') return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[s];
  if (named !== undefined) {
    return { r: (named >> 16) & 255, g: (named >> 8) & 255, b: named & 255, a: 1 };
  }
  return parseHex(s) ?? parseFunctional(s);
}

/** Like `parseColor` but throws a descriptive error. */
export function parseColorStrict(text: string): Rgba {
  const c = parseColor(text);
  if (!c) throw new Error(`Not a colour: "${text}"`);
  return c;
}

/** Relative distance helper for tolerance checks: max channel delta (0..255). */
export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(a.a - b.a) * 255,
  );
}
