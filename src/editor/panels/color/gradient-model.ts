// Pure helpers behind the gradient editor: stop ordering, colour at a
// position (premultiplied, like the engine renders gradients), CSS preview.

import { parseColor, toHex, type Rgba } from '$engine/index';

export interface EditorStop {
  offset: number;
  color: string;
}

export function sortStops(stops: readonly EditorStop[]): EditorStop[] {
  return stops
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
    .map(({ s }) => ({ offset: clamp01(s.offset), color: s.color }));
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** Colour at `t` (0..1), interpolated in premultiplied space. */
export function colorAt(stops: readonly EditorStop[], t: number): string {
  const s = sortStops(stops);
  if (s.length === 0) return '#000000';
  const u = clamp01(t);
  if (u <= s[0]!.offset) return s[0]!.color;
  if (u >= s[s.length - 1]!.offset) return s[s.length - 1]!.color;
  let k = 0;
  while (k + 1 < s.length && s[k + 1]!.offset <= u) k++;
  const a = parseColor(s[k]!.color) ?? BLACK;
  const b = parseColor(s[k + 1]!.color) ?? BLACK;
  const span = s[k + 1]!.offset - s[k]!.offset;
  const f = span > 0 ? (u - s[k]!.offset) / span : 0;
  const al = a.a + (b.a - a.a) * f;
  const ch = (x: number, y: number) => (al > 0 ? (x * a.a + (y * b.a - x * a.a) * f) / al : 0);
  return toHex({ r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: al });
}

/** A CSS linear-gradient (to right) previewing the stops. */
export function cssGradient(stops: readonly EditorStop[], direction = 'to right'): string {
  const s = sortStops(stops);
  if (s.length === 0) return 'transparent';
  if (s.length === 1) return `linear-gradient(${direction}, ${s[0]!.color}, ${s[0]!.color})`;
  return `linear-gradient(${direction}, ${s.map((x) => `${x.color} ${(x.offset * 100).toFixed(2)}%`).join(', ')})`;
}

/** The stops mirrored (0 ↔ 1). */
export function reverseStops(stops: readonly EditorStop[]): EditorStop[] {
  return sortStops(stops.map((s) => ({ offset: 1 - s.offset, color: s.color })));
}
