// Turning external pixels into layers: wrap RGBA/ImageData as surfaces, and
// fit + centre an image into the square document with optional padding.

import type { Doc, RasterLayer } from '../doc/types';
import { createRasterLayer } from '../doc/document';
import { Surface } from '../raster/surface';
import { floatToSurface, surfaceToFloat } from '../raster/float-image';
import type { FloatImage } from '../raster/float-image';
import { downsampleStepwise, padCentered, resize, resizeNearest } from '../raster/resample';

/** Copies straight RGBA8 bytes into a new surface. */
export function surfaceFromRgba(
  data: ArrayLike<number> | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Surface {
  return Surface.fromRgba(width, height, data);
}

/** Anything shaped like DOM ImageData (straight alpha). */
export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function surfaceFromImageData(img: ImageDataLike): Surface {
  return Surface.fromRgba(img.width, img.height, img.data);
}

export type ImportResample = 'auto' | 'smooth' | 'nearest';

export interface FitOptions {
  /** Target square size (default: 512). */
  size?: number;
  /** Transparent margin on each side, px of the target (default 0). */
  padding?: number;
  /** 'contain' fits inside (letterboxed); 'cover' fills and crops. */
  fit?: 'contain' | 'cover';
  /** Allow enlarging small images (default true). */
  allowUpscale?: boolean;
  /**
   * Upscaling filter. 'auto' keeps small sources (≤ 64 px, e.g. a 32 px
   * icon frame) pixel-crisp with nearest-neighbour when enlarged ≥ 2×, and
   * uses bilinear otherwise. Downscaling always uses stepwise area
   * resampling.
   */
  resample?: ImportResample;
  /** Crop fully transparent borders before fitting (default false). */
  trim?: boolean;
}

/** Fits `src` into a size×size transparent square, centred. */
export function fitAndCenter(src: Surface, opts: FitOptions = {}): Surface {
  const size = opts.size ?? 512;
  const pad = Math.max(0, Math.min(size / 2 - 1, opts.padding ?? 0));
  let source = src;
  if (opts.trim) {
    const b = src.alphaBounds();
    if (b && (b.w !== src.width || b.h !== src.height)) {
      source = new Surface(b.w, b.h);
      source.copyFrom(src, b, 0, 0);
    }
  }
  const box = size - 2 * pad;
  const sx = box / source.width;
  const sy = box / source.height;
  let scale = opts.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  if (opts.allowUpscale === false) scale = Math.min(scale, 1);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const img = surfaceToFloat(source);
  let scaled: FloatImage;
  if (w === source.width && h === source.height) scaled = img;
  else if (scale < 1) scaled = downsampleStepwise(img, w, h);
  else {
    const mode = opts.resample ?? 'auto';
    const nearest = mode === 'nearest' || (mode === 'auto' && Math.max(source.width, source.height) <= 64 && scale >= 2);
    scaled = nearest ? resizeNearest(img, w, h) : resize(img, w, h);
  }
  return floatToSurface(padCentered(scaled, size, size));
}

/** A new raster layer (not inserted) holding `src` fitted to the document. */
export function importLayer(doc: Doc, src: Surface, name: string, opts: Omit<FitOptions, 'size'> = {}): RasterLayer {
  const surface =
    src.width === doc.width && src.height === doc.height && !opts.trim && !opts.padding
      ? src.clone()
      : fitAndCenter(src, { ...opts, size: doc.width });
  return createRasterLayer(doc, { name, surface });
}

/** Index of the frame to use as a design source: the largest (ties: first). */
export function bestFrameIndex(frames: readonly { width: number; height: number }[]): number {
  let best = -1;
  let area = -1;
  frames.forEach((f, i) => {
    const a = f.width * f.height;
    if (a > area) {
      area = a;
      best = i;
    }
  });
  return best;
}
