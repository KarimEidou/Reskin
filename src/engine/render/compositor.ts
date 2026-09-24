// Reference compositor: the source of truth for export, thumbnails and
// "sample composite" tools. Pure JS, premultiplied Float32, over a
// transparent background (or an optional solid backdrop).

import type { Doc, Layer } from '../doc/types';
import { layerPixels } from '../doc/document';
import { hasActiveEffects } from '../doc/effects';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage, floatToSurface, surfaceToFloat } from '../raster/float-image';
import type { Surface } from '../raster/surface';
import type { Rgba } from '../color/color';
import { blendInto, blendStraightInto } from './blend';
import { renderStyledLayer } from './effects';
import type { TextRasterizer } from '../text/text';
import { refreshTextCache } from '../text/text';

export interface CompositeOptions {
  /** Layers to composite, bottom → top (default: all of the document's). */
  layers?: readonly Layer[];
  /** Include hidden layers (default false). */
  includeHidden?: boolean;
  /** Render layer effects (default true). */
  effects?: boolean;
  /** Opaque or translucent colour under everything (default transparent). */
  background?: Rgba | null;
  /** Re-renders stale text caches first when given. */
  textRasterizer?: TextRasterizer | null;
}

/** The image a layer contributes before blending: pixels + effects. */
export function styledLayerImage(layer: Layer, effects = true): FloatImage | null {
  const px = layerPixels(layer);
  if (!px) return null;
  return effects && hasActiveEffects(layer.effects) ? renderStyledLayer(px, layer.effects) : surfaceToFloat(px);
}

/** Blends one layer (with effects) onto a premultiplied accumulator. */
export function compositeLayerInto(acc: FloatImage, layer: Layer, effects = true): void {
  if (layer.opacity <= 0) return;
  const px = layerPixels(layer);
  if (!px) return;
  if (px.width !== acc.width || px.height !== acc.height) {
    throw new RangeError(`Layer "${layer.name}" does not match the document size`);
  }
  if (effects && hasActiveEffects(layer.effects)) {
    blendInto(acc.data, renderStyledLayer(px, layer.effects).data, layer.blend, layer.opacity);
  } else {
    // Fast path: blend the straight 8-bit pixels directly.
    blendStraightInto(acc.data, px.data, layer.blend, layer.opacity);
  }
}

/** Composites the document into a premultiplied float image. */
export function compositeDocument(doc: Doc, opts: CompositeOptions = {}): FloatImage {
  const acc = createFloatImage(doc.width, doc.height);
  if (opts.background && opts.background.a > 0) {
    const bg = opts.background;
    const a = Math.min(1, bg.a);
    const r = (bg.r / 255) * a;
    const g = (bg.g / 255) * a;
    const b = (bg.b / 255) * a;
    const d = acc.data;
    for (let p = 0; p < d.length; p += 4) {
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = a;
    }
  }
  const effects = opts.effects ?? true;
  for (const layer of opts.layers ?? doc.layers) {
    if (!layer.visible && !opts.includeHidden) continue;
    if (layer.kind === 'text') refreshTextCache(layer, doc, opts.textRasterizer ?? null);
    compositeLayerInto(acc, layer, effects);
  }
  return acc;
}

/** Composite as a straight-alpha 8-bit surface. */
export function compositeSurface(doc: Doc, opts: CompositeOptions = {}): Surface {
  return floatToSurface(compositeDocument(doc, opts));
}
