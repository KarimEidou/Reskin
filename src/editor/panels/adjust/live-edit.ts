// A live, cancellable pixel edit on one raster layer (adjustment and icon
// helper previews).
//
// The untouched pixels are kept for recomputing and restoring. Each preview
// is written through `engine.editLayerPixels` under one label, replacing the
// previous preview (undo it, then edit), so the canvas and every listener
// update normally and the whole adjustment is ONE history entry. Undo
// restores the exact original bytes (the engine's pixel commands swap
// tiles). Cancel undoes that entry and drops it from the redo stack.
//
// If anything else touches the history meanwhile (the user paints, undoes…)
// the edit becomes `stale` and stops writing.

import type { Engine } from '$engine/index';

type Command = ReturnType<Engine['history']['peek']>;

/** Drops the redo tail and tells listeners (the History panel) about it. */
export function discardRedo(engine: Engine): void {
  if (!engine.canRedo) return;
  engine.history.discardRedo();
  // A no-op jump re-announces the history state.
  engine.jumpTo(engine.historyIndex);
}

export class LiveLayerEdit {
  readonly layerId: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** The layer's pixels when the edit began. */
  readonly original: Uint8ClampedArray<ArrayBuffer>;
  private readonly engine: Engine;
  /** Our preview's history command, or null when none is shown. */
  private cmd: Command = null;
  /** History top / position we expect to find. */
  private anchor: Command;
  private anchorIndex: number;
  private done = false;

  constructor(engine: Engine, layerId: string, label: string) {
    const layer = engine.getLayer(layerId);
    if (!layer || layer.kind !== 'raster') throw new Error('Adjustments need an image layer');
    this.engine = engine;
    this.layerId = layerId;
    this.label = label;
    this.width = layer.surface.width;
    this.height = layer.surface.height;
    this.original = layer.surface.data.slice();
    this.anchor = engine.history.peek();
    this.anchorIndex = engine.historyIndex;
  }

  /** The original pixels as an image (a copy, safe to transfer). */
  source(): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
    return { width: this.width, height: this.height, data: this.original.slice() };
  }

  get active(): boolean {
    return !this.done && !this.stale;
  }

  /** Something else changed the document since our last write. */
  get stale(): boolean {
    const e = this.engine;
    const layer = e.getLayer(this.layerId);
    if (!layer || layer.kind !== 'raster') return true;
    if (this.cmd) return e.history.peek() !== this.cmd || e.historyIndex !== this.anchorIndex + 1;
    return e.history.peek() !== this.anchor || e.historyIndex !== this.anchorIndex;
  }

  /** A preview is currently applied to the layer. */
  get showing(): boolean {
    return this.cmd !== null;
  }

  /**
   * Shows `pixels` (same size as the layer) as the result, replacing the
   * previous preview. Returns false when the edit is finished or stale.
   */
  show(pixels: Uint8ClampedArray): boolean {
    if (!this.active) return false;
    if (pixels.length !== this.original.length) throw new RangeError('preview size does not match the layer');
    const e = this.engine;
    if (this.cmd) {
      e.undo();
      this.cmd = null;
    }
    const changed = e.editLayerPixels(this.layerId, this.label, (s) => s.data.set(pixels));
    if (changed) {
      this.cmd = e.history.peek();
      // A fresh edit history: anchor on what lies under our entry.
      this.anchorIndex = e.historyIndex - 1;
    } else {
      // Identical to the original: nothing to record, forget the undone preview.
      discardRedo(e);
      this.anchor = e.history.peek();
      this.anchorIndex = e.historyIndex;
    }
    return true;
  }

  /** Keeps the current preview as the result (one history entry). */
  commit(): boolean {
    const kept = this.active && this.cmd !== null;
    this.done = true;
    return kept;
  }

  /** Restores the original pixels exactly and removes the preview entry. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (this.stale || !this.cmd) return;
    this.engine.undo();
    discardRedo(this.engine);
    this.cmd = null;
  }
}
