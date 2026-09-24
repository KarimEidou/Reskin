// .reskin project files: versioned JSON.
//
// {
//   "format": "reskin", "version": 1,
//   "width": 512, "height": 512, "pixelArt": null | { "grid": 32 },
//   "meta": { "name", "source": null | { kind, name, path }, "createdAt", "savedAt" },
//   "activeLayerId": "L3",
//   "layers": [                                   // bottom → top
//     { "kind": "raster", "id", "name", "visible", "locked", "opacity" (0..1),
//       "blend", "effects": [...], "pixels": base64(zlib(RGBA straight)) },
//     { "kind": "text", …common, "text", "fontFamily", "fontSize", "weight",
//       "italic", "align", "color": {r,g,b,a}, "x", "y", "rotation", "lineHeight" }
//   ]
// }
//
// width = height = 512, or the grid size in pixel-art mode; at most
// MAX_PROJECT_LAYERS layers. Older files go through `migrateProject` first;
// every field is validated on load (`ProjectError` names the offending
// path), and pixel blobs are inflated with a hard output limit, so a
// malformed or hostile file cannot exhaust memory.

import type {
  BlendMode,
  Doc,
  Layer,
  LayerEffect,
  PixelGrid,
  RasterLayer,
  SourceInfo,
  TextLayer,
  TextProps,
} from '../doc/types';
import {
  BLEND_MODES,
  EFFECT_TYPES,
  MASTER_SIZE,
  MAX_FONT_WEIGHT,
  MAX_LINE_HEIGHT,
  MAX_PARAM_PX,
  MIN_FONT_WEIGHT,
  MIN_LINE_HEIGHT,
  isBlendMode,
  isPixelGrid,
} from '../doc/types';
import { createEffect } from '../doc/effects';
import { Surface } from '../raster/surface';
import type { Rgba } from '../color/color';
import { decodeBase64, encodeBase64 } from '../util/base64';
import { OutputLimitError, deflate, inflate } from '../util/compress';
import { isFiniteNumber } from '../util/math';
import { pickTextProps } from '../text/text';

export const PROJECT_FORMAT = 'reskin';
export const PROJECT_VERSION = 1;
/** Most layers a project may contain (each raster layer is ~1 MB decoded). */
export const MAX_PROJECT_LAYERS = 256;

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

interface CommonLayerJson {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  effects: LayerEffect[];
}

export interface RasterLayerJson extends CommonLayerJson {
  kind: 'raster';
  pixels: string;
}

export interface TextLayerJson extends CommonLayerJson, TextProps {
  kind: 'text';
}

export type LayerJson = RasterLayerJson | TextLayerJson;

export interface ProjectJson {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  width: number;
  height: number;
  pixelArt: { grid: PixelGrid } | null;
  meta: { name: string; source: SourceInfo | null; createdAt: number; savedAt: number };
  activeLayerId: string | null;
  layers: LayerJson[];
}

/**
 * Version 0 (pre-release) files, kept as the example migration:
 * `{ format: 'reskin', version: 0, size (512 or a pixel-art grid), name?,
 * createdAt?, layers: [{ name, visible, opacity: 0..100, blend?, pixels }] }`
 * — raster layers only, no ids, locks or effects, percentage opacity.
 */
interface ProjectV0Json {
  format: 'reskin';
  version: 0;
  size: number;
  name?: string;
  createdAt?: number;
  layers: { name: string; visible: boolean; opacity: number; blend?: string; pixels: string }[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, what: string): never {
  throw new ProjectError(`${path}: ${what}`);
}

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, 'expected an object');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected a string');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true/false');
  return v;
}

function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (!isFiniteNumber(v) || v < min || v > max) {
    fail(path, `expected a number${min > -Infinity ? ` in ${min}..${max}` : ''}`);
  }
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function color(v: unknown, path: string): Rgba {
  const o = obj(v, path);
  return {
    r: num(o.r, `${path}.r`, 0, 255),
    g: num(o.g, `${path}.g`, 0, 255),
    b: num(o.b, `${path}.b`, 0, 255),
    a: num(o.a, `${path}.a`, 0, 1),
  };
}

function effect(v: unknown, path: string): LayerEffect {
  const o = obj(v, path);
  const type = oneOf(o.type, EFFECT_TYPES, `${path}.type`);
  const e = createEffect(type) as unknown as Obj;
  for (const [k, def] of Object.entries(e)) {
    if (k === 'type' || o[k] === undefined) continue;
    const p = `${path}.${k}`;
    if (k === 'color') e[k] = color(o[k], p);
    else if (k === 'enabled') e[k] = bool(o[k], p);
    else if (k === 'opacity') e[k] = num(o[k], p, 0, 1);
    else if (k === 'blend') e[k] = oneOf(o[k], BLEND_MODES, p);
    else if (k === 'position') e[k] = oneOf(o[k], ['outside', 'center', 'inside'], p);
    else if (typeof def === 'number') {
      e[k] = k === 'angle' ? num(o[k], p) : num(o[k], p, 0, MAX_PARAM_PX);
    }
  }
  return e as unknown as LayerEffect;
}

function common(o: Obj, path: string): CommonLayerJson {
  const blend = str(o.blend, `${path}.blend`);
  if (!isBlendMode(blend)) fail(`${path}.blend`, `unknown blend mode "${blend}"`);
  const effects = o.effects === undefined ? [] : o.effects;
  if (!Array.isArray(effects)) fail(`${path}.effects`, 'expected an array');
  const id = str(o.id, `${path}.id`);
  if (!id) fail(`${path}.id`, 'must not be empty');
  return {
    id,
    name: str(o.name, `${path}.name`),
    visible: bool(o.visible, `${path}.visible`),
    locked: bool(o.locked, `${path}.locked`),
    opacity: num(o.opacity, `${path}.opacity`, 0, 1),
    blend,
    effects: effects.map((e, i) => effect(e, `${path}.effects[${i}]`)),
  };
}

function layerJson(v: unknown, path: string): LayerJson {
  const o = obj(v, path);
  const kind = oneOf(o.kind, ['raster', 'text'] as const, `${path}.kind`);
  const c = common(o, path);
  if (kind === 'raster') return { ...c, kind, pixels: str(o.pixels, `${path}.pixels`) };
  return {
    ...c,
    kind,
    text: str(o.text, `${path}.text`),
    fontFamily: str(o.fontFamily, `${path}.fontFamily`),
    fontSize: num(o.fontSize, `${path}.fontSize`, 1, MAX_PARAM_PX),
    weight: num(o.weight, `${path}.weight`, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT),
    italic: bool(o.italic, `${path}.italic`),
    align: oneOf(o.align, ['left', 'center', 'right'] as const, `${path}.align`),
    color: color(o.color, `${path}.color`),
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    rotation: num(o.rotation, `${path}.rotation`),
    lineHeight: num(o.lineHeight, `${path}.lineHeight`, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT),
  };
}

function source(v: unknown, path: string): SourceInfo | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, path);
  return {
    kind: str(o.kind, `${path}.kind`) as SourceInfo['kind'],
    name: str(o.name, `${path}.name`),
    path: o.path === null || o.path === undefined ? null : str(o.path, `${path}.path`),
  };
}

/** Validates a (current-version) project object. */
export function validateProject(v: unknown): ProjectJson {
  const o = obj(v, 'project');
  if (o.format !== PROJECT_FORMAT) fail('format', 'not a Reskin project');
  if (o.version !== PROJECT_VERSION) fail('version', `expected ${PROJECT_VERSION}`);
  const width = num(o.width, 'width', 1, MASTER_SIZE);
  const height = num(o.height, 'height', 1, MASTER_SIZE);
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail('width', 'expected whole pixels');
  if (width !== height) fail('height', 'designs must be square');
  let pixelArt: ProjectJson['pixelArt'] = null;
  if (o.pixelArt !== null && o.pixelArt !== undefined) {
    const grid = obj(o.pixelArt, 'pixelArt').grid;
    if (!isPixelGrid(grid)) fail('pixelArt.grid', 'expected 16, 24, 32, 48 or 64');
    if (grid !== width) fail('pixelArt.grid', 'must equal the document size');
    pixelArt = { grid };
  } else if (width !== MASTER_SIZE) {
    // The document model is the 512 master or a pixel-art grid, nothing else.
    fail('width', `expected ${MASTER_SIZE} (or the pixel-art grid size)`);
  }
  const meta = obj(o.meta, 'meta');
  if (!Array.isArray(o.layers) || o.layers.length === 0) fail('layers', 'expected at least one layer');
  if (o.layers.length > MAX_PROJECT_LAYERS) fail('layers', `at most ${MAX_PROJECT_LAYERS} layers are supported`);
  const layers = o.layers.map((l, i) => layerJson(l, `layers[${i}]`));
  const ids = new Set<string>();
  for (const [i, l] of layers.entries()) {
    if (ids.has(l.id)) fail(`layers[${i}].id`, `duplicate id "${l.id}"`);
    ids.add(l.id);
  }
  const active = o.activeLayerId === null || o.activeLayerId === undefined ? null : str(o.activeLayerId, 'activeLayerId');
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    width,
    height,
    pixelArt,
    meta: {
      name: str(meta.name, 'meta.name'),
      source: source(meta.source, 'meta.source'),
      createdAt: num(meta.createdAt, 'meta.createdAt'),
      savedAt: meta.savedAt === undefined ? 0 : num(meta.savedAt, 'meta.savedAt'),
    },
    activeLayerId: active !== null && ids.has(active) ? active : layers[layers.length - 1].id,
    layers,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function migrateV0(o: Obj): Obj {
  const v0 = o as unknown as ProjectV0Json;
  const size = num(v0.size, 'size', 1, MASTER_SIZE);
  if (size !== MASTER_SIZE && !isPixelGrid(size)) fail('size', `expected ${MASTER_SIZE} or a pixel-art grid size`);
  if (!Array.isArray(v0.layers)) fail('layers', 'expected an array');
  if (v0.layers.length > MAX_PROJECT_LAYERS) fail('layers', `at most ${MAX_PROJECT_LAYERS} layers are supported`);
  const layers = v0.layers.map((l, i) => {
    const lo = obj(l, `layers[${i}]`);
    return {
      kind: 'raster',
      id: `L${i + 1}`,
      name: str(lo.name, `layers[${i}].name`),
      visible: bool(lo.visible, `layers[${i}].visible`),
      locked: false,
      opacity: num(lo.opacity, `layers[${i}].opacity`, 0, 100) / 100,
      blend: lo.blend ?? 'normal',
      effects: [],
      pixels: str(lo.pixels, `layers[${i}].pixels`),
    };
  });
  return {
    format: PROJECT_FORMAT,
    version: 1,
    width: size,
    height: size,
    pixelArt: isPixelGrid(size) ? { grid: size } : null,
    meta: {
      name: typeof v0.name === 'string' ? v0.name : 'Untitled',
      source: null,
      createdAt: isFiniteNumber(v0.createdAt) ? v0.createdAt : 0,
      savedAt: 0,
    },
    activeLayerId: layers.length ? layers[layers.length - 1].id : null,
    layers,
  };
}

/**
 * Upgrades any supported project version to the current one (validated).
 * Accepts a JSON string or an already-parsed object.
 */
export function migrateProject(input: unknown): ProjectJson {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new ProjectError('The file is not valid JSON');
    }
  }
  let o = obj(v, 'project');
  if (o.format !== PROJECT_FORMAT) fail('format', 'not a Reskin project');
  if (!isFiniteNumber(o.version) || !Number.isInteger(o.version) || o.version < 0) fail('version', 'missing or invalid');
  if (o.version > PROJECT_VERSION) {
    throw new ProjectError('This project was saved by a newer version of Reskin');
  }
  if (o.version === 0) o = migrateV0(o);
  return validateProject(o);
}

// ---------------------------------------------------------------------------
// Serialize / deserialize
// ---------------------------------------------------------------------------

async function decodePixels(b64: string, width: number, height: number, path: string): Promise<Surface> {
  const expected = width * height * 4;
  // zlib never expands data by more than a few bytes per 16 KB block, so
  // anything far longer than the raw size (base64: 4/3) is not ours.
  if (b64.length > 2 * expected + 1024) fail(path, 'pixel data is too long');
  let raw: Uint8Array;
  try {
    raw = await inflate(decodeBase64(b64), expected);
  } catch (e) {
    fail(path, e instanceof OutputLimitError ? `more than ${expected} bytes of pixel data` : 'corrupt pixel data');
  }
  if (raw.length !== expected) fail(path, `expected ${expected} bytes, got ${raw.length}`);
  return Surface.fromRgba(width, height, raw);
}

function commonJson(l: Layer): CommonLayerJson {
  return {
    id: l.id,
    name: l.name,
    visible: l.visible,
    locked: l.locked,
    opacity: l.opacity,
    blend: l.blend,
    effects: l.effects.map((e) => ({ ...e, color: { ...e.color } })),
  };
}

export interface SerializeOptions {
  /** Indent the JSON (debugging); default compact. */
  pretty?: boolean;
  /** Unix ms stored as meta.savedAt (default now). */
  savedAt?: number;
}

/** A raster layer of a snapshot: its pixels (straight RGBA) not encoded yet. */
export interface RasterLayerSnapshot extends CommonLayerJson {
  kind: 'raster';
  pixels: Uint8Array<ArrayBuffer>;
}

/**
 * A document's content at one moment, ready to be encoded anywhere (see
 * `encodeSnapshot`). The raster pixels are private copies: edits made
 * while it is encoded cannot tear it, and their buffers can be handed to
 * a worker without another copy (`snapshotBuffers`).
 */
export interface ProjectSnapshot {
  project: Omit<ProjectJson, 'layers'>;
  layers: (RasterLayerSnapshot | TextLayerJson)[];
}

/** Takes a snapshot of `doc`; synchronous, and cheap next to encoding it. */
export function snapshotProject(doc: Doc, opts: SerializeOptions = {}): ProjectSnapshot {
  return {
    project: {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      width: doc.width,
      height: doc.height,
      pixelArt: doc.pixelArt ? { grid: doc.pixelArt.grid } : null,
      meta: {
        name: doc.meta.name,
        source: doc.meta.source ? { ...doc.meta.source } : null,
        createdAt: doc.meta.createdAt,
        savedAt: opts.savedAt ?? Date.now(),
      },
      activeLayerId: doc.activeLayerId,
    },
    layers: doc.layers.map((l) =>
      l.kind === 'raster'
        ? { ...commonJson(l), kind: 'raster', pixels: new Uint8Array(l.surface.data) }
        : { ...commonJson(l), ...pickTextProps(l), kind: 'text' },
    ),
  };
}

/** The pixel buffers of a snapshot, to transfer it to a worker. */
export function snapshotBuffers(snapshot: ProjectSnapshot): ArrayBuffer[] {
  return snapshot.layers.flatMap((l) => (l.kind === 'raster' ? [l.pixels.buffer] : []));
}

/** Encodes a snapshot's pixels (zlib, base64): the project as JSON data. */
export async function encodeSnapshot(snapshot: ProjectSnapshot): Promise<ProjectJson> {
  const layers = await Promise.all(
    snapshot.layers.map(async (l): Promise<LayerJson> =>
      l.kind === 'raster' ? { ...l, pixels: encodeBase64(await deflate(l.pixels)) } : l,
    ),
  );
  return { ...snapshot.project, layers };
}

export function projectToJson(doc: Doc, opts: SerializeOptions = {}): Promise<ProjectJson> {
  return encodeSnapshot(snapshotProject(doc, opts));
}

/** Serializes a document to .reskin JSON text. */
export async function serializeProject(doc: Doc, opts: SerializeOptions = {}): Promise<string> {
  return JSON.stringify(await projectToJson(doc, opts), null, opts.pretty ? 2 : undefined);
}

/** Parses, migrates, validates and decodes a project into a document. */
export async function deserializeProject(input: unknown): Promise<Doc> {
  const p = migrateProject(input);
  const layers = await Promise.all(
    p.layers.map(async (l, i): Promise<Layer> => {
      const base = {
        id: l.id,
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        opacity: l.opacity,
        blend: l.blend,
        effects: l.effects,
      };
      if (l.kind === 'raster') {
        const surface = await decodePixels(l.pixels, p.width, p.height, `layers[${i}].pixels`);
        return { ...base, kind: 'raster', surface } satisfies RasterLayer;
      }
      return { ...base, ...pickTextProps(l), kind: 'text', cache: null, cacheKey: null } satisfies TextLayer;
    }),
  );
  let seq = 0;
  for (const l of layers) {
    const m = /^L(\d+)$/.exec(l.id);
    if (m) seq = Math.max(seq, parseInt(m[1], 10));
  }
  return {
    width: p.width,
    height: p.height,
    pixelArt: p.pixelArt,
    layers,
    activeLayerId: p.activeLayerId,
    selection: null,
    meta: { name: p.meta.name, source: p.meta.source, createdAt: p.meta.createdAt },
    seq,
  };
}

/** Quick check used by import UIs before a full load. */
export function looksLikeProject(text: string): boolean {
  return /^\s*\{/.test(text) && text.includes(`"format"`) && text.includes(`"${PROJECT_FORMAT}"`);
}
