/**
 * Putting a preset (or any prepared layer) into an Engine as ONE undoable
 * step, through `Engine.replaceLayers`.
 */
import type { Engine } from '../engine';
import { createRasterLayer, getLayer, layerPixels } from '../doc/document';
import { cloneEffects } from '../doc/effects';
import type { Layer, RasterLayer } from '../doc/types';
import type { Pixels } from '../filters/types';
import { Surface } from '../raster/surface';
import { buildPreset } from './build';
import { getPreset } from './presets';
import type { PresetId, PresetOptions, PresetResult } from './types';

/** A new raster layer for the engine's document from straight RGBA pixels. */
export function makeRasterLayer(
  engine: Engine,
  name: string,
  pixels: Pixels,
  props: { opacity?: number; blend?: RasterLayer['blend']; effects?: RasterLayer['effects'] } = {},
): RasterLayer {
  const doc = engine.doc;
  return createRasterLayer(doc, {
    name,
    opacity: props.opacity ?? 1,
    blend: props.blend ?? 'normal',
    effects: cloneEffects(props.effects ?? []),
    surface: new Surface(doc.width, doc.height, new Uint8ClampedArray(pixels.data)),
  });
}

/**
 * Inserts one layer at `index` (bottom = 0; default above the active layer)
 * as one history entry. Returns the new layer's id.
 */
export function insertLayer(engine: Engine, label: string, layer: Layer, index?: number, activate = true): string {
  const doc = engine.doc;
  const active = doc.activeLayerId ? doc.layers.findIndex((l) => l.id === doc.activeLayerId) : -1;
  const at = Math.max(0, Math.min(doc.layers.length, index ?? active + 1));
  const layers = doc.layers.slice();
  layers.splice(at, 0, layer);
  engine.replaceLayers(layers, { label, activeLayerId: activate ? layer.id : doc.activeLayerId });
  return layer.id;
}

export interface ApplyPresetOptions {
  /** History label (default "Style: <preset>"). */
  label?: string;
  /**
   * Merge key: applying again with the same key while the look is still the
   * latest change replaces it in place, as the same single step (see
   * Engine.replaceLayers).
   */
  mergeKey?: string;
}

/**
 * Replaces the whole design with a built preset (one history entry).
 * Returns the id of the preset's icon layer, which becomes active.
 */
export function applyPresetResult(engine: Engine, result: PresetResult, opts: ApplyPresetOptions = {}): string {
  const doc = engine.doc;
  if (result.size !== doc.width || result.size !== doc.height) {
    throw new RangeError(`preset was built at ${result.size} px for a ${doc.width} px document`);
  }
  const layers = result.layers.map((l) => makeRasterLayer(engine, l.name, l.pixels, l));
  const icon = layers[result.iconIndex] ?? layers[layers.length - 1]!;
  engine.replaceLayers(layers, {
    label: opts.label ?? `Style: ${getPreset(result.id).label}`,
    activeLayerId: icon.id,
    ...(opts.mergeKey === undefined ? {} : { mergeKey: opts.mergeKey, mergeWindowMs: Infinity }),
  });
  return icon.id;
}

/** Straight RGBA copy of a layer's visible pixels (raster surface or rendered text), or null. */
export function layerImage(engine: Engine, layerId: string): Pixels | null {
  const l = getLayer(engine.doc, layerId);
  const px = l ? layerPixels(l) : null;
  return px ? { width: px.width, height: px.height, data: new Uint8ClampedArray(px.data) } : null;
}

/**
 * Synchronous "build from this layer and apply": what "Apply style to all"
 * replays on every queued icon (the app prefers the worker, see the
 * Styles panel). Returns the new icon layer id, or null without an icon.
 */
export function applyPresetFromLayer(engine: Engine, id: PresetId, iconLayerId: string, options: Partial<PresetOptions> = {}): string | null {
  const icon = layerImage(engine, iconLayerId);
  if (!icon) return null;
  return applyPresetResult(engine, buildPreset(id, icon, engine.doc.width, options));
}
