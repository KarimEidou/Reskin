import { describe, expect, it } from 'vitest';
import { renderBackdrop } from '../backdrop/render';
import { FilterClient, FilterCancelledError, isFilterCancelled, type WorkerLike } from './client';
import { applyFilter } from './registry';
import { randomPixels } from './test-utils';
import { clonePixels, type Pixels } from './types';
import { handleRequest, type FilterRequest, type WorkerRequest, type WorkerResponse } from './worker-core';

/** In-process stand-in for the module worker, with real structured-clone transfer semantics. */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;

  constructor(private readonly crash = false) {}

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push({ message: message as WorkerRequest, transfer });
    const cloned = structuredClone(message, { transfer }) as WorkerRequest;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.crash) {
        this.onerror?.({ message: 'boom' } as ErrorEvent);
        return;
      }
      const { response, transfer: back } = handleRequest(cloned);
      this.onmessage?.({ data: structuredClone(response, { transfer: back }) } as MessageEvent);
    }, 1);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A fake worker that holds requests until the test delivers them, one at a time, in order. */
class ManualWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly queue: WorkerRequest[] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.queue.push(structuredClone(message, { transfer }) as WorkerRequest);
  }

  /** Runs the oldest posted request and delivers its response. */
  deliver(): void {
    const req = this.queue.shift();
    if (!req) throw new Error('nothing posted');
    const { response, transfer } = handleRequest(req);
    this.onmessage?.({ data: structuredClone(response, { transfer }) } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Lets pending promise callbacks run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('worker request handler', () => {
  it('filters in place and transfers the result buffer back', () => {
    const src = randomPixels(4, 4, 1);
    const expected = applyFilter('invert', src);
    const req: WorkerRequest = { id: 'invert', reqId: 7, pixels: clonePixels(src) };
    const { response, transfer } = handleRequest(req);
    expect(response.reqId).toBe(7);
    const px = (response as { pixels: Pixels }).pixels;
    expect(px.data).toEqual(expected.data);
    expect(px.data).toBe(req.pixels.data);
    expect(transfer).toEqual([px.data.buffer]);
  });

  it('applies masks and params', () => {
    const src = randomPixels(4, 4, 2);
    const mask = new Uint8Array(16).fill(128);
    const { response } = handleRequest({ id: 'blur', reqId: 1, pixels: clonePixels(src), params: { radius: 1 }, mask });
    expect((response as { pixels: Pixels }).pixels.data).toEqual(applyFilter('blur', src, { radius: 1 }, mask).data);
  });

  it('reports errors instead of throwing', () => {
    const res = handleRequest({ id: 'nope', reqId: 3, pixels: randomPixels(2, 2) });
    expect(res.response).toEqual({ reqId: 3, error: 'unknown filter "nope"' });
    const bad = handleRequest({ id: 'invert', reqId: 4, pixels: { width: 3, height: 3, data: new Uint8ClampedArray(4) } });
    expect('error' in bad.response).toBe(true);
  });

  it('renders backdrops', () => {
    const { response } = handleRequest({ op: 'backdrop', reqId: 2, spec: { shape: 'circle' }, size: 32 });
    expect((response as { pixels: Pixels }).pixels.data).toEqual(renderBackdrop({ shape: 'circle' }, 32).data);
  });
});

describe('FilterClient (main-thread fallback)', () => {
  it('falls back to synchronous execution without Worker and matches applyFilter', async () => {
    const client = new FilterClient();
    expect(client.mode).toBe('sync');
    const src = randomPixels(16, 16, 5);
    const copy = clonePixels(src);
    const out = await client.run('sepia', src, { amount: 70 });
    expect(out.data).toEqual(applyFilter('sepia', src, { amount: 70 }).data);
    expect(src.data).toEqual(copy.data);
    expect(out.data).not.toBe(src.data);
  });

  it('latest wins per channel: waiting requests are superseded, results arrive in order', async () => {
    const client = new FilterClient({ worker: false });
    const src = randomPixels(8, 8, 6);
    const order: number[] = [];
    const run = (radius: number) =>
      client.run('blur', src, { radius }, { channel: 'preview' }).then((p) => {
        order.push(radius);
        return p;
      });
    const [a, b, c] = await Promise.allSettled([run(1), run(2), run(3)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(isFilterCancelled((b as PromiseRejectedResult).reason)).toBe(true);
    expect(c.status).toBe('fulfilled');
    expect((c as PromiseFulfilledResult<Pixels>).value.data).toEqual(applyFilter('blur', src, { radius: 3 }).data);
    expect(order).toEqual([1, 3]);
    expect(client.pending).toBe(0);
  });

  it('requests on different channels or without one do not cancel each other', async () => {
    const client = new FilterClient({ worker: false });
    const src = randomPixels(4, 4, 7);
    const results = await Promise.allSettled([
      client.run('invert', src),
      client.run('invert', src),
      client.run('invert', src, null, { channel: 'a' }),
      client.run('invert', src, null, { channel: 'b' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('cancel() and AbortSignal reject with FilterCancelledError', async () => {
    const client = new FilterClient({ worker: false });
    const src = randomPixels(4, 4, 8);
    const p = client.run('invert', src, null, { channel: 'x' });
    client.cancel('x');
    await expect(p).rejects.toBeInstanceOf(FilterCancelledError);
    await expect(client.run('invert', src, null, { channel: 'x' })).resolves.toBeTruthy();

    const ctl = new AbortController();
    const q = client.run('invert', src, null, { signal: ctl.signal });
    ctl.abort();
    await expect(q).rejects.toBeInstanceOf(FilterCancelledError);
    await expect(client.run('invert', src, null, { signal: ctl.signal })).rejects.toBeInstanceOf(FilterCancelledError);
  });

  it('transfer: true on the main thread writes the result into the caller buffer', async () => {
    const client = new FilterClient({ worker: false });
    const src = randomPixels(4, 4, 16);
    const expected = applyFilter('invert', src).data;
    const out = await client.run('invert', src, null, { transfer: true });
    expect(out.data).toBe(src.data);
    expect(out.data).toEqual(expected);
  });

  it('validates input', async () => {
    const client = new FilterClient({ worker: false });
    await expect(client.run('nope' as 'invert', randomPixels(2, 2))).rejects.toBeInstanceOf(RangeError);
    await expect(client.run('invert', randomPixels(2, 2), null, { mask: new Uint8Array(3) })).rejects.toBeInstanceOf(RangeError);
  });

  it('renders backdrops', async () => {
    const client = new FilterClient({ worker: false });
    const out = await client.backdrop({ shape: 'hexagon' }, 48, { channel: 'bd' });
    expect(out.data).toEqual(renderBackdrop({ shape: 'hexagon' }, 48).data);
  });

  it('dispose() rejects outstanding and future requests', async () => {
    const client = new FilterClient({ worker: false });
    const p = client.run('invert', randomPixels(4, 4));
    client.dispose();
    await expect(p).rejects.toBeInstanceOf(FilterCancelledError);
    await expect(client.run('invert', randomPixels(4, 4))).rejects.toBeInstanceOf(FilterCancelledError);
  });
});

describe('FilterClient (worker)', () => {
  it('copies by default and transfers (detaching the caller buffers) on request', async () => {
    const worker = new FakeWorker();
    const client = new FilterClient({ worker });
    expect(client.mode).toBe('worker');
    const src = randomPixels(8, 8, 9);
    const expected = applyFilter('invert', src).data;

    const kept = await client.run('invert', src);
    expect(kept.data).toEqual(expected);
    expect(src.data.byteLength).toBe(64 * 4);
    // The client's private copy was transferred (detached), the caller's buffer untouched.
    expect(worker.posted[0].transfer).toHaveLength(1);
    expect((worker.posted[0].message as FilterRequest).pixels.data.byteLength).toBe(0);

    const mask = new Uint8Array(64).fill(255);
    const given = await client.run('invert', src, null, { transfer: true, mask });
    expect(given.data).toEqual(expected);
    expect(src.data.byteLength).toBe(0);
    expect(mask.byteLength).toBe(0);
  });

  it('delivers errors from the worker as rejections', async () => {
    const client = new FilterClient({ worker: () => new FakeWorker() });
    await expect(client.backdrop({ shape: 'circle' }, 0)).rejects.toThrow(/invalid backdrop size/);
    await expect(client.run('pixelate', randomPixels(2, 2), { size: 2 })).resolves.toMatchObject({ width: 2 });
  });

  it('falls back to the main thread when the worker dies', async () => {
    const worker = new FakeWorker(true);
    const client = new FilterClient({ worker });
    const src = randomPixels(4, 4, 10);
    const first = client.run('invert', src, null, { channel: 'c' });
    const queued = client.run('grayscale', src, null, { channel: 'c' });
    await expect(first).rejects.toThrow(/filter worker failed: boom/);
    await expect(queued).resolves.toMatchObject({ width: 4, height: 4 });
    expect(worker.terminated).toBe(true);
    expect(client.mode).toBe('sync');
    const after = await client.run('invert', src);
    expect(after.data).toEqual(applyFilter('invert', src).data);
  });

  it('latest wins per channel: one request in the worker, one waiting, older waiting ones cancelled', async () => {
    const worker = new ManualWorker();
    const client = new FilterClient({ worker });
    const src = randomPixels(8, 8, 12);
    const order: number[] = [];
    const run = (radius: number) => client.run('blur', src, { radius }, { channel: 'preview' }).then((p) => (order.push(radius), p));
    const r1 = run(1);
    const r2 = run(2);
    const r3 = run(3);
    await expect(r2).rejects.toBeInstanceOf(FilterCancelledError);
    expect(worker.queue).toHaveLength(1); // only the first was posted
    expect(client.pending).toBe(2);
    worker.deliver();
    expect((await r1).data).toEqual(applyFilter('blur', src, { radius: 1 }).data);
    expect(worker.queue).toHaveLength(1); // the newest waiting request went out next
    worker.deliver();
    expect((await r3).data).toEqual(applyFilter('blur', src, { radius: 3 }).data);
    expect(order).toEqual([1, 3]);
    expect(client.pending).toBe(0);
  });

  it('cancelling a running request rejects it at once and drops its late result', async () => {
    const worker = new ManualWorker();
    const client = new FilterClient({ worker });
    const src = randomPixels(4, 4, 13);
    let settled = 0;
    const a = client.run('invert', src, null, { channel: 'c' });
    const b = client.run('sepia', src, null, { channel: 'c' });
    a.catch(() => settled++);
    client.cancel('c');
    await expect(a).rejects.toBeInstanceOf(FilterCancelledError);
    await expect(b).rejects.toBeInstanceOf(FilterCancelledError);
    // A new request waits for the worker to finish the cancelled one (it cannot be interrupted).
    const d = client.run('grayscale', src, null, { channel: 'c' });
    expect(worker.queue).toHaveLength(1);
    worker.deliver(); // the cancelled invert's result: ignored
    await tick();
    expect(settled).toBe(1);
    expect(worker.queue).toHaveLength(1);
    worker.deliver();
    expect((await d).data).toEqual(applyFilter('grayscale', src).data);
    expect(client.pending).toBe(0);
  });

  it('an aborted waiting request leaves the queue; unchannelled requests all run', async () => {
    const worker = new ManualWorker();
    const client = new FilterClient({ worker });
    const src = randomPixels(4, 4, 14);
    const ctl = new AbortController();
    const first = client.run('invert', src, null, { channel: 'x' });
    const waiting = client.run('sepia', src, null, { channel: 'x', signal: ctl.signal });
    ctl.abort();
    await expect(waiting).rejects.toBeInstanceOf(FilterCancelledError);
    worker.deliver();
    await first;
    expect(worker.queue).toHaveLength(0);
    expect(client.pending).toBe(0);
    const both = [client.run('invert', src), client.run('invert', src)];
    expect(worker.queue).toHaveLength(2);
    worker.deliver();
    worker.deliver();
    expect((await Promise.all(both)).every((p) => p.width === 4)).toBe(true);
  });

  it('rejects every posted request when the worker dies', async () => {
    const worker = new ManualWorker();
    const client = new FilterClient({ worker });
    const src = randomPixels(4, 4, 15);
    const a = client.run('invert', src);
    const b = client.backdrop({ shape: 'circle' }, 16);
    worker.onerror?.({ message: 'gone' } as ErrorEvent);
    await expect(a).rejects.toThrow(/gone/);
    await expect(b).rejects.toThrow(/gone/);
    expect(client.mode).toBe('sync');
    expect(client.pending).toBe(0);
  });

  it('ignores malformed and unknown responses', () => {
    const worker = new FakeWorker();
    const client = new FilterClient({ worker });
    expect(() => worker.onmessage?.({ data: undefined } as MessageEvent)).not.toThrow();
    expect(() => worker.onmessage?.({ data: { nope: true } } as MessageEvent)).not.toThrow();
    client.dispose();
  });

  it('ignores responses for requests it no longer tracks', () => {
    const worker = new FakeWorker();
    const client = new FilterClient({ worker });
    const stray: WorkerResponse = { reqId: 999, error: 'x' };
    expect(() => worker.onmessage?.({ data: stray } as MessageEvent)).not.toThrow();
    client.dispose();
    expect(worker.terminated).toBe(true);
  });
});
