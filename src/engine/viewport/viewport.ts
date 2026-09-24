// Zoom/pan state and screen ↔ document transforms for the canvas stage.
//
// Units: "screen" = CSS px inside the canvas element (origin top-left);
// "doc" = document px. `zoom` is relative to the 512 master: 100 % shows a
// normal document 1:1 and a 32×32 pixel-art document at 512 px (16 px per
// cell), so switching modes keeps the design the same size on screen.
// `scale` is the actual screen px per document px.

import type { Affine, Point } from '../geometry/affine';
import type { Rect } from '../util/rect';
import { Emitter } from '../util/emitter';
import { MASTER_SIZE } from '../doc/types';

export interface ViewportState {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ViewportOptions {
  viewWidth?: number;
  viewHeight?: number;
  docWidth?: number;
  docHeight?: number;
  /** Document size shown at 1:1 when zoom = 1 (default 512). */
  masterSize?: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 32;
/** The pixel grid appears from this many screen px per document px. */
export const GRID_THRESHOLD = 8;
/** Breathing room around the fitted document, CSS px. */
export const FIT_PADDING = 24;
/** Zoom presets for zoom in/out steps. */
export const ZOOM_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;

export class Viewport {
  private vw: number;
  private vh: number;
  private dw: number;
  private dh: number;
  private readonly master: number;
  private z = 1;
  private px = 0;
  private py = 0;
  private readonly changes = new Emitter<ViewportState>();
  /** Keep at least this many px of the document on screen when panning. */
  keepVisible = 32;

  constructor(opts: ViewportOptions = {}) {
    this.vw = Math.max(1, opts.viewWidth ?? 800);
    this.vh = Math.max(1, opts.viewHeight ?? 600);
    this.dw = opts.docWidth ?? MASTER_SIZE;
    this.dh = opts.docHeight ?? MASTER_SIZE;
    this.master = opts.masterSize ?? MASTER_SIZE;
    this.fit();
  }

  get viewWidth(): number {
    return this.vw;
  }
  get viewHeight(): number {
    return this.vh;
  }
  get docWidth(): number {
    return this.dw;
  }
  get docHeight(): number {
    return this.dh;
  }
  get zoom(): number {
    return this.z;
  }
  get panX(): number {
    return this.px;
  }
  get panY(): number {
    return this.py;
  }

  /** Screen px per document px. */
  get scale(): number {
    return this.scaleFor(this.z);
  }

  private get base(): number {
    return this.master / Math.max(this.dw, this.dh);
  }

  private scaleFor(zoom: number): number {
    return zoom * this.base;
  }

  /** Document → screen transform (canvas order). */
  get transform(): Affine {
    const s = this.scale;
    return [s, 0, 0, s, this.px, this.py];
  }

  get state(): ViewportState {
    return { zoom: this.z, panX: this.px, panY: this.py };
  }

  subscribe(listener: (s: ViewportState) => void): () => void {
    return this.changes.subscribe(listener);
  }

  restore(s: ViewportState): void {
    this.z = clampZoom(s.zoom);
    this.px = s.panX;
    this.py = s.panY;
    this.commit();
  }

  /** Resizes the view; the screen point at the old centre stays centred. */
  setViewSize(width: number, height: number): void {
    const c = this.screenToDoc(this.vw / 2, this.vh / 2);
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
    const s = this.scale;
    this.px = this.vw / 2 - c.x * s;
    this.py = this.vh / 2 - c.y * s;
    this.commit();
  }

  /** New document size (e.g. pixel-art toggle); zoom is kept, the doc re-centred. */
  setDocSize(width: number, height: number): void {
    this.dw = width;
    this.dh = height;
    this.center();
  }

  /** Zoom that fits the whole document with `padding` CSS px around it. */
  fitZoom(padding = FIT_PADDING): number {
    const avail = Math.max(1, Math.min(this.vw - 2 * padding, this.vh - 2 * padding));
    return clampZoom(avail / (Math.max(this.dw, this.dh) * this.base));
  }

  fit(padding = FIT_PADDING): void {
    this.z = this.fitZoom(padding);
    this.center();
  }

  center(): void {
    const s = this.scale;
    this.px = (this.vw - this.dw * s) / 2;
    this.py = (this.vh - this.dh * s) / 2;
    this.commit();
  }

  /** Sets the zoom, keeping the document point under (ax, ay) fixed. */
  setZoom(zoom: number, ax = this.vw / 2, ay = this.vh / 2): void {
    const z = clampZoom(zoom);
    const d = this.screenToDoc(ax, ay);
    this.z = z;
    const s = this.scale;
    this.px = ax - d.x * s;
    this.py = ay - d.y * s;
    this.commit();
  }

  zoomBy(factor: number, ax?: number, ay?: number): void {
    this.setZoom(this.z * factor, ax, ay);
  }

  /** Next preset step up/down (wheel notches, Ctrl +/−). */
  zoomStep(direction: 1 | -1, ax?: number, ay?: number): void {
    const z = this.z;
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM)
        : ([...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? MIN_ZOOM);
    this.setZoom(next, ax, ay);
  }

  /** 100 % around the view centre (Ctrl+1). */
  actualSize(): void {
    this.setZoom(1);
  }

  panBy(dx: number, dy: number): void {
    this.px += dx;
    this.py += dy;
    this.commit();
  }

  screenToDoc(sx: number, sy: number): Point {
    const s = this.scale;
    return { x: (sx - this.px) / s, y: (sy - this.py) / s };
  }

  docToScreen(x: number, y: number): Point {
    const s = this.scale;
    return { x: x * s + this.px, y: y * s + this.py };
  }

  docRectToScreen(r: Rect): Rect {
    const s = this.scale;
    return { x: r.x * s + this.px, y: r.y * s + this.py, w: r.w * s, h: r.h * s };
  }

  /** The part of the document currently on screen (integer px, clipped), or null. */
  visibleDocRect(): Rect | null {
    const a = this.screenToDoc(0, 0);
    const b = this.screenToDoc(this.vw, this.vh);
    const x0 = Math.max(0, Math.floor(a.x));
    const y0 = Math.max(0, Math.floor(a.y));
    const x1 = Math.min(this.dw, Math.ceil(b.x));
    const y1 = Math.min(this.dh, Math.ceil(b.y));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Whether the pixel grid should be drawn at the current scale. */
  gridVisible(threshold = GRID_THRESHOLD): boolean {
    return this.scale >= threshold;
  }

  private constrain(): void {
    const s = this.scale;
    const m = Math.min(this.keepVisible, (this.dw * s) / 2, (this.dh * s) / 2);
    this.px = Math.min(this.vw - m, Math.max(m - this.dw * s, this.px));
    this.py = Math.min(this.vh - m, Math.max(m - this.dh * s, this.py));
  }

  private commit(): void {
    this.constrain();
    this.changes.emit(this.state);
  }
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}
