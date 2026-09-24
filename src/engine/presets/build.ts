/**
 * Building and previewing presets: icon → analysis → layer stack, and a
 * layer stack → one composited image (the engine's reference compositor,
 * so thumbnails show exactly what applying the preset produces).
 */
import { createRasterLayer } from '../doc/document';
import { cloneEffects } from '../doc/effects';
import type { Doc } from '../doc/types';
import type { Pixels } from '../filters/types';
import { floatToSurface } from '../raster/float-image';
import { Surface } from '../raster/surface';
import { compositeDocument } from '../render/compositor';
import { analyzeIcon, type IconAnalysis } from './icon';
import { buildFromAnalysis } from './presets';
import type { PresetId, PresetOptions, PresetResult } from './types';

/** Builds a preset from any icon image (analysis included). */
export function buildPreset(id: PresetId, icon: Pixels, size: number, options: Partial<PresetOptions> = {}, analysis?: IconAnalysis): PresetResult {
  return buildFromAnalysis(id, analysis ?? analyzeIcon(icon), size, options);
}

/** A detached document holding a preset's layers (pixels are copied). */
export function presetDocument(result: PresetResult): Doc {
  const doc: Doc = {
    width: result.size,
    height: result.size,
    pixelArt: null,
    layers: [],
    activeLayerId: null,
    selection: null,
    meta: { name: result.id, source: null, createdAt: 0 },
    seq: 0,
  };
  doc.layers = result.layers.map((l) =>
    createRasterLayer(doc, {
      name: l.name,
      opacity: l.opacity,
      blend: l.blend,
      effects: cloneEffects(l.effects),
      surface: new Surface(result.size, result.size, new Uint8ClampedArray(l.pixels.data)),
    }),
  );
  doc.activeLayerId = doc.layers[result.iconIndex]?.id ?? doc.layers[0]?.id ?? null;
  return doc;
}

/** The preset's final look as one straight-alpha image. */
export function compositePreset(result: PresetResult): Pixels {
  const s = floatToSurface(compositeDocument(presetDocument(result)));
  return { width: s.width, height: s.height, data: s.data };
}
