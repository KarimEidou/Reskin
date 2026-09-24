// DOM ONLY. Fast interactive view of an Engine's document on a Canvas 2D
// context: checkerboard, layers composited with the GPU (blend modes via
// `globalCompositeOperation`, which follows the same W3C formulas as the
// reference compositor), viewport transform, pixel grid, Windows keylines,
// marching ants, before/after comparison and the tool overlay.
//
// Caching: every layer has its own document-sized canvas updated with
// `putImageData` for dirty rects only (zero-copy ImageData over the layer's
// pixels). Layers below the active one are pre-composited into one canvas,
// and so are the layers above it when they all use the normal blend mode
// (source-over is associative). Painting on the active layer therefore
// costs one dirty-rect upload plus three drawImage calls per frame. Layers
// with effects are styled by the pure-JS effect renderer, throttled while a
// gesture is in progress.
//
// Never imported by the pure core; importing it in Node is harmless, but
// constructing it needs OffscreenCanvas or a document.

import type { Engine, EngineEvent } from '../engine';
import type { Layer } from '../doc/types';
import { layerPixels } from '../doc/document';
import { hasActiveEffects } from '../doc/effects';
import type { Surface } from '../raster/surface';
import { floatToSurface } from '../raster/float-image';
import type { Viewport } from '../viewport/viewport';
import type { OverlayPainter, OverlayStyle, HandleShape } from './overlay';
import { CANVAS_COMPOSITE_OP } from './blend';
import { renderStyledLayer } from './effects';
import { keylines } from './keylines';
import type { SelectionMask } from '../selection/mask';
import { selectionOutline } from '../selection/outline';
import type { Rect } from '../util/rect';
import { fullRect, unionRect } from '../util/rect';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function hasCanvasSupport(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
}

/** A document-sized scratch canvas (OffscreenCanvas when available). */
export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('Canvas rendering needs a browser environment');
}

function context2d(c: AnyCanvas): AnyContext {
  const ctx = c.getContext('2d', { willReadFrequently: false }) as AnyContext | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Wraps a surface's pixels as ImageData without copying. */
export function surfaceToImageData(s: Surface): ImageData {
  return new ImageData(s.data, s.width, s.height);
}

export interface CanvasViewTheme {
  checkerLight: string;
  checkerDark: string;
  /** CSS px per checker square. */
  checkerSize: number;
  grid: string;
  keyline: string;
  overlay: string;
  overlayShadow: string;
  handleFill: string;
  antsLight: string;
  antsDark: string;
  divider: string;
}

export const DEFAULT_VIEW_THEME: CanvasViewTheme = {
  checkerLight: '#f2f2f5',
  checkerDark: '#d9d9e0',
  checkerSize: 8,
  grid: 'rgba(120, 120, 140, 0.35)',
  keyline: 'rgba(31, 200, 227, 0.8)',
  overlay: '#ffffff',
  overlayShadow: 'rgba(0, 0, 0, 0.65)',
  handleFill: '#ffffff',
  antsLight: '#ffffff',
  antsDark: '#000000',
  divider: '#7c5cff',
};

export interface RenderOptions {
  /** Device pixel ratio of the target canvas (default `devicePixelRatio` or 1). */
  dpr?: number;
  /** Pixel grid when zoomed in enough (default true). */
  showGrid?: boolean;
  showKeylines?: boolean;
  /** Tool overlay + symmetry guides (default true). */
  showOverlay?: boolean;
  showSelection?: boolean;
  /**
   * Before/after: `split` null shows `image` alone (hold `\`); a number
   * 0..1 shows `image` left of that fraction of the document width.
   */
  compare?: { image: Surface; split: number | null } | null;
  /** Marching-ants dash offset in px (default time based). */
  antsOffset?: number;
}

interface LayerEntry {
  canvas: AnyCanvas;
  ctx: AnyContext;
  surface: Surface | null;
  image: ImageData | null;
  dirty: Rect | null;
  version: number;
  /** Styled (effects) rendering. */
  styled: AnyCanvas | null;
  styledKey: string;
  styledAt: number;
}

interface GroupCache {
  canvas: AnyCanvas;
  ctx: AnyContext;
  key: string;
}

/** Re-style a layer with effects at most this often during a gesture, ms. */
const RESTYLE_INTERVAL_MS = 120;

export class CanvasView {
  private readonly theme: CanvasViewTheme;
  private layers = new Map<string, LayerEntry>();
  private below: GroupCache | null = null;
  private above: GroupCache | null = null;
  private frame: GroupCache | null = null;
  private compareCanvas: { surface: Surface; canvas: AnyCanvas } | null = null;
  private checker: CanvasPattern | null = null;
  private checkerOwner: AnyContext | null = null;
  private outline: { mask: SelectionMask; segments: number[] } | null = null;
  private size = { w: 0, h: 0 };
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    opts: { theme?: Partial<CanvasViewTheme>; onInvalidate?: () => void } = {},
  ) {
    if (!hasCanvasSupport()) throw new Error('CanvasView needs a browser environment');
    this.theme = { ...DEFAULT_VIEW_THEME, ...opts.theme };
    const onInvalidate = opts.onInvalidate;
    this.unsubscribe = engine.subscribe((e) => {
      this.onEvent(e);
      if (onInvalidate && e.kind !== 'message' && e.kind !== 'textEdit') onInvalidate();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.invalidate();
  }

  /** Drops every cache (e.g. after a theme change). */
  invalidate(): void {
    this.layers.clear();
    this.below = this.above = this.frame = null;
    this.compareCanvas = null;
    this.checker = null;
    this.checkerOwner = null;
    this.outline = null;
  }

  private onEvent(e: EngineEvent): void {
    switch (e.kind) {
      case 'pixels': {
        const entry = this.layers.get(e.layerId);
        if (entry) {
          entry.dirty = unionRect(entry.dirty, e.rect);
          entry.version++;
        }
        break;
      }
      case 'document':
        this.invalidate();
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Caches
  // -------------------------------------------------------------------------

  private ensureSize(): void {
    const { width, height } = this.engine.doc;
    if (width !== this.size.w || height !== this.size.h) {
      this.invalidate();
      this.size = { w: width, h: height };
    }
  }

  private entryFor(layer: Layer): LayerEntry | null {
    const px = layerPixels(layer);
    if (!px) return null;
    let e = this.layers.get(layer.id);
    if (!e) {
      const canvas = createCanvas(px.width, px.height);
      e = {
        canvas,
        ctx: context2d(canvas),
        surface: null,
        image: null,
        dirty: null,
        version: 0,
        styled: null,
        styledKey: '',
        styledAt: 0,
      };
      this.layers.set(layer.id, e);
    }
    if (e.surface !== px) {
      // New pixel buffer (merge, resize, re-rendered text): full upload.
      e.surface = px;
      e.image = surfaceToImageData(px);
      e.dirty = fullRect(px.width, px.height);
      e.version++;
    }
    if (e.dirty && e.image) {
      const r = e.dirty;
      e.ctx.putImageData(e.image, 0, 0, r.x, r.y, r.w, r.h);
      e.dirty = null;
    }
    return e;
  }

  /** The canvas to draw for a layer: styled when it has effects. */
  private layerCanvas(layer: Layer, now: number): AnyCanvas | null {
    const e = this.entryFor(layer);
    if (!e) return null;
    if (!hasActiveEffects(layer.effects)) return e.canvas;
    const key = `${e.version}|${JSON.stringify(layer.effects)}`;
    const stale = e.styledKey !== key;
    const throttled = this.engine.isInteracting && e.styled && now - e.styledAt < RESTYLE_INTERVAL_MS;
    if (stale && !throttled && e.surface) {
      const styled = floatToSurface(renderStyledLayer(e.surface, layer.effects));
      if (!e.styled) e.styled = createCanvas(styled.width, styled.height);
      context2d(e.styled).putImageData(surfaceToImageData(styled), 0, 0);
      e.styledKey = key;
      e.styledAt = now;
    }
    return e.styled ?? e.canvas;
  }

  private group(prev: GroupCache | null): GroupCache {
    if (prev) return prev;
    const canvas = createCanvas(this.size.w, this.size.h);
    return { canvas, ctx: context2d(canvas), key: '\u0000' };
  }

  private static drawLayer(ctx: AnyContext, layer: Layer, canvas: AnyCanvas): void {
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = CANVAS_COMPOSITE_OP[layer.blend];
    ctx.drawImage(canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private layerKey(layer: Layer): string {
    const e = this.layers.get(layer.id);
    // `styledKey` says which pixels the styled canvas currently shows: a
    // restyle throttled during a gesture must still refresh cached groups
    // once it happens.
    return `${layer.id}:${e?.version ?? -1}:${layer.opacity}:${layer.blend}:${JSON.stringify(layer.effects)}:${e?.styledKey ?? ''}`;
  }

  /** Composites the whole document into the frame canvas (document px). */
  private composeFrame(now: number): AnyCanvas {
    this.ensureSize();
    const doc = this.engine.doc;
    for (const id of this.layers.keys()) {
      if (!doc.layers.some((l) => l.id === id)) this.layers.delete(id);
    }
    const visible = doc.layers.filter((l) => l.visible && l.opacity > 0);
    const activeIdx = visible.findIndex((l) => l.id === doc.activeLayerId);
    const split = activeIdx < 0 ? visible.length : activeIdx;
    const belowLayers = visible.slice(0, split);
    const active = activeIdx < 0 ? null : visible[activeIdx];
    const aboveLayers = activeIdx < 0 ? [] : visible.slice(activeIdx + 1);

    // Make sure uploads/styling happen before keys are computed.
    const canvases = new Map<string, AnyCanvas | null>();
    for (const l of visible) canvases.set(l.id, this.layerCanvas(l, now));

    const belowKey = belowLayers.map((l) => this.layerKey(l)).join('|');
    this.below = this.group(this.below);
    if (this.below.key !== belowKey) {
      const g = this.below;
      g.ctx.clearRect(0, 0, this.size.w, this.size.h);
      for (const l of belowLayers) {
        const c = canvases.get(l.id);
        if (c) CanvasView.drawLayer(g.ctx, l, c);
      }
      g.key = belowKey;
    }

    const aboveNormal = aboveLayers.every((l) => l.blend === 'normal');
    if (aboveNormal && aboveLayers.length > 0) {
      const aboveKey = aboveLayers.map((l) => this.layerKey(l)).join('|');
      this.above = this.group(this.above);
      if (this.above.key !== aboveKey) {
        const g = this.above;
        g.ctx.clearRect(0, 0, this.size.w, this.size.h);
        for (const l of aboveLayers) {
          const c = canvases.get(l.id);
          if (c) CanvasView.drawLayer(g.ctx, l, c);
        }
        g.key = aboveKey;
      }
    }

    this.frame = this.group(this.frame);
    const f = this.frame.ctx;
    f.clearRect(0, 0, this.size.w, this.size.h);
    f.drawImage(this.below.canvas, 0, 0);
    if (active) {
      const c = canvases.get(active.id);
      if (c) CanvasView.drawLayer(f, active, c);
    }
    if (aboveLayers.length > 0) {
      if (aboveNormal && this.above) f.drawImage(this.above.canvas, 0, 0);
      else {
        for (const l of aboveLayers) {
          const c = canvases.get(l.id);
          if (c) CanvasView.drawLayer(f, l, c);
        }
      }
    }
    return this.frame.canvas;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Draws the view into `ctx` (whose canvas covers the viewport, in device
   * px). Call on the next animation frame after engine events.
   */
  render(ctx: CanvasRenderingContext2D, viewport: Viewport, opts: RenderOptions = {}): void {
    if (this.disposed) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dpr = opts.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const doc = this.engine.doc;
    const frame = this.composeFrame(now);
    const s = viewport.scale;
    const pixelArt = doc.pixelArt !== null;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const docRect = viewport.docRectToScreen(fullRect(doc.width, doc.height));
    this.drawChecker(ctx, docRect);

    // Document pixels: nearest when magnified (crisp pixels), smooth when reduced.
    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * viewport.panX, dpr * viewport.panY);
    ctx.imageSmoothingEnabled = !pixelArt && s < 1;
    ctx.imageSmoothingQuality = 'high';
    const compare = opts.compare ?? null;
    if (!compare) {
      ctx.drawImage(frame, 0, 0);
    } else if (compare.split === null) {
      ctx.drawImage(this.compareSource(compare.image), 0, 0, doc.width, doc.height);
    } else {
      // "Before" left of the split, "after" right of it, both over the checker.
      const sx = Math.max(0, Math.min(1, compare.split)) * doc.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, 0, doc.width - sx, doc.height);
      ctx.clip();
      ctx.drawImage(frame, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, sx, doc.height);
      ctx.clip();
      ctx.drawImage(this.compareSource(compare.image), 0, 0, doc.width, doc.height);
      ctx.restore();
    }
    ctx.restore();
    if (compare && compare.split !== null) {
      const x = docRect.x + Math.max(0, Math.min(1, compare.split)) * docRect.w;
      ctx.strokeStyle = this.theme.divider;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, docRect.y);
      ctx.lineTo(x, docRect.y + docRect.h);
      ctx.stroke();
    }

    if ((opts.showGrid ?? true) && (viewport.gridVisible() || (pixelArt && s >= 4))) {
      this.drawGrid(ctx, viewport, dpr);
    }
    if (opts.showKeylines) this.drawKeylines(ctx, viewport);
    if ((opts.showSelection ?? true) && doc.selection) this.drawAnts(ctx, viewport, doc.selection, opts.antsOffset ?? now / 60);
    if (opts.showOverlay ?? true) this.engine.drawOverlay(new CanvasOverlayPainter(ctx, viewport, this.theme));
    ctx.restore();
  }

  private compareSource(img: Surface): AnyCanvas {
    if (this.compareCanvas?.surface !== img) {
      const canvas = createCanvas(img.width, img.height);
      context2d(canvas).putImageData(surfaceToImageData(img), 0, 0);
      this.compareCanvas = { surface: img, canvas };
    }
    return this.compareCanvas.canvas;
  }

  private drawChecker(ctx: CanvasRenderingContext2D, r: Rect): void {
    if (!this.checker || this.checkerOwner !== ctx) {
      const n = this.theme.checkerSize;
      const tile = createCanvas(n * 2, n * 2);
      const t = context2d(tile);
      t.fillStyle = this.theme.checkerLight;
      t.fillRect(0, 0, n * 2, n * 2);
      t.fillStyle = this.theme.checkerDark;
      t.fillRect(n, 0, n, n);
      t.fillRect(0, n, n, n);
      this.checker = ctx.createPattern(tile as CanvasImageSource, 'repeat');
      this.checkerOwner = ctx;
    }
    if (!this.checker) return;
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.fillStyle = this.checker;
    ctx.fillRect(0, 0, r.w, r.h);
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number): void {
    const vis = vp.visibleDocRect();
    if (!vis) return;
    const s = vp.scale;
    // Align to device pixels so the 1-device-px lines stay crisp.
    const snap = (v: number) => (Math.round(v * dpr) + 0.5) / dpr;
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    const top = vp.panY + vis.y * s;
    const bottom = vp.panY + (vis.y + vis.h) * s;
    const left = vp.panX + vis.x * s;
    const right = vp.panX + (vis.x + vis.w) * s;
    for (let x = vis.x; x <= vis.x + vis.w; x++) {
      const sx = snap(vp.panX + x * s);
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, bottom);
    }
    for (let y = vis.y; y <= vis.y + vis.h; y++) {
      const sy = snap(vp.panY + y * s);
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawKeylines(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const s = vp.scale;
    ctx.save();
    ctx.strokeStyle = this.theme.keyline;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    for (const k of keylines(this.engine.doc.width)) {
      ctx.beginPath();
      if (k.kind === 'circle') {
        ctx.arc(vp.panX + k.cx * s, vp.panY + k.cy * s, k.r * s, 0, Math.PI * 2);
      } else {
        ctx.roundRect(vp.panX + k.x * s, vp.panY + k.y * s, k.w * s, k.h * s, k.radius * s);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawAnts(ctx: CanvasRenderingContext2D, vp: Viewport, mask: SelectionMask, offset: number): void {
    if (this.outline?.mask !== mask) this.outline = { mask, segments: selectionOutline(mask) };
    const seg = this.outline.segments;
    if (seg.length === 0) return;
    const s = vp.scale;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 4) {
      ctx.moveTo(vp.panX + seg[i] * s, vp.panY + seg[i + 1] * s);
      ctx.lineTo(vp.panX + seg[i + 2] * s, vp.panY + seg[i + 3] * s);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.theme.antsDark;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.strokeStyle = this.theme.antsLight;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -offset;
    ctx.stroke();
    ctx.restore();
  }
}

/** OverlayPainter over a 2D context in CSS px (the context has the dpr transform). */
export class CanvasOverlayPainter implements OverlayPainter {
  readonly scale: number;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly vp: Viewport,
    private readonly theme: CanvasViewTheme = DEFAULT_VIEW_THEME,
  ) {
    this.scale = vp.scale;
  }

  private sx(x: number): number {
    return this.vp.panX + x * this.scale;
  }

  private sy(y: number): number {
    return this.vp.panY + y * this.scale;
  }

  private stroke(style: OverlayStyle = {}): void {
    const ctx = this.ctx;
    const w = style.width ?? 1;
    ctx.setLineDash(style.dash ? [...style.dash] : []);
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    if (style.contrast ?? true) {
      ctx.strokeStyle = this.theme.overlayShadow;
      ctx.lineWidth = w + 2;
      ctx.stroke();
    }
    ctx.strokeStyle = style.color ?? this.theme.overlay;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  line(x0: number, y0: number, x1: number, y1: number, style?: OverlayStyle): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(this.sx(x0), this.sy(y0));
    ctx.lineTo(this.sx(x1), this.sy(y1));
    this.stroke(style);
  }

  rect(x: number, y: number, w: number, h: number, style?: OverlayStyle): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.rect(this.sx(x), this.sy(y), w * this.scale, h * this.scale);
    this.stroke(style);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, style?: OverlayStyle): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(this.sx(cx), this.sy(cy), Math.abs(rx) * this.scale, Math.abs(ry) * this.scale, 0, 0, Math.PI * 2);
    this.stroke(style);
  }

  polyline(points: readonly number[], closed: boolean, style?: OverlayStyle): void {
    if (points.length < 4) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(this.sx(points[0]), this.sy(points[1]));
    for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(this.sx(points[i]), this.sy(points[i + 1]));
    if (closed) ctx.closePath();
    this.stroke(style);
  }

  handle(x: number, y: number, shape: HandleShape = 'square', sizePx = 8): void {
    const ctx = this.ctx;
    const cx = this.sx(x);
    const cy = this.sy(y);
    const h = sizePx / 2;
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(cx, cy, h, 0, Math.PI * 2);
    else ctx.rect(cx - h, cy - h, sizePx, sizePx);
    ctx.fillStyle = this.theme.handleFill;
    ctx.fill();
    ctx.strokeStyle = this.theme.overlayShadow;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
  }
}
