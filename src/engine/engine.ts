// Engine: the framework-agnostic editing session the UI drives.
//
// It owns the document, history, tools and their options, colours,
// symmetry, and (optionally) a viewport for the hand/zoom tools. Pointer
// input arrives in DOCUMENT coordinates. Every change is announced through
// `subscribe()` as EngineEvents; the Svelte side wraps the engine in a store
// and redraws on the next animation frame.

import type { SizedPng } from '$lib/ipc/types';
import type { Rgba } from './color/color';
import { BLACK, WHITE, clampRgba } from './color/color';
import type { Doc, Layer, LayerProps, PixelGrid, RasterLayer, TextLayer, TextProps } from './doc/types';
import type { NewDocumentOptions } from './doc/document';
import { createDocument, createRasterLayer, createTextLayer, getLayer, layerPixels } from './doc/document';
import {
  OpError,
  addLayerOp,
  deleteLayerOp,
  duplicateLayerOp,
  flattenOp,
  mergeDownOp,
  moveLayerOp,
  rasterizeLayerOp,
  resizeDocumentOp,
  setLayerPropsOp,
  setTextPropsOp,
} from './doc/ops';
import { documentThumbnail, layerThumbnail } from './doc/thumbnails';
import type { Change, HistoryEntryInfo, PushOptions } from './history/history';
import { History } from './history/history';
import type { DocCommand } from './history/commands';
import { CompoundCommand, PropsCommand, SelectionCommand, StackCommand } from './history/commands';
import { PixelTransaction } from './history/pixel-transaction';
import type { Modifiers, PointerInput } from './input/pointer';
import type { Point } from './geometry/affine';
import type { Surface } from './raster/surface';
import { compositeSurface } from './render/compositor';
import type { OverlayPainter } from './render/overlay';
import type { SelectionMask, SelectionOp } from './selection/mask';
import {
  combineMasks,
  ellipseMask,
  featherMask,
  invertMask,
  masksEqual,
  polygonMask,
  rectMask,
  selectAllMask,
} from './selection/mask';
import { alphaMask, borderMask, growMask, shrinkMask } from './selection/refine';
import type { SymmetrySettings } from './symmetry/symmetry';
import { NO_SYMMETRY, symmetryCenter } from './symmetry/symmetry';
import type { TextLayout, TextMeasurer, TextRasterizer } from './text/text';
import { approximateMeasurer, isTextCacheFresh, refreshTextCache } from './text/text';
import type { CursorHint, MessageLevel, Tool, ToolContext, ToolId } from './tools/types';
import { Scratch } from './tools/types';
import type { ToolOptionsMap, ToolOptionsState, ToolSet } from './tools/registry';
import { createTools, defaultToolOptions } from './tools/registry';
import type { TransformParams } from './tools/transform';
import { liftableBounds } from './tools/transform';
import type { FitOptions } from './io/import';
import { importLayer } from './io/import';
import { deserializeProject, serializeProject } from './io/project';
import type { ExportOptions } from './export/export';
import { toSizedPngs } from './export/export';
import { DEFAULT_ICO_SIZES } from './export/plan';
import type { Viewport } from './viewport/viewport';
import type { Rect } from './util/rect';
import { fullRect, unionRect } from './util/rect';
import { Emitter } from './util/emitter';

export type EngineEvent =
  /** Pixels of a layer changed (text caches included). Redraw `rect`. */
  | { kind: 'pixels'; layerId: string; rect: Rect }
  /** Layer list, order, props or the active layer changed. */
  | { kind: 'layers' }
  | { kind: 'selection' }
  /** Undo stack changed (entries, index). */
  | { kind: 'history' }
  /** Tool, tool options or cursor changed. */
  | { kind: 'tool' }
  | { kind: 'color' }
  | { kind: 'symmetry' }
  /** The document was replaced or resized (pixel-art mode): reset everything. */
  | { kind: 'document' }
  /** Tool overlay needs a redraw. */
  | { kind: 'overlay' }
  /** A pointer gesture started/ended (views may defer expensive work). */
  | { kind: 'interaction'; active: boolean }
  /** Open (layer id) or close (null) the inline text editor. */
  | { kind: 'textEdit'; layerId: string | null }
  /** User-facing notice, e.g. "This layer is locked". */
  | { kind: 'message'; level: MessageLevel; text: string };

export type EngineEventKind = EngineEvent['kind'];

/** Tools that may temporarily override the current one (Space → hand…). */
export type OverrideToolId = 'hand' | 'zoom' | 'eyedropper';

export interface EngineOptions {
  doc?: Doc;
  /** Needed to render text layers (see text/measure-canvas.ts). */
  textRasterizer?: TextRasterizer | null;
  /** History memory cap, bytes (default 256 MB). */
  historyBytes?: number;
  viewport?: Viewport | null;
  primary?: Rgba;
  secondary?: Rgba;
  tool?: ToolId;
}

interface TextEditSession {
  layerId: string;
  mergeKey: string;
  /** The command that created the layer right before this session, if any. */
  created: DocCommand | null;
}

export class Engine {
  readonly history: History<Doc>;
  readonly tools: ToolSet;
  private _doc: Doc;
  private options: ToolOptionsState;
  private _toolId: ToolId;
  private override: OverrideToolId | null = null;
  private _primary: Rgba;
  private _secondary: Rgba;
  private _symmetry: SymmetrySettings = { ...NO_SYMMETRY };
  private rasterizer: TextRasterizer | null;
  private _viewport: Viewport | null;
  private readonly events = new Emitter<EngineEvent>();
  private readonly scratch = new Scratch();
  private compositeCache: Surface | null = null;
  /** Move-tool content bounds per raster layer id (see ToolContext.contentBounds). */
  private readonly boundsCache = new Map<string, Rect | null>();
  private gesture: { toolId: ToolId; last: PointerInput } | null = null;
  private hoverPoint: Point | null = null;
  private textEdit: TextEditSession | null = null;
  private textSerial = 0;
  private disposed = false;
  private readonly ctx: ToolContext;

  constructor(opts: EngineOptions = {}) {
    this._doc = opts.doc ?? createDocument();
    this.history = new History<Doc>({ maxBytes: opts.historyBytes });
    this.tools = createTools();
    this.options = defaultToolOptions(this.tools);
    this._toolId = opts.tool ?? 'brush';
    this._primary = { ...(opts.primary ?? BLACK) };
    this._secondary = { ...(opts.secondary ?? WHITE) };
    this.rasterizer = opts.textRasterizer ?? null;
    this._viewport = opts.viewport ?? null;
    this.ctx = this.createContext();
    this.syncTextCaches(false);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Listens to every change. Returns an unsubscribe function. */
  subscribe(listener: (e: EngineEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  private emit(e: EngineEvent): void {
    if (this.disposed) return;
    if (e.kind === 'pixels' || e.kind === 'layers' || e.kind === 'document') this.compositeCache = null;
    if (e.kind === 'pixels') this.boundsCache.delete(e.layerId);
    else if (e.kind === 'layers' || e.kind === 'document' || e.kind === 'selection') this.boundsCache.clear();
    this.events.emit(e);
  }

  private emitChanges(changes: readonly Change[]): void {
    let layers = false;
    let selection = false;
    let document = false;
    const pixels = new Map<string, Rect>();
    for (const c of changes) {
      if (c.kind === 'layers') layers = true;
      else if (c.kind === 'selection') selection = true;
      else if (c.kind === 'document') document = true;
      else pixels.set(c.layerId, unionRect(pixels.get(c.layerId) ?? null, c.rect) as Rect);
    }
    if (document) {
      this._viewport?.setDocSize(this._doc.width, this._doc.height);
      this.emit({ kind: 'document' });
      layers = selection = true;
    }
    if (layers) this.emit({ kind: 'layers' });
    if (selection) this.emit({ kind: 'selection' });
    for (const [layerId, rect] of pixels) this.emit({ kind: 'pixels', layerId, rect });
    this.syncTextCaches(true);
    if (layers) this.dropStaleTextEdit();
  }

  /**
   * Closes the inline text editor when its layer is gone or no longer a
   * text layer (deleted, merged, flattened, rasterized, undone).
   */
  private dropStaleTextEdit(): void {
    const s = this.textEdit;
    if (!s || getLayer(this._doc, s.layerId)?.kind === 'text') return;
    this.textEdit = null;
    this.emit({ kind: 'textEdit', layerId: null });
  }

  private message(text: string, level: MessageLevel = 'info'): void {
    this.emit({ kind: 'message', level, text });
  }

  // -------------------------------------------------------------------------
  // Document
  // -------------------------------------------------------------------------

  get doc(): Doc {
    return this._doc;
  }

  get activeLayer(): Layer | null {
    return getLayer(this._doc, this._doc.activeLayerId);
  }

  getLayer(id: string): Layer | null {
    return getLayer(this._doc, id);
  }

  /** Replaces the document; history is cleared. */
  loadDocument(doc: Doc): void {
    this.settle('cancel');
    this.endTextEdit();
    this._doc = doc;
    this.history.clear();
    this.compositeCache = null;
    this.boundsCache.clear();
    this.syncTextCaches(false);
    if (this._viewport) {
      this._viewport.setDocSize(doc.width, doc.height);
      this._viewport.fit();
    }
    this.emit({ kind: 'document' });
    this.emit({ kind: 'layers' });
    this.emit({ kind: 'selection' });
    this.emit({ kind: 'history' });
  }

  newDocument(opts: NewDocumentOptions = {}): void {
    this.loadDocument(createDocument(opts));
  }

  setDocumentName(name: string): void {
    this._doc.meta.name = name.trim() || 'Untitled';
    this.emit({ kind: 'layers' });
  }

  /** Switches between the 512 master and a pixel-art grid (recorded). */
  setPixelArt(grid: PixelGrid | null): void {
    this.settle('commit');
    this.run(() => resizeDocumentOp(this._doc, grid));
  }

  /** Straight-alpha composite of the visible layers (cached until something changes). */
  composite(): Surface {
    this.compositeCache ??= compositeSurface(this._doc, { textRasterizer: this.rasterizer });
    return this.compositeCache;
  }

  thumbnail(size: number): Surface {
    return documentThumbnail(this._doc, size, { textRasterizer: this.rasterizer });
  }

  layerThumbnail(id: string, size: number): Surface | null {
    const l = getLayer(this._doc, id);
    return l ? layerThumbnail(l, size, this._doc.pixelArt !== null) : null;
  }

  /** The design at every size as base64 PNGs (what `apply_icon` receives). */
  exportPngs(sizes: readonly number[] = DEFAULT_ICO_SIZES, opts: ExportOptions = {}): Promise<SizedPng[]> {
    return toSizedPngs(this._doc, sizes, { textRasterizer: this.rasterizer, ...opts });
  }

  /** .reskin project JSON of the current document. */
  serialize(): Promise<string> {
    return serializeProject(this._doc);
  }

  /** Loads .reskin JSON (any supported version). Rejects with ProjectError. */
  async loadProject(json: unknown): Promise<void> {
    this.loadDocument(await deserializeProject(json));
  }

  /** Installs (or replaces) the text rasterizer and re-renders text layers. */
  setTextRasterizer(r: TextRasterizer | null): void {
    this.rasterizer = r;
    for (const l of this._doc.layers) {
      if (l.kind === 'text') {
        l.cacheKey = null;
      }
    }
    this.syncTextCaches(true);
  }

  get textMeasurer(): TextMeasurer {
    return this.rasterizer ?? approximateMeasurer;
  }

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  get viewport(): Viewport | null {
    return this._viewport;
  }

  attachViewport(v: Viewport | null): void {
    this._viewport = v;
    v?.setDocSize(this._doc.width, this._doc.height);
  }

  // -------------------------------------------------------------------------
  // Colours & symmetry
  // -------------------------------------------------------------------------

  get primary(): Rgba {
    return { ...this._primary };
  }

  get secondary(): Rgba {
    return { ...this._secondary };
  }

  setColor(which: 'primary' | 'secondary', c: Rgba): void {
    const v = clampRgba(c);
    if (which === 'primary') this._primary = v;
    else this._secondary = v;
    this.emit({ kind: 'color' });
  }

  swapColors(): void {
    [this._primary, this._secondary] = [this._secondary, this._primary];
    this.emit({ kind: 'color' });
  }

  resetColors(): void {
    this._primary = { ...BLACK };
    this._secondary = { ...WHITE };
    this.emit({ kind: 'color' });
  }

  get symmetry(): SymmetrySettings {
    return { ...this._symmetry };
  }

  setSymmetry(patch: Partial<SymmetrySettings>): void {
    const next = { ...this._symmetry, ...patch };
    next.rays = Number.isFinite(next.rays) ? Math.max(2, Math.min(64, Math.round(next.rays))) : this._symmetry.rays;
    // A non-finite centre falls back to the document centre.
    if (next.cx !== null && !Number.isFinite(next.cx)) next.cx = null;
    if (next.cy !== null && !Number.isFinite(next.cy)) next.cy = null;
    this._symmetry = next;
    this.emit({ kind: 'symmetry' });
    this.emit({ kind: 'overlay' });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /** The tool pointer input goes to (the override if any). */
  get toolId(): ToolId {
    return this.override ?? this._toolId;
  }

  /** The selected tool, ignoring a temporary override. */
  get selectedToolId(): ToolId {
    return this._toolId;
  }

  setTool(id: ToolId): void {
    if (id === this._toolId) return;
    this.settle('commit');
    this.endTextEdit();
    this._toolId = id;
    this.emit({ kind: 'tool' });
    this.emit({ kind: 'overlay' });
  }

  /** Temporarily routes input to hand/zoom/eyedropper without committing anything (null restores). */
  setToolOverride(id: OverrideToolId | null): void {
    if (id === this.override) return;
    // A gesture in progress keeps its tool; the override applies to the next one.
    this.override = id;
    this.emit({ kind: 'tool' });
    this.emit({ kind: 'overlay' });
  }

  getToolOptions<K extends ToolId>(id: K): Readonly<ToolOptionsMap[K]> {
    return this.options[id];
  }

  setToolOptions<K extends ToolId>(id: K, patch: Partial<ToolOptionsMap[K]>): void {
    this.options[id] = { ...this.options[id], ...patch };
    this.emit({ kind: 'tool' });
    this.emit({ kind: 'overlay' });
  }

  private tool(id: ToolId): Tool<object> {
    return this.tools[id] as unknown as Tool<object>;
  }

  get cursor(): CursorHint {
    const id = this.gesture?.toolId ?? this.toolId;
    return this.tool(id).cursor(this.options[id], this.ctx);
  }

  get isInteracting(): boolean {
    return this.gesture !== null;
  }

  /** True while a tool holds uncommitted work (e.g. a pending transform). */
  get hasPending(): boolean {
    return this.tool(this._toolId).hasPending?.() ?? false;
  }

  /**
   * The move tool's box: the pending transform, else the active layer's
   * content bounds or text block (what the move tool draws handles around,
   * whichever tool is selected). Null when there is nothing to move.
   */
  get transformBox(): TransformParams | null {
    return this.tools.move.previewParams(this.ctx);
  }

  /** Commits pending tool work (Enter). */
  commitPending(): void {
    this.settle('commit');
  }

  /** Discards pending tool work (Esc). */
  cancelPending(): void {
    this.settle('cancel');
  }

  private settle(mode: 'commit' | 'cancel'): void {
    if (this.gesture) this.pointerCancel();
    const t = this.tool(this._toolId);
    if (t.hasPending?.()) {
      if (mode === 'commit') t.commit?.(this.ctx, this.options[this._toolId]);
      else t.cancel(this.ctx);
    }
  }

  // -------------------------------------------------------------------------
  // Pointer & keyboard input (document coordinates)
  // -------------------------------------------------------------------------

  pointerDown(p: PointerInput): void {
    if (this.disposed) return;
    if (this.gesture) this.pointerCancel();
    const toolId = this.toolId;
    this.gesture = { toolId, last: p };
    this.hoverPoint = { x: p.x, y: p.y };
    this.emit({ kind: 'interaction', active: true });
    this.tool(toolId).pointerDown(this.ctx, p, this.options[toolId]);
    this.emit({ kind: 'overlay' });
  }

  /** Accepts one sample or a batch of coalesced samples (oldest first). */
  pointerMove(input: PointerInput | readonly PointerInput[]): void {
    if (this.disposed) return;
    const list = Array.isArray(input) ? (input as readonly PointerInput[]) : [input as PointerInput];
    if (list.length === 0) return;
    const g = this.gesture;
    if (!g) {
      this.pointerHover(list[list.length - 1]);
      return;
    }
    const t = this.tool(g.toolId);
    for (const p of list) {
      g.last = p;
      t.pointerMove(this.ctx, p, this.options[g.toolId]);
    }
    const last = list[list.length - 1];
    this.hoverPoint = { x: last.x, y: last.y };
    this.emit({ kind: 'overlay' });
  }

  pointerUp(p: PointerInput): void {
    const g = this.gesture;
    if (!g || this.disposed) return;
    this.gesture = null;
    this.tool(g.toolId).pointerUp(this.ctx, p, this.options[g.toolId]);
    this.hoverPoint = { x: p.x, y: p.y };
    this.emit({ kind: 'interaction', active: false });
    this.emit({ kind: 'tool' });
    this.emit({ kind: 'overlay' });
  }

  /** Aborts the gesture in progress (pointercancel, Esc during a drag). */
  pointerCancel(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.tool(g.toolId).cancel(this.ctx);
    this.emit({ kind: 'interaction', active: false });
    this.emit({ kind: 'overlay' });
  }

  /** Pointer moved with no button down; null when it left the canvas. */
  pointerHover(p: PointerInput | null): void {
    if (this.disposed) return;
    this.hoverPoint = p ? { x: p.x, y: p.y } : null;
    const id = this.toolId;
    this.tool(id).hover?.(this.ctx, p, this.options[id]);
    this.emit({ kind: 'overlay' });
  }

  /** Modifier keys changed mid-gesture: re-evaluates the drag (Shift constrain…). */
  updateModifiers(mods: Modifiers): void {
    const g = this.gesture;
    if (!g) return;
    this.pointerMove({ ...g.last, modifiers: { ...mods } });
  }

  /**
   * Keyboard for the active tool (Enter commits a transform, Escape cancels,
   * arrows nudge). Returns true when handled.
   */
  keyDown(key: string, mods: Modifiers): boolean {
    if (this.disposed) return false;
    if (key === 'Escape' && this.gesture) {
      this.pointerCancel();
      return true;
    }
    const id = this.toolId;
    const handled = this.tool(id).key?.(this.ctx, key, mods, this.options[id]) ?? false;
    if (handled) this.emit({ kind: 'overlay' });
    return handled;
  }

  /**
   * Draws the current tool's overlay and symmetry guides. While an override
   * (Space → hand…) is active, pending work of the selected tool (a
   * transform box, a lasso polygon) stays visible underneath.
   */
  drawOverlay(painter: OverlayPainter): void {
    const id = this.gesture?.toolId ?? this.toolId;
    const t = this.tool(id);
    if (id !== this._toolId) {
      const selected = this.tool(this._toolId);
      if (selected.hasPending?.()) selected.drawOverlay?.(painter, this.ctx, this.options[this._toolId], null);
    }
    if (t.usesSymmetry && this._symmetry.mode !== 'off') this.drawSymmetryGuides(painter);
    t.drawOverlay?.(painter, this.ctx, this.options[id], this.hoverPoint);
  }

  private drawSymmetryGuides(painter: OverlayPainter): void {
    const { width: w, height: h } = this._doc;
    const c = symmetryCenter(this._symmetry, w, h);
    const style = { color: 'rgba(124, 92, 255, 0.85)', dash: [6, 4] as const, contrast: false };
    const mode = this._symmetry.mode;
    if (mode === 'x' || mode === 'xy') painter.line(c.x, 0, c.x, h, style);
    if (mode === 'y' || mode === 'xy') painter.line(0, c.y, w, c.y, style);
    if (mode === 'radial') {
      const n = this._symmetry.rays;
      const r = Math.hypot(w, h);
      for (let k = 0; k < n; k++) {
        const a = -Math.PI / 2 + (k * 2 * Math.PI) / n;
        painter.line(c.x, c.y, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, style);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layers (all recorded in history)
  // -------------------------------------------------------------------------

  /** Runs an op that builds a command; OpErrors become messages. Returns success. */
  private run(build: () => DocCommand | null, opts?: PushOptions): boolean {
    if (this.disposed) return false;
    let cmd: DocCommand | null;
    try {
      cmd = build();
    } catch (e) {
      if (e instanceof OpError) {
        this.message(e.message, 'warning');
        return false;
      }
      throw e;
    }
    if (!cmd) return false;
    this.execute(cmd, opts);
    return true;
  }

  private execute(cmd: DocCommand, opts?: PushOptions): void {
    const changes = cmd.redo(this._doc);
    this.history.push(cmd, opts);
    this.emitChanges(changes);
    this.emit({ kind: 'history' });
  }

  /** Adds an empty raster layer above the active one. Returns its id. */
  addLayer(opts: { name?: string; index?: number } = {}): string | null {
    this.settle('commit');
    const layer = createRasterLayer(this._doc, { name: opts.name });
    return this.run(() => addLayerOp(this._doc, layer, opts.index)) ? layer.id : null;
  }

  /** Adds a text layer (defaults: centred, primary colour). Returns its id. */
  addTextLayer(props: Partial<TextProps> & { name?: string } = {}): string | null {
    this.settle('commit');
    const layer = createTextLayer(this._doc, { color: this.primary, ...props });
    return this.run(() => addLayerOp(this._doc, layer, undefined, 'Add text')) ? layer.id : null;
  }

  /** Adds pixels (any size) as a new layer, fitted/centred to the document. */
  importImage(src: Surface, name: string, fit: Omit<FitOptions, 'size'> = {}): string | null {
    this.settle('commit');
    const layer = importLayer(this._doc, src, name, fit);
    return this.run(() => addLayerOp(this._doc, layer, undefined, `Import ${name}`)) ? layer.id : null;
  }

  deleteLayer(id: string | null = this._doc.activeLayerId): boolean {
    if (id === null) return false;
    this.settle('commit');
    return this.run(() => deleteLayerOp(this._doc, id));
  }

  duplicateLayer(id: string | null = this._doc.activeLayerId): string | null {
    if (id === null) return null;
    this.settle('commit');
    return this.run(() => duplicateLayerOp(this._doc, id)) ? this._doc.activeLayerId : null;
  }

  renameLayer(id: string, name: string): boolean {
    return this.setLayerProps(id, { name });
  }

  /** Moves a layer to `toIndex` in the bottom → top order. */
  moveLayer(id: string, toIndex: number): boolean {
    this.settle('commit');
    return this.run(() => moveLayerOp(this._doc, id, toIndex));
  }

  mergeDown(id: string | null = this._doc.activeLayerId): boolean {
    if (id === null) return false;
    this.settle('commit');
    return this.run(() => mergeDownOp(this._doc, id));
  }

  flatten(): boolean {
    this.settle('commit');
    return this.run(() => flattenOp(this._doc));
  }

  rasterizeLayer(id: string | null = this._doc.activeLayerId): boolean {
    if (id === null) return false;
    this.settle('commit');
    const l = getLayer(this._doc, id);
    if (l?.kind === 'text') refreshTextCache(l, this._doc, this.rasterizer);
    return this.run(() => rasterizeLayerOp(this._doc, id));
  }

  /**
   * Changes common layer props. With `merge`, consecutive calls using the
   * same key within a second become one history entry (sliders).
   */
  setLayerProps(id: string, patch: Partial<LayerProps>, opts: { merge?: string } = {}): boolean {
    this.settle('commit');
    return this.run(
      () => setLayerPropsOp(this._doc, id, patch),
      opts.merge ? { mergeKey: `props:${id}:${opts.merge}` } : undefined,
    );
  }

  /** Makes a layer active (not an undo step). */
  setActiveLayer(id: string): void {
    if (id === this._doc.activeLayerId || !getLayer(this._doc, id)) return;
    this.settle('commit');
    this.activate(id);
  }

  private activate(id: string): void {
    if (id === this._doc.activeLayerId || !getLayer(this._doc, id)) return;
    this._doc.activeLayerId = id;
    this.emit({ kind: 'layers' });
    this.emit({ kind: 'overlay' });
  }

  /**
   * Edits a raster layer's pixels with arbitrary code as one undo step.
   * `edit` mutates `surface` directly; only changed tiles are stored.
   */
  editLayerPixels(id: string, label: string, edit: (surface: Surface) => void): boolean {
    if (this.disposed) return false;
    this.settle('commit');
    const layer = getLayer(this._doc, id);
    if (!layer || layer.kind !== 'raster') {
      this.message('Only image layers can be edited this way', 'warning');
      return false;
    }
    if (layer.locked) {
      this.message(`${layer.name} is locked`, 'warning');
      return false;
    }
    const tx = new PixelTransaction(layer);
    tx.touch(fullRect(layer.surface.width, layer.surface.height));
    edit(layer.surface);
    const cmd = tx.commit(label);
    if (!cmd) return false;
    this.history.push(cmd);
    this.emitChanges([{ kind: 'pixels', layerId: layer.id, rect: cmd.rect ?? fullRect(this._doc.width, this._doc.height) }]);
    this.emit({ kind: 'history' });
    return true;
  }

  /** Clears the selected pixels (everything without a selection) of a layer (Delete key). */
  clearPixels(id: string | null = this._doc.activeLayerId): boolean {
    if (id === null) return false;
    const sel = this._doc.selection?.data ?? null;
    return this.editLayerPixels(id, 'Clear', (s) => {
      const d = s.data;
      if (!sel) {
        d.fill(0);
        return;
      }
      for (let i = 0; i < sel.length; i++) {
        const m = sel[i];
        if (!m) continue;
        const p = i * 4;
        d[p + 3] = d[p + 3] * (1 - m / 255);
        if (d[p + 3] === 0) d[p] = d[p + 1] = d[p + 2] = 0;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Text editing
  // -------------------------------------------------------------------------

  /** The text layer the inline editor is open on, or null. */
  get textEditLayerId(): string | null {
    return this.textEdit?.layerId ?? null;
  }

  /** Opens an inline edit session on a text layer (the UI shows its editor). */
  beginTextEdit(id: string): void {
    const layer = getLayer(this._doc, id);
    if (!layer || layer.kind !== 'text') return;
    if (this.textEdit?.layerId === id) return;
    this.endTextEdit();
    // Called by the text tool during its own gesture: nothing to settle then.
    if (!this.gesture) this.settle('commit');
    const top = this.history.peek();
    const justCreated =
      top instanceof StackCommand && top.after.layers.includes(layer) && !top.before.layers.includes(layer);
    this.textEdit = {
      layerId: id,
      mergeKey: `text-edit:${id}:${++this.textSerial}`,
      created: justCreated ? top : null,
    };
    this.activate(id);
    this.emit({ kind: 'textEdit', layerId: id });
  }

  /** Updates text props (typing merges into one history entry per edit session). */
  updateText(id: string, patch: Partial<TextProps>): boolean {
    const session = this.textEdit?.layerId === id ? this.textEdit : null;
    return this.run(
      () => setTextPropsOp(this._doc, id, patch),
      session ? { mergeKey: session.mergeKey, mergeWindowMs: Infinity } : { mergeKey: `text-props:${id}` },
    );
  }

  /**
   * Closes the edit session. A text layer the session created and left
   * empty is removed without leaving history entries behind; an existing
   * text layer that was emptied is deleted (one undoable step).
   */
  endTextEdit(): void {
    this.closeTextEdit(true);
  }

  /**
   * Closes the edit session (see `endTextEdit`). With `deleteEmptied` false,
   * an emptied pre-existing layer is kept, so history navigation (undo,
   * redo, jump) never pushes a new entry. Returns true when the session's
   * own entries were rolled back.
   */
  private closeTextEdit(deleteEmptied: boolean): boolean {
    const s = this.textEdit;
    if (!s) return false;
    this.textEdit = null;
    let rolledBack = false;
    const layer = getLayer(this._doc, s.layerId);
    if (layer?.kind === 'text' && layer.text.trim() === '') {
      // Undo "add + edits" when nothing else happened since, so an abandoned
      // text leaves no history entries behind.
      const h = this.history;
      const top = h.peek();
      let steps = 0;
      if (s.created && top === s.created) steps = 1;
      else if (
        s.created &&
        top instanceof PropsCommand &&
        top.layer === layer &&
        h.index >= 2 &&
        h.commandAt(h.index - 2) === s.created
      ) {
        steps = 2;
      }
      if (steps > 0) {
        const changes = h.jumpTo(this._doc, h.index - steps);
        h.discardRedo();
        rolledBack = true;
        this.emitChanges(changes);
        this.emit({ kind: 'history' });
      } else if (deleteEmptied && this._doc.layers.length > 1) {
        this.run(() => deleteLayerOp(this._doc, s.layerId));
      }
    }
    this.emit({ kind: 'textEdit', layerId: null });
    return rolledBack;
  }

  /** Measured layout of a text layer (real fonts when a rasterizer is installed). */
  textLayout(layer: TextLayer): TextLayout {
    return this.textMeasurer.measure(layer);
  }

  /** Re-renders stale text caches; emits pixel events for those that changed. */
  private syncTextCaches(emit: boolean): void {
    if (!this.rasterizer) return;
    for (const l of this._doc.layers) {
      if (l.kind !== 'text' || isTextCacheFresh(l, this._doc)) continue;
      if (refreshTextCache(l, this._doc, this.rasterizer) && emit) {
        this.emit({ kind: 'pixels', layerId: l.id, rect: fullRect(this._doc.width, this._doc.height) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Selection (recorded)
  // -------------------------------------------------------------------------

  setSelection(mask: SelectionMask | null, label = 'Selection'): void {
    if (masksEqual(this._doc.selection, mask)) return;
    this.settle('commit');
    this.execute(new SelectionCommand(label, this._doc.selection, mask));
  }

  selectAll(): void {
    this.setSelection(selectAllMask(this._doc.width, this._doc.height), 'Select all');
  }

  deselect(): void {
    this.setSelection(null, 'Deselect');
  }

  invertSelection(): void {
    if (!this._doc.selection) return;
    this.setSelection(invertMask(this._doc.selection, this._doc.width, this._doc.height), 'Invert selection');
  }

  /** Adds a rectangle/ellipse (document px) to the selection with `op`. */
  selectShape(shape: 'rect' | 'ellipse', r: Rect, op: SelectionOp = 'replace', antialias = shape === 'ellipse'): void {
    const { width: w, height: h } = this._doc;
    const m = shape === 'rect' ? rectMask(w, h, r, antialias) : ellipseMask(w, h, r, antialias);
    this.setSelection(combineMasks(this._doc.selection, m, op), shape === 'rect' ? 'Rectangle select' : 'Ellipse select');
  }

  featherSelection(radius: number): void {
    if (!this._doc.selection || radius <= 0) return;
    this.setSelection(featherMask(this._doc.selection, radius), 'Feather');
  }

  /**
   * Selects a closed polygon (flat document points [x0, y0, x1, y1, …],
   * nonzero rule) combined with `op`. Anti-aliased by default; pixel-art
   * documents always select whole pixels. Returns false for fewer than
   * three points.
   */
  selectPolygon(points: readonly number[], op: SelectionOp = 'replace', antialias = true): boolean {
    if (this.disposed || points.length < 6 || points.some((v) => !Number.isFinite(v))) return false;
    const { width: w, height: h } = this._doc;
    const shape = polygonMask(w, h, [points], antialias && this._doc.pixelArt === null);
    this.setSelection(combineMasks(this._doc.selection, shape, op), 'Polygon select');
    return true;
  }

  /** Expands the selection by `px` document px (one undo step). False when there is nothing to grow. */
  growSelection(px: number): boolean {
    return this.refineSelection(px, 'Grow selection', growMask);
  }

  /** Contracts the selection by `px` document px (one undo step). Canvas edges are not selection edges. */
  shrinkSelection(px: number): boolean {
    return this.refineSelection(px, 'Shrink selection', shrinkMask);
  }

  /** Replaces the selection with a band `px` wide centred on its edge (one undo step). */
  borderSelection(px: number): boolean {
    return this.refineSelection(px, 'Border selection', borderMask);
  }

  private refineSelection(
    px: number,
    label: string,
    refine: (m: SelectionMask, px: number, opts: { binary: boolean }) => SelectionMask | null,
  ): boolean {
    if (this.disposed || !this._doc.selection || !Number.isFinite(px) || px <= 0) return false;
    this.settle('commit');
    const current = this._doc.selection;
    if (!current) return false;
    const next = refine(current, Math.min(px, Math.max(this._doc.width, this._doc.height)), {
      binary: this._doc.pixelArt !== null,
    });
    if (!next) {
      this.message('Nothing would be left selected', 'warning');
      return false;
    }
    if (masksEqual(current, next)) return false;
    this.setSelection(next, label);
    return true;
  }

  /**
   * Selects a layer's pixels by their opacity ("select layer pixels"),
   * combined with `op`. Text layers use their rendered text. False (with a
   * message) when the layer shows nothing.
   */
  selectByAlpha(layerId: string | null = this._doc.activeLayerId, op: SelectionOp = 'replace'): boolean {
    if (this.disposed || layerId === null) return false;
    const layer = getLayer(this._doc, layerId);
    if (!layer) return false;
    this.settle('commit');
    const pixels = layerPixels(layer);
    const shape = pixels ? alphaMask(pixels, { binary: this._doc.pixelArt !== null }) : null;
    if (!shape) {
      this.message(`${layer.name} is empty`, 'warning');
      return false;
    }
    this.setSelection(combineMasks(this._doc.selection, shape, op), 'Select layer pixels');
    return true;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  get canUndo(): boolean {
    return this.history.canUndo || this.hasPending;
  }

  get canRedo(): boolean {
    return this.history.canRedo && !this.hasPending;
  }

  get historyEntries(): HistoryEntryInfo[] {
    return this.history.entries;
  }

  /** Number of applied entries (see History.index). */
  get historyIndex(): number {
    return this.history.index;
  }

  /**
   * Undo. A pending transform is cancelled instead, and a text layer that
   * was just created and is still empty is removed instead (that is the
   * step being undone).
   */
  undo(): boolean {
    if (this.disposed) return false;
    if (this.gesture) this.pointerCancel();
    if (this.hasPending) {
      this.settle('cancel');
      return true;
    }
    if (this.closeTextEdit(false)) return true;
    const changes = this.history.undo(this._doc);
    if (!changes) return false;
    this.emitChanges(changes);
    this.emit({ kind: 'history' });
    return true;
  }

  redo(): boolean {
    if (this.disposed) return false;
    this.settle('commit');
    this.closeTextEdit(false);
    const changes = this.history.redo(this._doc);
    if (!changes) return false;
    this.emitChanges(changes);
    this.emit({ kind: 'history' });
    return true;
  }

  /** Jumps to a history position (0 = oldest reachable state). */
  jumpTo(index: number): void {
    if (this.disposed) return;
    this.settle('commit');
    this.closeTextEdit(false);
    const changes = this.history.jumpTo(this._doc, index);
    this.emitChanges(changes);
    this.emit({ kind: 'history' });
  }

  clearHistory(): void {
    this.history.clear();
    this.emit({ kind: 'history' });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.settle('cancel');
    this.textEdit = null;
    this.disposed = true;
    this.events.clear();
    this.history.clear();
    this.compositeCache = null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // -------------------------------------------------------------------------
  // Tool context
  // -------------------------------------------------------------------------

  private createContext(): ToolContext {
    // Getters below run with `this` bound to the context object.
    const engine = this;
    return {
      get doc() {
        return engine._doc;
      },
      get primary() {
        return engine._primary;
      },
      get secondary() {
        return engine._secondary;
      },
      get symmetry() {
        return engine._symmetry;
      },
      get viewport() {
        return engine._viewport;
      },
      get viewScale() {
        return engine._viewport?.scale ?? 1;
      },
      scratch: this.scratch,
      activeLayer: () => this.activeLayer,
      setActiveLayer: (id) => this.activate(id),
      paintableLayer: () => this.paintableLayer(),
      beginPixels: (layer) => {
        this.compositeCache = null;
        return new PixelTransaction(layer);
      },
      pixelsChanged: (tx) => {
        const r = tx.takeDirty();
        if (r) this.emit({ kind: 'pixels', layerId: tx.layer.id, rect: r });
      },
      commitPixels: (tx, label, extra = []) => this.commitPixels(tx, label, extra),
      cancelPixels: (tx) => {
        const r = tx.cancel();
        tx.takeDirty();
        if (r) this.emit({ kind: 'pixels', layerId: tx.layer.id, rect: r });
      },
      execute: (cmd, opts) => {
        if (cmd) this.execute(cmd, opts);
      },
      setSelection: (mask, label) => {
        if (!masksEqual(this._doc.selection, mask)) {
          this.execute(new SelectionCommand(label, this._doc.selection, mask));
        }
      },
      composite: () => this.composite(),
      setColor: (which, c) => this.setColor(which, c),
      message: (text, level) => this.message(text, level),
      overlayChanged: () => this.emit({ kind: 'overlay' }),
      textLayout: (layer) => this.textLayout(layer),
      requestTextEdit: (id) => {
        if (id) this.beginTextEdit(id);
        else this.endTextEdit();
      },
      emitChanges: (changes) => this.emitChanges(changes),
      contentBounds: (layer) => this.contentBounds(layer),
    };
  }

  /** Bounds of a raster layer's pixels inside the selection (cached; see ToolContext). */
  private contentBounds(layer: RasterLayer): Rect | null {
    const cached = this.boundsCache.get(layer.id);
    if (cached !== undefined) return cached ? { ...cached } : null;
    const r = liftableBounds(layer.surface, this._doc.selection);
    this.boundsCache.set(layer.id, r);
    return r ? { ...r } : null;
  }

  private paintableLayer(): RasterLayer | null {
    const l = this.activeLayer;
    if (!l) {
      this.message('Select a layer first', 'warning');
      return null;
    }
    if (l.kind !== 'raster') {
      this.message('Text layers cannot be painted — rasterize the layer first', 'warning');
      return null;
    }
    if (l.locked) {
      this.message(`${l.name} is locked`, 'warning');
      return null;
    }
    if (!l.visible) {
      this.message(`${l.name} is hidden`, 'warning');
      return null;
    }
    return l;
  }

  private commitPixels(tx: PixelTransaction, label: string, extra: DocCommand[]): void {
    const dirty = tx.takeDirty();
    if (dirty) this.emit({ kind: 'pixels', layerId: tx.layer.id, rect: dirty });
    const cmds: DocCommand[] = [];
    const pixels = tx.commit(label);
    if (pixels) cmds.push(pixels);
    const changes: Change[] = [];
    for (const c of extra) {
      changes.push(...c.redo(this._doc));
      cmds.push(c);
    }
    if (cmds.length === 0) return;
    this.history.push(cmds.length === 1 ? cmds[0] : new CompoundCommand(label, cmds));
    if (changes.length) this.emitChanges(changes);
    this.emit({ kind: 'history' });
  }
}

