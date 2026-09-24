// Document and layer construction plus read-only queries. Mutations that
// must be undoable are built as commands in ./ops.ts.

import type {
  BlendMode,
  Doc,
  DocMeta,
  Layer,
  LayerProps,
  PixelGrid,
  RasterLayer,
  SourceInfo,
  TextLayer,
  TextProps,
} from './types';
import { MASTER_SIZE, TEXT_PROP_KEYS, isPixelGrid } from './types';
import { cloneEffects } from './effects';
import { Surface } from '../raster/surface';
import { defaultTextProps, pickTextProps } from '../text/text';
import type { Rgba } from '../color/color';
import { toRgba8 } from '../color/color';
import { cloneMask } from '../selection/mask';

export interface NewDocumentOptions {
  /** Pixel-art grid; the document is then grid×grid. */
  pixelArt?: PixelGrid | null;
  name?: string;
  source?: SourceInfo | null;
  /** Fill for the first layer (default transparent). */
  background?: Rgba | null;
  /** Unix ms (default now). */
  createdAt?: number;
}

export function createDocument(opts: NewDocumentOptions = {}): Doc {
  const grid = opts.pixelArt ?? null;
  if (grid !== null && !isPixelGrid(grid)) throw new RangeError(`Invalid pixel grid ${grid}`);
  const size = grid ?? MASTER_SIZE;
  const doc: Doc = {
    width: size,
    height: size,
    pixelArt: grid === null ? null : { grid },
    layers: [],
    activeLayerId: null,
    selection: null,
    meta: {
      name: opts.name ?? 'Untitled',
      source: opts.source ?? null,
      createdAt: opts.createdAt ?? Date.now(),
    },
    seq: 0,
  };
  const layer = createRasterLayer(doc, { name: opts.background ? 'Background' : 'Layer 1' });
  if (opts.background) {
    const [r, g, b, a] = toRgba8(opts.background);
    layer.surface.fill(r, g, b, a);
  }
  doc.layers.push(layer);
  doc.activeLayerId = layer.id;
  return doc;
}

/** Generates an id unique within `doc`. */
export function newLayerId(doc: Doc): string {
  let id: string;
  do id = `L${++doc.seq}`;
  while (doc.layers.some((l) => l.id === id));
  return id;
}

export function defaultLayerProps(name: string): LayerProps {
  return { name, visible: true, locked: false, opacity: 1, blend: 'normal', effects: [] };
}

export interface NewRasterLayerOptions extends Partial<LayerProps> {
  surface?: Surface;
  id?: string;
}

/** A new raster layer sized to the document (not yet inserted). */
export function createRasterLayer(doc: Doc, opts: NewRasterLayerOptions = {}): RasterLayer {
  const surface = opts.surface ?? new Surface(doc.width, doc.height);
  if (surface.width !== doc.width || surface.height !== doc.height) {
    throw new RangeError('Layer surface must match the document size');
  }
  return {
    ...defaultLayerProps(opts.name ?? nextLayerName(doc)),
    ...stripUndefined(opts),
    effects: cloneEffects(opts.effects ?? []),
    kind: 'raster',
    id: opts.id ?? newLayerId(doc),
    surface,
  };
}

export interface NewTextLayerOptions extends Partial<LayerProps>, Partial<TextProps> {
  id?: string;
}

/** A new text layer (cache empty until a rasterizer renders it). */
export function createTextLayer(doc: Doc, opts: NewTextLayerOptions = {}): TextLayer {
  const text = defaultTextProps(doc.width);
  const target = text as unknown as Record<string, unknown>;
  for (const k of TEXT_PROP_KEYS) if (opts[k] !== undefined) target[k] = opts[k];
  text.color = { ...text.color };
  return {
    ...defaultLayerProps(opts.name ?? layerNameForText(text.text)),
    ...pickLayerProps(opts),
    effects: cloneEffects(opts.effects ?? []),
    ...text,
    kind: 'text',
    id: opts.id ?? newLayerId(doc),
    cache: null,
    cacheKey: null,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function pickLayerProps(o: Partial<LayerProps>): Partial<LayerProps> {
  const out: Partial<LayerProps> = {};
  if (o.name !== undefined) out.name = o.name;
  if (o.visible !== undefined) out.visible = o.visible;
  if (o.locked !== undefined) out.locked = o.locked;
  if (o.opacity !== undefined) out.opacity = o.opacity;
  if (o.blend !== undefined) out.blend = o.blend;
  return out;
}

/** "Text" layers are named after their first line (trimmed to 32 chars). */
export function layerNameForText(text: string): string {
  const first = text.split(/\r?\n/)[0].trim();
  if (!first) return 'Text';
  return first.length > 32 ? `${first.slice(0, 31)}…` : first;
}

/** "Layer N" with N one more than the highest existing "Layer N". */
export function nextLayerName(doc: Doc, base = 'Layer'): string {
  let max = 0;
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  for (const l of doc.layers) {
    const m = re.exec(l.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${base} ${max + 1}`;
}

export function getLayer(doc: Doc, id: string | null): Layer | null {
  if (id === null) return null;
  return doc.layers.find((l) => l.id === id) ?? null;
}

export function layerIndex(doc: Doc, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

export function activeLayer(doc: Doc): Layer | null {
  return getLayer(doc, doc.activeLayerId);
}

/** The pixels a layer shows: its surface, or a text layer's rendered cache. */
export function layerPixels(layer: Layer): Surface | null {
  return layer.kind === 'raster' ? layer.surface : layer.cache;
}

export function isRasterLayer(layer: Layer | null): layer is RasterLayer {
  return layer?.kind === 'raster';
}

export function isTextLayer(layer: Layer | null): layer is TextLayer {
  return layer?.kind === 'text';
}

/** Deep copy of a layer. `id`/`name` default to the source's. */
export function cloneLayer<L extends Layer>(layer: L, id = layer.id, name = layer.name): L {
  const common = {
    id,
    name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blend: layer.blend as BlendMode,
    effects: cloneEffects(layer.effects),
  };
  if (layer.kind === 'raster') {
    return { ...common, kind: 'raster', surface: layer.surface.clone() } as L;
  }
  return {
    ...common,
    ...pickTextProps(layer),
    kind: 'text',
    cache: layer.cache ? layer.cache.clone() : null,
    cacheKey: layer.cacheKey,
  } as L;
}

/** Full deep copy of a document (layers, selection, metadata). */
export function cloneDocument(doc: Doc): Doc {
  return {
    width: doc.width,
    height: doc.height,
    pixelArt: doc.pixelArt ? { ...doc.pixelArt } : null,
    layers: doc.layers.map((l) => cloneLayer(l)),
    activeLayerId: doc.activeLayerId,
    selection: doc.selection ? cloneMask(doc.selection) : null,
    meta: cloneMeta(doc.meta),
    seq: doc.seq,
  };
}

export function cloneMeta(m: DocMeta): DocMeta {
  return { name: m.name, createdAt: m.createdAt, source: m.source ? { ...m.source } : null };
}

/** Approximate memory held by a layer's pixel buffers, bytes. */
export function layerBytes(layer: Layer): number {
  return layer.kind === 'raster' ? layer.surface.byteLength : (layer.cache?.byteLength ?? 0);
}
