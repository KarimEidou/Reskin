// Client for the panels worker, with latest-wins channels (like the filter
// client): requests on one channel run one at a time and a newer request
// replaces a waiting one, so dragging a slider costs at most one extra
// render. Without Worker support (node tests) requests run on the calling
// thread, still asynchronously.

import type { PanelMessage, PanelOp, PanelResponse, PanelResults, RequestOf } from './protocol';

export class PanelTaskCancelled extends Error {
  constructor(message = 'panel task cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isCancelled(e: unknown): e is PanelTaskCancelled {
  return e instanceof PanelTaskCancelled;
}

export interface WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface RequestOptions {
  /** Latest-wins channel. */
  channel?: string;
  /** Buffers of the request to hand over (they become detached). */
  transfer?: Transferable[];
}

interface Job {
  msg: PanelMessage;
  transfer: Transferable[];
  channel: string | undefined;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

function spawn(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./panels.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

export class PanelsClient {
  private worker: WorkerLike | null;
  private nextId = 1;
  private readonly inflight = new Map<number, Job>();
  private readonly channels = new Map<string, { active: Job | null; queued: Job | null }>();

  constructor(worker: WorkerLike | null | false = spawn()) {
    this.worker = worker || null;
    if (this.worker) {
      this.worker.onmessage = (ev) => this.onResponse(ev.data as PanelResponse);
      this.worker.onerror = (ev) => this.onWorkerError(ev);
    }
  }

  get mode(): 'worker' | 'sync' {
    return this.worker ? 'worker' : 'sync';
  }

  request<K extends PanelOp>(req: RequestOf<K>, opts: RequestOptions = {}): Promise<PanelResults[K]> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        msg: { ...req, reqId: this.nextId++ } as PanelMessage,
        transfer: opts.transfer ?? [],
        channel: opts.channel,
        resolve: resolve as (v: unknown) => void,
        reject,
        settled: false,
      };
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
        if (ch.queued) this.settle(ch.queued, new PanelTaskCancelled('superseded'));
        ch.queued = job;
        return;
      }
      ch.active = job;
      this.dispatch(job);
    });
  }

  /** Cancels the running and waiting requests of a channel. */
  cancel(channel: string): void {
    const ch = this.channels.get(channel);
    if (!ch) return;
    if (ch.queued) {
      this.settle(ch.queued, new PanelTaskCancelled());
      ch.queued = null;
    }
    if (ch.active) this.settle(ch.active, new PanelTaskCancelled());
  }

  dispose(): void {
    for (const job of this.inflight.values()) this.settle(job, new PanelTaskCancelled('disposed'));
    for (const ch of this.channels.values()) if (ch.queued) this.settle(ch.queued, new PanelTaskCancelled('disposed'));
    this.inflight.clear();
    this.channels.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private dispatch(job: Job): void {
    this.inflight.set(job.msg.reqId, job);
    const worker = this.worker;
    if (!worker) {
      // Same-thread fallback; the handler (and the engine code behind it)
      // is loaded on demand so it stays out of the page's initial script.
      void import('./protocol').then(({ handlePanelMessage }) => {
        if (job.settled) {
          this.inflight.delete(job.msg.reqId);
          this.advance(job);
          return;
        }
        this.onResponse(handlePanelMessage(job.msg).response);
      });
      return;
    }
    try {
      worker.postMessage(job.msg, job.transfer);
    } catch (e) {
      this.onResponse({ reqId: job.msg.reqId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private settle(job: Job, result: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }

  private onResponse(res: PanelResponse): void {
    const job = this.inflight.get(res.reqId);
    if (!job) return;
    this.inflight.delete(res.reqId);
    this.settle(job, 'error' in res ? new Error(res.error) : res.result);
    this.advance(job);
  }

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
    // Fall back to same-thread processing; requests already posted are lost.
    const lost = [...this.inflight.values()];
    this.inflight.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    const err = new Error(`panels worker failed${ev?.message ? `: ${ev.message}` : ''}`);
    for (const job of lost) {
      this.settle(job, err);
      this.advance(job);
    }
  }
}

let shared: PanelsClient | null = null;

/** The page-wide panels worker (created on first use). */
export function panelsWorker(): PanelsClient {
  shared ??= new PanelsClient();
  return shared;
}
