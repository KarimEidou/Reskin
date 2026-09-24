// Undoable document operations. Each function validates, builds a command
// and returns it WITHOUT applying it; apply with `cmd.redo(doc)` and push it
// to a History (the Engine does both). Invalid requests throw `OpError`
// with a user-facing message.

import type { Doc, Layer, LayerProps, PixelGrid, RasterLayer, TextLayer, TextProps } from './types';
import {
  EFFECT_TYPES,
  LAYER_PROP_KEYS,
  MASTER_SIZE,
  MAX_PARAM_PX,
  PIXEL_GRIDS,
  TEXT_PROP_KEYS,
  isBlendMode,
  isPixelGrid,
} from './types';
import {
  cloneLayer,
  createRasterLayer,
  getLayer,
  layerIndex,
  layerNameForText,
  newLayerId,
  normalizeTextProps,
} from './document';
import { normalizeEffect, normalizeEffects, scaleEffect } from './effects';
import type { PropPatch } from '../history/commands';
import {
  DocShapeCommand,
  PropsCommand,
  StackCommand,
  captureShape,
  capturePatch,
  captureStack,
} from '../history/commands';
import { compositeDocument } from '../render/compositor';
import { floatToSurface, surfaceToFloat } from '../raster/float-image';
import { downsampleStepwise, padCentered, upscaleInteger } from '../raster/resample';
import type { Surface } from '../raster/surface';
import { clamp, clamp01, isFiniteNumber } from '../util/math';

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

function requireLayer(doc: Doc, id: string): Layer {
  const l = getLayer(doc, id);
  if (!l) throw new OpError('That layer no longer exists');
  return l;
}

/** Inserts `layer` at `index` (default: above the active layer) and activates it. */
export function addLayerOp(doc: Doc, layer: Layer, index?: number, label = 'New layer'): StackCommand {
  if (layer.kind === 'raster' && (layer.surface.width !== doc.width || layer.surface.height !== doc.height)) {
    throw new OpError('Layer size does not match the document');
  }
  const before = captureStack(doc);
  const active = doc.activeLayerId ? layerIndex(doc, doc.activeLayerId) : -1;
  const at = Math.max(0, Math.min(doc.layers.length, index ?? active + 1));
  const layers = doc.layers.slice();
  layers.splice(at, 0, layer);
  return new StackCommand(label, before, { layers, activeLayerId: layer.id });
}

export function deleteLayerOp(doc: Doc, id: string): StackCommand {
  const layer = requireLayer(doc, id);
  if (doc.layers.length <= 1) throw new OpError('A design needs at least one layer');
  const idx = layerIndex(doc, id);
  const layers = doc.layers.filter((l) => l !== layer);
  let active = doc.activeLayerId;
  if (active === id) active = layers[Math.max(0, idx - 1)].id;
  return new StackCommand(`Delete ${layer.name}`, captureStack(doc), { layers, activeLayerId: active });
}

export function duplicateLayerOp(doc: Doc, id: string): StackCommand {
  const layer = requireLayer(doc, id);
  const copy = cloneLayer(layer, newLayerId(doc), `${layer.name} copy`);
  copy.locked = false;
  const idx = layerIndex(doc, id);
  const layers = doc.layers.slice();
  layers.splice(idx + 1, 0, copy);
  return new StackCommand(`Duplicate ${layer.name}`, captureStack(doc), { layers, activeLayerId: copy.id });
}

/** Moves a layer to `toIndex` (bottom = 0). Null when nothing changes. */
export function moveLayerOp(doc: Doc, id: string, toIndex: number): StackCommand | null {
  const layer = requireLayer(doc, id);
  const from = layerIndex(doc, id);
  const to = Math.max(0, Math.min(doc.layers.length - 1, Math.floor(toIndex)));
  if (from === to) return null;
  const layers = doc.layers.slice();
  layers.splice(from, 1);
  layers.splice(to, 0, layer);
  return new StackCommand(`Move ${layer.name}`, captureStack(doc), { layers, activeLayerId: doc.activeLayerId });
}

/**
 * Validates and clamps a props patch into the ranges the engine (and the
 * .reskin loader) support; unusable values are dropped or rejected.
 */
function normalizeProps(patch: Partial<LayerProps>): Partial<LayerProps> {
  const out: Partial<LayerProps> = {};
  for (const k of LAYER_PROP_KEYS) {
    if (patch[k] === undefined) continue;
    (out as Record<string, unknown>)[k] = patch[k];
  }
  if (out.opacity !== undefined) {
    if (isFiniteNumber(out.opacity)) out.opacity = clamp01(out.opacity);
    else delete out.opacity;
  }
  if (out.blend !== undefined && !isBlendMode(out.blend)) throw new OpError(`Unknown blend mode ${out.blend}`);
  if (out.name !== undefined) out.name = String(out.name).trim() || 'Layer';
  if (out.visible !== undefined) out.visible = Boolean(out.visible);
  if (out.locked !== undefined) out.locked = Boolean(out.locked);
  if (out.effects !== undefined) {
    const bad = out.effects.find((e) => !(EFFECT_TYPES as readonly string[]).includes(e?.type));
    if (bad) throw new OpError(`Unknown effect ${String(bad?.type)}`);
    out.effects = normalizeEffects(out.effects);
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function propsLabel(patch: PropPatch, layer: Layer): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return `Edit ${layer.name}`;
  switch (keys[0]) {
    case 'name':
      return 'Rename layer';
    case 'visible':
      return patch.visible ? 'Show layer' : 'Hide layer';
    case 'locked':
      return patch.locked ? 'Lock layer' : 'Unlock layer';
    case 'opacity':
      return 'Layer opacity';
    case 'blend':
      return 'Blend mode';
    case 'effects':
      return 'Layer effects';
    default:
      return 'Edit text';
  }
}

/** Changes common layer props. Null when nothing changes. */
export function setLayerPropsOp(doc: Doc, id: string, patch: Partial<LayerProps>, label?: string): PropsCommand | null {
  const layer = requireLayer(doc, id);
  const norm = normalizeProps(patch);
  const src = layer as unknown as Record<string, unknown>;
  for (const k of Object.keys(norm) as (keyof LayerProps)[]) if (sameValue(src[k], norm[k])) delete norm[k];
  if (Object.keys(norm).length === 0) return null;
  return new PropsCommand(label ?? propsLabel(norm, layer), layer, capturePatch(layer, norm), norm);
}

/**
 * Changes text props of a text layer. When the layer name was derived from
 * its text, the name follows the new text.
 */
export function setTextPropsOp(doc: Doc, id: string, patch: Partial<TextProps>): PropsCommand | null {
  const layer = requireLayer(doc, id);
  if (layer.kind !== 'text') throw new OpError('Not a text layer');
  const clean = normalizeTextProps(patch);
  const norm: PropPatch = {};
  const src = layer as unknown as Record<string, unknown>;
  for (const k of TEXT_PROP_KEYS) {
    const v = clean[k];
    if (v === undefined || sameValue(src[k], v)) continue;
    (norm as Record<string, unknown>)[k] = v;
  }
  if (norm.text !== undefined && layer.name === layerNameForText(layer.text)) {
    norm.name = layerNameForText(norm.text);
  }
  if (Object.keys(norm).length === 0) return null;
  return new PropsCommand('Edit text', layer, capturePatch(layer, norm), norm);
}

/** Bakes the layer below + this layer into one raster layer (keeps the lower's name, id and blend). */
export function mergeDownOp(doc: Doc, id: string): StackCommand {
  const upper = requireLayer(doc, id);
  const idx = layerIndex(doc, id);
  if (idx <= 0) throw new OpError('There is no layer below to merge into');
  const lower = doc.layers[idx - 1];
  if (lower.locked) throw new OpError(`${lower.name} is locked`);
  if (!upper.visible || !lower.visible) throw new OpError('Show both layers before merging');
  if (lower.kind === 'text' && !lower.cache) throw new OpError('Text is not rendered yet');
  // Lower's own look (opacity, effects) is baked; its blend mode stays a layer prop.
  const lowerAsNormal = { ...lower, blend: 'normal' } as Layer;
  const merged = createRasterLayer(doc, {
    id: lower.id,
    name: lower.name,
    blend: lower.blend,
    surface: floatToSurface(compositeDocument(doc, { layers: [lowerAsNormal, upper] })),
  });
  const layers = doc.layers.slice();
  layers.splice(idx - 1, 2, merged);
  return new StackCommand('Merge down', captureStack(doc), { layers, activeLayerId: merged.id });
}

/** Composites every visible layer into one (hidden layers are discarded). */
export function flattenOp(doc: Doc): StackCommand | null {
  const only = doc.layers.length === 1 ? doc.layers[0] : null;
  if (
    only &&
    only.kind === 'raster' &&
    only.visible &&
    only.opacity === 1 &&
    only.blend === 'normal' &&
    only.effects.length === 0
  ) {
    return null;
  }
  const merged = createRasterLayer(doc, {
    name: 'Flattened',
    surface: floatToSurface(compositeDocument(doc)),
  });
  return new StackCommand('Flatten', captureStack(doc), { layers: [merged], activeLayerId: merged.id });
}

/** Replaces a text layer by a raster layer with the same look and id. */
export function rasterizeLayerOp(doc: Doc, id: string): StackCommand {
  const layer = requireLayer(doc, id);
  if (layer.kind !== 'text') throw new OpError('Only text layers can be rasterized');
  if (!layer.cache) throw new OpError('Text is not rendered yet');
  const raster: RasterLayer = {
    kind: 'raster',
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blend: layer.blend,
    effects: layer.effects.map((e) => ({ ...e, color: { ...e.color } })),
    surface: layer.cache.clone(),
  };
  const layers = doc.layers.map((l) => (l === layer ? raster : l));
  return new StackCommand('Rasterize text', captureStack(doc), {
    layers,
    activeLayerId: doc.activeLayerId,
  });
}

interface AxisMap {
  scale: number;
  offset: number;
}

/**
 * Pixel-crisp resample between document sizes: integer nearest-neighbour
 * upscale centred on the new canvas, or stepwise-halving area downscale.
 */
export function resampleForResize(src: Surface, size: number): Surface {
  const from = src.width;
  if (size === from) return src.clone();
  const img = surfaceToFloat(src);
  if (size > from) return floatToSurface(padCentered(upscaleInteger(img, Math.floor(size / from)), size));
  return floatToSurface(downsampleStepwise(img, size));
}

/** How coordinates map under `resampleForResize`. */
function axisMapFor(from: number, to: number): AxisMap {
  if (to > from) {
    const k = Math.floor(to / from);
    return { scale: k, offset: Math.floor((to - from * k) / 2) };
  }
  return { scale: to / from, offset: 0 };
}

/**
 * Switches between the 512 master and pixel-art grids (or between grids).
 * Raster layers are resampled, text and effects scaled; the selection is
 * cleared. Null when nothing changes.
 */
export function resizeDocumentOp(doc: Doc, pixelArt: PixelGrid | null): DocShapeCommand | null {
  if (pixelArt !== null && !isPixelGrid(pixelArt)) throw new OpError(`Pixel-art grids are ${PIXEL_GRIDS.join(', ')} px`);
  const size = pixelArt ?? MASTER_SIZE;
  if (size === doc.width && (doc.pixelArt?.grid ?? null) === pixelArt) return null;
  const before = captureShape(doc);
  const map = axisMapFor(doc.width, size);
  const after = captureShape(doc);
  after.width = size;
  after.height = size;
  after.pixelArt = pixelArt === null ? null : { grid: pixelArt };
  after.selection = null;
  for (const l of after.layers) {
    if (l.surface) l.surface = resampleForResize(l.surface, size);
    if (l.layer.kind === 'text') {
      const t = l.layer as TextLayer;
      l.text = {
        x: t.x * map.scale + map.offset,
        y: t.y * map.scale + map.offset,
        fontSize: clamp(t.fontSize * map.scale, 1, MAX_PARAM_PX),
      };
    }
    l.effects = l.effects.map((e) => normalizeEffect(scaleEffect(e, map.scale)));
  }
  const label = pixelArt === null ? 'Exit pixel-art mode' : `Pixel-art ${pixelArt}×${pixelArt}`;
  return new DocShapeCommand(label, before, after);
}

