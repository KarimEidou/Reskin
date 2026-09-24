/**
 * FilterClient: runs filters (and backdrop renders) in a module worker for
 * live previews, with latest-wins cancellation per channel and zero-copy
 * buffer transfer. Falls back to running on the main thread (still async)
 * when `Worker` is unavailable, e.g. in node tests.
 *
 * ```ts
 * const client = new FilterClient();
 * // on every slider input:
 * client.run('blur', layerPixels, { radius }, { channel: 'preview' })
 *   .then(show)
 *   .catch((e) => { if (!isFilterCancelled(e)) throw e; });
 * ```
 *
 * Channel semantics: requests on the same channel run one at a time. While
 * one is running, a newer request waits; a request arriving after it
 * replaces (and cancels) the waiting one. Results therefore arrive in order,
 * never older-after-newer, and a burst of slider events costs at most one
 * extra render. Requests without a channel are never cancelled implicitly.
 */
import { resolveBackdropSpec, type BackdropSpec, type BackdropSpecInput } from '../backdrop/spec';
import type { ParamRecord } from './params';
import { isFilterId, normalizeFilterParams, type FilterId, type FilterParamsMap } from './registry';
import { assertMask, assertPixels, type Mask, type Pixels } from './types';
import { handleRequest, type WorkerRequest, type WorkerResponse } from './worker-core';

/** The subset of `Worker` the client needs (lets tests inject a fake). */
export interface WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface FilterClientOptions {
  /**
   * The worker to use, a factory for one, or `false` to always run on the
   * calling thread. Default: spawn `filter.worker.ts` when `Worker` exists.
   */
  worker?: WorkerLike | (() => WorkerLike | null) | false;
}

export interface RunOptions {
  /** Latest-wins channel name (e.g. 'preview'). */
  channel?: string;
  /** Rejects the request with `FilterCancelledError` when aborted. */
  signal?: AbortSignal;
}

export interface FilterRunOptions extends RunOptions {
  /** Selection mask (0..255 per pixel). */
  mask?: Mask | null;
  /**
   * Hand the pixel and mask buffers over instead of copying them. In worker
   * mode they are transferred (the caller's arrays become detached); in
   * main-thread mode they may be overwritten with the result. Default false.
   */
  transfer?: boolean;
}

/** Rejection reason for superseded, aborted or disposed requests. */
export class FilterCancelledError extends Error {
  constructor(message = 'filter request cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isFilterCancelled(e: unknown): e is FilterCancelledError {
  return e instanceof FilterCancelledError;
}

interface Job {
  reqId: number;
  msg: WorkerRequest;
  transfer: Transferable[];
  channel: string | undefined;
  resolve: (p: Pixels) => void;
  reject: (e: unknown) => void;
  settled: boolean;
  cleanup: () => void;
}

interface Channel {
  active: Job | null;
  queued: Job | null;
}

function spawnDefaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./filter.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function ownedBuffer(view: Uint8Array | Uint8ClampedArray): ArrayBuffer | null {
  const buf = view.buffer;
  return buf instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buf.byteLength ? buf : null;
}

export class FilterClient {
  private worker: WorkerLike | null;
  private nextId = 1;
  private readonly inflight = new Map<number, Job>();
  private readonly channels = new Map<string, Channel>();
  private disposed = false;

  constructor(opts: FilterClientOptions = {}) {
    const w = opts.worker;
    this.worker = w === false ? null : typeof w === 'function' ? w() : (w ?? spawnDefaultWorker());
    if (this.worker) {
      this.worker.onmessage = (ev) => this.onResponse(ev.data as WorkerResponse);
      this.worker.onerror = (ev) => this.onWorkerError(ev);
    }
  }

  /** 'worker' while a worker is in use, 'sync' when running on the calling thread. */
  get mode(): 'worker' | 'sync' {
    return this.worker ? 'worker' : 'sync';
  }

  /** Requests running or waiting. */
  get pending(): number {
    let n = this.inflight.size;
    for (const ch of this.channels.values()) if (ch.queued) n++;
    return n;
  }

  /** Runs a filter; resolves with a new image (the input is untouched unless `transfer` is set). */
  run<K extends FilterId>(id: K, pixels: Pixels, params?: Partial<FilterParamsMap[K]> | ParamRecord | null, opts: FilterRunOptions = {}): Promise<Pixels> {
    if (!isFilterId(id)) return Promise.reject(new RangeError(`unknown filter "${String(id)}"`));
    try {
      assertPixels(pixels, 'pixels');
      assertMask(opts.mask, pixels.width, pixels.height);
    } catch (e) {
      return Promise.reject(e);
    }
    // Either hand over the caller's buffers or make one private copy; in both
    // cases the buffer we send is ours, so it is transferred, never cloned again.
    let data = pixels.data;
    if (!(opts.transfer && ownedBuffer(data))) data = new Uint8ClampedArray(data);
    const transfer: Transferable[] = [data.buffer as ArrayBuffer];
    let mask = opts.mask ?? null;
    if (mask) {
      if (!(opts.transfer && ownedBuffer(mask) && mask.buffer !== data.buffer)) mask = new Uint8Array(mask);
      transfer.push(mask.buffer as ArrayBuffer);
    }
    const msg: WorkerRequest = {
      id,
      reqId: 0,
      pixels: { width: pixels.width, height: pixels.height, data },
      // Normalising also turns reactive proxies into plain, cloneable objects.
      params: normalizeFilterParams(id, params) as unknown as ParamRecord,
      mask,
    };
    return this.submit(msg, transfer, opts);
  }

  /** Renders a backdrop off the main thread. */
  backdrop(spec: BackdropSpecInput | BackdropSpec | null, size: number, opts: RunOptions = {}): Promise<Pixels> {
    const msg: WorkerRequest = { op: 'backdrop', reqId: 0, spec: resolveBackdropSpec(spec), size };
    return this.submit(msg, [], opts);
  }

  /** Cancels the running and waiting requests of a channel (their promises reject with FilterCancelledError). */
  cancel(channel: string): void {
    const ch = this.channels.get(channel);
    if (!ch) return;
    if (ch.queued) {
      const q = ch.queued;
      ch.queued = null;
      this.settle(q, new FilterCancelledError());
    }
    if (ch.active) this.settle(ch.active, new FilterCancelledError());
  }

  /** Rejects everything outstanding and terminates the worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.inflight.values()) this.settle(job, new FilterCancelledError('filter client disposed'));
    for (const ch of this.channels.values()) if (ch.queued) this.settle(ch.queued, new FilterCancelledError('filter client disposed'));
    this.inflight.clear();
    this.channels.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private submit(msg: WorkerRequest, transfer: Transferable[], opts: RunOptions): Promise<Pixels> {
    if (this.disposed) return Promise.reject(new FilterCancelledError('filter client disposed'));
    if (opts.signal?.aborted) return Promise.reject(new FilterCancelledError());
    return new Promise<Pixels>((resolve, reject) => {
      const reqId = this.nextId++;
      msg.reqId = reqId;
      const job: Job = { reqId, msg, transfer, channel: opts.channel, resolve, reject, settled: false, cleanup: () => {} };
      const signal = opts.signal;
      if (signal) {
        const onAbort = () => this.abort(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      if (job.channel === undefined) {
        this.dispatch(job);
        return;
      }
      let ch = this.channels.get(job.channel);
      if (!ch) {
        ch = { active: null, queued: null };
        this.channels.set(job.channel, ch);
      }
      if (ch.active) {
        if (ch.queued) this.settle(ch.queued, new FilterCancelledError('superseded by a newer request'));
        ch.queued = job;
        return;
      }
      ch.active = job;
      this.dispatch(job);
    });
  }

  private dispatch(job: Job): void {
    this.inflight.set(job.reqId, job);
    const worker = this.worker;
    if (!worker) {
      setTimeout(() => {
        if (job.settled) {
          // Cancelled before it started: skip the work, just let the channel move on.
          this.inflight.delete(job.reqId);
          this.advance(job);
          return;
        }
        this.onResponse(handleRequest(job.msg).response);
      }, 0);
      return;
    }
    try {
      worker.postMessage(job.msg, job.transfer);
    } catch (e) {
      this.onResponse({ reqId: job.reqId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private settle(job: Job, result: Pixels | Error): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }

  private abort(job: Job): void {
    if (job.settled) return;
    const ch = job.channel !== undefined ? this.channels.get(job.channel) : undefined;
    if (ch && ch.queued === job) ch.queued = null;
    this.settle(job, new FilterCancelledError());
  }

  private onResponse(res: WorkerResponse): void {
    if (!res || typeof res !== 'object' || typeof res.reqId !== 'number') return;
    const job = this.inflight.get(res.reqId);
    if (!job) return;
    this.inflight.delete(res.reqId);
    this.settle(job, 'error' in res ? new Error(res.error) : res.pixels);
    this.advance(job);
  }

  /** After a channel's active job finishes, start its queued successor. */
  private advance(job: Job): void {
    if (job.channel === undefined) return;
    const ch = this.channels.get(job.channel);
    if (!ch || ch.active !== job) return;
    ch.active = ch.queued;
    ch.queued = null;
    if (ch.active) this.dispatch(ch.active);
    else this.channels.delete(job.channel);
  }

  private onWorkerError(ev: ErrorEvent): void {
    const detail = ev?.message;
    const err = new Error(`filter worker failed${detail ? `: ${detail}` : ''}`);
    // Requests already posted are lost with the worker (their buffers were transferred).
    const lost = [...this.inflight.values()];
    this.inflight.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    for (const job of lost) {
      this.settle(job, err);
      this.advance(job);
    }
  }
}
