import { describe, expect, it } from 'vitest';
import { pixelAt } from './test-utils';
import { aliases, createPixels, pixelsFrom } from './types';
import { beginOutput, finishOutput, smoothstep } from './util';

describe('finishOutput (selection-mask blending)', () => {
  it('mask 0 keeps the original and 255 takes the result, exactly', () => {
    const src = pixelsFrom(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]);
    const res = pixelsFrom(2, 1, [9, 9, 9, 9, 200, 100, 50, 25]);
    expect([...finishOutput(src, res, new Uint8Array([0, 255])).data]).toEqual([1, 2, 3, 4, 200, 100, 50, 25]);
  });

  it('blends partially selected pixels in premultiplied space', () => {
    const t = 128 / 255;
    // Opaque red → fully transparent blue at 50 %: alpha halves, no blue tint creeps in.
    const a = finishOutput(pixelsFrom(1, 1, [200, 0, 0, 255]), pixelsFrom(1, 1, [0, 0, 200, 0]), new Uint8Array([128]));
    expect(pixelAt(a, 0, 0)).toEqual([200, 0, 0, Math.round(255 * (1 - t))]);
    // Transparent black → opaque white at 50 %: no dark fringe from the stored black.
    const b = finishOutput(pixelsFrom(1, 1, [0, 0, 0, 0]), pixelsFrom(1, 1, [255, 255, 255, 255]), new Uint8Array([128]));
    expect(pixelAt(b, 0, 0)).toEqual([255, 255, 255, 128]);
    // Same alpha: a plain lerp.
    const c = finishOutput(pixelsFrom(1, 1, [0, 100, 200, 77]), pixelsFrom(1, 1, [255, 0, 100, 77]), new Uint8Array([128]));
    expect(pixelAt(c, 0, 0)).toEqual([Math.round(255 * t), Math.round(100 * (1 - t)), Math.round(200 - 100 * t), 77]);
  });

  it('writes into `out`, which may alias the source', () => {
    const src = pixelsFrom(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]);
    const mask = new Uint8Array([255, 0]);
    const dst = beginOutput(src, mask, src);
    // With a mask, an aliasing `out` gets a scratch buffer so the original survives for blending.
    expect(aliases(dst, src)).toBe(false);
    dst.data.set([0, 0, 0, 255, 0, 0, 0, 255]);
    const out = finishOutput(src, dst, mask, src);
    expect(out).toBe(src);
    expect([...src.data]).toEqual([0, 0, 0, 255, 40, 50, 60, 255]);
    expect(beginOutput(src, null, src)).toBe(src);
    expect(() => beginOutput(src, null, createPixels(1, 1))).toThrow(RangeError);
  });
});

describe('smoothstep', () => {
  it('is 0 / ½ / 1 at the start / middle / end and a hard step when the edges meet', () => {
    expect(smoothstep(0, 2, 0)).toBe(0);
    expect(smoothstep(0, 2, 1)).toBe(0.5);
    expect(smoothstep(0, 2, 2)).toBe(1);
    expect(smoothstep(1, 1, 0.9)).toBe(0);
    expect(smoothstep(1, 1, 1)).toBe(1);
  });
});
