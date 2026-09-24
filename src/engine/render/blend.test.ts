import { describe, expect, it } from 'vitest';
import { BLEND_FUNCTIONS, blendInto, blendPixel, blendStraightInto } from './blend';
import type { BlendMode } from '../doc/types';
import { BLEND_MODES } from '../doc/types';

// Opaque backdrop Cb and source Cs; with both opaque the result is B(Cb, Cs).
const CB = [0.2, 0.4, 0.6];
const CS = [0.8, 0.5, 0.25];

// Hand-computed from the W3C Compositing and Blending Level 1 formulas.
const EXPECTED: Record<BlendMode, number[]> = {
  normal: [0.8, 0.5, 0.25],
  multiply: [0.16, 0.2, 0.15],
  screen: [0.84, 0.7, 0.7],
  // overlay(b, s) = hardLight(s, b): 0.8·(2·0.2), 0.5·(2·0.4), screen(0.25, 0.2)
  overlay: [0.32, 0.4, 0.4],
  darken: [0.2, 0.4, 0.25],
  lighten: [0.8, 0.5, 0.6],
  // min(1, b / (1 − s)): 0.2/0.2, 0.4/0.5, 0.6/0.75
  'color-dodge': [1, 0.8, 0.8],
  // 1 − min(1, (1 − b)/s): all saturate to 0 for these values
  'color-burn': [0, 0, 0],
  // s>0.5 → screen(b, 2s−1); else multiply(b, 2s)
  'hard-light': [0.68, 0.4, 0.3],
  // s>0.5: b + (2s−1)(D(b) − b), D(0.2) = ((16·0.2−12)·0.2+4)·0.2 = 0.448
  'soft-light': [0.3488, 0.4, 0.48],
  difference: [0.6, 0.1, 0.35],
  exclusion: [0.68, 0.5, 0.55],
};

describe('blend modes', () => {
  it('covers all 12 modes', () => {
    expect(Object.keys(BLEND_FUNCTIONS).sort()).toEqual([...BLEND_MODES].sort());
  });

  for (const mode of BLEND_MODES) {
    it(`${mode} matches hand-computed values (opaque)`, () => {
      const out = blendPixel(mode, [...CB, 1], [...CS, 1]);
      out.slice(0, 3).forEach((v, i) => expect(v).toBeCloseTo(EXPECTED[mode][i], 5));
      expect(out[3]).toBeCloseTo(1, 6);
    });
  }

  it('color-burn and color-dodge edge cases', () => {
    const burn = BLEND_FUNCTIONS['color-burn'];
    expect(burn(0.9, 0.8)).toBeCloseTo(1 - 0.1 / 0.8, 12);
    expect(burn(1, 0)).toBe(1);
    expect(burn(0.5, 0)).toBe(0);
    const dodge = BLEND_FUNCTIONS['color-dodge'];
    expect(dodge(0, 1)).toBe(0);
    expect(dodge(0.3, 1)).toBe(1);
    expect(dodge(0.3, 0.4)).toBeCloseTo(0.5, 12);
  });

  it('soft-light uses the sqrt branch for bright backdrops', () => {
    expect(BLEND_FUNCTIONS['soft-light'](0.64, 0.75)).toBeCloseTo(0.64 + 0.5 * (0.8 - 0.64), 12);
  });

  it('mixes with a translucent backdrop per the source-over formula', () => {
    // Cb=(.2,.4,.6) αb=.5, Cs=(.8,.5,.25) αs=.5, multiply:
    // co = αs((1−αb)Cs + αb·Cs·Cb) + (1−αs)αb·Cb ; αo = .75
    const out = blendPixel('multiply', [0.1, 0.2, 0.3, 0.5], [0.4, 0.25, 0.125, 0.5]);
    const expected = CB.map((cb, i) => 0.5 * (0.5 * CS[i] + 0.5 * CS[i] * cb) + 0.25 * cb);
    out.slice(0, 3).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
    expect(out[3]).toBeCloseTo(0.75, 6);
  });

  it('applies layer opacity to the source', () => {
    const out = blendPixel('normal', [0, 0, 1, 1], [1, 0, 0, 1], 0.25);
    expect(out.map((v) => +v.toFixed(6))).toEqual([0.25, 0, 0.75, 1]);
  });

  it('any mode over a transparent backdrop yields the source', () => {
    for (const mode of BLEND_MODES) {
      const out = blendPixel(mode, [0, 0, 0, 0], [0.3, 0.2, 0.1, 0.5]);
      expect(out[0]).toBeCloseTo(0.3, 6);
      expect(out[1]).toBeCloseTo(0.2, 6);
      expect(out[2]).toBeCloseTo(0.1, 6);
      expect(out[3]).toBeCloseTo(0.5, 6);
    }
  });

  it('the straight 8-bit fast path agrees with the float path for every mode', () => {
    const src = new Uint8ClampedArray(64 * 4);
    const back = new Float32Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      src.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, (i * 29) % 256], i * 4);
      const a = ((i * 17) % 256) / 255;
      back.set([((i * 13) % 256) / 255 * a, ((i * 7) % 256) / 255 * a, ((i * 3) % 256) / 255 * a, a], i * 4);
    }
    const premul = new Float32Array(src.length);
    for (let p = 0; p < src.length; p += 4) {
      const a = src[p + 3] / 255;
      premul.set([(src[p] / 255) * a, (src[p + 1] / 255) * a, (src[p + 2] / 255) * a, a], p);
    }
    for (const mode of BLEND_MODES) {
      const a = back.slice();
      const b = back.slice();
      blendInto(a, premul, mode, 0.7);
      blendStraightInto(b, src, mode, 0.7);
      for (let i = 0; i < a.length; i++) expect(b[i], `${mode} @${i}`).toBeCloseTo(a[i], 5);
    }
  });

  it('bulk blending equals the per-pixel reference', () => {
    const acc = Float32Array.of(0.1, 0.2, 0.3, 0.5, 0, 0, 0, 0);
    const src = Float32Array.of(0.4, 0.25, 0.125, 0.5, 0.2, 0.2, 0.2, 0.2);
    blendInto(acc, src, 'screen', 0.8);
    const a = blendPixel('screen', [0.1, 0.2, 0.3, 0.5], [0.4, 0.25, 0.125, 0.5], 0.8);
    const b = blendPixel('screen', [0, 0, 0, 0], [0.2, 0.2, 0.2, 0.2], 0.8);
    expect(Array.from(acc)).toEqual([...a, ...b]);
  });
});
