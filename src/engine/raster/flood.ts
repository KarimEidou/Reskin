// Flood fill region selection (paint bucket, and later the magic wand).
//
// Colour distance is the maximum absolute channel difference of the
// PREMULTIPLIED RGBA values (0..255), so every fully transparent pixel
// matches every other one regardless of the invisible colour it stores.
// A pixel matches when distance ≤ tolerance (0 = exact, 255 = everything).
//
// Contiguous mode is a span-based scanline fill (4-connected); global mode
// tests every pixel.

import type { Rect } from '../util/rect';

export interface FloodResult {
  /** 1 for pixels in the region, 0 elsewhere (width·height). */
  mask: Uint8Array;
  bounds: Rect | null;
  count: number;
}

export interface FloodOptions {
  /** 0..255 */
  tolerance: number;
  /** true: only pixels connected to the seed (4-neighbourhood). */
  contiguous: boolean;
}

export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  opts: FloodOptions,
): FloodResult {
  const mask = new Uint8Array(width * height);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return { mask, bounds: null, count: 0 };

  const tol = Math.max(0, Math.min(255, opts.tolerance));
  const s = (sy * width + sx) * 4;
  const sa = data[s + 3];
  const tr = (data[s] * sa) / 255;
  const tg = (data[s + 1] * sa) / 255;
  const tb = (data[s + 2] * sa) / 255;
  // Premultiplied values are compared with a tiny epsilon so integer
  // tolerances behave exactly on opaque pixels despite float rounding.
  const limit = tol + 1e-7;
  const matches = (i: number): boolean => {
    const p = i * 4;
    const a = data[p + 3];
    if (Math.abs(a - sa) > limit) return false;
    const k = a / 255;
    return (
      Math.abs(data[p] * k - tr) <= limit &&
      Math.abs(data[p + 1] * k - tg) <= limit &&
      Math.abs(data[p + 2] * k - tb) <= limit
    );
  };

  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  const mark = (x0: number, x1: number, y: number): void => {
    mask.fill(1, y * width + x0, y * width + x1 + 1);
    count += x1 - x0 + 1;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  if (!opts.contiguous) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (matches(y * width + x)) mark(x, x, y);
      }
    }
  } else {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop() as number;
      const x = stack.pop() as number;
      const row = y * width;
      if (mask[row + x] || !matches(row + x)) continue;
      let x0 = x;
      let x1 = x;
      while (x0 > 0 && !mask[row + x0 - 1] && matches(row + x0 - 1)) x0--;
      while (x1 < width - 1 && !mask[row + x1 + 1] && matches(row + x1 + 1)) x1++;
      mark(x0, x1, y);
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= height) continue;
        const nrow = ny * width;
        let inRun = false;
        for (let nx = x0; nx <= x1; nx++) {
          const ok = !mask[nrow + nx] && matches(nrow + nx);
          if (ok && !inRun) stack.push(nx, ny);
          inRun = ok;
        }
      }
    }
  }
  return {
    mask,
    bounds: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    count,
  };
}
