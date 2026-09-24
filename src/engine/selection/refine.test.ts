import { describe, expect, it } from 'vitest';
import { maskBounds, rectMask, selectAllMask } from './mask';
import { alphaMask, antialiasRegion, borderMask, growMask, shrinkMask, wandMask } from './refine';
import { selectionOutline } from './outline';
import { Surface } from '../raster/surface';

const W = 32;

function covered(m: { data: Uint8Array }): number {
  let n = 0;
  for (const v of m.data) n += v;
  return n / 255;
}

describe('grow / shrink / border', () => {
  const square = rectMask(W, W, { x: 10, y: 10, w: 10, h: 10 });

  it('grows and shrinks by whole pixels along straight edges', () => {
    const g = growMask(square, 2)!;
    expect(maskBounds(g)).toEqual({ x: 8, y: 8, w: 14, h: 14 });
    // Edge midpoints are fully in; the far corner is rounded off.
    expect(g.data[15 * W + 8]).toBe(255);
    expect(g.data[8 * W + 8]).toBeLessThan(255);
    const s = shrinkMask(square, 2)!;
    expect(maskBounds(s)).toEqual({ x: 12, y: 12, w: 6, h: 6 });
    expect(s.data.every((v) => v === 0 || v === 255)).toBe(true);
    expect(shrinkMask(square, 5)).toBeNull();
  });

  it('whole-pixel mode stays binary', () => {
    const g = growMask(square, 3, { binary: true })!;
    expect(g.data.every((v) => v === 0 || v === 255)).toBe(true);
    expect(maskBounds(g)).toEqual({ x: 7, y: 7, w: 16, h: 16 });
  });

  it('border is a band centred on the edge', () => {
    const b = borderMask(square, 4)!;
    expect(b.data[15 * W + 15]).toBe(0); // centre
    expect(b.data[15 * W + 10]).toBe(255); // on the edge, inside
    expect(b.data[15 * W + 11]).toBe(255);
    expect(b.data[15 * W + 12]).toBe(0);
    expect(b.data[15 * W + 9]).toBe(255); // outside
    expect(b.data[15 * W + 8]).toBe(255);
    expect(b.data[15 * W + 7]).toBe(0);
    // Odd whole-pixel widths put the extra pixel outside.
    const odd = borderMask(square, 3, { binary: true })!;
    expect(odd.data[15 * W + 8]).toBe(255);
    expect(odd.data[15 * W + 10]).toBe(255);
    expect(odd.data[15 * W + 11]).toBe(0);
    // No edge inside the canvas → nothing.
    expect(borderMask(selectAllMask(W, W), 4)).toBeNull();
  });

  it('canvas edges are not selection edges', () => {
    const all = shrinkMask(selectAllMask(W, W), 3)!;
    expect(maskBounds(all)).toEqual({ x: 0, y: 0, w: W, h: W });
  });
});

describe('alpha masks and wand regions', () => {
  it('selects by alpha', () => {
    const s = new Surface(8, 8);
    s.setPixel(2, 3, 255, 0, 0, 255);
    s.setPixel(4, 4, 0, 0, 0, 100);
    const m = alphaMask(s)!;
    expect(m.data[3 * 8 + 2]).toBe(255);
    expect(m.data[4 * 8 + 4]).toBe(100);
    expect(alphaMask(s, { binary: true })!.data[4 * 8 + 4]).toBe(0);
    expect(alphaMask(new Surface(4, 4))).toBeNull();
  });

  it('anti-aliased regions keep the hard outline and soften edges 7/8 – 1/8', () => {
    const region = new Uint8Array(W * W);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) region[y * W + x] = 1;
    const aa = antialiasRegion(region, W, W, { x: 8, y: 8, w: 16, h: 16 });
    expect(aa[16 * W + 16]).toBe(255);
    expect(aa[16 * W + 8]).toBe(223); // 14/16
    expect(aa[16 * W + 7]).toBe(32); // 2/16
    expect(aa[16 * W + 5]).toBe(0);
    const hard = { width: W, height: W, data: region.map((v) => v * 255) };
    expect(selectionOutline({ width: W, height: W, data: aa })).toEqual(selectionOutline(hard));
    // Area is preserved on straight edges (corners lose a little).
    expect(covered({ data: aa })).toBeCloseTo(256, -1);
  });

  it('wand regions: tolerance boundary, contiguous vs global', () => {
    const s = new Surface(8, 1);
    const greys = [100, 110, 111, 100, 200, 100, 105, 90];
    greys.forEach((g, x) => s.setPixel(x, 0, g, g, g, 255));
    const pick = (x: number, tolerance: number, contiguous: boolean) =>
      [...wandMask(s.data, 8, 1, x, 0, { tolerance, contiguous, antialias: false })!.data].map((v) => (v ? 1 : 0));
    expect(pick(0, 10, true)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(pick(0, 11, true)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(pick(0, 10, false)).toEqual([1, 1, 0, 1, 0, 1, 1, 1]);
    expect(pick(0, 0, false)).toEqual([1, 0, 0, 1, 0, 1, 0, 0]);
    expect(wandMask(s.data, 8, 1, 9, 0, { tolerance: 10, contiguous: true, antialias: false })).toBeNull();
  });
});
