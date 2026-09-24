import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { Buffer } from 'node:buffer';
import { crc32 } from './crc32';
import { encodePng, filterScanlines, PNG_SIGNATURE } from './png';
import { DEFAULT_ICO_SIZES, normalizeSizes, planExport } from './plan';
import { exportPng, renderSizes, toSizedPngs } from './export';
import { createDocument } from '../doc/document';
import type { RasterLayer } from '../doc/types';
import { decodeBase64 } from '../util/base64';
import { alphaSum, seededRandom } from '../test-helpers';

function decode(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes));
}

function randomRgba(w: number, h: number, seed: number): Uint8ClampedArray {
  const r = seededRandom(seed);
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256);
  return d;
}

/** Splits a PNG into chunks, checking lengths and CRCs. */
function chunks(png: Uint8Array): { type: string; length: number; crcOk: boolean }[] {
  expect(Array.from(png.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  let o = 8;
  while (o < png.length) {
    const length = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const stored = view.getUint32(o + 8 + length);
    out.push({ type, length, crcOk: crc32(png, o + 4, o + 8 + length) === stored });
    o += 12 + length;
  }
  return out;
}

describe('crc32', () => {
  it('matches known values', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('PNG encoder', () => {
  it('produces files pngjs decodes to the same pixels (both filter modes)', async () => {
    for (const [w, h, seed] of [
      [1, 1, 1],
      [17, 13, 2],
      [64, 3, 3],
    ] as const) {
      const rgba = randomRgba(w, h, seed);
      for (const filter of ['adaptive', 'none'] as const) {
        const png = await encodePng(rgba, w, h, { filter });
        const img = decode(png);
        expect([img.width, img.height]).toEqual([w, h]);
        expect(Uint8Array.from(img.data)).toEqual(Uint8Array.from(rgba));
      }
    }
  });

  it('writes IHDR/IDAT/IEND with valid CRCs', async () => {
    const png = await encodePng(randomRgba(10, 10, 4), 10, 10);
    const c = chunks(png);
    expect(c.map((x) => x.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(c.every((x) => x.crcOk)).toBe(true);
    expect(c[0].length).toBe(13);
    expect(png[8 + 8 + 8]).toBe(8); // bit depth
    expect(png[8 + 8 + 9]).toBe(6); // RGBA
  });

  it('adaptive filtering picks Sub for horizontal gradients', () => {
    const w = 32;
    const rgba = new Uint8ClampedArray(w * 2 * 4);
    for (let i = 0; i < w * 2; i++) rgba.set([(i % w) * 8, 0, 0, 255], i * 4);
    const f = filterScanlines(rgba, w, 2);
    expect(f[0]).toBe(1);
  });

  it('rejects mismatched buffers', async () => {
    await expect(encodePng(new Uint8Array(3), 1, 1)).rejects.toThrow(RangeError);
  });
});

describe('export size plan', () => {
  it('halves to the nearest larger power-of-two step, then area-resamples', () => {
    const plan = planExport(512, DEFAULT_ICO_SIZES, { pixelArt: false });
    expect(plan.map((p) => p.size)).toEqual([...DEFAULT_ICO_SIZES]);
    const bySize = new Map(plan.map((p) => [p.size, p]));
    expect(bySize.get(256)).toMatchObject({ kind: 'smooth', halvings: [256], finalResample: false, sharpen: false });
    expect(bySize.get(48)).toMatchObject({ halvings: [256, 128, 64], finalResample: true });
    expect(bySize.get(20)).toMatchObject({ halvings: [256, 128, 64, 32], finalResample: true, sharpen: true });
    expect(bySize.get(16)).toMatchObject({ halvings: [256, 128, 64, 32, 16], finalResample: false, sharpen: true });
    expect(bySize.get(40)).toMatchObject({ sharpen: false });
  });

  it('plans integer nearest scaling with centring for pixel art', () => {
    const plan = planExport(32, [16, 20, 32, 40, 48, 64, 96, 256], { pixelArt: true });
    const s = (n: number) => plan.find((p) => p.size === n)!;
    expect(s(16)).toMatchObject({ kind: 'pixel', factor: 0.5, content: 16, offset: 0 });
    expect(s(20)).toMatchObject({ factor: 0.5, content: 16, offset: 2 });
    expect(s(32)).toMatchObject({ factor: 1, content: 32, offset: 0 });
    expect(s(40)).toMatchObject({ factor: 1, content: 32, offset: 4 });
    expect(s(96)).toMatchObject({ factor: 3, content: 96, offset: 0 });
    expect(s(256)).toMatchObject({ factor: 8, content: 256 });
  });

  it('validates and de-duplicates sizes', () => {
    expect(normalizeSizes([32, 16, 32])).toEqual([16, 32]);
    expect(() => normalizeSizes([0])).toThrow(RangeError);
    expect(() => normalizeSizes([12.5])).toThrow(RangeError);
  });
});

describe('rendering sizes', () => {
  function circleDoc() {
    const doc = createDocument();
    const s = (doc.layers[0] as RasterLayer).surface;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const d = Math.hypot(x + 0.5 - 256, y + 0.5 - 256);
        if (d < 200) s.setPixel(x, y, 124, 92, 255, 255);
      }
    }
    return doc;
  }

  it('produces every size, correctly sized and non-empty', () => {
    const out = renderSizes(circleDoc(), DEFAULT_ICO_SIZES);
    expect(out.map((o) => o.size)).toEqual([...DEFAULT_ICO_SIZES]);
    for (const { size, surface } of out) {
      expect([surface.width, surface.height]).toEqual([size, size]);
      expect(alphaSum(surface)).toBeGreaterThan(0);
      // The centre stays the design colour; corners stay transparent.
      const c = surface.getPixel(size >> 1, size >> 1);
      expect(c[3]).toBe(255);
      expect(Math.abs(c[0] - 124)).toBeLessThanOrEqual(2);
      expect(surface.getPixel(0, 0)[3]).toBe(0);
    }
    // Coverage scales with area (≈ π·(200/512·size)²).
    const s64 = out.find((o) => o.size === 64)!.surface;
    const expected = Math.PI * (200 / 8) ** 2 * 255;
    expect(Math.abs(alphaSum(s64) - expected) / expected).toBeLessThan(0.02);
  });

  it('empty designs export transparent images', () => {
    const out = renderSizes(createDocument(), [16, 256]);
    expect(out.every((o) => alphaSum(o.surface) === 0)).toBe(true);
  });

  it('pixel-art export is nearest-neighbour and centred', () => {
    const doc = createDocument({ pixelArt: 16 });
    const s = (doc.layers[0] as RasterLayer).surface;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x + y) % 2 === 0) s.setPixel(x, y, 255, 255, 0, 255);
    const out = new Map(renderSizes(doc, [16, 32, 40, 256]).map((o) => [o.size, o.surface]));
    const x2 = out.get(32)!;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) expect(x2.getPixel(x, y)).toEqual(s.getPixel(x >> 1, y >> 1));
    }
    const x40 = out.get(40)!;
    expect(x40.alphaBounds()).toEqual({ x: 4, y: 4, w: 32, h: 32 });
    expect(x40.getPixel(4, 4)).toEqual([255, 255, 0, 255]);
    expect(out.get(16)!.equals(s)).toBe(true);
    const big = out.get(256)!;
    expect(big.getPixel(16 * 3 + 15, 16 * 5 + 15)).toEqual(s.getPixel(3, 5));
    // No intermediate values: every alpha is 0 or 255.
    for (let i = 3; i < big.data.length; i += 4) expect(big.data[i] === 0 || big.data[i] === 255).toBe(true);
  });

  it('toSizedPngs returns base64 PNGs that decode to the rendered pixels', async () => {
    const doc = circleDoc();
    const sizes = [16, 48, 256];
    const pngs = await toSizedPngs(doc, sizes);
    const rendered = renderSizes(doc, sizes);
    expect(pngs.map((p) => p.size)).toEqual(sizes);
    pngs.forEach((p, i) => {
      const img = decode(decodeBase64(p.png));
      expect([img.width, img.height]).toEqual([p.size, p.size]);
      expect(Uint8Array.from(img.data)).toEqual(Uint8Array.from(rendered[i].surface.data));
    });
    const single = await exportPng(doc, 100);
    expect(decode(decodeBase64(single.png)).width).toBe(100);
  });
});
