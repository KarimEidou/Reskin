/**
 * The engine's shared pixel type and the small helpers every image function
 * builds on.
 *
 * Conventions (all of src/engine/filters, helpers and backdrop follow them):
 * - `Pixels` is RGBA8, **straight** (non-premultiplied) alpha, row-major,
 *   top-down; `data.length === width * height * 4`.
 * - Functions are pure: they never mutate their inputs and return a new
 *   `Pixels`, or write into an optional `out` image of the same size (which
 *   may alias the input).
 * - A `Mask` is one byte per pixel (0 = untouched, 255 = fully affected);
 *   results are blended with the original by mask coverage.
 */

/** RGBA8, straight alpha, row-major, top-down. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Selection / coverage mask: one byte per pixel (0..255), same size as the image. */
export type Mask = Uint8Array;

/** Integer pixel rectangle; `x`/`y` may be negative when it extends past the image. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assertDims(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
}

/** A new, fully transparent image (or one wrapping `data`, which must be `width*height*4` bytes). */
export function createPixels(width: number, height: number, data?: Uint8ClampedArray): Pixels {
  assertDims(width, height);
  const len = width * height * 4;
  if (data && data.length !== len) {
    throw new RangeError(`pixel buffer is ${data.length} bytes, expected ${len} for ${width}x${height}`);
  }
  return { width, height, data: data ?? new Uint8ClampedArray(len) };
}

/** Builds an image from a flat RGBA list (handy for fixtures). */
export function pixelsFrom(width: number, height: number, rgba: ArrayLike<number>): Pixels {
  const p = createPixels(width, height);
  if (rgba.length !== p.data.length) {
    throw new RangeError(`expected ${p.data.length} values for ${width}x${height}, got ${rgba.length}`);
  }
  for (let i = 0; i < rgba.length; i++) p.data[i] = rgba[i];
  return p;
}

/** A solid-colour image. */
export function solidPixels(width: number, height: number, r: number, g: number, b: number, a = 255): Pixels {
  const p = createPixels(width, height);
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
  return p;
}

/** A deep copy. */
export function clonePixels(src: Pixels): Pixels {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

/** Throws a RangeError unless `p` is a well-formed image. */
export function assertPixels(p: Pixels, name = 'pixels'): void {
  if (!p || !(p.data instanceof Uint8ClampedArray)) throw new TypeError(`${name}: data must be a Uint8ClampedArray`);
  assertDims(p.width, p.height);
  if (p.data.length !== p.width * p.height * 4) {
    throw new RangeError(`${name}: buffer is ${p.data.length} bytes, expected ${p.width * p.height * 4}`);
  }
}

/** Throws a RangeError unless `mask` is absent or has one byte per pixel. */
export function assertMask(mask: Mask | null | undefined, width: number, height: number): void {
  if (mask == null) return;
  if (!(mask instanceof Uint8Array)) throw new TypeError('mask must be a Uint8Array');
  if (mask.length !== width * height) {
    throw new RangeError(`mask has ${mask.length} entries, expected ${width * height} for ${width}x${height}`);
  }
}

/** True when both images have the same dimensions. */
export function sameSize(a: Pixels, b: Pixels): boolean {
  return a.width === b.width && a.height === b.height;
}

/** True when two images share (any part of) the same backing buffer. */
export function aliases(a: Pixels, b: Pixels): boolean {
  if (a.data.buffer !== b.data.buffer) return false;
  const a0 = a.data.byteOffset;
  const b0 = b.data.byteOffset;
  return a0 < b0 + b.data.byteLength && b0 < a0 + a.data.byteLength;
}
