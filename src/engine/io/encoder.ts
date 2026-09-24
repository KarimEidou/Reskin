/**
 * ProjectEncoder: .reskin serialization off the main thread, for the
 * autosave and the other saves the editor makes while the user works.
 * `encode(doc)` only snapshots the document on the calling thread (a copy
 * of each layer's pixels, see `snapshotProject`); a module worker
 * compresses, base64-encodes and stringifies it, and the pixel copies are
 * transferred to it rather than cloned again. Without `Worker` (node
 * tests) it encodes on the calling thread, still asynchronously.
 *
 * ```ts
 * const encoder = new ProjectEncoder();
 * const json = await encoder.encode(engine.doc); // = serializeProject(engine.doc)
 * encoder.dispose();
 * ```
 */
import type { Doc } from '../doc/types';
import { encodeSnapshot, snapshotBuffers, snapshotProject, type ProjectSnapshot, type SerializeOptions } from './project';

export interface EncodeRequest {
  id: number;
  snapshot: ProjectSnapshot;
}

export type EncodeResponse = { id: number; json: string } | { id: number; error: string };

/** What the worker does with a request (also the calling-thread fallback). */
export async function handleEncode(req: EncodeRequest): Promise<EncodeResponse> {
  try {
    return { id: req.id, json: JSON.stringify(await encodeSnapshot(req.snapshot)) };
  } catch (e) {
    return { id: req.id, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The subset of `Worker` the encoder needs (lets tests inject a fake). */
export interface EncoderWorker {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface ProjectEncoderOptions {
  /**
   * The worker to use, a factory for one, or `false` to always encode on
   * the calling thread. Default: spawn `project.worker.ts` when `Worker`
   * exists.
   */
  worker?: EncoderWorker | (() => EncoderWorker | null) | false;
}

function spawnDefaultWorker(): EncoderWorker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./project.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function settle(res: EncodeResponse): string {
  if ('error' in res) throw new Error(res.error);
  return res.json;
}

interface Pending {
  resolve: (json: string) => void;
  reject: (e: unknown) => void;
}

export class ProjectEncoder {
  private worker: EncoderWorker | null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor(opts: ProjectEncoderOptions = {}) {
    const w = opts.worker;
    this.worker = w === false ? null : typeof w === 'function' ? w() : (w ?? spawnDefaultWorker());
    if (this.worker) {
      this.worker.onmessage = (ev) => this.onResponse(ev.data as EncodeResponse);
      this.worker.onerror = (ev) => this.onWorkerError(ev);
    }
  }

  /** 'worker' while a worker is in use, 'sync' when encoding on the calling thread. */
  get mode(): 'worker' | 'sync' {
    return this.worker ? 'worker' : 'sync';
  }

  /**
   * The document as .reskin JSON, as it is when this is called (later
   * edits do not reach it). Rejects once the encoder is disposed.
   */
  encode(doc: Doc, opts: SerializeOptions = {}): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('The project encoder was closed'));
    let req: EncodeRequest;
    try {
      req = { id: this.nextId++, snapshot: snapshotProject(doc, opts) };
    } catch (e) {
      return Promise.reject(e);
    }
    const worker = this.worker;
    if (!worker) return handleEncode(req).then(settle);
    return new Promise<string>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      worker.postMessage(req, snapshotBuffers(req.snapshot));
    });
  }

  /** Stops the worker; requests still running reject. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.failPending(new Error('The project encoder was closed'));
  }

  private onResponse(res: EncodeResponse): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    try {
      p.resolve(settle(res));
    } catch (e) {
      p.reject(e);
    }
  }

  /**
   * The worker failed (it could not load, or crashed): the requests it had
   * are lost — their pixel buffers went with them — and later ones are
   * encoded on the calling thread.
   */
  private onWorkerError(ev: ErrorEvent): void {
    const detail = ev?.message;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.failPending(new Error(`The project encoder failed${detail ? `: ${detail}` : ''}`));
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(error);
  }
}
