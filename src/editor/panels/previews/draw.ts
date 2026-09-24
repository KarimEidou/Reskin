// Drawing rendered icon sizes onto preview canvases.

import type { Pixels } from '$engine/filters/types';
import { pickSize } from './desktop';

export type Rendered = ReadonlyMap<number, Pixels>;

const bitmaps = new WeakMap<Pixels, HTMLCanvasElement>();

/** A canvas holding the pixels (cached per image), for drawImage compositing. */
function asCanvas(p: Pixels): HTMLCanvasElement {
  let c = bitmaps.get(p);
  if (!c) {
    c = document.createElement('canvas');
    c.width = p.width;
    c.height = p.height;
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
    bitmaps.set(p, c);
  }
  return c;
}

/**
 * Draws the icon at `size` device px with its top-left at (x, y) device px
 * (no transform on `ctx`): the exact export size 1:1 when rendered, else
 * the next larger one scaled down, as Windows does.
 */
export function drawIcon(ctx: CanvasRenderingContext2D, rendered: Rendered, size: number, x: number, y: number): boolean {
  const pick = pickSize([...rendered.keys()], size);
  if (pick === null) return false;
  const px = rendered.get(pick)!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(asCanvas(px), Math.round(x), Math.round(y), size, size);
  ctx.restore();
  return true;
}
