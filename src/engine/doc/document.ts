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
import {
  MASTER_SIZE,
  MAX_FONT_WEIGHT,
  MAX_LINE_HEIGHT,
  MAX_PARAM_PX,
  MIN_FONT_WEIGHT,
  MIN_LINE_HEIGHT,
  isBlendMode,
  isPixelGrid,
} from './types';
import { cloneEffects, normalizeEffects } from './effects';
import { Surface } from '../raster/surface';
import { defaultTextProps, pickTextProps } from '../text/text';
import type { Rgba } from '../color/color';
import { clampRgba, toRgba8 } from '../color/color';
import { clamp, clamp01, isFiniteNumber } from '../util/math';
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
    ...defaultLayerProps(nextLayerName(doc)),
    ...validLayerProps(opts),
    effects: normalizeEffects(opts.effects ?? []),
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
  const text: TextProps = { ...defaultTextProps(doc.width), ...normalizeTextProps(opts) };
  text.color = { ...text.color };
  return {
    ...defaultLayerProps(layerNameForText(text.text)),
    ...validLayerProps(opts),
    effects: normalizeEffects(opts.effects ?? []),
    ...text,
    kind: 'text',
    id: opts.id ?? newLayerId(doc),
    cache: null,
    cacheKey: null,
  };
}

/** The usable common props of `o` (wrong types and non-finite numbers dropped, opacity clamped). */
function validLayerProps(o: Partial<LayerProps>): Partial<Omit<LayerProps, 'effects'>> {
  const out: Partial<Omit<LayerProps, 'effects'>> = {};
  if (typeof o.name === 'string') out.name = o.name;
  if (typeof o.visible === 'boolean') out.visible = o.visible;
  if (typeof o.locked === 'boolean') out.locked = o.locked;
  if (isFiniteNumber(o.opacity)) out.opacity = clamp01(o.opacity);
  if (isBlendMode(o.blend)) out.blend = o.blend;
  return out;
}

/**
 * The usable text props of `p`, clamped into the supported ranges (font
 * size 1..MAX_PARAM_PX, weight 100..900, line height 0.5..10, colour);
 * wrong types and non-finite numbers are dropped.
 */
export function normalizeTextProps(p: Partial<TextProps>): Partial<TextProps> {
  const out: Partial<TextProps> = {};
  if (typeof p.text === 'string') out.text = p.text;
  if (typeof p.fontFamily === 'string') out.fontFamily = p.fontFamily;
  if (isFiniteNumber(p.fontSize)) out.fontSize = clamp(p.fontSize, 1, MAX_PARAM_PX);
  if (isFiniteNumber(p.weight)) out.weight = clamp(Math.round(p.weight), MIN_FONT_WEIGHT, MAX_FONT_WEIGHT);
  if (typeof p.italic === 'boolean') out.italic = p.italic;
  if (p.align === 'left' || p.align === 'center' || p.align === 'right') out.align = p.align;
  if (p.color && typeof p.color === 'object') out.color = clampRgba(p.color);
  if (isFiniteNumber(p.x)) out.x = p.x;
  if (isFiniteNumber(p.y)) out.y = p.y;
  if (isFiniteNumber(p.rotation)) out.rotation = p.rotation;
  if (isFiniteNumber(p.lineHeight)) out.lineHeight = clamp(p.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT);
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
