/**
 * Fixture helpers for the engine's unit tests (filters, helpers, backdrop).
 * Not used by application code.
 */
import { mulberry32 } from './prng';
import { createPixels, type Pixels } from './types';

export type Px = [number, number, number, number];

/** Builds an image from a per-pixel function. */
export function makePixels(width: number, height: number, fn: (x: number, y: number) => Px): Pixels {
  const p = createPixels(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = a;
    }
  }
  return p;
}

/** Deterministic random RGBA (alpha random too unless `opaque`). */
export function randomPixels(width: number, height: number, seed = 1, opaque = false): Pixels {
  const rand = mulberry32(seed);
  return makePixels(width, height, () => [
    Math.floor(rand() * 256),
    Math.floor(rand() * 256),
    Math.floor(rand() * 256),
    opaque ? 255 : Math.floor(rand() * 256),
  ]);
}

/** The RGBA of one pixel. */
export function pixelAt(p: Pixels, x: number, y: number): Px {
  const i = (y * p.width + x) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
}

/** Sum of alpha / 255 (total coverage). */
export function alphaMass(p: Pixels): number {
  let s = 0;
  for (let i = 3; i < p.data.length; i += 4) s += p.data[i];
  return s / 255;
}

/** Sum of premultiplied channel c (0..2) / 255. */
export function premulMass(p: Pixels, c: number): number {
  let s = 0;
  for (let i = 0; i < p.data.length; i += 4) s += (p.data[i + c] * p.data[i + 3]) / 255;
  return s / 255;
}

/** Largest absolute per-channel difference between two same-size images. */
export function maxDiff(a: Pixels, b: Pixels): number {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > m) m = d;
  }
  return m;
}

/** A mask filled by a per-pixel function. */
export function makeMask(width: number, height: number, fn: (x: number, y: number) => number): Uint8Array {
  const m = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) m[y * width + x] = fn(x, y);
  return m;
}
