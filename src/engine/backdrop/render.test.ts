import { describe, expect, it } from 'vitest';
import { alphaMass, pixelAt } from '../filters/test-utils';
import { backdropCoverage, backdropShapeMask, renderBackdrop, shapeBox } from './render';
import { blobControlPoints, geometrySdf, hexagonPolygon, roundPolygon, shapeGeometry, shieldPolygon, superellipseSdf } from './shapes';
import { BACKDROP_STYLES, DEFAULT_BACKDROP, backdropStyle, resolveBackdropSpec, type BackdropSpecInput } from './spec';

const sum = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

function expectSymmetric(cov: Float32Array, n: number, { horizontal = true, vertical = true, diagonal = false } = {}) {
  let worst = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = cov[y * n + x];
      if (horizontal) worst = Math.max(worst, Math.abs(v - cov[y * n + (n - 1 - x)]));
      if (vertical) worst = Math.max(worst, Math.abs(v - cov[(n - 1 - y) * n + x]));
      if (diagonal) worst = Math.max(worst, Math.abs(v - cov[x * n + y]));
    }
  }
  expect(worst).toBeLessThan(1e-3);
}

const solid = (extra: BackdropSpecInput = {}): BackdropSpecInput => ({ fill: { type: 'solid', color: '#3366cc' }, shadow: false, ...extra });

describe('shape coverage', () => {
  it('circle area ≈ πr² within 1%', () => {
    for (const size of [37, 64, 200]) {
      const cov = backdropCoverage({ shape: 'circle', inset: 0.1 }, size);
      const r = (size * 0.8) / 2;
      expect(Math.abs(sum(cov) - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.01);
    }
  });

  it('rounded square area = side² − (4 − π)r²', () => {
    const size = 120;
    const cov = backdropCoverage({ shape: 'rounded', inset: 0.1, cornerRadius: 0.25 }, size);
    const side = size * 0.8;
    const r = side * 0.25;
    const expected = side * side - (4 - Math.PI) * r * r;
    expect(Math.abs(sum(cov) - expected) / expected).toBeLessThan(0.005);
  });

  it('squircle is symmetric (both axes and the diagonal) and between circle and square', () => {
    const n = 97;
    const cov = backdropCoverage({ shape: 'squircle', inset: 0.05, squircleExponent: 5 }, n);
    expectSymmetric(cov, n, { diagonal: true });
    const side = n * 0.9;
    const area = sum(cov);
    expect(area).toBeGreaterThan((Math.PI * side * side) / 4);
    expect(area).toBeLessThan(side * side);
    // area of |x|^5+|y|^5 ≤ 1 is 4·Γ(1.2)²/Γ(1.4) ≈ 3.8023 (unit half-sides)
    const expected = 3.8023 * (side / 2) ** 2;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
  });

  it('hexagon is symmetric with the regular-hexagon area', () => {
    const n = 101;
    for (const hexOrientation of ['pointy', 'flat'] as const) {
      const cov = backdropCoverage({ shape: 'hexagon', inset: 0.05, cornerRadius: 0, hexOrientation }, n);
      expectSymmetric(cov, n);
      const box = shapeBox(0.05, n, n);
      const R = hexOrientation === 'pointy' ? Math.min(box.h / 2, box.w / Math.sqrt(3)) : Math.min(box.w / 2, box.h / Math.sqrt(3));
      const expected = ((3 * Math.sqrt(3)) / 2) * R * R;
      expect(Math.abs(sum(cov) - expected) / expected).toBeLessThan(0.005);
    }
  });

  it('shield is left/right symmetric and pointed at the bottom', () => {
    const n = 80;
    const cov = backdropCoverage({ shape: 'shield', inset: 0.05, cornerRadius: 0.1 }, n);
    expectSymmetric(cov, n, { vertical: false });
    expect(cov[6 * n + n / 2]).toBeGreaterThan(0.9); // just below the flat top (box starts at y = 4)
    expect(cov[(n - 5) * n + 20]).toBe(0); // bottom corners are cut away
  });

  it('seeded blobs are deterministic, differ by seed and fit the box', () => {
    const a = backdropCoverage({ shape: 'blob', blob: { seed: 42 } }, 64);
    const b = backdropCoverage({ shape: 'blob', blob: { seed: 42 } }, 64);
    const c = backdropCoverage({ shape: 'blob', blob: { seed: 43 } }, 64);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(blobControlPoints({ seed: 5, points: 7, variance: 0.3 })).toEqual(blobControlPoints({ seed: 5, points: 7, variance: 0.3 }));
    const box = shapeBox(DEFAULT_BACKDROP.inset, 64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (a[y * 64 + x] > 0) {
          expect(x + 1).toBeGreaterThan(box.x - 0.01);
          expect(x).toBeLessThan(box.x + box.w + 0.01);
          expect(y + 1).toBeGreaterThan(box.y - 0.01);
          expect(y).toBeLessThan(box.y + box.h + 0.01);
        }
      }
    }
    // variance 0 is a circle
    const round = backdropCoverage({ shape: 'blob', inset: 0.1, blob: { variance: 0 } }, 100);
    const r = 40;
    expect(Math.abs(sum(round) - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.01);
  });

  it('byte masks match coverage', () => {
    const cov = backdropCoverage({ shape: 'circle' }, 32);
    const mask = backdropShapeMask({ shape: 'circle' }, 32);
    for (let i = 0; i < cov.length; i++) expect(Math.abs(mask[i] - cov[i] * 255)).toBeLessThanOrEqual(0.5);
  });

  it('fillets polygon corners and keeps short edges intact', () => {
    const sharp = hexagonPolygon({ x: 0, y: 0, w: 100, h: 100 }, 'pointy', 0);
    expect(sharp).toHaveLength(12);
    const round = roundPolygon(sharp, 10);
    expect(round.length).toBeGreaterThan(40);
    const tiny = roundPolygon([0, 0, 1, 0, 1, 1, 0, 1], 100);
    for (const v of tiny) expect(v).toBeGreaterThanOrEqual(-1e-9);
  });

  it('mirrored SDF sampling equals direct evaluation at odd and even sizes', () => {
    for (const size of [41, 64]) {
      for (const shape of ['circle', 'rounded', 'squircle'] as const) {
        const spec = resolveBackdropSpec({ shape, inset: 0.07, cornerRadius: 0.3, squircleExponent: 4.5 });
        const geom = shapeGeometry(spec, shapeBox(spec.inset, size, size));
        if (geom.kind !== 'sdf') throw new Error('expected an SDF shape');
        const fast = geometrySdf(geom, size, size, 6);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const direct = Math.max(-6, Math.min(6, geom.sdf(x + 0.5, y + 0.5, 6)));
            expect(Math.abs(fast[y * size + x] - direct)).toBeLessThan(1e-5);
          }
        }
      }
    }
  });

  it('flattens the shield curves within 0.05 px with few segments', () => {
    const box = { x: 0, y: 0, w: 860, h: 1000 };
    const poly = shieldPolygon(box, 0);
    expect(poly.length / 2).toBeLessThan(200);
    // The first bottom curve: P0 = (860, 460), P1 = (860, 780), P2 = (653.6, 930), P3 = (430, 1000).
    const P = [860, 460, 860, 780, 653.6, 930, 430, 1000];
    const bez = (t: number) => {
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      return [a * P[0] + b * P[2] + c * P[4] + d * P[6], a * P[1] + b * P[3] + c * P[5] + d * P[7]];
    };
    // Distance from dense curve samples to the polygon outline.
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const [qx, qy] = bez(i / 2000);
      let best = Infinity;
      for (let k = 0; k < poly.length / 2; k++) {
        const ax = poly[k * 2];
        const ay = poly[k * 2 + 1];
        const bx = poly[((k + 1) % (poly.length / 2)) * 2];
        const by = poly[((k + 1) % (poly.length / 2)) * 2 + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(ax + t * dx - qx, ay + t * dy - qy));
      }
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThanOrEqual(0.05);
  });

  it('superellipse distance estimate is exact on the axes', () => {
    const sdf = superellipseSdf(0, 0, 10, 10, 5);
    expect(sdf(12, 0, Infinity)).toBeCloseTo(2, 6);
    expect(sdf(0, -7, Infinity)).toBeCloseTo(-3, 6);
    expect(sdf(0, 0, Infinity)).toBeCloseTo(-10, 6);
  });
});

describe('renderBackdrop', () => {
  it('fills the shape and leaves the outside transparent', () => {
    const px = renderBackdrop(solid({ shape: 'circle' }), 64);
    expect(pixelAt(px, 32, 32)).toEqual([0x33, 0x66, 0xcc, 255]);
    expect(pixelAt(px, 0, 0)).toEqual([0, 0, 0, 0]);
    const cov = backdropCoverage({ shape: 'circle' }, 64);
    expect(alphaMass(px)).toBeCloseTo(sum(cov), 0);
  });

  it('linear gradients follow the CSS angle convention', () => {
    const stops = [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' },
    ];
    const down = renderBackdrop({ shape: 'rounded', cornerRadius: 0, inset: 0, shadow: false, fill: { type: 'linear', angle: 180, stops } }, 64);
    expect(pixelAt(down, 32, 0)[0]).toBeGreaterThan(245);
    expect(pixelAt(down, 32, 63)[2]).toBeGreaterThan(245);
    const right = renderBackdrop({ shape: 'rounded', cornerRadius: 0, inset: 0, shadow: false, fill: { type: 'linear', angle: 90, stops } }, 64);
    expect(pixelAt(right, 0, 32)[0]).toBeGreaterThan(245);
    expect(pixelAt(right, 63, 32)[2]).toBeGreaterThan(245);
    const mid = pixelAt(right, 32, 32);
    expect(Math.abs(mid[0] - mid[2])).toBeLessThan(12);
  });

  it('radial gradients start at their centre', () => {
    const px = renderBackdrop(
      {
        shape: 'circle',
        shadow: false,
        fill: { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] },
      },
      64,
    );
    const [c] = pixelAt(px, 32, 32);
    const [e] = pixelAt(px, 32, 8);
    expect(c).toBeGreaterThan(240);
    expect(e).toBeLessThan(c - 100);
  });

  it('borders: inside keeps the silhouette, outside grows it, no seam between fill and stroke', () => {
    const size = 80;
    const inside = renderBackdrop(solid({ shape: 'squircle', border: { width: 0.05, color: '#ffcc00', position: 'inside' } }), size);
    const plain = renderBackdrop(solid({ shape: 'squircle' }), size);
    expect(alphaMass(inside)).toBeCloseTo(alphaMass(plain), 0);
    const cov = backdropCoverage({ shape: 'squircle' }, size);
    for (let i = 0; i < cov.length; i++) expect(Math.abs(inside.data[i * 4 + 3] - cov[i] * 255)).toBeLessThanOrEqual(2);
    const box = shapeBox(DEFAULT_BACKDROP.inset, size, size);
    const edgeX = Math.ceil(box.x) + 1;
    expect(pixelAt(inside, edgeX, size / 2)).toEqual([255, 0xcc, 0, 255]);
    expect(pixelAt(inside, size / 2, size / 2)).toEqual([0x33, 0x66, 0xcc, 255]);
    const outside = renderBackdrop(solid({ shape: 'hexagon', border: { width: 0.04, color: '#ffffff', position: 'outside' } }), size);
    const plainHex = renderBackdrop(solid({ shape: 'hexagon' }), size);
    expect(alphaMass(outside)).toBeGreaterThan(alphaMass(plainHex) + 50);
    const center = renderBackdrop(solid({ shape: 'blob', border: { width: 0.03, position: 'center' } }), size);
    expect(alphaMass(center)).toBeGreaterThan(alphaMass(renderBackdrop(solid({ shape: 'blob' }), size)));
  });

  it('gloss lightens the top only, shadow adds alpha below', () => {
    const plain = renderBackdrop(solid({ shape: 'squircle' }), 64);
    const gloss = renderBackdrop(solid({ shape: 'squircle', gloss: { opacity: 0.5 } }), 64);
    expect(pixelAt(gloss, 32, 10)[0]).toBeGreaterThan(pixelAt(plain, 32, 10)[0] + 30);
    expect(pixelAt(gloss, 32, 55)).toEqual(pixelAt(plain, 32, 55));
    expect(pixelAt(gloss, 0, 0)[3]).toBe(0);
    const shadow = renderBackdrop(solid({ shape: 'circle', shadow: { offsetY: 0.05, blur: 0.03, opacity: 0.8 } }), 64);
    expect(pixelAt(shadow, 32, 62)[3]).toBeGreaterThan(0);
    expect(pixelAt(plain, 32, 62)[3]).toBe(0);
    expect(pixelAt(shadow, 32, 32)).toEqual(pixelAt(renderBackdrop(solid({ shape: 'circle' }), 64), 32, 32));
  });

  it('renders every starter style at icon sizes', () => {
    expect(BACKDROP_STYLES.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(BACKDROP_STYLES.map((s) => s.id));
    expect(ids.size).toBe(BACKDROP_STYLES.length);
    for (const s of BACKDROP_STYLES) {
      for (const size of [16, 48, 128]) {
        const px = renderBackdrop(s.spec, size);
        expect(px.width).toBe(size);
        expect(alphaMass(px)).toBeGreaterThan(size * size * 0.3);
      }
      expect(backdropStyle(s.id)).toEqual(s.spec);
    }
    expect(backdropStyle('nope')).toBeUndefined();
  });

  it('is deterministic and validates its size', () => {
    expect(renderBackdrop(backdropStyle('bubble'), 40).data).toEqual(renderBackdrop(backdropStyle('bubble'), 40).data);
    expect(() => renderBackdrop({}, 0)).toThrow(RangeError);
    expect(() => renderBackdrop({}, 1.5)).toThrow(RangeError);
    expect(renderBackdrop(null, 1).data).toHaveLength(4);
  });
});

describe('resolveBackdropSpec', () => {
  it('fills defaults and clamps', () => {
    const s = resolveBackdropSpec({ shape: 'star' as never, inset: 2, cornerRadius: -1, blob: { points: 99 }, gloss: true, border: false, shadow: null });
    expect(s.shape).toBe(DEFAULT_BACKDROP.shape);
    expect(s.inset).toBe(0.45);
    expect(s.cornerRadius).toBe(0);
    expect(s.blob.points).toBe(16);
    expect(s.gloss).toEqual({ opacity: 0.35, size: 0.55, color: '#ffffff' });
    expect(s.border).toBeNull();
    expect(s.shadow).toBeNull();
    expect(resolveBackdropSpec(undefined)).toEqual(resolveBackdropSpec(DEFAULT_BACKDROP));
  });

  it('completes partial fills per type', () => {
    expect(resolveBackdropSpec({ fill: { type: 'radial' } }).fill).toMatchObject({ type: 'radial', cx: 0.5, cy: 0.35, radius: 0.75 });
    expect(resolveBackdropSpec({ fill: { type: 'solid', color: 'bad' } }).fill).toEqual({ type: 'solid', color: '#6e8bff' });
    expect(resolveBackdropSpec({ fill: { type: 'linear', stops: [] } }).fill).toMatchObject({ type: 'linear', angle: 180 });
    expect(resolveBackdropSpec({ border: { color: '#000' } }).border).toEqual({ width: 0.02, color: '#000', position: 'inside' });
  });

  it('exports deeply frozen defaults and presets', () => {
    expect(Object.isFrozen(DEFAULT_BACKDROP.blob)).toBe(true);
    const style = BACKDROP_STYLES[0].spec;
    expect(Object.isFrozen(style.fill)).toBe(true);
    if (style.fill.type !== 'solid') expect(Object.isFrozen(style.fill.stops[0])).toBe(true);
    const copy = backdropStyle(BACKDROP_STYLES[0].id)!;
    copy.inset = 0.3;
    expect(copy.inset).toBe(0.3);
  });

  it('never shares mutable state with the defaults', () => {
    const a = resolveBackdropSpec({});
    a.blob.seed = 99;
    if (a.fill.type === 'linear') a.fill.stops[0].color = '#000000';
    const b = resolveBackdropSpec({});
    expect(b.blob.seed).toBe(1);
    expect(b.fill).toEqual(DEFAULT_BACKDROP.fill);
  });
});
