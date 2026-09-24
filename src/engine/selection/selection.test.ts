import { describe, expect, it } from 'vitest';
import {
  combineMasks,
  ellipseMask,
  featherMask,
  invertMask,
  isMaskEmpty,
  maskBounds,
  maskCoverage,
  rectMask,
  resizeMask,
  selectAllMask,
  transformMask,
} from './mask';
import { selectionOutline } from './outline';
import { translation } from '../geometry/affine';

const W = 32;

describe('selection masks', () => {
  it('builds rect and ellipse masks', () => {
    const r = rectMask(W, W, { x: 4, y: 6, w: 10, h: 8 });
    expect(maskBounds(r)).toEqual({ x: 4, y: 6, w: 10, h: 8 });
    expect(maskCoverage(r, 4, 6)).toBe(1);
    expect(maskCoverage(r, 3, 6)).toBe(0);
    const e = ellipseMask(W, W, { x: 0, y: 0, w: 32, h: 32 });
    expect(maskCoverage(e, 16, 16)).toBe(1);
    expect(maskCoverage(e, 0, 0)).toBe(0);
    const edge = e.data[16 * W + 0];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(maskCoverage(null, 5, 5)).toBe(1);
  });

  it('combines with add/subtract/intersect', () => {
    const a = rectMask(W, W, { x: 0, y: 0, w: 16, h: 32 });
    const b = rectMask(W, W, { x: 8, y: 0, w: 16, h: 32 });
    expect(maskBounds(combineMasks(a, b, 'add')!)).toEqual({ x: 0, y: 0, w: 24, h: 32 });
    expect(maskBounds(combineMasks(a, b, 'subtract')!)).toEqual({ x: 0, y: 0, w: 8, h: 32 });
    expect(maskBounds(combineMasks(a, b, 'intersect')!)).toEqual({ x: 8, y: 0, w: 8, h: 32 });
    expect(maskBounds(combineMasks(a, b, 'replace')!)).toEqual({ x: 8, y: 0, w: 16, h: 32 });
    expect(combineMasks(a, a, 'subtract')).toBeNull();
    expect(combineMasks(null, b, 'add')).toEqual(b);
    expect(combineMasks(null, b, 'subtract')).toBeNull();
  });

  it('inverts, feathers, transforms and resizes', () => {
    const a = rectMask(W, W, { x: 0, y: 0, w: 16, h: 32 });
    expect(maskBounds(invertMask(a, W, W)!)).toEqual({ x: 16, y: 0, w: 16, h: 32 });
    expect(invertMask(selectAllMask(W, W), W, W)).toBeNull();
    const f = featherMask(a, 4)!;
    expect(f.data[10 * W + 16]).toBeGreaterThan(0);
    expect(f.data[10 * W + 15]).toBeLessThan(255);
    const moved = transformMask(a, translation(4, 0))!;
    expect(maskBounds(moved)).toEqual({ x: 4, y: 0, w: 16, h: 32 });
    const small = resizeMask(a, 8, 8)!;
    expect(maskBounds(small)).toEqual({ x: 0, y: 0, w: 4, h: 8 });
    expect(isMaskEmpty(selectAllMask(2, 2))).toBe(false);
  });

  it('outlines a rectangle with four merged segments', () => {
    const segs = selectionOutline(rectMask(W, W, { x: 2, y: 3, w: 5, h: 4 }));
    expect(segs).toHaveLength(16);
    expect(segs).toEqual([2, 3, 7, 3, 2, 7, 7, 7, 2, 3, 2, 7, 7, 3, 7, 7]);
  });
});
