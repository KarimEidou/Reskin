import { describe, expect, it } from 'vitest';
import { Surface } from './surface';
import { floatToSurface, surfaceToFloat, createFloatImage } from './float-image';
import {
  affineResample,
  downsampleStepwise,
  downscaleInteger,
  halve,
  padCentered,
  resize,
  resizeBilinear,
  resizeNearest,
  upscaleInteger,
} from './resample';
import { forEachTile, readTile, swapTile, tileEquals, tileGrid, tileRect, TILE_SIZE } from './tiles';
import { gaussianBlur } from './blur';
import { dilate, distanceTransform, erode } from './distance';
import { unsharpMask } from './unsharp';
import { averageColor, sampleBilinear } from './sample';
import { DirtyRegion } from './dirty';
import { blitOver } from './blit';
import { translation } from '../geometry/affine';
import { seededRandom } from '../test-helpers';

function randomSurface(w: number, h: number, seed = 1): Surface {
  const r = seededRandom(seed);
  const s = new Surface(w, h);
  for (let i = 0; i < s.data.length; i++) s.data[i] = Math.floor(r() * 256);
  return s;
}

describe('Surface', () => {
  it('validates sizes and reads/writes rects', () => {
    expect(() => new Surface(0, 4)).toThrow(RangeError);
    const s = randomSurface(10, 8);
    const r = { x: 2, y: 3, w: 4, h: 2 };
    const buf = s.readRect(r);
    const t = new Surface(10, 8);
    t.writeRect(r, buf);
    expect(t.getPixel(3, 4)).toEqual(s.getPixel(3, 4));
    expect(t.getPixel(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('copies with clipping and finds alpha bounds', () => {
    const src = new Surface(4, 4);
    src.fill(1, 2, 3, 255);
    const dst = new Surface(6, 6);
    dst.copyFrom(src, src.bounds, 4, -2);
    expect(dst.alphaBounds()).toEqual({ x: 4, y: 0, w: 2, h: 2 });
    expect(new Surface(3, 3).isTransparent()).toBe(true);
  });
});

describe('float conversions', () => {
  it('straight → premultiplied → straight is exact for visible pixels', () => {
    const s = randomSurface(32, 32, 7);
    const back = floatToSurface(surfaceToFloat(s));
    for (let i = 0; i < s.data.length; i += 4) {
      if (s.data[i + 3] === 0) {
        expect([back.data[i], back.data[i + 1], back.data[i + 2], back.data[i + 3]]).toEqual([0, 0, 0, 0]);
      } else {
        expect(back.data.subarray(i, i + 4)).toEqual(s.data.subarray(i, i + 4));
      }
    }
  });
});

describe('tiles', () => {
  it('covers the surface with clipped 64 px tiles', () => {
    const g = tileGrid(150, 70);
    expect(g).toEqual({ cols: 3, rows: 2, count: 6 });
    expect(tileRect(2, 150, 70)).toEqual({ x: 128, y: 0, w: 22, h: 64 });
    expect(tileRect(5, 150, 70)).toEqual({ x: 128, y: 64, w: 22, h: 6 });
    const seen: number[] = [];
    forEachTile({ x: 60, y: 60, w: 10, h: 10 }, 150, 70, (i) => seen.push(i));
    expect(seen).toEqual([0, 1, 3, 4]);
    expect(TILE_SIZE).toBe(64);
  });

  it('swaps tile contents in place', () => {
    const a = randomSurface(100, 100, 3);
    const orig = a.clone();
    const r = tileRect(1, 100, 100);
    const tile = new Uint8ClampedArray(r.w * r.h * 4).fill(9);
    swapTile(a.data, 100, r, tile);
    expect(readTile(a.data, 100, r).every((v) => v === 9)).toBe(true);
    expect(tile).toEqual(readTile(orig.data, 100, r));
    swapTile(a.data, 100, r, tile);
    expect(a.equals(orig)).toBe(true);
    expect(tileEquals(a.data, orig.data, 100, r)).toBe(true);
  });
});

describe('resampling', () => {
  it('halving averages 2×2 blocks in premultiplied space', () => {
    const s = new Surface(2, 2);
    s.setPixel(0, 0, 255, 0, 0, 255);
    s.setPixel(1, 0, 0, 255, 0, 0); // invisible green must not tint
    s.setPixel(0, 1, 255, 0, 0, 255);
    s.setPixel(1, 1, 255, 0, 0, 255);
    expect(floatToSurface(halve(surfaceToFloat(s))).getPixel(0, 0)).toEqual([255, 0, 0, 191]);
  });

  it('stepwise downsampling matches exact area averaging for power-of-two ratios', () => {
    const s = randomSurface(64, 64, 11);
    const img = surfaceToFloat(s);
    const a = downsampleStepwise(img, 8);
    const b = resize(img, 8, 8);
    for (let i = 0; i < a.data.length; i++) expect(a.data[i]).toBeCloseTo(b.data[i], 5);
  });

  it('area resize preserves total coverage for arbitrary ratios', () => {
    const s = randomSurface(40, 40, 5);
    const img = surfaceToFloat(s);
    const out = resize(img, 24, 24);
    const sum = (d: Float32Array) => d.reduce((n, v, i) => (i % 4 === 3 ? n + v : n), 0);
    expect(sum(out.data) * (40 * 40) / (24 * 24)).toBeCloseTo(sum(img.data), 1);
  });

  it('nearest and integer scaling replicate pixels', () => {
    const s = randomSurface(4, 4, 2);
    const up = floatToSurface(upscaleInteger(surfaceToFloat(s), 3));
    expect(up.width).toBe(12);
    expect(up.getPixel(7, 10)).toEqual(floatToSurface(surfaceToFloat(s)).getPixel(2, 3));
    const near = floatToSurface(resizeNearest(surfaceToFloat(s), 8, 8));
    expect(near.getPixel(5, 1)).toEqual(up.getPixel(7, 1));
    const down = downscaleInteger(upscaleInteger(surfaceToFloat(s), 3), 3);
    const back = floatToSurface(down);
    expect(back.equals(floatToSurface(surfaceToFloat(s)))).toBe(true);
  });

  it('bilinear resize keeps constant images constant', () => {
    const s = new Surface(5, 5);
    s.fill(50, 100, 150, 200);
    const out = floatToSurface(resizeBilinear(surfaceToFloat(s), 13, 9));
    expect(out.getPixel(6, 4)).toEqual([50, 100, 150, 200]);
    expect(out.getPixel(0, 0)).toEqual([50, 100, 150, 200]);
  });

  it('pads and crops centred', () => {
    const img = createFloatImage(2, 2);
    img.data.fill(1);
    const padded = padCentered(img, 6);
    expect(padded.data[(2 * 6 + 2) * 4 + 3]).toBe(1);
    expect(padded.data[(1 * 6 + 1) * 4 + 3]).toBe(0);
    const cropped = padCentered(createFloatImage(10, 10), 4);
    expect(cropped.width).toBe(4);
  });

  it('affine resample with an integer translation is exact', () => {
    const s = randomSurface(16, 16, 9);
    const img = surfaceToFloat(s);
    const moved = floatToSurface(affineResample(img, translation(3, -2), 16, 16));
    const ref = floatToSurface(img);
    expect(moved.getPixel(3 + 4, 5 - 2)).toEqual(ref.getPixel(4, 5));
    expect(moved.getPixel(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('bilinear sampling interpolates between pixel centres', () => {
    const img = createFloatImage(2, 1);
    img.data.set([0, 0, 0, 0, 1, 1, 1, 1]);
    const out = new Float32Array(4);
    sampleBilinear(img, 1, 0.5, out, 0, 'clamp');
    expect(Array.from(out)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('filters', () => {
  it('gaussian blur preserves mass away from edges', () => {
    const plane = new Float32Array(41 * 41);
    plane[20 * 41 + 20] = 1;
    gaussianBlur(plane, 41, 41, 1, 3);
    expect(plane.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    expect(plane[20 * 41 + 20]).toBeLessThan(0.1);
    const small = new Float32Array(21 * 21);
    small[10 * 21 + 10] = 1;
    gaussianBlur(small, 21, 21, 1, 0.8);
    expect(small.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('distance transform is euclidean', () => {
    const d = distanceTransform(10, 10, (i) => i === 0);
    expect(d[0]).toBe(0);
    expect(d[3 * 10 + 4]).toBeCloseTo(5, 6);
  });

  it('dilate and erode by whole pixels', () => {
    const w = 20;
    const plane = new Float32Array(w * w);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) plane[y * w + x] = 1;
    const grown = dilate(plane, w, w, 2);
    expect(grown[10 * w + 6]).toBe(1);
    expect(grown[10 * w + 5]).toBe(0);
    const shrunk = erode(plane, w, w, 1);
    expect(shrunk[9 * w + 9]).toBe(1);
    expect(shrunk[8 * w + 9]).toBe(0);
  });

  it('unsharp mask increases edge contrast without leaving valid ranges', () => {
    const s = new Surface(8, 8);
    s.fill(80, 80, 80, 255);
    s.fill(170, 170, 170, 255, { x: 4, y: 0, w: 4, h: 8 });
    const img = unsharpMask(surfaceToFloat(s), { amount: 1, radius: 1 });
    const out = floatToSurface(img);
    expect(out.getPixel(3, 4)[0]).toBeLessThan(80);
    expect(out.getPixel(4, 4)[0]).toBeGreaterThan(170);
    for (let i = 0; i < img.data.length; i += 4) expect(img.data[i]).toBeLessThanOrEqual(img.data[i + 3]);
  });

  it('averages 1/3/5 px eyedropper squares', () => {
    const s = new Surface(5, 5);
    s.fill(255, 0, 0, 255);
    s.setPixel(2, 2, 0, 0, 255, 255);
    expect(averageColor(s, 2, 2, 1)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
    const avg = averageColor(s, 2, 2, 3);
    expect(Math.round(avg.r)).toBe(Math.round((255 * 8) / 9));
    expect(averageColor(s, 0, 0, 5).a).toBe(1);
  });

  it('blits source-over with opacity and clipping', () => {
    const dst = new Surface(4, 4);
    dst.fill(0, 0, 255, 255);
    const src = new Surface(2, 2);
    src.fill(255, 0, 0, 255);
    expect(blitOver(dst, src, 3, -1, 0.6)).toEqual({ x: 3, y: 0, w: 1, h: 1 });
    expect(dst.getPixel(3, 0)).toEqual([153, 0, 102, 255]);
    expect(dst.getPixel(2, 0)).toEqual([0, 0, 255, 255]);
    const clear = new Surface(2, 2);
    blitOver(clear, src, 0, 0, 0.5);
    expect(clear.getPixel(0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('tracks dirty regions', () => {
    const d = new DirtyRegion(10, 10);
    d.add({ x: -5, y: 2, w: 7, h: 2 });
    d.add({ x: 8, y: 8, w: 5, h: 5 });
    expect(d.take()).toEqual({ x: 0, y: 2, w: 10, h: 8 });
    expect(d.isEmpty).toBe(true);
  });
});
