import { describe, expect, it } from 'vitest';
import { contourArea, insideMask, polygonSdf, rasterizePolygon } from './raster';

const sum = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

describe('rasterizePolygon', () => {
  it('covers an axis-aligned rectangle with exact fractional edges', () => {
    // x 1.25..3.5, y 1..3 (pixel rows exactly), in an 5×4 grid
    const cov = rasterizePolygon([[1.25, 1, 3.5, 1, 3.5, 3, 1.25, 3]], 5, 4);
    const row = (y: number) => [...cov.subarray(y * 5, y * 5 + 5)].map((v) => Math.round(v * 1000) / 1000);
    expect(row(0)).toEqual([0, 0, 0, 0, 0]);
    expect(row(1)).toEqual([0, 0.75, 1, 0.5, 0]);
    expect(row(2)).toEqual([0, 0.75, 1, 0.5, 0]);
    expect(row(3)).toEqual([0, 0, 0, 0, 0]);
  });

  it('gets triangle areas right and ignores winding direction', () => {
    const tri = [2, 2, 30, 4, 10, 27];
    const area = Math.abs(contourArea(tri));
    expect(sum(rasterizePolygon([tri], 32, 32))).toBeCloseTo(area, 0);
    const rev = [10, 27, 30, 4, 2, 2];
    expect(sum(rasterizePolygon([rev], 32, 32))).toBeCloseTo(area, 0);
  });

  it('clips to the image and uses the non-zero rule for multiple contours', () => {
    expect(sum(rasterizePolygon([[-5, -5, 10, -5, 10, 10, -5, 10]], 4, 4))).toBeCloseTo(16, 6);
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const holeOpposite = [3, 3, 3, 7, 7, 7, 7, 3];
    expect(sum(rasterizePolygon([outer, holeOpposite], 10, 10))).toBeCloseTo(100 - 16, 3);
  });
});

describe('insideMask / polygonSdf', () => {
  it('classifies pixel centres', () => {
    const m = insideMask([[0.9, 0.9, 3.1, 0.9, 3.1, 3.1, 0.9, 3.1]], 4, 4);
    expect([...m]).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('gives signed distances to the outline, clamped to the band', () => {
    const sq = [[2, 2, 8, 2, 8, 8, 2, 8]];
    const sdf = polygonSdf(sq, 10, 10, 3);
    expect(sdf[5 * 10 + 5]).toBeCloseTo(-2.5, 5); // centre pixel (5.5, 5.5): 2.5 from each edge
    expect(sdf[5 * 10 + 1]).toBeCloseTo(0.5, 5); // (1.5, 5.5) outside by 0.5
    expect(sdf[0]).toBeCloseTo(Math.hypot(1.5, 1.5), 5); // nearest the corner
    expect(sdf[9 * 10 + 0]).toBeCloseTo(Math.hypot(1.5, 1.5), 5);
    const far = polygonSdf(sq, 30, 30, 3);
    expect(far[25 * 30 + 25]).toBe(3);
  });
});
