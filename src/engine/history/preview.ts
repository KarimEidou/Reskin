// A live, cancellable edit of one raster layer's pixels (adjustment and
// icon-helper previews), created by `Engine.beginPreview`.
//
// Every `update` is shown on the canvas at once (pixel events for the
// tiles that changed) but stays out of the history. `commit()` records the
// result as ONE entry holding only the 64×64 tiles that differ from the
// original, so undo/redo are byte-exact; `cancel()` copies the original
// tiles back and leaves the history (redo stack included) untouched. The
// engine ends a preview itself when anything else changes the document or
// moves the history (state 'stale', the original restored).

import type { RasterLayer } from '../doc/types';
import { Surface } from '../raster/surface';
import { readTile, tileEquals, tileGrid, tileRect } from '../raster/tiles';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';
import type { TilePatch } from './commands';
import { PixelCommand } from './commands';

/**
 * `open` while it can be updated; `committed` (recorded, or nothing to
 * record), `cancelled` (by its owner) and `stale` (ended by another change)
 * are final.
 */
export type PreviewState = 'open' | 'committed' | 'cancelled' | 'stale';

/** Straight RGBA pixels of the layer's size. */
export interface PreviewPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The next preview: finished pixels, or a function that edits the layer's
 * surface in place — it receives the surface holding the ORIGINAL pixels.
 */
export type PreviewContent = PreviewPixels | ((surface: Surface) => void);

/** What a preview needs from its engine. */
export interface PreviewHost {
  /** Pixels of the layer changed inside `rect` (redraw). */
  pixelsChanged(layer: RasterLayer, rect: Rect): void;
  /**
   * The preview ended (see its `state`): record `cmd` as the newest history
   * entry when there is one, announce `restored` (tiles copied back).
   */
  ended(preview: LayerPreview, cmd: PixelCommand | null, restored: Rect | null): void;
}

export class LayerPreview {
  readonly label: string;
  readonly layerId: string;
  /** The layer's pixels when the preview began (a private copy; do not modify). */
  readonly original: Surface;
  private readonly layer: RasterLayer;
  private readonly surface: Surface;
  private readonly host: PreviewHost;
  /** Per 64×64 tile: the layer currently differs from the original there. */
  private readonly differs: Uint8Array;
  private _state: PreviewState = 'open';

  constructor(label: string, layer: RasterLayer, host: PreviewHost) {
    this.label = label;
    this.layerId = layer.id;
    this.layer = layer;
    this.surface = layer.surface;
    this.host = host;
    this.original = new Surface(layer.surface.width, layer.surface.height, layer.surface.data.slice());
    this.differs = new Uint8Array(tileGrid(layer.surface.width, layer.surface.height).count);
  }

  get state(): PreviewState {
    return this._state;
  }

  /** Still open: updates are shown, commit/cancel are possible. */
  get active(): boolean {
    return this._state === 'open';
  }

  /** The layer shows something other than its original pixels. */
  get changed(): boolean {
    return this.differs.includes(1);
  }

  /**
   * Shows `content` as the preview, replacing the previous one (only tiles
   * that change are redrawn). Returns false once the preview has ended.
   */
  update(content: PreviewContent): boolean {
    if (!this.active) return false;
    const { width: w, height: h } = this.surface;
    const data = this.surface.data;
    const base = this.original.data;
    let dirty: Rect | null = null;
    if (typeof content === 'function') {
      dirty = this.restore();
      try {
        content(this.surface);
      } finally {
        // Whatever the function managed to write is shown and tracked.
        for (let i = 0; i < this.differs.length; i++) {
          const r = tileRect(i, w, h);
          this.differs[i] = tileEquals(base, data, w, r) ? 0 : 1;
          if (this.differs[i]) dirty = unionRect(dirty, r);
        }
        if (dirty) this.host.pixelsChanged(this.layer, dirty);
      }
      return true;
    }
    if (content.width !== w || content.height !== h || content.data.length !== data.length) {
      throw new RangeError('preview size does not match the layer');
    }
    const src = content.data;
    for (let i = 0; i < this.differs.length; i++) {
      const r = tileRect(i, w, h);
      if (tileEquals(src, data, w, r)) continue;
      copyRect(src, data, w, r);
      this.differs[i] = tileEquals(base, data, w, r) ? 0 : 1;
      dirty = unionRect(dirty, r);
    }
    if (dirty) this.host.pixelsChanged(this.layer, dirty);
    return true;
  }

  /**
   * Keeps what is shown as ONE history entry (only the changed tiles).
   * Returns true when an entry was recorded, false when nothing changed or
   * the preview had already ended.
   */
  commit(): boolean {
    if (!this.active) return false;
    const { width: w, height: h } = this.surface;
    const tiles: TilePatch[] = [];
    for (let i = 0; i < this.differs.length; i++) {
      if (!this.differs[i]) continue;
      const rect = tileRect(i, w, h);
      tiles.push({ index: i, rect, data: readTile(this.original.data, w, rect) });
    }
    this._state = 'committed';
    const cmd = tiles.length > 0 ? new PixelCommand(this.label, this.layer, tiles) : null;
    this.host.ended(this, cmd, null);
    return cmd !== null;
  }

  /** Restores the original pixels exactly; the history is left as it is. */
  cancel(): void {
    this.end('cancelled');
  }

  /** Ends the preview because something else changed the document (called by the engine). */
  expire(): void {
    this.end('stale');
  }

  private end(state: 'cancelled' | 'stale'): void {
    if (!this.active) return;
    const restored = this.restore();
    this._state = state;
    this.host.ended(this, null, restored);
  }

  /** Copies the original back into every differing tile; returns their area. */
  private restore(): Rect | null {
    const { width: w, height: h } = this.surface;
    let area: Rect | null = null;
    for (let i = 0; i < this.differs.length; i++) {
      if (!this.differs[i]) continue;
      const r = tileRect(i, w, h);
      copyRect(this.original.data, this.surface.data, w, r);
      this.differs[i] = 0;
      area = unionRect(area, r);
    }
    return area;
  }
}

/** Copies rect `r` between two same-sized full-surface buffers. */
function copyRect(src: Uint8ClampedArray, dst: Uint8ClampedArray, width: number, r: Rect): void {
  const row = r.w * 4;
  for (let y = r.y; y < r.y + r.h; y++) {
    const i = (y * width + r.x) * 4;
    dst.set(src.subarray(i, i + row), i);
  }
}
