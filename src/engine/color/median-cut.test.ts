import { describe, expect, it } from 'vitest';
import { dominantColors } from './median-cut';
import { Surface } from '../raster/surface';

function stripes(parts: [number[], number][], size = 100): Surface {
  // Vertical stripes whose widths are proportional to the weights.
  const s = new Surface(size, size);
  let x = 0;
  for (const [c, share] of parts) {
    const w = Math.round(size * share);
    s.fill(c[0], c[1], c[2], c[3], { x, y: 0, w, h: size });
    x += w;
  }
  return s;
}

describe('dominantColors (median cut)', () => {
  it('finds the distinct colours ordered by population', () => {
    const s = stripes([
      [[220, 30, 40, 255], 0.5],
      [[20, 180, 60, 255], 0.3],
      [[30, 60, 230, 255], 0.2],
    ]);
    const out = dominantColors(s.data, s.width, s.height, { count: 3 });
    expect(out.map((d) => d.color)).toEqual([
      { r: 220, g: 30, b: 40, a: 1 },
      { r: 20, g: 180, b: 60, a: 1 },
      { r: 30, g: 60, b: 230, a: 1 },
    ]);
    expect(out.map((d) => Math.round(d.share * 100))).toEqual([50, 30, 20]);
  });

  it('ignores transparent pixels and stops when nothing is left to split', () => {
    const s = stripes([
      [[10, 200, 10, 255], 0.5],
      [[255, 0, 0, 0], 0.5],
    ]);
    const out = dominantColors(s.data, s.width, s.height, { count: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].color).toEqual({ r: 10, g: 200, b: 10, a: 1 });
    expect(out[0].share).toBe(1);
  });

  it('averages noisy clusters', () => {
    const s = new Surface(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const jitter = (x + y) % 3; // 0..2
        if (x < 32) s.setPixel(x, y, 200 + jitter, 20, 20, 255);
        else s.setPixel(x, y, 20, 20, 200 + jitter, 255);
      }
    }
    const out = dominantColors(s.data, 64, 64, { count: 2 });
    expect(out).toHaveLength(2);
    const reds = out.find((d) => d.color.r > 100)!;
    const blues = out.find((d) => d.color.b > 100)!;
    expect(reds.color.r).toBeGreaterThanOrEqual(200);
    expect(reds.color.r).toBeLessThanOrEqual(202);
    expect(blues.color.b).toBeGreaterThanOrEqual(200);
    expect(reds.share).toBeCloseTo(0.5, 5);
  });

  it('returns nothing for an empty image', () => {
    const s = new Surface(8, 8);
    expect(dominantColors(s.data, 8, 8)).toEqual([]);
  });
});
