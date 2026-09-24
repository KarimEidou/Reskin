// Shared helpers for the engine's unit tests (not used by the app).

import { Surface } from './raster/surface';
import type { PointerInput } from './input/pointer';
import { pointerInput } from './input/pointer';
import type { TextRasterizer } from './text/text';
import { approximateMeasurer, baselineOf, lineStartX } from './text/text';

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function solidSurface(w: number, h: number, rgba: readonly number[]): Surface {
  const s = new Surface(w, h);
  s.fill(rgba[0], rgba[1], rgba[2], rgba[3]);
  return s;
}

export function pixel(s: Surface, x: number, y: number): number[] {
  return [...s.getPixel(x, y)];
}

export function pointer(x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput {
  return pointerInput({ x, y, ...extra });
}

/** Sum of alpha over a surface (0..255 per pixel). */
export function alphaSum(s: Surface): number {
  let n = 0;
  for (let i = 3; i < s.data.length; i += 4) n += s.data[i];
  return n;
}

/**
 * A font-free TextRasterizer: every glyph line becomes a solid block the
 * size the approximate measurer predicts (rotation ignored). Enough to test
 * text layers end to end in Node.
 */
export function blockTextRasterizer(): TextRasterizer {
  return {
    measure: (p) => approximateMeasurer.measure(p),
    render(p, width, height) {
      const s = new Surface(width, height);
      const layout = approximateMeasurer.measure(p);
      const a8 = Math.round(p.color.a * 255);
      layout.lines.forEach((line, i) => {
        const x0 = Math.round(p.x + lineStartX(p.align, line.width));
        const top = Math.round(p.y + baselineOf(layout, i) - layout.ascent);
        s.fill(p.color.r, p.color.g, p.color.b, a8, {
          x: x0,
          y: top,
          w: Math.max(0, Math.round(line.width)),
          h: Math.round(layout.ascent + layout.descent),
        });
      });
      return s;
    },
  };
}
