import { describe, expect, it } from 'vitest';
import { alphaMass, makePixels, pixelAt, premulMass } from '../filters/test-utils';
import { createPixels } from '../filters/types';
import { cropPixels, resizePixels } from './resample';
import { alphaBounds, autoTrim, computeFit, fitAndCenter } from './trim';

/** 10×10 transparent with an opaque blue block at x 2..5, y 3..7. */
const block = () => makePixels(10, 10, (x, y) => (x >= 2 && x <= 5 && y >= 3 && y <= 7 ? [0, 0, 255, 255] : [0, 0, 0, 0]));

describe('alphaBounds / autoTrim', () => {
  it('finds the content rectangle', () => {
    expect(alphaBounds(block())).toEqual({ x: 2, y: 3, width: 4, height: 5 });
    expect(alphaBounds(createPixels(4, 4))).toBeNull();
  });

  it('respects the alpha threshold', () => {
    const faint = makePixels(6, 6, (x, y) => (x === 1 && y === 1 ? [0, 0, 0, 10] : x === 4 && y === 4 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(alphaBounds(faint)).toEqual({ x: 1, y: 1, width: 4, height: 4 });
    expect(alphaBounds(faint, 128)).toEqual({ x: 4, y: 4, width: 1, height: 1 });
  });

  it('crops with padding (extending past the image with transparency)', () => {
    const t = autoTrim(block(), { padding: 3 })!;
    expect(t.rect).toEqual({ x: -1, y: 0, width: 10, height: 11 });
    expect(t.pixels.width).toBe(10);
    expect(t.pixels.height).toBe(11);
    expect(pixelAt(t.pixels, 3, 3)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(t.pixels, 0, 0)[3]).toBe(0);
    expect(alphaMass(t.pixels)).toBe(20);
    expect(autoTrim(createPixels(3, 3))).toBeNull();
  });
});

describe('computeFit / fitAndCenter', () => {
  /** 20×10 opaque content inside a 30×30 transparent image. */
  const wide = () => makePixels(30, 30, (x, y) => (x >= 5 && x < 25 && y >= 10 && y < 20 ? [255, 128, 0, 255] : [0, 0, 0, 0]));

  it('scales the trimmed content to fit inside the padding, keeping aspect', () => {
    const fit = computeFit(wide(), 64, { paddingRatio: 0.125 })!;
    expect(fit.source).toEqual({ x: 5, y: 10, width: 20, height: 10 });
    expect(fit.scale).toBeCloseTo(2.4);
    expect(fit).toMatchObject({ x: 8, y: 20, width: 48, height: 24 });
  });

  it('aligns to edges and corners', () => {
    expect(computeFit(wide(), 64, { paddingRatio: 0.125, alignment: 'top-left' })).toMatchObject({ x: 8, y: 8 });
    expect(computeFit(wide(), 64, { paddingRatio: 0.125, alignment: 'bottom-right' })).toMatchObject({ x: 8, y: 32 });
    expect(computeFit(wide(), 64, { paddingRatio: 0.125, alignment: 'bottom' })).toMatchObject({ x: 8, y: 32 });
    expect(computeFit(wide(), 64, { paddingRatio: 0.125, alignment: 'left' })).toMatchObject({ x: 8, y: 20 });
  });

  it('can skip trimming and upscaling', () => {
    expect(computeFit(wide(), 64, { trim: false, paddingRatio: 0 })).toMatchObject({ x: 0, y: 0, width: 64, height: 64 });
    expect(computeFit(wide(), 64, { upscale: false, paddingRatio: 0 })).toMatchObject({ width: 20, height: 10, x: 22, y: 27 });
    expect(computeFit(createPixels(5, 5), 64)).toBeNull();
  });

  it('renders the content at the computed place', () => {
    const out = fitAndCenter(wide(), 64, { paddingRatio: 0.125 });
    expect(out.width).toBe(64);
    expect(out.height).toBe(64);
    expect(pixelAt(out, 8, 20)).toEqual([255, 128, 0, 255]);
    expect(pixelAt(out, 55, 43)).toEqual([255, 128, 0, 255]);
    expect(pixelAt(out, 7, 20)[3]).toBe(0);
    expect(pixelAt(out, 8, 19)[3]).toBe(0);
    expect(pixelAt(out, 56, 43)[3]).toBe(0);
    expect(pixelAt(out, 8, 44)[3]).toBe(0);
    expect(alphaMass(out)).toBeCloseTo(48 * 24, 0);
    expect(alphaMass(fitAndCenter(createPixels(4, 4), 16))).toBe(0);
  });

  it('pixel-art mode keeps hard pixels', () => {
    const art = makePixels(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = fitAndCenter(art, 8, { paddingRatio: 0, resampling: 'nearest' });
    const values = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) values.add(out.data[i]);
    expect([...values].sort()).toEqual([0, 255]);
    expect(pixelAt(out, 3, 3)[0]).toBe(0);
    expect(pixelAt(out, 4, 3)[0]).toBe(255);
  });
});

describe('resizePixels / cropPixels', () => {
  it('area-averages when shrinking', () => {
    const checker = makePixels(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = resizePixels(checker, 2, 2);
    for (let i = 0; i < out.data.length; i += 4) expect([...out.data.subarray(i, i + 4)]).toEqual([128, 128, 128, 255]);
    const third = resizePixels(makePixels(3, 1, (x) => [x * 90, 0, 0, 255]), 1, 1);
    expect(pixelAt(third, 0, 0)[0]).toBe(90);
  });

  it('does not darken semi-transparent edges', () => {
    const src = makePixels(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    expect(pixelAt(resizePixels(src, 1, 1), 0, 0)).toEqual([255, 0, 0, 128]);
    const up = resizePixels(src, 8, 1);
    for (let x = 0; x < 8; x++) {
      const [r, g, b, a] = pixelAt(up, x, 0);
      if (a > 0) expect([r, g, b]).toEqual([255, 0, 0]);
    }
  });

  it('bilinear upscaling interpolates and conserves mass', () => {
    const src = makePixels(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [200, 200, 200, 255]));
    const up = resizePixels(src, 4, 1);
    expect([0, 1, 2, 3].map((x) => pixelAt(up, x, 0)[0])).toEqual([0, 50, 150, 200]);
    const blob = makePixels(8, 8, (x, y) => (x > 1 && x < 6 && y > 2 && y < 5 ? [9, 99, 199, 255] : [0, 0, 0, 0]));
    const big = resizePixels(blob, 24, 24);
    expect(alphaMass(big) / 9).toBeCloseTo(alphaMass(blob), 0);
    expect(premulMass(big, 2) / 9).toBeCloseTo(premulMass(blob, 2), 0);
  });

  it('crop copies a region and pads outside', () => {
    const c = cropPixels(block(), { x: 4, y: 6, width: 8, height: 8 });
    expect(c.width).toBe(8);
    expect(pixelAt(c, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(c, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(c, 2, 0)[3]).toBe(0);
    expect(pixelAt(c, 7, 7)[3]).toBe(0);
    expect(cropPixels(block(), { x: 50, y: 50, width: 3, height: 3 }).data.every((v) => v === 0)).toBe(true);
  });
});
