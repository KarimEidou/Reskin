import { describe, expect, it } from 'vitest';
import { boxForSigma, boxVariance, gaussianBlur } from './blur-core';
import { luma } from './colormath';
import { blur, chromaticAberration, emboss, glow, noise, pixelate, sharpen, sketch, vignette } from './spatial';
import { alphaMass, makeMask, makePixels, maxDiff, pixelAt, premulMass, randomPixels } from './test-utils';
import { solidPixels } from './types';

/** 32×32 transparent (with junk green colour) and an opaque red 8×8 square in the middle. */
const redSquare = () => makePixels(32, 32, (x, y) => (x >= 12 && x < 20 && y >= 12 && y < 20 ? [255, 0, 0, 255] : [0, 255, 0, 0]));

describe('gaussian blur core', () => {
  it('three fractional box passes have exactly the requested variance', () => {
    for (const sigma of [0.3, 0.5, 1, 1.7, 4, 12.3, 64]) {
      const b = boxForSigma(sigma);
      expect(b.f).toBeGreaterThanOrEqual(0);
      expect(b.f).toBeLessThan(1);
      expect(3 * boxVariance(b)).toBeCloseTo(sigma * sigma, 9);
    }
  });

  it('an impulse spreads with variance σ² and conserves mass', () => {
    const n = 301;
    const buf = new Float32Array(n);
    buf[150] = 1000;
    gaussianBlur(buf, n, 1, 1, 6, 0);
    let mass = 0;
    let m2 = 0;
    for (let i = 0; i < n; i++) {
      mass += buf[i];
      m2 += buf[i] * (i - 150) * (i - 150);
    }
    expect(mass).toBeCloseTo(1000, 2);
    expect(m2 / mass).toBeCloseTo(36, 1);
    // symmetric
    for (let d = 1; d < 30; d++) expect(buf[150 - d]).toBeCloseTo(buf[150 + d], 3);
  });

  it('is a no-op for σ = 0 and clamps at the edges', () => {
    const buf = new Float32Array([5, 5, 5, 5]);
    gaussianBlur(buf, 4, 1, 1, 0);
    expect([...buf]).toEqual([5, 5, 5, 5]);
    gaussianBlur(buf, 4, 1, 1, 3);
    for (const v of buf) expect(v).toBeCloseTo(5, 4);
  });
});

describe('blur', () => {
  it('conserves premultiplied mass and never darkens edges', () => {
    const src = redSquare();
    const out = blur(src, { radius: 3 });
    expect(alphaMass(out)).toBeCloseTo(alphaMass(src), 0);
    expect(Math.abs(premulMass(out, 0) - premulMass(src, 0)) / premulMass(src, 0)).toBeLessThan(0.01);
    let fringe = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const [r, g, b, a] = pixelAt(out, x, y);
        if (a > 2) {
          expect(r).toBeGreaterThanOrEqual(250);
          expect(g).toBeLessThanOrEqual(3);
          expect(b).toBe(0);
          if (a < 250) fringe++;
        }
      }
    }
    expect(fringe).toBeGreaterThan(40);
  });

  it('keeps opaque uniform images (including borders) unchanged', () => {
    const src = solidPixels(16, 16, 10, 200, 30);
    expect(blur(src, { radius: 5 }).data).toEqual(src.data);
  });

  it('is symmetric', () => {
    const src = makePixels(21, 21, (x, y) => (x === 10 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = blur(src, { radius: 2 });
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        expect(pixelAt(out, x, y)).toEqual(pixelAt(out, 20 - x, y));
        expect(pixelAt(out, x, y)).toEqual(pixelAt(out, y, x));
      }
    }
  });

  it('respects the selection mask', () => {
    const src = redSquare();
    const mask = makeMask(32, 32, (x) => (x < 16 ? 255 : 0));
    const out = blur(src, { radius: 3 }, mask);
    const full = blur(src, { radius: 3 });
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) expect(pixelAt(out, x, y)).toEqual(x < 16 ? pixelAt(full, x, y) : pixelAt(src, x, y));
    }
  });

  it('works in place', () => {
    const src = redSquare();
    const expected = blur(src, { radius: 2 });
    blur(src, { radius: 2 }, null, src);
    expect(src.data).toEqual(expected.data);
  });
});

describe('sharpen', () => {
  const step = () => makePixels(20, 1, (x) => (x < 10 ? [100, 100, 100, 255] : [150, 150, 150, 255]));

  it('leaves flat areas alone and overshoots at edges', () => {
    const out = sharpen(step(), { amount: 100, radius: 1.5 });
    expect(pixelAt(out, 0, 0)[0]).toBe(100);
    expect(pixelAt(out, 19, 0)[0]).toBe(150);
    expect(pixelAt(out, 9, 0)[0]).toBeLessThan(100);
    expect(pixelAt(out, 10, 0)[0]).toBeGreaterThan(150);
    expect(pixelAt(out, 10, 0)[3]).toBe(255);
  });

  it('threshold suppresses low-contrast sharpening', () => {
    expect(sharpen(step(), { threshold: 60 }).data).toEqual(step().data);
  });

  it('uniform images are unchanged', () => {
    const src = solidPixels(8, 8, 90, 20, 200, 180);
    expect(sharpen(src, { amount: 300 }).data).toEqual(src.data);
  });
});

describe('pixelate', () => {
  it('averages blocks (alpha-aware)', () => {
    const src = makePixels(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const out = pixelate(src, { size: 2 });
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 128]);
    expect(pixelAt(out, 1, 0)).toEqual([255, 0, 0, 128]);
  });

  it('centres the block grid', () => {
    const src = makePixels(5, 1, (x) => [x * 10, x * 10, x * 10, 255]);
    const out = pixelate(src, { size: 2 });
    expect([0, 1, 2, 3, 4].map((x) => pixelAt(out, x, 0)[0])).toEqual([0, 15, 15, 35, 35]);
  });

  it('size 1 is identity and blocks divide evenly', () => {
    const src = randomPixels(6, 6, 3, true);
    expect(pixelate(src, { size: 1 }).data).toEqual(src.data);
    const out = pixelate(src, { size: 3 });
    expect(pixelAt(out, 0, 0)).toEqual(pixelAt(out, 2, 2));
    expect(pixelAt(out, 3, 3)).toEqual(pixelAt(out, 5, 5));
  });
});

describe('noise', () => {
  const grey = () => solidPixels(64, 64, 128, 128, 128, 200);

  it('is deterministic per seed', () => {
    const a = noise(grey(), { seed: 5, amount: 30 });
    const b = noise(grey(), { seed: 5, amount: 30 });
    const c = noise(grey(), { seed: 6, amount: 30 });
    expect(a.data).toEqual(b.data);
    expect(maxDiff(a, c)).toBeGreaterThan(10);
  });

  it('does not depend on the mask (masked pixels match the unmasked result)', () => {
    const mask = makeMask(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0));
    const masked = noise(grey(), { seed: 2 }, mask);
    const full = noise(grey(), { seed: 2 });
    expect(pixelAt(masked, 1, 0)).toEqual(pixelAt(full, 1, 0));
    expect(pixelAt(masked, 0, 0)).toEqual([128, 128, 128, 200]);
  });

  it('monochrome grain moves R, G, B together and keeps alpha', () => {
    const out = noise(grey(), { amount: 20, monochrome: true });
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i]).toBe(out.data[i + 2]);
      expect(out.data[i + 3]).toBe(200);
    }
  });

  for (const distribution of ['uniform', 'gaussian'] as const) {
    it(`${distribution} noise has zero mean and σ = amount / 2`, () => {
      const out = noise(grey(), { amount: 40, distribution, monochrome: false });
      let sum = 0;
      let sq = 0;
      let n = 0;
      let maxDev = 0;
      for (let i = 0; i < out.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = out.data[i + c] - 128;
          sum += d;
          sq += d * d;
          n++;
          maxDev = Math.max(maxDev, Math.abs(d));
        }
      }
      expect(Math.abs(sum / n)).toBeLessThan(0.6);
      expect(Math.sqrt(sq / n)).toBeGreaterThan(19);
      expect(Math.sqrt(sq / n)).toBeLessThan(21);
      if (distribution === 'uniform') expect(maxDev).toBeLessThanOrEqual(Math.ceil(20 * Math.sqrt(3)));
    });
  }

  it('gaussian and uniform noise have their distribution shapes', () => {
    // Share of samples within ±σ (±20.5 after rounding to integers): 69.5 % for a Gaussian,
    // 20.5 / (20√3) = 59.2 % for a uniform of the same σ; 12 288 samples → ±0.5 % standard error.
    const within = (distribution: 'uniform' | 'gaussian') => {
      const out = noise(grey(), { amount: 40, distribution, monochrome: false, seed: 3 });
      let inside = 0;
      let n = 0;
      for (let i = 0; i < out.data.length; i += 4) {
        for (let c = 0; c < 3; c++, n++) if (Math.abs(out.data[i + c] - 128) <= 20) inside++;
      }
      return inside / n;
    };
    expect(within('gaussian')).toBeGreaterThan(0.675);
    expect(within('gaussian')).toBeLessThan(0.715);
    expect(within('uniform')).toBeGreaterThan(0.572);
    expect(within('uniform')).toBeLessThan(0.612);
  });
});

describe('vignette', () => {
  it('darkens corners, keeps the centre and alpha', () => {
    const src = solidPixels(64, 64, 200, 180, 160, 222);
    const out = vignette(src, { amount: 80 });
    expect(pixelAt(out, 32, 32)).toEqual([200, 180, 160, 222]);
    const [r, , , a] = pixelAt(out, 0, 0);
    expect(r).toBeLessThan(120);
    expect(a).toBe(222);
  });

  it('tints towards its colour', () => {
    const out = vignette(solidPixels(32, 32, 0, 0, 0), { color: '#ffffff', amount: 100, radius: 50 });
    expect(pixelAt(out, 0, 0)[0]).toBeGreaterThan(200);
    expect(pixelAt(out, 16, 16)[0]).toBe(0);
  });
});

describe('emboss', () => {
  it('flat images become mid-grey (or stay put with keepColor)', () => {
    const src = solidPixels(10, 10, 30, 90, 200);
    const out = emboss(src);
    for (let i = 0; i < out.data.length; i += 4) expect([...out.data.subarray(i, i + 4)]).toEqual([128, 128, 128, 255]);
    expect(emboss(src, { keepColor: true }).data).toEqual(src.data);
  });

  it('relief = amount · 255 · (height(p − l) − height(p + l)) on a hand-computed step', () => {
    // Opaque black (height ½) left of x = 3, opaque white (height 1) from x = 3.
    const src = makePixels(6, 1, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const row = (angle: number) => [0, 1, 2, 3, 4, 5].map((x) => pixelAt(emboss(src, { angle, height: 1, amount: 50 }), x, 0)[0]);
    // Light from the east (0°): x = 2 and 3 see ½ − 1 = −½ → 128 − 63.75 = 64.25.
    expect(row(0)).toEqual([128, 128, 64, 64, 128, 128]);
    // Light from the west (180°): +½ → 191.75.
    expect(row(180)).toEqual([128, 128, 192, 192, 128, 128]);
  });

  it('lights the edge facing the light', () => {
    const src = makePixels(20, 20, (x, y) => (x >= 6 && x < 14 && y >= 6 && y < 14 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = emboss(src, { angle: 180, height: 1 }); // light from the left
    expect(pixelAt(out, 6, 10)[0]).toBeGreaterThan(160);
    expect(pixelAt(out, 13, 10)[0]).toBeLessThan(96);
    expect(pixelAt(out, 10, 10)[0]).toBe(128);
  });
});

describe('sketch', () => {
  it('flat images are blank paper; edges draw dark lines', () => {
    expect(sketch(solidPixels(6, 6, 90, 20, 10)).data.every((v) => v === 255)).toBe(true);
    const src = makePixels(12, 4, (x) => (x < 6 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = sketch(src);
    expect(pixelAt(out, 5, 1)[0]).toBeLessThan(40);
    expect(pixelAt(out, 6, 1)[0]).toBeLessThan(40);
    expect(pixelAt(out, 0, 1)[0]).toBe(255);
    expect(pixelAt(out, 11, 1)[0]).toBe(255);
    const inv = sketch(src, { invert: false });
    expect(pixelAt(inv, 5, 1)[0]).toBeGreaterThan(215);
    expect(pixelAt(inv, 0, 1)[0]).toBe(0);
  });

  it('Sobel magnitude on a hand-computed step: |G| / 4 at 100 %', () => {
    // Left half luma 0, right half luma 128: |Gx| = 4 · 128/255 at the two columns beside the step.
    const src = makePixels(6, 3, (x) => (x < 3 ? [0, 0, 0, 255] : [128, 128, 128, 255]));
    const light = sketch(src, { invert: false });
    expect([0, 1, 2, 3, 4, 5].map((x) => pixelAt(light, x, 1)[0])).toEqual([0, 0, 128, 128, 0, 0]);
    expect([0, 1, 2, 3, 4, 5].map((x) => pixelAt(sketch(src), x, 1)[0])).toEqual([255, 255, 127, 127, 255, 255]);
    // 200 % saturates at full strength; a diagonal step combines Gx and Gy.
    expect(pixelAt(sketch(src, { invert: false, strength: 200 }), 2, 1)[0]).toBe(255);
    const diag = makePixels(3, 3, (x, y) => (x + y >= 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    // centre: Gx = tr + 2r + br − (tl + 2l + bl) = 0 + 2 + 1 − 0 = 3, Gy = 3 → |G| = 3√2 → /4 = 1.06 → clipped to 1
    expect(pixelAt(sketch(diag, { invert: false }), 1, 1)[0]).toBe(255);
    expect(pixelAt(sketch(diag, { invert: false, strength: 50 }), 1, 1)[0]).toBe(Math.round(255 * ((3 * Math.SQRT2) / 8)));
  });

  it('draws the silhouette of an icon on transparency', () => {
    const src = makePixels(12, 12, (x, y) => (x >= 3 && x < 9 && y >= 3 && y < 9 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const out = sketch(src);
    expect(pixelAt(out, 3, 6)[0]).toBeLessThan(60);
    expect(pixelAt(out, 3, 6)[3]).toBe(255);
    expect(pixelAt(out, 0, 0)[3]).toBe(0);
  });

  it('coloured mode keeps hues', () => {
    const src = makePixels(12, 2, (x) => (x < 6 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const [r, g, b] = pixelAt(sketch(src, { colored: true, invert: false }), 5, 0);
    expect(r).toBeGreaterThan(g);
    expect(b).toBe(0);
  });
});

describe('glow', () => {
  it('spills light from bright pixels onto transparency', () => {
    const src = makePixels(21, 21, (x, y) => (Math.abs(x - 10) <= 1 && Math.abs(y - 10) <= 1 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = glow(src, { radius: 3, threshold: 100 });
    expect(pixelAt(out, 10, 10)).toEqual([255, 255, 255, 255]);
    const [r, g, b, a] = pixelAt(out, 14, 10);
    expect(a).toBeGreaterThan(5);
    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(alphaMass(out)).toBeGreaterThan(alphaMass(src));
  });

  it('never darkens and ignores pixels below the threshold', () => {
    const dark = solidPixels(8, 8, 40, 40, 40);
    expect(glow(dark).data).toEqual(dark.data);
    const src = randomPixels(16, 16, 9, true);
    const out = glow(src, { threshold: 50, intensity: 200 });
    for (let i = 0; i < src.data.length; i += 4) {
      expect(luma(out.data[i], out.data[i + 1], out.data[i + 2])).toBeGreaterThanOrEqual(luma(src.data[i], src.data[i + 1], src.data[i + 2]) - 0.5);
    }
  });
});

describe('chromatic aberration', () => {
  it('leaves uniform images and the exact centre untouched', () => {
    const flat = solidPixels(9, 9, 12, 34, 56);
    expect(chromaticAberration(flat, { amount: 5 }).data).toEqual(flat.data);
    const src = randomPixels(9, 9, 4, true);
    expect(pixelAt(chromaticAberration(src, { amount: 3 }), 4, 4)).toEqual(pixelAt(src, 4, 4));
  });

  it('splits red outwards and blue inwards at edges', () => {
    const src = makePixels(32, 32, (x, y) => (x >= 10 && x < 22 && y >= 10 && y < 22 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = chromaticAberration(src, { amount: 4 });
    const [r, g, b] = pixelAt(out, 22, 16); // just outside the right edge
    expect(r).toBeGreaterThan(b + 40);
    expect(g).toBeLessThan(10);
    const [r2, , b2] = pixelAt(out, 21, 16); // just inside
    expect(r2).toBeGreaterThanOrEqual(b2);
  });

  it('gives each channel its own alpha on transparent images', () => {
    const src = makePixels(32, 32, (x, y) => (x >= 10 && x < 22 && y >= 10 && y < 22 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = chromaticAberration(src, { amount: 4 });
    const [r, g, b, a] = pixelAt(out, 22, 16);
    expect(a).toBeGreaterThan(40);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });
});
