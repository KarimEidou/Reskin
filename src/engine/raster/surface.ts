// Surface: an 8-bit RGBA bitmap with STRAIGHT (non-premultiplied) alpha.
//
// Why straight alpha for storage:
// - it is what ImageData, PNG and the IPC contract (`SizedPng`) use, so
//   layers can be uploaded to a canvas with zero copies and exported without
//   a lossy conversion;
// - 8-bit premultiplied storage would quantise the colour of faint pixels
//   (an alpha=2 pixel could only hold 3 colour levels), making repeated
//   edits and undo round-trips drift.
//
// All filtering maths (compositing, resampling, blurring) instead runs on
// premultiplied Float32 `FloatImage`s (see ./float-image.ts); conversions
// happen only at those boundaries.

import type { Rect } from '../util/rect';
import { clipRect, fullRect } from '../util/rect';

export type Pixels = Uint8ClampedArray<ArrayBuffer>;

export class Surface {
  readonly width: number;
  readonly height: number;
  /** RGBA, straight alpha, row-major, `width * height * 4` bytes. */
  readonly data: Pixels;

  constructor(width: number, height: number, data?: Pixels) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`Invalid surface size ${width}x${height}`);
    }
    const len = width * height * 4;
    if (data && data.length !== len) {
      throw new RangeError(`Pixel buffer has ${data.length} bytes, expected ${len}`);
    }
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(len);
  }

  /** Copies arbitrary RGBA bytes into a new surface. */
  static fromRgba(
    width: number,
    height: number,
    rgba: ArrayLike<number> | Uint8Array | Uint8ClampedArray,
  ): Surface {
    const s = new Surface(width, height);
    if (rgba.length !== s.data.length) {
      throw new RangeError(`Pixel buffer has ${rgba.length} bytes, expected ${s.data.length}`);
    }
    s.data.set(rgba);
    return s;
  }

  get byteLength(): number {
    return this.data.length;
  }

  get bounds(): Rect {
    return fullRect(this.width, this.height);
  }

  clone(): Surface {
    return new Surface(this.width, this.height, this.data.slice());
  }

  index(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Returns [r, g, b, a] (0..255) or transparent black outside the surface. */
  getPixel(x: number, y: number): [number, number, number, number] {
    if (!this.inBounds(x, y)) return [0, 0, 0, 0];
    const i = this.index(x, y);
    const d = this.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  setPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    const d = this.data;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }

  /** Fills `rect` (default: everything) with an RGBA8 colour. */
  fill(r: number, g: number, b: number, a: number, area?: Rect): void {
    const c = clipRect(area ?? this.bounds, this.width, this.height);
    if (!c) return;
    const d = this.data;
    for (let y = c.y; y < c.y + c.h; y++) {
      let i = (y * this.width + c.x) * 4;
      for (let x = 0; x < c.w; x++, i += 4) {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = a;
      }
    }
  }

  clear(area?: Rect): void {
    if (!area) {
      this.data.fill(0);
      return;
    }
    this.fill(0, 0, 0, 0, area);
  }

  /** Copies the pixels of `area` (clipped) into a new tightly packed buffer. */
  readRect(area: Rect): Pixels {
    const c = clipRect(area, this.width, this.height);
    if (!c) return new Uint8ClampedArray(0);
    const out = new Uint8ClampedArray(c.w * c.h * 4);
    const row = c.w * 4;
    for (let y = 0; y < c.h; y++) {
      const s = ((c.y + y) * this.width + c.x) * 4;
      out.set(this.data.subarray(s, s + row), y * row);
    }
    return out;
  }

  /** Writes a tightly packed `area.w * area.h * 4` buffer at `area` (must be in bounds). */
  writeRect(area: Rect, pixels: Uint8ClampedArray): void {
    if (area.x < 0 || area.y < 0 || area.x + area.w > this.width || area.y + area.h > this.height) {
      throw new RangeError('writeRect area out of bounds');
    }
    const row = area.w * 4;
    for (let y = 0; y < area.h; y++) {
      const d = ((area.y + y) * this.width + area.x) * 4;
      this.data.set(pixels.subarray(y * row, y * row + row), d);
    }
  }

  /** Raw copy (no blending) of `src` pixels in `srcRect` to (dx, dy). Clipped. */
  copyFrom(src: Surface, srcRect: Rect = src.bounds, dx = srcRect.x, dy = srcRect.y): void {
    let sx = srcRect.x;
    let sy = srcRect.y;
    let w = srcRect.w;
    let h = srcRect.h;
    // Clip against the source.
    if (sx < 0) { dx -= sx; w += sx; sx = 0; }
    if (sy < 0) { dy -= sy; h += sy; sy = 0; }
    w = Math.min(w, src.width - sx);
    h = Math.min(h, src.height - sy);
    // Clip against the destination.
    if (dx < 0) { sx -= dx; w += dx; dx = 0; }
    if (dy < 0) { sy -= dy; h += dy; dy = 0; }
    w = Math.min(w, this.width - dx);
    h = Math.min(h, this.height - dy);
    if (w <= 0 || h <= 0) return;
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const s = ((sy + y) * src.width + sx) * 4;
      this.data.set(src.data.subarray(s, s + row), ((dy + y) * this.width + dx) * 4);
    }
  }

  equals(other: Surface): boolean {
    if (other.width !== this.width || other.height !== this.height) return false;
    const a = this.data;
    const b = other.data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Tight bounds of pixels with alpha > `threshold`, or null when none. */
  alphaBounds(threshold = 0): Rect | null {
    const { width: w, height: h, data: d } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      let i = y * w * 4 + 3;
      for (let x = 0; x < w; x++, i += 4) {
        if (d[i] > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** True when every pixel is fully transparent. */
  isTransparent(): boolean {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }
}
