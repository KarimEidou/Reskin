/**
 * Gradient stops: validation and lookup tables. Interpolation happens in
 * premultiplied space (as CSS does), so a stop fading to transparent does
 * not drag a grey/black fringe through the gradient.
 */
import { parseColor, type Rgba } from './colormath';

/** A colour stop; `offset` is 0..1 along the gradient, `color` any `parseColor` string. */
export interface GradientStop {
  offset: number;
  color: string;
}

/** A validated stop with its parsed colour. */
export interface ResolvedStop {
  offset: number;
  rgba: Rgba;
}

/** Parses and orders stops (offsets clamped to 0..1, stable by offset). Invalid entries are dropped. */
function parseStops(stops: unknown): ResolvedStop[] {
  if (!Array.isArray(stops)) return [];
  const out: ResolvedStop[] = [];
  for (const s of stops as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const { offset, color } = s as { offset?: unknown; color?: unknown };
    if (typeof offset !== 'number' || !Number.isFinite(offset) || typeof color !== 'string') continue;
    const rgba = parseColor(color);
    if (!rgba) continue;
    out.push({ offset: Math.min(1, Math.max(0, offset)), rgba });
  }
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
    .map((e) => e.s);
}

/**
 * Validates stops, falling back to `fallback` when fewer than one is
 * usable. A single stop becomes a flat gradient.
 */
export function resolveStops(stops: unknown, fallback: readonly GradientStop[]): ResolvedStop[] {
  let r = parseStops(stops);
  if (r.length === 0) r = parseStops(fallback);
  if (r.length === 1) r = [{ offset: 0, rgba: r[0].rgba }, { offset: 1, rgba: r[0].rgba }];
  return r;
}

/** Normalised stop list (as plain `GradientStop`s) for storing in params. */
export function normalizeStops(stops: unknown, fallback: readonly GradientStop[]): GradientStop[] {
  const valid = parseStops(stops);
  if (valid.length < 2) return fallback.map((s) => ({ ...s }));
  return (stops as GradientStop[])
    .filter((s) => s && typeof s.offset === 'number' && Number.isFinite(s.offset) && typeof s.color === 'string' && parseColor(s.color))
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color }))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * `size` samples of the gradient over t ∈ [0, 1] as premultiplied float RGBA
 * (0..255 scale): entry i is t = i / (size − 1).
 */
export function gradientLutPremultiplied(stops: readonly ResolvedStop[], size = 1024): Float32Array {
  const lut = new Float32Array(size * 4);
  const n = stops.length;
  let k = 0;
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1);
    while (k + 1 < n && stops[k + 1].offset <= t) k++;
    const a = stops[k];
    let r: number, g: number, b: number, al: number;
    if (t < stops[0].offset || k === n - 1) {
      const s = t < stops[0].offset ? stops[0] : stops[n - 1];
      const m = s.rgba[3] / 255;
      r = s.rgba[0] * m;
      g = s.rgba[1] * m;
      b = s.rgba[2] * m;
      al = s.rgba[3];
    } else {
      const c = stops[k + 1];
      const span = c.offset - a.offset;
      const u = span > 0 ? (t - a.offset) / span : 1;
      const ma = a.rgba[3] / 255;
      const mc = c.rgba[3] / 255;
      r = a.rgba[0] * ma + (c.rgba[0] * mc - a.rgba[0] * ma) * u;
      g = a.rgba[1] * ma + (c.rgba[1] * mc - a.rgba[1] * ma) * u;
      b = a.rgba[2] * ma + (c.rgba[2] * mc - a.rgba[2] * ma) * u;
      al = a.rgba[3] + (c.rgba[3] - a.rgba[3]) * u;
    }
    const o = i * 4;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
    lut[o + 3] = al;
  }
  return lut;
}

/** `size` samples of the gradient as straight RGBA8 (entry i is t = i / (size − 1)). */
export function gradientLutRgba8(stops: readonly ResolvedStop[], size = 256): Uint8ClampedArray {
  const pm = gradientLutPremultiplied(stops, size);
  const out = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = pm[i + 3];
    if (a <= 1e-4) continue;
    const k = 255 / a;
    out[i] = pm[i] * k;
    out[i + 1] = pm[i + 1] * k;
    out[i + 2] = pm[i + 2] * k;
    out[i + 3] = a;
  }
  return out;
}
