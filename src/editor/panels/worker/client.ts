// Client for the panels worker, with latest-wins channels (like the filter
// client): requests on one channel run one at a time and a newer request
// replaces a waiting one, so dragging a slider costs at most one extra
// render. Without Worker support (node tests) requests run on the calling
// thread, still asynchronously.
//
// The worker is single-threaded, so the client hands it one request at a
// time and picks the next by priority: what the user just asked for (apply
// a preset, add a sticker, an icon-helper preview) goes before background
// renders (layer thumbnails, the Previews block, the Styles grid), and a
// request cancelled while waiting is never computed.

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
  /**
   * 'high' (default): the user is waiting for it. 'low': background work
   * (thumbnails, previews) that yields to every waiting 'high' request.
   */
  priority?: 'high' | 'low';
}

interface Job {
  msg: PanelMessage;
  transfer: Transferable[];
  channel: string | undefined;
  low: boolean;
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
  /** The request the worker (or the same-thread fallback) is running. */
  private running: Job | null = null;
  /** Requests ready to run, 'high' ones first (FIFO within a priority). */
  private readonly ready: Job[] = [];
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

  /** Requests waiting or running (for tests and diagnostics). */
  get pending(): number {
    let n = this.ready.length + (this.running ? 1 : 0);
    for (const ch of this.channels.values()) if (ch.queued) n++;
    return n;
  }

  request<K extends PanelOp>(req: RequestOf<K>, opts: RequestOptions = {}): Promise<PanelResults[K]> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        msg: { ...req, reqId: this.nextId++ } as PanelMessage,
        transfer: opts.transfer ?? [],
        channel: opts.channel,
        low: opts.priority === 'low',
        resolve: resolve as (v: unknown) => void,
        reject,
        settled: false,
      };
      if (job.channel === undefined) {
        this.enqueue(job);
        return;
      }
      let ch = this.channels.get(job.channel);
      if (!ch) {
        ch = { active: null, queued: null };
        this.channels.set(job.channel, ch);
      }
      if (ch.active && ch.active !== this.running) {
        // The channel's request has not started yet: this one replaces it.
        const old = ch.active;
        this.unready(old);
        this.settle(old, new PanelTaskCancelled('superseded'));
        ch.active = job;
        this.enqueue(job);
        return;
      }
      if (ch.active) {
        if (ch.queued) this.settle(ch.queued, new PanelTaskCancelled('superseded'));
        ch.queued = job;
        return;
      }
      ch.active = job;
      this.enqueue(job);
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
    const active = ch.active;
    if (!active) return;
    this.settle(active, new PanelTaskCancelled());
    if (active !== this.running) {
      // Not started: drop it now so the channel is free at once.
      this.unready(active);
      this.advance(active);
    }
  }

  dispose(): void {
    const cancelled = new PanelTaskCancelled('disposed');
    if (this.running) this.settle(this.running, cancelled);
    for (const job of this.ready) this.settle(job, cancelled);
    for (const ch of this.channels.values()) if (ch.queued) this.settle(ch.queued, cancelled);
    this.running = null;
    this.ready.length = 0;
    this.channels.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private unready(job: Job): void {
    const i = this.ready.indexOf(job);
    if (i >= 0) this.ready.splice(i, 1);
  }

  private enqueue(job: Job): void {
    if (job.low) this.ready.push(job);
    else {
      // After the other 'high' requests, before every 'low' one.
      const at = this.ready.findIndex((j) => j.low);
      if (at < 0) this.ready.push(job);
      else this.ready.splice(at, 0, job);
    }
    this.pump();
  }

  /** Starts the next ready request when nothing is running. */
  private pump(): void {
    while (!this.running && this.ready.length > 0) {
      const job = this.ready.shift()!;
      if (job.settled) {
        // Cancelled while waiting: never computed.
        this.advance(job);
        continue;
      }
      this.running = job;
      this.dispatch(job);
    }
  }

  private dispatch(job: Job): void {
    const worker = this.worker;
    if (!worker) {
      // Same-thread fallback; the handler (and the engine code behind it)
      // is loaded on demand so it stays out of the page's initial script.
      void import('./protocol').then(({ handlePanelMessage }) => {
        if (this.running !== job) return;
        if (job.settled) {
          this.finish(job);
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

  /** The running request is over: next in its channel, next overall. */
  private finish(job: Job): void {
    if (this.running === job) this.running = null;
    this.advance(job);
    this.pump();
  }

  private settle(job: Job, result: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }

  private onResponse(res: PanelResponse): void {
    const job = this.running;
    if (!job || job.msg.reqId !== res.reqId) return;
    this.settle(job, 'error' in res ? new Error(res.error) : res.result);
    this.finish(job);
  }

  /** Hands a channel's waiting request on once its active one is over. */
  private advance(job: Job): void {
    if (job.channel === undefined) return;
    const ch = this.channels.get(job.channel);
    if (!ch || ch.active !== job) return;
    ch.active = ch.queued;
    ch.queued = null;
    if (ch.active) this.enqueue(ch.active);
    else this.channels.delete(job.channel);
  }

  private onWorkerError(ev: ErrorEvent): void {
    // Fall back to same-thread processing; the request the worker had is lost.
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    const lost = this.running;
    if (!lost) return;
    this.settle(lost, new Error(`panels worker failed${ev?.message ? `: ${ev.message}` : ''}`));
    this.finish(lost);
  }
}

let shared: PanelsClient | null = null;

/** The page-wide panels worker (created on first use). */
export function panelsWorker(): PanelsClient {
  shared ??= new PanelsClient();
  return shared;
}
