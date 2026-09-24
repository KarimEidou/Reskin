import { describe, expect, it } from 'vitest';
import {
  autoContrast,
  brightnessContrast,
  colorize,
  duotone,
  gradientMap,
  grayscale,
  hueSaturation,
  invert,
  levels,
  opacity,
  posterize,
  sepia,
  threshold,
} from './adjust';
import { luma, rgbToHsl } from './colormath';
import { clonePixels, pixelsFrom, solidPixels } from './types';
import { makeMask, makePixels, pixelAt, randomPixels } from './test-utils';

const quad = () =>
  pixelsFrom(2, 2, [
    255, 0, 0, 255, //
    0, 255, 0, 128,
    0, 0, 255, 0,
    10, 200, 30, 255,
  ]);

const grey = (v: number, a = 255) => solidPixels(1, 1, v, v, v, a);
const one = (r: number, g: number, b: number, a = 255) => solidPixels(1, 1, r, g, b, a);

describe('invert', () => {
  it('inverts RGB and keeps alpha', () => {
    const out = invert(quad());
    expect([...out.data]).toEqual([0, 255, 255, 255, 255, 0, 255, 128, 255, 255, 0, 0, 245, 55, 225, 255]);
  });

  it('never mutates its input', () => {
    const src = quad();
    const copy = clonePixels(src);
    invert(src);
    expect(src.data).toEqual(copy.data);
  });

  it('blends by selection mask: 0 = unchanged, 255 = full, 128 ≈ halfway', () => {
    const src = pixelsFrom(3, 1, [200, 100, 0, 255, 200, 100, 0, 255, 200, 100, 0, 255]);
    const out = invert(src, {}, new Uint8Array([0, 255, 128]));
    expect(pixelAt(out, 0, 0)).toEqual([200, 100, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([55, 155, 255, 255]);
    const [r, g, b, a] = pixelAt(out, 2, 0);
    const t = 128 / 255;
    expect(Math.abs(r - (200 + (55 - 200) * t))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(g - (100 + (155 - 100) * t))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(b - 255 * t)).toBeLessThanOrEqual(0.5);
    expect(a).toBe(255);
  });

  it('writes into `out`, including in place', () => {
    const src = quad();
    const out = solidPixels(2, 2, 1, 2, 3, 4);
    const res = invert(src, {}, null, out);
    expect(res).toBe(out);
    expect(pixelAt(out, 0, 0)).toEqual([0, 255, 255, 255]);
    const inPlace = quad();
    invert(inPlace, {}, new Uint8Array([255, 0, 255, 0]), inPlace);
    expect(pixelAt(inPlace, 0, 0)).toEqual([0, 255, 255, 255]);
    expect(pixelAt(inPlace, 1, 0)).toEqual([0, 255, 0, 128]);
  });

  it('rejects a mask of the wrong size', () => {
    expect(() => invert(quad(), {}, new Uint8Array(3))).toThrow(RangeError);
  });
});

describe('grayscale', () => {
  it('uses Rec.709 luma', () => {
    expect(pixelAt(grayscale(one(255, 0, 0)), 0, 0)).toEqual([54, 54, 54, 255]);
    expect(pixelAt(grayscale(one(0, 255, 0)), 0, 0)).toEqual([182, 182, 182, 255]);
    expect(pixelAt(grayscale(one(0, 0, 255)), 0, 0)).toEqual([18, 18, 18, 255]);
    expect(pixelAt(grayscale(one(255, 255, 255, 77)), 0, 0)).toEqual([255, 255, 255, 77]);
    expect(pixelAt(grayscale(grey(93)), 0, 0)).toEqual([93, 93, 93, 255]);
  });

  it('blends by amount', () => {
    // luma(200, 0, 0) = 43; 40 % of the way: 200 → 137.2, 0 → 17.2
    expect(pixelAt(grayscale(one(200, 0, 0), { amount: 40 }), 0, 0)).toEqual([137, 17, 17, 255]);
  });
});

describe('threshold', () => {
  it('splits at the level (luma ≥ level → white)', () => {
    expect(pixelAt(threshold(grey(127)), 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(threshold(grey(128)), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(threshold(grey(200), { level: 201 }), 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(threshold(grey(0), { level: 0 }), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(threshold(grey(254), { level: 255 }), 0, 0)).toEqual([0, 0, 0, 255]);
    // pure red has luma 54
    expect(pixelAt(threshold(one(255, 0, 0), { level: 54 }), 0, 0)[0]).toBe(255);
    expect(pixelAt(threshold(one(255, 0, 0), { level: 55 }), 0, 0)[0]).toBe(0);
  });

  it('keeps alpha', () => {
    expect(pixelAt(threshold(grey(200, 31)), 0, 0)).toEqual([255, 255, 255, 31]);
  });
});

describe('posterize', () => {
  const values = [0, 50, 127, 128, 200, 255];
  const run = (levels: number) => values.map((v) => pixelAt(posterize(grey(v), { levels }), 0, 0)[0]);

  it('2 levels is a per-channel threshold at the midpoint', () => {
    expect(run(2)).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('4 levels snaps to 0/85/170/255', () => {
    // 127/255·3 = 1.49 → 85, 128/255·3 = 1.51 → 170
    expect(run(4)).toEqual([0, 85, 85, 170, 170, 255]);
  });

  it('clamps levels into range', () => {
    expect(pixelAt(posterize(grey(100), { levels: 1 }), 0, 0)[0]).toBe(0);
    expect(pixelAt(posterize(grey(100), { levels: 9999 }), 0, 0)[0]).toBe(pixelAt(posterize(grey(100), { levels: 32 }), 0, 0)[0]);
  });
});

describe('brightnessContrast', () => {
  it('brightness shifts by 2.55 per step and clamps', () => {
    expect(pixelAt(brightnessContrast(grey(100), { brightness: 20 }), 0, 0)).toEqual([151, 151, 151, 255]);
    expect(pixelAt(brightnessContrast(grey(220), { brightness: 20 }), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(brightnessContrast(grey(30), { brightness: -20 }), 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(brightnessContrast(grey(0), { brightness: 100 }), 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('applies the classic contrast factor F = 259(C + 255) / (255(259 − C)), C = 2.55·contrast', () => {
    // contrast 50: C = 127.5, F = 2.95444; 100 → F·(−28) + 128 = 45.28, 150 → F·22 + 128 = 193.0
    const out = brightnessContrast(pixelsFrom(2, 1, [100, 100, 100, 255, 150, 150, 150, 9]), { contrast: 50 });
    expect([...out.data]).toEqual([45, 45, 45, 255, 193, 193, 193, 9]);
    // brightness is added after contrast: 45.28 + 25.5 = 70.8
    expect(pixelAt(brightnessContrast(grey(100), { contrast: 50, brightness: 10 }), 0, 0)[0]).toBe(71);
  });

  it('contrast pivots around 128', () => {
    expect(pixelAt(brightnessContrast(grey(128), { contrast: 70 }), 0, 0)[0]).toBe(128);
    expect(pixelAt(brightnessContrast(grey(129), { contrast: 100 }), 0, 0)[0]).toBe(255);
    expect(pixelAt(brightnessContrast(grey(127), { contrast: 100 }), 0, 0)[0]).toBe(0);
    expect(pixelAt(brightnessContrast(grey(10), { contrast: -100 }), 0, 0)[0]).toBe(128);
    expect(pixelAt(brightnessContrast(grey(250), { contrast: -100 }), 0, 0)[0]).toBe(128);
  });
});

describe('hueSaturation', () => {
  it('rotating pure red by 180° gives cyan', () => {
    expect(pixelAt(hueSaturation(one(255, 0, 0), { hue: 180 }), 0, 0)).toEqual([0, 255, 255, 255]);
    expect(pixelAt(hueSaturation(one(255, 0, 0), { hue: -180 }), 0, 0)).toEqual([0, 255, 255, 255]);
  });

  it('rotating red by 120° gives green, −120° gives blue', () => {
    expect(pixelAt(hueSaturation(one(255, 0, 0), { hue: 120 }), 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(hueSaturation(one(255, 0, 0), { hue: -120 }), 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('saturation −100 desaturates to HSL lightness', () => {
    expect(pixelAt(hueSaturation(one(255, 0, 0), { saturation: -100 }), 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it('lightness ±100 reaches white / black and keeps alpha', () => {
    expect(pixelAt(hueSaturation(one(12, 99, 200, 40), { lightness: 100 }), 0, 0)).toEqual([255, 255, 255, 40]);
    expect(pixelAt(hueSaturation(one(12, 99, 200, 40), { lightness: -100 }), 0, 0)).toEqual([0, 0, 0, 40]);
  });

  it('keeps greys grey when saturating', () => {
    expect(pixelAt(hueSaturation(grey(90), { saturation: 100, hue: 45 }), 0, 0)).toEqual([90, 90, 90, 255]);
  });

  it('scales HSL saturation (hand-computed)', () => {
    // rgb(191, 64, 64): l = 0.5, s = 0.49804 → ×1.5 = 0.74706; q = l(1 + s) = 0.87353 → 222.75, p = 2l − q → 32.25
    expect(pixelAt(hueSaturation(one(191, 64, 64), { saturation: 50 }), 0, 0)).toEqual([223, 32, 32, 255]);
    // lightness +50 moves l halfway to white: rgb(0, 0, 128) (h = 240, s = 1, l = 0.251) → l = 0.6255;
    // q = l + s − ls = 1, p = 2l − q = 0.251 → rgb(64, 64, 255)
    expect(pixelAt(hueSaturation(one(0, 0, 128), { lightness: 50 }), 0, 0)).toEqual([64, 64, 255, 255]);
  });

  it('rotating by +h then −h round-trips arbitrary colours (±1)', () => {
    const src = randomPixels(32, 32, 77);
    const back = hueSaturation(hueSaturation(src, { hue: 73 }), { hue: -73 });
    for (let i = 0; i < src.data.length; i++) expect(Math.abs(back.data[i] - src.data[i])).toBeLessThanOrEqual(1);
  });
});

describe('sepia', () => {
  it('applies the sepia matrix', () => {
    expect(pixelAt(sepia(one(10, 20, 30)), 0, 0)).toEqual([25, 22, 17, 255]);
    expect(pixelAt(sepia(one(255, 255, 255)), 0, 0)).toEqual([255, 255, 239, 255]);
    expect(pixelAt(sepia(one(0, 0, 0, 9)), 0, 0)).toEqual([0, 0, 0, 9]);
  });
});

describe('colorize', () => {
  it('keeps luma (±1) and tints to the requested hue', () => {
    const hsl = [0, 0, 0];
    for (let v = 0; v <= 255; v += 5) {
      const [r, g, b] = pixelAt(colorize(grey(v), { hue: 200, saturation: 70 }), 0, 0);
      expect(Math.abs(luma(r, g, b) - v)).toBeLessThanOrEqual(1);
      if (v >= 40 && v <= 215) {
        rgbToHsl(r / 255, g / 255, b / 255, hsl);
        expect(Math.abs(hsl[0] - 200)).toBeLessThan(3);
      }
    }
  });

  it('saturation 0 is plain greyscale', () => {
    expect(pixelAt(colorize(one(255, 0, 0), { saturation: 0 }), 0, 0)).toEqual(pixelAt(grayscale(one(255, 0, 0)), 0, 0));
  });
});

describe('duotone and gradient map', () => {
  it('duotone maps black → shadows and white → highlights', () => {
    const params = { shadows: '#102030', highlights: '#f0e0d0' };
    expect(pixelAt(duotone(grey(0), params), 0, 0)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(pixelAt(duotone(grey(255, 99), params), 0, 0)).toEqual([0xf0, 0xe0, 0xd0, 99]);
    const [r] = pixelAt(duotone(grey(128), params), 0, 0);
    expect(r).toBeGreaterThan(0x10);
    expect(r).toBeLessThan(0xf0);
  });

  it('gradient map maps luma through N stops', () => {
    const stops = [
      { offset: 0, color: '#ff0000' },
      { offset: 0.5, color: '#00ff00' },
      { offset: 1, color: '#0000ff' },
    ];
    expect(pixelAt(gradientMap(grey(0), { stops }), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(gradientMap(grey(255), { stops }), 0, 0)).toEqual([0, 0, 255, 255]);
    const [r, g, b] = pixelAt(gradientMap(grey(127), { stops }), 0, 0);
    expect(g).toBeGreaterThan(250);
    expect(r).toBeLessThan(5);
    expect(b).toBe(0);
    expect(pixelAt(gradientMap(grey(0), { stops, reverse: true }), 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('gradient map falls back to its default stops for invalid input', () => {
    const bad = gradientMap(grey(0), { stops: [{ offset: 0, color: 'nope' }] as never });
    expect(bad.data).toEqual(gradientMap(grey(0)).data);
  });
});

describe('levels and auto contrast', () => {
  it('levels remaps the input range', () => {
    const p = { inBlack: 64, inWhite: 192 };
    expect(pixelAt(levels(grey(64), p), 0, 0)[0]).toBe(0);
    expect(pixelAt(levels(grey(30), p), 0, 0)[0]).toBe(0);
    expect(pixelAt(levels(grey(128), p), 0, 0)[0]).toBe(128);
    expect(pixelAt(levels(grey(192), p), 0, 0)[0]).toBe(255);
    expect(pixelAt(levels(grey(128), { gamma: 2 }), 0, 0)[0]).toBe(Math.round(255 * Math.sqrt(128 / 255)));
    expect(pixelAt(levels(grey(255), { outWhite: 200, outBlack: 50 }), 0, 0)[0]).toBe(200);
    expect(pixelAt(levels(grey(0), { outWhite: 200, outBlack: 50 }), 0, 0)[0]).toBe(50);
  });

  it('auto contrast stretches the used range to 0..255', () => {
    const src = makePixels(2, 1, (x) => (x === 0 ? [64, 64, 64, 255] : [192, 192, 192, 255]));
    const out = autoContrast(src, { clip: 0 });
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([255, 255, 255, 255]);
  });

  it('auto contrast ignores transparent pixels and leaves full-range images alone', () => {
    const src = makePixels(3, 1, (x) => (x === 0 ? [0, 0, 0, 0] : x === 1 ? [100, 100, 100, 255] : [150, 150, 150, 255]));
    const out = autoContrast(src, { clip: 0 });
    expect(pixelAt(out, 1, 0)[0]).toBe(0);
    expect(pixelAt(out, 2, 0)[0]).toBe(255);
    const full = makePixels(2, 1, (x) => (x ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    expect(autoContrast(full).data).toEqual(full.data);
  });
});

describe('opacity', () => {
  it('scales alpha only', () => {
    expect(pixelAt(opacity(one(10, 20, 30, 200), { amount: 50 }), 0, 0)).toEqual([10, 20, 30, 100]);
    expect(pixelAt(opacity(one(10, 20, 30, 200), { amount: 0 }), 0, 0)).toEqual([10, 20, 30, 0]);
  });

  it('partial mask blends alpha without shifting colour', () => {
    const out = opacity(one(10, 20, 30, 200), { amount: 0 }, new Uint8Array([128]));
    const [r, g, b, a] = pixelAt(out, 0, 0);
    expect([r, g, b]).toEqual([10, 20, 30]);
    expect(a).toBe(Math.round(200 * (1 - 128 / 255)));
  });
});

describe('identity parameters', () => {
  const src = randomPixels(7, 5, 42);
  const cases: [string, (s: typeof src) => typeof src][] = [
    ['brightnessContrast', (s) => brightnessContrast(s)],
    ['hueSaturation', (s) => hueSaturation(s)],
    ['grayscale 0', (s) => grayscale(s, { amount: 0 })],
    ['sepia 0', (s) => sepia(s, { amount: 0 })],
    ['colorize 0', (s) => colorize(s, { amount: 0 })],
    ['duotone 0', (s) => duotone(s, { amount: 0 })],
    ['gradientMap 0', (s) => gradientMap(s, { amount: 0 })],
    ['levels', (s) => levels(s)],
    ['opacity 100', (s) => opacity(s)],
  ];
  for (const [name, fn] of cases) {
    it(`${name} leaves pixels unchanged (in a new buffer)`, () => {
      const out = fn(src);
      expect(out.data).toEqual(src.data);
    });
  }

  it('returns a copy, not the input', () => {
    const out = levels(src);
    expect(out).not.toBe(src);
    expect(out.data).not.toBe(src.data);
  });

  it('invert applied twice is the identity (through the LUT path)', () => {
    expect(invert(invert(src)).data).toEqual(src.data);
  });

  it('mask of all 255 equals the unmasked result', () => {
    const full = makeMask(7, 5, () => 255);
    expect(sepia(src, {}, full).data).toEqual(sepia(src).data);
    expect(hueSaturation(src, { hue: 90 }, full).data).toEqual(hueSaturation(src, { hue: 90 }).data);
  });

  it('mask of all zeros leaves any filter unchanged', () => {
    const zero = makeMask(7, 5, () => 0);
    expect(invert(src, {}, zero).data).toEqual(src.data);
    expect(sepia(src, {}, zero).data).toEqual(src.data);
    expect(hueSaturation(src, { hue: 90 }, zero).data).toEqual(src.data);
  });
});
