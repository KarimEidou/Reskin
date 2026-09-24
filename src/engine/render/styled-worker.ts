// Off-main-thread rendering of styled layers for the interactive view
// (CanvasView): one module worker (effects.worker.ts) shared by every view,
// running requests one at a time, in order. Callers keep latest-wins
// themselves (one request per layer in flight). Without `Worker` (node
// tests) or after the worker failed, `styledWorker()` is null and callers
// render on their own thread. Export and thumbnails never come here: they
// render exactly, synchronously, through the compositor.

import type { LayerEffect } from '../doc/types';
import type { Surface } from '../raster/surface';
import type { Rect } from '../util/rect';
import type { StyledPixels } from './effects';

/** Request: a copy of the layer's straight RGBA8 pixels and its effects (JSON). */
export interface StyledJob {
  id: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  effects: string;
}

/** Response: the styled pixels cropped to `rect` (null: nothing to draw), or an error. */
export type StyledJobResult =
  | { id: number; rect: Rect; pixels: ArrayBuffer }
  | { id: number; rect: null; pixels: null }
  | { id: number; error: string };

/** The subset of `Worker` used (lets tests inject a fake). */
export interface StyledWorkerLike {
  onmessage: ((ev: MessageEvent<StyledJobResult>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: StyledJob, transfer: Transferable[]): void;
  terminate(): void;
}

interface Pending {
  resolve: (styled: StyledPixels | null) => void;
  reject: (e: Error) => void;
}

export class StyledWorker {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private broken = false;

  constructor(private readonly worker: StyledWorkerLike) {
    worker.onmessage = (ev) => this.onResult(ev.data);
    worker.onerror = (ev) => this.fail(new Error(ev.message || 'styled-layer worker failed'));
  }

  /** False once the worker failed: callers render on their own thread from then on. */
  get usable(): boolean {
    return !this.broken;
  }

  /**
   * Renders a layer's pixels with `effects` (their JSON) in the worker; the
   * pixels are copied, so the caller may keep editing them meanwhile.
   */
  render(src: Surface, effects: string | readonly LayerEffect[]): Promise<StyledPixels | null> {
    if (this.broken) return Promise.reject(new Error('styled-layer worker failed'));
    const id = this.nextId++;
    const pixels = src.data.slice().buffer;
    const job: StyledJob = {
      id,
      width: src.width,
      height: src.height,
      pixels,
      effects: typeof effects === 'string' ? effects : JSON.stringify(effects),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(job, [pixels]);
    });
  }

  private onResult(r: StyledJobResult): void {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    if ('error' in r) {
      p.reject(new Error(r.error));
      // A render that throws there would throw again: stop using the worker.
      this.fail(new Error(r.error));
    } else {
      p.resolve(r.rect ? { rect: r.rect, data: new Uint8ClampedArray(r.pixels) } : null);
    }
  }

  private fail(error: Error): void {
    this.broken = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
}

let shared: StyledWorker | null | undefined;

/** The page's styled-layer worker (spawned on first use), or null where there is none. */
export function styledWorker(): StyledWorker | null {
  if (shared === undefined) {
    shared = null;
    if (typeof Worker !== 'undefined') {
      try {
        shared = new StyledWorker(new Worker(new URL('./effects.worker.ts', import.meta.url), { type: 'module' }));
      } catch {
        shared = null;
      }
    }
  }
  return shared?.usable ? shared : null;
}
