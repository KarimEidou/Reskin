// Detached copies of a document / layer that can be posted to the panels
// worker (plain objects + transferable pixel buffers) and turned back into
// engine structures there, so the worker runs the engine's own code paths
// (export plan, thumbnails, compositor) on identical data.

import { cloneEffects } from '$engine/doc/effects';
import type { BlendMode, Doc, Layer, LayerEffect, RasterLayer } from '$engine/doc/types';
import { Surface } from '$engine/raster/surface';

export interface LayerSnapshot {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  effects: LayerEffect[];
  width: number;
  height: number;
  /** Straight RGBA (a raster layer's surface or a text layer's rendered cache). */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface DocSnapshot {
  width: number;
  height: number;
  pixelArt: number | null;
  layers: LayerSnapshot[];
}

/** The pixels a layer shows, or null (text not rendered yet). */
function pixelsOf(layer: Layer): Surface | null {
  return layer.kind === 'raster' ? layer.surface : layer.cache;
}

/** A copy of one layer; null when it has nothing to show. */
export function snapshotLayer(layer: Layer): LayerSnapshot | null {
  const px = pixelsOf(layer);
  if (!px) return null;
  return {
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    blend: layer.blend,
    effects: cloneEffects(layer.effects),
    width: px.width,
    height: px.height,
    data: px.data.slice(),
  };
}

/** A copy of the visible layers (what export sees). */
export function snapshotDoc(doc: Doc): DocSnapshot {
  const layers: LayerSnapshot[] = [];
  for (const l of doc.layers) {
    if (!l.visible) continue;
    const s = snapshotLayer(l);
    if (s) layers.push(s);
  }
  return { width: doc.width, height: doc.height, pixelArt: doc.pixelArt?.grid ?? null, layers };
}

export function snapshotTransfer(s: DocSnapshot): Transferable[] {
  return s.layers.map((l) => l.data.buffer);
}

export function layerFromSnapshot(s: LayerSnapshot, id = 'L1'): RasterLayer {
  return {
    kind: 'raster',
    id,
    name: s.name,
    visible: s.visible,
    locked: false,
    opacity: s.opacity,
    blend: s.blend,
    effects: cloneEffects(s.effects),
    surface: new Surface(s.width, s.height, s.data),
  };
}

export function docFromSnapshot(s: DocSnapshot): Doc {
  const layers = s.layers.map((l, i) => layerFromSnapshot(l, `L${i + 1}`));
  return {
    width: s.width,
    height: s.height,
    pixelArt: s.pixelArt === null ? null : ({ grid: s.pixelArt } as Doc['pixelArt']),
    layers,
    activeLayerId: layers[0]?.id ?? null,
    selection: null,
    meta: { name: 'preview', source: null, createdAt: 0 },
    seq: layers.length,
  };
}
