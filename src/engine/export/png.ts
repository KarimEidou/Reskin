// Pure-TS PNG encoder: 8-bit RGBA (colour type 6, straight alpha), one
// IDAT, zlib via the Compression Streams API, CRC-32 per chunk. Each
// scanline picks the filter (None/Sub/Up/Average/Paeth) with the smallest
// sum of absolute signed bytes — the standard libpng heuristic — which
// compresses icons well.

import { crc32 } from './crc32';
import { deflate } from '../util/compress';
import { encodeBase64 } from '../util/base64';
import type { Surface } from '../raster/surface';

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export type PngFilterMode = 'adaptive' | 'none';

export interface PngEncodeOptions {
  filter?: PngFilterMode;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Filters raw RGBA rows into the PNG scanline format (filter byte + row). */
export function filterScanlines(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: PngFilterMode = 'adaptive',
): Uint8Array<ArrayBuffer> {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const cand = mode === 'adaptive' ? [0, 1, 2, 3, 4].map(() => new Uint8Array(stride)) : [];
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    const o = y * (stride + 1);
    if (mode === 'none') {
      out[o] = 0;
      out.set(rgba.subarray(row, row + stride), o + 1);
      continue;
    }
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgba[row + i];
        const a = i >= 4 ? rgba[row + i - 4] : 0;
        const b = prev >= 0 ? rgba[prev + i] : 0;
        const c = prev >= 0 && i >= 4 ? rgba[prev + i - 4] : 0;
        let v: number;
        switch (f) {
          case 0:
            v = x;
            break;
          case 1:
            v = x - a;
            break;
          case 2:
            v = x - b;
            break;
          case 3:
            v = x - ((a + b) >> 1);
            break;
          default:
            v = x - paeth(a, b, c);
        }
        v &= 0xff;
        buf[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[o] = best;
    out.set(cand[best], o + 1);
  }
  return out;
}

function writeU32(buf: Uint8Array, o: number, v: number): void {
  buf[o] = (v >>> 24) & 0xff;
  buf[o + 1] = (v >>> 16) & 0xff;
  buf[o + 2] = (v >>> 8) & 0xff;
  buf[o + 3] = v & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encodes straight-alpha RGBA8 pixels as a PNG file. */
export async function encodePng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: PngEncodeOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid PNG size ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) throw new RangeError('Pixel buffer does not match the PNG size');
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = await deflate(filterScanlines(rgba, width, height, opts.filter ?? 'adaptive'));
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function encodeSurfacePng(s: Surface, opts?: PngEncodeOptions): Promise<Uint8Array<ArrayBuffer>> {
  return encodePng(s.data, s.width, s.height, opts);
}

/** Base64 PNG (no `data:` prefix) — the IPC image format. */
export async function surfaceToPngBase64(s: Surface, opts?: PngEncodeOptions): Promise<string> {
  return encodeBase64(await encodeSurfacePng(s, opts));
}

/** `data:image/png;base64,…` for <img> previews. */
export async function surfaceToPngDataUrl(s: Surface, opts?: PngEncodeOptions): Promise<string> {
  return `data:image/png;base64,${await surfaceToPngBase64(s, opts)}`;
}
