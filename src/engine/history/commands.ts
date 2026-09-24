// Undoable commands over a Doc. Commands hold object references (layers,
// surfaces, masks), never ids, so they stay valid however layers move.
//
// Pixel edits store only the 64×64 tiles that actually changed, and use
// swap semantics: a command keeps the tile content of the state it is NOT
// in, and undo/redo exchange it with the layer. One copy per tile, and
// round trips are byte-identical.

import type { Change, Command } from './history';
import type { Doc, Layer, LayerProps, PixelArtSettings, RasterLayer, TextProps } from '../doc/types';
import { layerBytes } from '../doc/document';
import { cloneEffects } from '../doc/effects';
import type { Surface, Pixels } from '../raster/surface';
import { swapTile } from '../raster/tiles';
import type { SelectionMask } from '../selection/mask';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';

export type DocCommand = Command<Doc>;

/** Fixed bookkeeping cost per stored object, so empty commands still count. */
const OVERHEAD = 64;

export interface TilePatch {
  index: number;
  rect: Rect;
  /** The tile's pixels in the state the document is currently NOT in. */
  data: Pixels;
}

export class PixelCommand implements DocCommand {
  constructor(
    readonly label: string,
    readonly layer: RasterLayer,
    readonly tiles: TilePatch[],
  ) {}

  get bytes(): number {
    let n = OVERHEAD;
    for (const t of this.tiles) n += t.data.length + OVERHEAD;
    return n;
  }

  get rect(): Rect | null {
    let r: Rect | null = null;
    for (const t of this.tiles) r = unionRect(r, t.rect);
    return r;
  }

  private swap(): Change[] {
    const s = this.layer.surface;
    for (const t of this.tiles) swapTile(s.data, s.width, t.rect, t.data);
    const r = this.rect;
    return r ? [{ kind: 'pixels', layerId: this.layer.id, rect: r }] : [];
  }

  undo(): Change[] {
    return this.swap();
  }

  redo(): Change[] {
    return this.swap();
  }

  merge(next: DocCommand): boolean {
    if (!(next instanceof PixelCommand) || next.layer !== this.layer) return false;
    // Tiles both touched keep our (older) snapshot; new tiles come from next.
    const have = new Set(this.tiles.map((t) => t.index));
    for (const t of next.tiles) if (!have.has(t.index)) this.tiles.push(t);
    return true;
  }
}

export interface StackState {
  layers: Layer[];
  activeLayerId: string | null;
}

export function captureStack(doc: Doc): StackState {
  return { layers: doc.layers.slice(), activeLayerId: doc.activeLayerId };
}

/** Structural change: add/delete/reorder/replace layers, active layer. */
export class StackCommand implements DocCommand {
  readonly bytes: number;

  constructor(
    readonly label: string,
    readonly before: StackState,
    readonly after: StackState,
  ) {
    const a = new Set(before.layers);
    const b = new Set(after.layers);
    let n = OVERHEAD;
    for (const l of a) if (!b.has(l)) n += layerBytes(l);
    for (const l of b) if (!a.has(l)) n += layerBytes(l);
    this.bytes = n;
  }

  private static apply(doc: Doc, s: StackState): Change[] {
    doc.layers = s.layers.slice();
    doc.activeLayerId = s.activeLayerId;
    return [{ kind: 'layers' }];
  }

  undo(doc: Doc): Change[] {
    return StackCommand.apply(doc, this.before);
  }

  redo(doc: Doc): Change[] {
    return StackCommand.apply(doc, this.after);
  }
}

export type PropPatch = Partial<LayerProps> & Partial<TextProps>;

function clonePatch(p: PropPatch): PropPatch {
  const out: PropPatch = { ...p };
  if (p.effects) out.effects = cloneEffects(p.effects);
  if (p.color) out.color = { ...p.color };
  return out;
}

/** Snapshot of the current values of the keys in `patch`. */
export function capturePatch(layer: Layer, patch: PropPatch): PropPatch {
  const out: Record<string, unknown> = {};
  const src = layer as unknown as Record<string, unknown>;
  for (const k of Object.keys(patch)) out[k] = src[k];
  return clonePatch(out as PropPatch);
}

/** Layer property change (common props and text props). */
export class PropsCommand implements DocCommand {
  readonly bytes = OVERHEAD * 2;
  private before: PropPatch;
  private after: PropPatch;

  constructor(
    readonly label: string,
    readonly layer: Layer,
    before: PropPatch,
    after: PropPatch,
  ) {
    this.before = clonePatch(before);
    this.after = clonePatch(after);
  }

  private apply(p: PropPatch): Change[] {
    Object.assign(this.layer, clonePatch(p));
    return [{ kind: 'layers' }];
  }

  undo(): Change[] {
    return this.apply(this.before);
  }

  redo(): Change[] {
    return this.apply(this.after);
  }

  merge(next: DocCommand): boolean {
    if (!(next instanceof PropsCommand) || next.layer !== this.layer) return false;
    const keys = Object.keys(next.after);
    if (keys.length !== Object.keys(this.after).length || keys.some((k) => !(k in this.after))) return false;
    this.after = clonePatch(next.after);
    return true;
  }
}

/** Selection change. Masks are treated as immutable snapshots. */
export class SelectionCommand implements DocCommand {
  readonly bytes: number;

  constructor(
    readonly label: string,
    readonly before: SelectionMask | null,
    readonly after: SelectionMask | null,
  ) {
    this.bytes = OVERHEAD + (before?.data.length ?? 0) + (after?.data.length ?? 0);
  }

  undo(doc: Doc): Change[] {
    doc.selection = this.before;
    return [{ kind: 'selection' }];
  }

  redo(doc: Doc): Change[] {
    doc.selection = this.after;
    return [{ kind: 'selection' }];
  }
}

export interface LayerShape {
  layer: Layer;
  surface: Surface | null;
  text: Partial<TextProps> | null;
  effects: Layer['effects'];
}

/** Everything a document resize changes. */
export interface DocShape {
  width: number;
  height: number;
  pixelArt: PixelArtSettings | null;
  selection: SelectionMask | null;
  layers: LayerShape[];
}

export function captureShape(doc: Doc): DocShape {
  return {
    width: doc.width,
    height: doc.height,
    pixelArt: doc.pixelArt ? { ...doc.pixelArt } : null,
    selection: doc.selection,
    layers: doc.layers.map((layer) => ({
      layer,
      surface: layer.kind === 'raster' ? layer.surface : null,
      text:
        layer.kind === 'text'
          ? { x: layer.x, y: layer.y, fontSize: layer.fontSize }
          : null,
      effects: cloneEffects(layer.effects),
    })),
  };
}

/** Resize / pixel-art mode switch: swaps whole surfaces and scaled props. */
export class DocShapeCommand implements DocCommand {
  readonly bytes: number;

  constructor(
    readonly label: string,
    readonly before: DocShape,
    readonly after: DocShape,
  ) {
    let n = OVERHEAD;
    for (const s of [before, after]) {
      n += s.selection?.data.length ?? 0;
      for (const l of s.layers) n += (l.surface?.byteLength ?? 0) + OVERHEAD;
    }
    this.bytes = n;
  }

  private static apply(doc: Doc, s: DocShape): Change[] {
    doc.width = s.width;
    doc.height = s.height;
    doc.pixelArt = s.pixelArt ? { ...s.pixelArt } : null;
    doc.selection = s.selection;
    for (const l of s.layers) {
      if (l.layer.kind === 'raster' && l.surface) l.layer.surface = l.surface;
      if (l.layer.kind === 'text' && l.text) {
        Object.assign(l.layer, l.text);
        l.layer.cache = null;
        l.layer.cacheKey = null;
      }
      l.layer.effects = cloneEffects(l.effects);
    }
    return [{ kind: 'document' }];
  }

  undo(doc: Doc): Change[] {
    return DocShapeCommand.apply(doc, this.before);
  }

  redo(doc: Doc): Change[] {
    return DocShapeCommand.apply(doc, this.after);
  }
}

/** Several commands as one entry (undone in reverse order). */
export class CompoundCommand implements DocCommand {
  constructor(
    readonly label: string,
    readonly commands: DocCommand[],
  ) {}

  get bytes(): number {
    return this.commands.reduce((n, c) => n + c.bytes, OVERHEAD);
  }

  undo(doc: Doc): Change[] {
    const out: Change[] = [];
    for (let i = this.commands.length - 1; i >= 0; i--) out.push(...this.commands[i].undo(doc));
    return out;
  }

  redo(doc: Doc): Change[] {
    const out: Change[] = [];
    for (const c of this.commands) out.push(...c.redo(doc));
    return out;
  }
}

