/**
 * Putting a preset (or any prepared layer stack) into an Engine as ONE
 * undoable step.
 *
 * The engine has no public "replace the layer stack" operation, so this
 * records a `StackCommand` (the same command the engine's own layer ops
 * use) and then runs it through the engine's undo/redo, which applies it and
 * announces every change (layers, pixels, history) to listeners exactly as
 * any other edit. Pending tool work and inline text editing are settled
 * first so nothing else can slip in between.
 */
import type { Engine } from '../engine';
import { createRasterLayer, getLayer, layerPixels } from '../doc/document';
import { cloneEffects } from '../doc/effects';
import type { Layer, RasterLayer } from '../doc/types';
import type { Pixels } from '../filters/types';
import { captureStack, StackCommand } from '../history/commands';
import { Surface } from '../raster/surface';
import { buildPreset } from './build';
import { getPreset } from './presets';
import type { PresetId, PresetOptions, PresetResult } from './types';

/**
 * Replaces the document's layer list (bottom → top) and active layer as one
 * history entry labelled `label`. Layers must match the document size.
 */
export function commitLayerStack(engine: Engine, label: string, layers: Layer[], activeLayerId: string | null): void {
  const doc = engine.doc;
  if (layers.length === 0) throw new RangeError('a document needs at least one layer');
  for (const l of layers) {
    const px = layerPixels(l);
    if (l.kind === 'raster' && px && (px.width !== doc.width || px.height !== doc.height)) {
      throw new RangeError(`layer "${l.name}" does not match the document size`);
    }
  }
  engine.endTextEdit();
  engine.commitPending();
  const cmd = new StackCommand(label, captureStack(doc), { layers: layers.slice(), activeLayerId });
  // Recorded as the newest entry, then applied by redo so listeners hear it.
  engine.history.push(cmd);
  engine.undo();
  engine.redo();
}

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
  commitLayerStack(engine, label, layers, activate ? layer.id : doc.activeLayerId);
  return layer.id;
}

/**
 * Replaces the whole design with a built preset (one history entry).
 * Returns the id of the preset's icon layer, which becomes active.
 */
export function applyPresetResult(engine: Engine, result: PresetResult, label = `Style: ${getPreset(result.id).label}`): string {
  const doc = engine.doc;
  if (result.size !== doc.width || result.size !== doc.height) {
    throw new RangeError(`preset was built at ${result.size} px for a ${doc.width} px document`);
  }
  const layers = result.layers.map((l) => makeRasterLayer(engine, l.name, l.pixels, l));
  const icon = layers[result.iconIndex] ?? layers[layers.length - 1]!;
  commitLayerStack(engine, label, layers, icon.id);
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
