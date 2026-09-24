// Multi-stop gradients: the spec the gradient editor edits, and sampling.
//
// Colours are interpolated in premultiplied space (like CSS/canvas), so a
// stop fading to transparent does not drag the colour towards black.

import type { Rgba } from './color';
import { clamp01, mod } from '../util/math';

export type GradientKind = 'linear' | 'radial' | 'conic';
/** What happens outside 0..1: clamp, wrap, or mirror. */
export type GradientSpread = 'pad' | 'repeat' | 'reflect';

export interface GradientStop {
  /** 0..1 */
  offset: number;
  color: Rgba;
}

export interface GradientSpec {
  kind: GradientKind;
  stops: GradientStop[];
  spread: GradientSpread;
}

export function createGradient(
  from: Rgba,
  to: Rgba,
  kind: GradientKind = 'linear',
  spread: GradientSpread = 'pad',
): GradientSpec {
  return {
    kind,
    spread,
    stops: [
      { offset: 0, color: { ...from } },
      { offset: 1, color: { ...to } },
    ],
  };
}

export function cloneGradient(g: GradientSpec): GradientSpec {
  return { kind: g.kind, spread: g.spread, stops: g.stops.map((s) => ({ offset: s.offset, color: { ...s.color } })) };
}

/** Sorted copy with offsets clamped to 0..1. Throws when there are no stops. */
export function normalizeStops(stops: readonly GradientStop[]): GradientStop[] {
  if (stops.length === 0) throw new Error('A gradient needs at least one stop');
  return stops
    .map((s) => ({ offset: clamp01(s.offset), color: s.color }))
    .sort((a, b) => a.offset - b.offset);
}

export function reverseGradient(g: GradientSpec): GradientSpec {
  return {
    ...g,
    stops: g.stops.map((s) => ({ offset: 1 - s.offset, color: { ...s.color } })).reverse(),
  };
}

/** Straight-alpha colour at `t` (0..1, clamped) for already-sorted stops. */
export function sampleStops(stops: readonly GradientStop[], t: number): Rgba {
  const u = clamp01(t);
  const first = stops[0];
  if (u <= first.offset) return { ...first.color };
  const last = stops[stops.length - 1];
  if (u >= last.offset) return { ...last.color };
  let i = 1;
  while (i < stops.length - 1 && stops[i].offset < u) i++;
  const a = stops[i - 1];
  const b = stops[i];
  const span = b.offset - a.offset;
  const k = span <= 0 ? 1 : (u - a.offset) / span;
  const alpha = a.color.a + (b.color.a - a.color.a) * k;
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const pr = a.color.r * a.color.a + (b.color.r * b.color.a - a.color.r * a.color.a) * k;
  const pg = a.color.g * a.color.a + (b.color.g * b.color.a - a.color.g * a.color.a) * k;
  const pb = a.color.b * a.color.a + (b.color.b * b.color.a - a.color.b * a.color.a) * k;
  return { r: pr / alpha, g: pg / alpha, b: pb / alpha, a: alpha };
}

/** Straight-alpha colour of `spec` at parameter `t` after applying spread. */
export function sampleGradient(spec: GradientSpec, t: number): Rgba {
  return sampleStops(normalizeStops(spec.stops), applySpread(spec.spread, t));
}

export function applySpread(spread: GradientSpread, t: number): number {
  switch (spread) {
    case 'pad':
      return clamp01(t);
    case 'repeat':
      // Keep t = 1 at the end colour for the first cycle.
      return t > 0 && t % 1 === 0 ? 1 : mod(t, 1);
    case 'reflect': {
      const m = mod(t, 2);
      return m > 1 ? 2 - m : m;
    }
  }
}

/**
 * A lookup table of `size` premultiplied RGBA samples (0..1 floats) over
 * t = 0..1 inclusive, for fast per-pixel rendering.
 */
export function gradientLut(stops: readonly GradientStop[], size = 1024): Float32Array {
  const sorted = normalizeStops(stops);
  const lut = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const c = sampleStops(sorted, size === 1 ? 0 : i / (size - 1));
    const a = c.a;
    lut[i * 4] = (c.r / 255) * a;
    lut[i * 4 + 1] = (c.g / 255) * a;
    lut[i * 4 + 2] = (c.b / 255) * a;
    lut[i * 4 + 3] = a;
  }
  return lut;
}

/**
 * Gradient parameter (before spread) at point (x, y) for a gradient dragged
 * from (x0, y0) to (x1, y1):
 * - linear: projection onto the drag vector;
 * - radial: distance from the start over the drag length;
 * - conic: angle around the start, measured clockwise from the drag direction.
 */
export function gradientParam(
  kind: GradientKind,
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const px = x - x0;
  const py = y - y0;
  switch (kind) {
    case 'linear':
      return len2 === 0 ? 0 : (px * dx + py * dy) / len2;
    case 'radial':
      return len2 === 0 ? 0 : Math.sqrt((px * px + py * py) / len2);
    case 'conic': {
      const base = Math.atan2(dy, dx);
      const a = Math.atan2(py, px) - base;
      return mod(a / (2 * Math.PI), 1);
    }
  }
}
