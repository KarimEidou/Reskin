import { describe, expect, it } from 'vitest';
import { coverageArea, coverageAt, orientPositive, rasterizePolygons, signedArea } from './rasterize';
import {
  ellipsePolygon,
  heartPolygon,
  rectPolygon,
  regularPolygon,
  roundedRectPolygon,
  shapeGeometry,
  squirclePolygon,
  starPolygon,
  strokePolygons,
} from './shapes';
import type { ShapeSpec } from './shapes';
import { apply, compose, invert, multiply, rotation, scaling, translation } from './affine';

describe('coverage rasterizer', () => {
  it('a circle covers ≈ πr²', () => {
    for (const r of [3.3, 10, 57.5, 200]) {
      const area = coverageArea(rasterizePolygons([ellipsePolygon({ x: 256 - r, y: 256 - r, w: 2 * r, h: 2 * r })]));
      expect(Math.abs(area - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.005);
    }
  });

  it('pixel-aligned rectangles are exact', () => {
    const c = rasterizePolygons([rectPolygon({ x: 2, y: 3, w: 10, h: 4 })])!;
    expect(coverageArea(c)).toBeCloseTo(40, 6);
    expect(coverageAt(c, 2, 3)).toBeCloseTo(1, 6);
    expect(coverageAt(c, 1, 3)).toBe(0);
    expect(coverageAt(c, 11, 6)).toBeCloseTo(1, 6);
    expect(coverageAt(c, 12, 6)).toBe(0);
  });

  it('half-covered pixels get fractional coverage', () => {
    const c = rasterizePolygons([rectPolygon({ x: 0.5, y: 0, w: 2, h: 1 })])!;
    expect(coverageAt(c, 0, 0)).toBeCloseTo(0.5, 6);
    expect(coverageAt(c, 1, 0)).toBeCloseTo(1, 6);
    expect(coverageAt(c, 2, 0)).toBeCloseTo(0.5, 6);
  });

  it('aliased mode is binary by pixel centre', () => {
    const c = rasterizePolygons([ellipsePolygon({ x: 0, y: 0, w: 10, h: 10 })], { antialias: false })!;
    for (const v of c.data) expect(v === 0 || v === 1).toBe(true);
    expect(coverageArea(c)).toBeGreaterThan(70);
    expect(coverageArea(c)).toBeLessThan(90);
  });

  it('nonzero unions overlaps; even-odd punches holes', () => {
    const a = rectPolygon({ x: 0, y: 0, w: 10, h: 10 });
    const b = rectPolygon({ x: 5, y: 0, w: 10, h: 10 });
    expect(coverageArea(rasterizePolygons([a, b]))).toBeCloseTo(150, 5);
    expect(coverageArea(rasterizePolygons([a, b], { fillRule: 'evenodd' }))).toBeCloseTo(100, 5);
  });

  it('clips to the canvas', () => {
    const c = rasterizePolygons([rectPolygon({ x: -5, y: -5, w: 10, h: 10 })], { clip: { x: 0, y: 0, w: 100, h: 100 } })!;
    expect(c.x).toBe(0);
    expect(coverageArea(c)).toBeCloseTo(25, 5);
  });

  it('orients polygons positively', () => {
    const cw = [0, 0, 10, 0, 10, 10, 0, 10];
    const ccw = [0, 0, 0, 10, 10, 10, 10, 0];
    expect(signedArea(cw)).toBeGreaterThan(0);
    expect(signedArea(orientPositive(ccw))).toBeGreaterThan(0);
  });
});

describe('shape geometry', () => {
  const box = { x: 100, y: 100, w: 200, h: 200 };

  it('areas match their formulas', () => {
    const area = (p: number[]) => coverageArea(rasterizePolygons([p]));
    expect(area(roundedRectPolygon(box, 40)) / (200 * 200 - (4 - Math.PI) * 40 * 40)).toBeCloseTo(1, 2);
    expect(area(regularPolygon(box, 4)) / (2 * 100 * 100)).toBeCloseTo(1, 2);
    const star = starPolygon(box, 5, 0.5);
    expect(star).toHaveLength(20);
    expect(area(star)).toBeLessThan(area(regularPolygon(box, 5)));
    // Squircle lies between the inscribed circle and the square.
    const sq = area(squirclePolygon(box));
    expect(sq).toBeGreaterThan(Math.PI * 100 * 100);
    expect(sq).toBeLessThan(200 * 200);
    const heart = area(heartPolygon(box));
    expect(heart).toBeGreaterThan(0.4 * 200 * 200);
    expect(heart).toBeLessThan(0.8 * 200 * 200);
  });

  it('strokes a closed ring with the right area and a hole', () => {
    const ring = rasterizePolygons(strokePolygons(ellipsePolygon({ x: 0, y: 0, w: 200, h: 200 }), { width: 10, closed: true, join: 'round' }))!;
    const expected = Math.PI * (105 * 105 - 95 * 95);
    expect(Math.abs(coverageArea(ring) - expected) / expected).toBeLessThan(0.01);
    expect(coverageAt(ring, 100, 100)).toBe(0);
  });

  it('strokes rectangles with mitred corners', () => {
    const c = rasterizePolygons(strokePolygons(rectPolygon({ x: 10, y: 10, w: 40, h: 40 }), { width: 4, closed: true }))!;
    expect(coverageArea(c)).toBeCloseTo(44 * 44 - 36 * 36, 3);
    expect(coverageAt(c, 8, 8)).toBeCloseTo(1, 6); // sharp outer corner
  });

  it('lines get round caps and arrows a head', () => {
    const spec: ShapeSpec = {
      kind: 'line',
      x0: 10,
      y0: 50,
      x1: 110,
      y1: 50,
      cornerRadius: 0,
      sides: 5,
      innerRatio: 0.5,
      strokeWidth: 10,
      stroke: true,
    };
    const line = coverageArea(rasterizePolygons(shapeGeometry(spec).stroke));
    expect(line / (100 * 10 + Math.PI * 25)).toBeCloseTo(1, 2);
    const arrow = rasterizePolygons(shapeGeometry({ ...spec, kind: 'arrow' }).stroke)!;
    // Head: length 35, half-width 20, tip at x=110 → at x=80 it spans y≈33..67.
    expect(coverageAt(arrow, 80, 50 - 12)).toBeGreaterThan(0.5);
    expect(coverageAt(arrow, 40, 50 - 12)).toBe(0); // the shaft is only 10 px wide
    expect(coverageAt(arrow, 111, 50)).toBe(0);
  });

  it('insets closed shapes so the stroke stays inside the drag box', () => {
    const g = shapeGeometry({
      kind: 'rect',
      x0: 0,
      y0: 0,
      x1: 50,
      y1: 50,
      cornerRadius: 0,
      sides: 5,
      innerRatio: 0.5,
      strokeWidth: 6,
      stroke: true,
    });
    const c = rasterizePolygons(g.stroke)!;
    expect(c.x).toBe(0);
    expect(c.x + c.w).toBeLessThanOrEqual(51);
    expect(coverageAt(c, 0, 25)).toBeCloseTo(1, 6);
  });
});

describe('affine', () => {
  it('composes left to right and inverts', () => {
    const m = compose(translation(-5, -5), rotation(Math.PI / 2), scaling(2), translation(10, 0));
    const p = apply(m, 6, 5);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(2, 9);
    const back = apply(invert(m)!, p.x, p.y);
    expect(back.x).toBeCloseTo(6, 9);
    expect(back.y).toBeCloseTo(5, 9);
    expect(invert(scaling(0))).toBeNull();
    const ab = multiply(translation(1, 0), scaling(3));
    expect(apply(ab, 1, 1)).toEqual({ x: 4, y: 3 });
  });
});
