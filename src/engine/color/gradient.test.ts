import { describe, expect, it } from 'vitest';
import {
  applySpread,
  createGradient,
  gradientLut,
  gradientParam,
  normalizeStops,
  reverseGradient,
  sampleGradient,
  sampleStops,
} from './gradient';
import { toRgba8 } from './color';

const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };

describe('gradients', () => {
  it('samples endpoints and midpoints exactly', () => {
    const g = createGradient(red, blue);
    expect(sampleGradient(g, 0)).toEqual(red);
    expect(sampleGradient(g, 1)).toEqual(blue);
    expect(toRgba8(sampleGradient(g, 0.5))).toEqual([128, 0, 128, 255]);
    // Pad clamps outside 0..1.
    expect(sampleGradient(g, -3)).toEqual(red);
    expect(sampleGradient(g, 7)).toEqual(blue);
  });

  it('handles multi-stop and unsorted stops', () => {
    const stops = normalizeStops([
      { offset: 1, color: blue },
      { offset: 0, color: red },
      { offset: 0.5, color: { r: 0, g: 255, b: 0, a: 1 } },
    ]);
    expect(stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(toRgba8(sampleStops(stops, 0.5))).toEqual([0, 255, 0, 255]);
    expect(toRgba8(sampleStops(stops, 0.75))).toEqual([0, 128, 128, 255]);
  });

  it('interpolates towards transparent without darkening', () => {
    const c = sampleStops(normalizeStops([{ offset: 0, color: red }, { offset: 1, color: { ...blue, a: 0 } }]), 0.5);
    expect(toRgba8(c)).toEqual([255, 0, 0, 128]);
  });

  it('applies spread modes', () => {
    expect(applySpread('pad', 1.25)).toBe(1);
    expect(applySpread('repeat', 1.25)).toBeCloseTo(0.25, 12);
    expect(applySpread('repeat', 1)).toBe(1);
    expect(applySpread('reflect', 1.25)).toBeCloseTo(0.75, 12);
    expect(applySpread('reflect', -0.25)).toBeCloseTo(0.25, 12);
  });

  it('computes linear, radial and conic parameters', () => {
    expect(gradientParam('linear', 5, 3, 0, 0, 10, 0)).toBeCloseTo(0.5, 12);
    expect(gradientParam('linear', 0, 0, 0, 0, 10, 0)).toBe(0);
    expect(gradientParam('radial', 0, 5, 0, 0, 10, 0)).toBeCloseTo(0.5, 12);
    expect(gradientParam('conic', 0, 10, 0, 0, 10, 0)).toBeCloseTo(0.25, 12);
    expect(gradientParam('conic', -10, 0, 0, 0, 10, 0)).toBeCloseTo(0.5, 12);
  });

  it('builds a premultiplied LUT with exact ends', () => {
    const lut = gradientLut(createGradient(red, { ...blue, a: 0.5 }).stops, 16);
    expect(Array.from(lut.subarray(0, 4))).toEqual([1, 0, 0, 1]);
    expect(Array.from(lut.subarray(60, 64))).toEqual([0, 0, 0.5, 0.5]);
  });

  it('reverses', () => {
    const g = reverseGradient(createGradient(red, blue));
    expect(sampleGradient(g, 0)).toEqual(blue);
  });
});
