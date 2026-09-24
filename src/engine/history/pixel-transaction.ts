// An in-progress pixel edit on one raster layer (a stroke, fill, preview…).
//
// At `begin` the layer's pixels are copied once (`base`); tools paint into
// the live surface after calling `touch(rect)` for every area they change,
// and can recompute pixels from `base` (strokes with opacity caps, live
// shape/gradient previews). `commit()` diffs only the touched tiles against
// `base` and produces a PixelCommand holding just the tiles that really
// changed; `cancel()` restores them.

import type { RasterLayer } from '../doc/types';
import type { Pixels, Surface } from '../raster/surface';
import { forEachTile, readTile, tileEquals, tileGrid, tileRect } from '../raster/tiles';
import type { Rect } from '../util/rect';
import { clipRect, unionRect } from '../util/rect';
import { DirtyRegion } from '../raster/dirty';
import type { TilePatch } from './commands';
import { PixelCommand } from './commands';

export class PixelTransaction {
  readonly layer: RasterLayer;
  readonly surface: Surface;
  /** The layer's pixels when the transaction began. */
  readonly base: Pixels;
  private readonly touched: Uint8Array;
  private readonly dirty: DirtyRegion;
  private area: Rect | null = null;
  private closed = false;

  constructor(layer: RasterLayer) {
    this.layer = layer;
    this.surface = layer.surface;
    this.base = layer.surface.data.slice();
    this.touched = new Uint8Array(tileGrid(this.surface.width, this.surface.height).count);
    this.dirty = new DirtyRegion(this.surface.width, this.surface.height);
  }

  get width(): number {
    return this.surface.width;
  }

  get height(): number {
    return this.surface.height;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Everything touched so far (clipped), or null. */
  get touchedRect(): Rect | null {
    return this.area ? { ...this.area } : null;
  }

  /** Declares that `r` is about to change. Returns the clipped rect or null. */
  touch(r: Rect): Rect | null {
    const c = clipRect(r, this.width, this.height);
    if (!c) return null;
    forEachTile(c, this.width, this.height, (i) => {
      this.touched[i] = 1;
    });
    this.area = unionRect(this.area, c);
    this.dirty.add(c);
    return c;
  }

  /** Region changed since the last call (for incremental redraw). */
  takeDirty(): Rect | null {
    return this.dirty.take();
  }

  /** Copies `r` back from `base` (marks it touched). */
  restore(r: Rect): void {
    const c = this.touch(r);
    if (!c) return;
    const row = c.w * 4;
    const w = this.width;
    for (let y = c.y; y < c.y + c.h; y++) {
      const i = (y * w + c.x) * 4;
      this.surface.data.set(this.base.subarray(i, i + row), i);
    }
  }

  /** Restores everything touched so far. */
  restoreAll(): void {
    if (this.area) this.restore(this.area);
  }

  /** Finishes the edit. Returns null when no pixel actually changed. */
  commit(label: string): PixelCommand | null {
    this.ensureOpen();
    this.closed = true;
    const tiles: TilePatch[] = [];
    const { width: w, height: h } = this;
    for (let i = 0; i < this.touched.length; i++) {
      if (!this.touched[i]) continue;
      const rect = tileRect(i, w, h);
      if (tileEquals(this.base, this.surface.data, w, rect)) continue;
      tiles.push({ index: i, rect, data: readTile(this.base, w, rect) });
    }
    return tiles.length ? new PixelCommand(label, this.layer, tiles) : null;
  }

  /** Abandons the edit, restoring the original pixels. Returns the restored area. */
  cancel(): Rect | null {
    this.ensureOpen();
    const a = this.area;
    this.restoreAll();
    this.closed = true;
    return a;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Pixel transaction already finished');
  }
}
