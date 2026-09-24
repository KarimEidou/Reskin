// Thumbnails for the Layers panel, Library and history (straight RGBA8).
// Downscaling uses stepwise halving + area resampling in premultiplied
// space, so edges stay clean; pixel-art sources upscale crisply.

import type { Doc, Layer } from './types';
import type { Surface } from '../raster/surface';
import { floatToSurface, surfaceToFloat } from '../raster/float-image';
import type { FloatImage } from '../raster/float-image';
import { downsampleStepwise, padCentered, resize, upscaleInteger } from '../raster/resample';
import { compositeDocument } from '../render/compositor';
import type { CompositeOptions } from '../render/compositor';
import { styledLayerImage } from '../render/compositor';

/** Fits a float image into `size`×`size` (aspect kept, centred). */
export function fitFloat(img: FloatImage, size: number, crisp = false): FloatImage {
  const scale = Math.min(size / img.width, size / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  let out: FloatImage;
  if (scale >= 1 && crisp) {
    const k = Math.max(1, Math.floor(scale));
    out = upscaleInteger(img, k);
  } else if (scale < 1) {
    out = downsampleStepwise(img, w, h);
  } else {
    out = resize(img, w, h);
  }
  return out.width === size && out.height === size ? out : padCentered(out, size);
}

export function surfaceThumbnail(src: Surface, size: number, crisp = false): Surface {
  return floatToSurface(fitFloat(surfaceToFloat(src), size, crisp));
}

/** A layer's thumbnail including its effects; null for text not rendered yet. */
export function layerThumbnail(layer: Layer, size: number, crisp = false): Surface | null {
  const img = styledLayerImage(layer);
  return img ? floatToSurface(fitFloat(img, size, crisp)) : null;
}

/** The whole design's thumbnail (visible layers, effects included). */
export function documentThumbnail(doc: Doc, size: number, opts: CompositeOptions = {}): Surface {
  return floatToSurface(fitFloat(compositeDocument(doc, opts), size, doc.pixelArt !== null));
}
