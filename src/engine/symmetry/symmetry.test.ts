import { describe, expect, it } from 'vitest';
import { mirrorPixel, mirrorPoint, symmetryTransforms, NO_SYMMETRY } from './symmetry';
import type { SymmetrySettings } from './symmetry';

const sym = (patch: Partial<SymmetrySettings>): SymmetrySettings => ({ ...NO_SYMMETRY, ...patch });

describe('symmetry', () => {
  it('off is just the identity', () => {
    expect(mirrorPoint(symmetryTransforms(NO_SYMMETRY, 512, 512), 10, 20)).toEqual([{ x: 10, y: 20 }]);
  });

  it('mirrors across the vertical and horizontal axes', () => {
    expect(mirrorPoint(symmetryTransforms(sym({ mode: 'x' }), 512, 512), 100, 40)).toEqual([
      { x: 100, y: 40 },
      { x: 412, y: 40 },
    ]);
    expect(mirrorPoint(symmetryTransforms(sym({ mode: 'y' }), 512, 512), 100, 40)).toEqual([
      { x: 100, y: 40 },
      { x: 100, y: 472 },
    ]);
    const four = mirrorPoint(symmetryTransforms(sym({ mode: 'xy' }), 512, 512), 100, 40);
    expect(four).toHaveLength(4);
    expect(four).toContainEqual({ x: 412, y: 472 });
  });

  it('mirrors whole pixels exactly (pixel centres)', () => {
    const t = symmetryTransforms(sym({ mode: 'xy' }), 32, 32);
    expect(mirrorPixel(t, 0, 5, 32, 32)).toEqual([
      [0, 5],
      [31, 5],
      [0, 26],
      [31, 26],
    ]);
    // A pixel on the axis maps to itself once.
    expect(mirrorPixel(symmetryTransforms(sym({ mode: 'x' }), 5, 5), 2, 2, 5, 5)).toEqual([[2, 2]]);
  });

  it('radial N rotates about the centre', () => {
    const pts = mirrorPoint(symmetryTransforms(sym({ mode: 'radial', rays: 4 }), 100, 100), 50, 10);
    const round = pts.map((p) => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 }));
    expect(round).toEqual([
      { x: 50, y: 10 },
      { x: 90, y: 50 },
      { x: 50, y: 90 },
      { x: 10, y: 50 },
    ]);
    const kaleido = symmetryTransforms(sym({ mode: 'radial', rays: 6, mirror: true }), 100, 100);
    expect(kaleido).toHaveLength(12);
  });

  it('honours a custom centre', () => {
    expect(mirrorPoint(symmetryTransforms(sym({ mode: 'x', cx: 10 }), 100, 100), 4, 0)[1]).toEqual({ x: 16, y: 0 });
  });
});
