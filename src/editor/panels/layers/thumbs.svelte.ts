// Layer thumbnails for the Layers panel, kept up to date off the main
// thread: pixel events mark their layer dirty, layer events re-check each
// layer's signature (surface, effects, rendered text), and dirty layers are
// re-rendered in the panels worker with the engine's layerThumbnail()
// (effects included), one request at a time, throttled.

import type { Engine, EngineEvent, Layer } from '$engine/index';
import type { Pixels } from '$engine/filters/types';
import { throttle, type Scheduled } from '../common/schedule';
import { isCancelled, panelsWorker } from '../worker/client';
import { snapshotLayer, type LayerSnapshot } from '../worker/snapshot';

const surfaceIds = new WeakMap<object, number>();
let nextSurfaceId = 1;

function identity(o: object | null): number {
  if (!o) return 0;
  let id = surfaceIds.get(o);
  if (!id) {
    id = nextSurfaceId++;
    surfaceIds.set(o, id);
  }
  return id;
}

function signature(l: Layer): string {
  const px = l.kind === 'raster' ? l.surface : l.cache;
  return `${l.kind}:${identity(px)}:${l.kind === 'text' ? l.cacheKey : ''}:${JSON.stringify(l.effects)}`;
}

export class LayerThumbs {
  /** Latest thumbnail per layer id. */
  thumbs = $state.raw<Record<string, Pixels>>({});
  private readonly engine: Engine;
  private size: number;
  private readonly dirty = new Set<string>();
  private readonly sigs = new Map<string, string>();
  private busy = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly schedule: Scheduled<[]>;

  constructor(engine: Engine, size: number) {
    this.engine = engine;
    this.size = size;
    this.schedule = throttle(() => void this.flush(), 160);
    this.unsubscribe = engine.subscribe((e) => this.onEvent(e));
    this.markAll();
  }

  /** Thumbnail pixel size (CSS size × devicePixelRatio). */
  setSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    this.markAll();
  }

  dispose(): void {
    this.disposed = true;
    this.schedule.cancel();
    this.unsubscribe();
  }

  private markAll(): void {
    this.sigs.clear();
    for (const l of this.engine.doc.layers) {
      this.dirty.add(l.id);
      this.sigs.set(l.id, signature(l));
    }
    this.schedule();
  }

  private onEvent(e: EngineEvent): void {
    if (e.kind === 'pixels') {
      this.dirty.add(e.layerId);
      this.schedule();
    } else if (e.kind === 'document') {
      this.markAll();
    } else if (e.kind === 'layers') {
      const seen = new Set<string>();
      for (const l of this.engine.doc.layers) {
        seen.add(l.id);
        const sig = signature(l);
        if (this.sigs.get(l.id) !== sig) {
          this.sigs.set(l.id, sig);
          this.dirty.add(l.id);
        }
      }
      for (const id of [...this.sigs.keys()]) if (!seen.has(id)) this.sigs.delete(id);
      if (this.dirty.size) this.schedule();
    }
  }

  private async flush(): Promise<void> {
    if (this.busy || this.disposed || this.dirty.size === 0) return;
    const ids: string[] = [];
    const snaps: LayerSnapshot[] = [];
    for (const id of this.dirty) {
      const l = this.engine.getLayer(id);
      const s = l ? snapshotLayer(l) : null;
      if (s) {
        ids.push(id);
        snaps.push(s);
      }
    }
    this.dirty.clear();
    if (snaps.length === 0) return;
    this.busy = true;
    try {
      const out = await panelsWorker().request(
        { op: 'layerThumbs', layers: snaps, size: this.size, crisp: this.engine.doc.pixelArt !== null },
        { transfer: snaps.map((s) => s.data.buffer) },
      );
      if (this.disposed) return;
      const next = { ...this.thumbs };
      ids.forEach((id, i) => {
        const px = out[i];
        if (px) next[id] = px;
      });
      // Forget deleted layers.
      for (const id of Object.keys(next)) if (!this.engine.getLayer(id)) delete next[id];
      this.thumbs = next;
    } catch (e) {
      // A cancelled batch is retried; a failing one is not (no busy loop).
      if (isCancelled(e)) ids.forEach((id) => this.dirty.add(id));
      else console.warn('layer thumbnails failed', e);
    } finally {
      this.busy = false;
      if (this.dirty.size && !this.disposed) this.schedule();
    }
  }
}
