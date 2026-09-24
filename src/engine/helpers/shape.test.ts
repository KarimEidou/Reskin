import { describe, expect, it } from 'vitest';
import { alphaMass, makeMask, pixelAt, randomPixels } from '../filters/test-utils';
import { solidPixels } from '../filters/types';
import { distanceTransform } from './distance';
import { fitToShape, roundCorners } from './shape';

describe('roundCorners', () => {
  const S = 64;
  const opaque = () => solidPixels(S, S, 40, 90, 200);

  it('clears the corner pixels and leaves edges and centre opaque', () => {
    const out = roundCorners(opaque(), 0.25);
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [63, 0],
      [0, 63],
      [63, 63],
      [2, 1],
    ]) {
      expect(pixelAt(out, x, y)[3]).toBe(0);
    }
    for (const [x, y] of [
      [32, 0],
      [0, 32],
      [63, 32],
      [32, 63],
      [32, 32],
      [16, 16],
    ]) {
      expect(pixelAt(out, x, y)[3]).toBe(255);
    }
    expect(pixelAt(out, 0, 0).slice(0, 3)).toEqual([40, 90, 200]);
  });

  it('removes exactly the area outside the arcs (anti-aliased)', () => {
    const r = 16;
    const out = roundCorners(opaque(), r / S);
    const removed = S * S - alphaMass(out);
    const expected = r * r * (4 - Math.PI);
    expect(Math.abs(removed - expected) / expected).toBeLessThan(0.01);
    let partial = 0;
    for (let i = 3; i < out.data.length; i += 4) if (out.data[i] > 0 && out.data[i] < 255) partial++;
    expect(partial).toBeGreaterThan(40);
  });

  it('is symmetric in both axes', () => {
    for (const style of ['circular', 'squircle'] as const) {
      const out = roundCorners(opaque(), 0.3, { style });
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const a = pixelAt(out, x, y)[3];
          expect(pixelAt(out, S - 1 - x, y)[3]).toBe(a);
          expect(pixelAt(out, x, S - 1 - y)[3]).toBe(a);
          expect(pixelAt(out, y, x)[3]).toBe(a);
        }
      }
    }
  });

  it('squircle corners are fuller than circular ones', () => {
    const circ = roundCorners(opaque(), 0.3);
    const sq = roundCorners(opaque(), 0.3, { style: 'squircle' });
    expect(alphaMass(sq)).toBeGreaterThan(alphaMass(circ) + 20);
    expect(pixelAt(sq, 0, 0)[3]).toBe(0);
  });

  it('multiplies existing alpha, handles 0 and the 0.5 maximum', () => {
    const half = solidPixels(S, S, 1, 2, 3, 100);
    expect(pixelAt(roundCorners(half, 0.2), 32, 32)[3]).toBe(100);
    expect(roundCorners(half, 0).data).toEqual(half.data);
    const disc = roundCorners(opaque(), 0.5);
    const expected = Math.PI * 32 * 32;
    expect(Math.abs(alphaMass(disc) - expected) / expected).toBeLessThan(0.01);
    const wide = roundCorners(solidPixels(40, 20, 9, 9, 9), 0.5);
    expect(pixelAt(wide, 20, 10)[3]).toBe(255);
    expect(pixelAt(wide, 0, 0)[3]).toBe(0);
    expect(pixelAt(wide, 0, 10)[3]).toBeGreaterThan(200);
  });
});

describe('fitToShape', () => {
  it('multiplies alpha by a byte mask', () => {
    const src = randomPixels(6, 6, 1, true);
    const out = fitToShape(src, makeMask(6, 6, (x) => (x < 3 ? 255 : 0)));
    expect(pixelAt(out, 1, 1)).toEqual(pixelAt(src, 1, 1));
    expect(pixelAt(out, 4, 1)[3]).toBe(0);
    expect(pixelAt(out, 4, 1).slice(0, 3)).toEqual(pixelAt(src, 4, 1).slice(0, 3));
    expect(() => fitToShape(src, new Uint8Array(5))).toThrow(RangeError);
  });

  it('clips to a backdrop shape with anti-aliasing', () => {
    const out = fitToShape(solidPixels(64, 64, 200, 10, 10), { shape: 'circle' });
    expect(pixelAt(out, 0, 0)[3]).toBe(0);
    expect(pixelAt(out, 32, 32)[3]).toBe(255);
    const expected = Math.PI * 32 * 32;
    expect(Math.abs(alphaMass(out) - expected) / expected).toBeLessThan(0.01);
    const hex = fitToShape(solidPixels(64, 64, 200, 10, 10), { shape: 'hexagon', cornerRadius: 0 });
    expect(pixelAt(hex, 0, 32)[3]).toBe(0);
    expect(pixelAt(hex, 32, 1)[3]).toBe(255);
  });

  it('accepts float coverage and clamped byte masks', () => {
    const cov = new Float32Array(4).fill(0.5);
    expect(pixelAt(fitToShape(solidPixels(2, 2, 0, 0, 0, 200), cov), 0, 0)[3]).toBe(100);
    const clamped = new Uint8ClampedArray([255, 0, 51, 255]);
    const out = fitToShape(solidPixels(2, 2, 9, 9, 9, 200), clamped);
    expect([0, 1, 2, 3].map((i) => out.data[i * 4 + 3])).toEqual([200, 0, 40, 200]);
  });

  it('respects a selection mask', () => {
    const src = solidPixels(2, 1, 9, 9, 9, 255);
    const out = fitToShape(src, new Uint8Array([0, 0]), new Uint8Array([255, 0]));
    expect([out.data[3], out.data[7]]).toEqual([0, 255]);
  });
});

describe('distanceTransform', () => {
  it('matches brute force', () => {
    const w = 23;
    const h = 17;
    const feature = makeMask(w, h, (x, y) => ((x * 31 + y * 17) % 29 === 0 ? 1 : 0));
    const dt = distanceTransform(feature, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (feature[yy * w + xx]) best = Math.min(best, Math.hypot(x - xx, y - yy));
        expect(dt[y * w + x]).toBeCloseTo(best, 4);
      }
    }
  });

  it('is Infinity without features', () => {
    expect([...distanceTransform(new Uint8Array(4), 2, 2)]).toEqual([Infinity, Infinity, Infinity, Infinity]);
  });
});
