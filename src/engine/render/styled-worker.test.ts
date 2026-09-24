import { describe, expect, it } from 'vitest';
import { createEffect } from '../doc/effects';
import { Surface } from '../raster/surface';
import { renderStyledPixels } from './effects';
import { StyledWorker, styledWorker, type StyledJob, type StyledJobResult, type StyledWorkerLike } from './styled-worker';

/** A worker running the real renderer on the next microtask (like effects.worker.ts). */
class FakeWorker implements StyledWorkerLike {
  onmessage: ((ev: MessageEvent<StyledJobResult>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  jobs: StyledJob[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  failWith: string | null = null;

  postMessage(job: StyledJob, transfer: Transferable[]): void {
    this.jobs.push(job);
    this.transfers.push(transfer);
    queueMicrotask(() => {
      if (this.failWith) {
        this.reply({ id: job.id, error: this.failWith });
        return;
      }
      const src = new Surface(job.width, job.height, new Uint8ClampedArray(job.pixels));
      const styled = renderStyledPixels(src, JSON.parse(job.effects));
      this.reply(styled ? { id: job.id, rect: styled.rect, pixels: styled.data.slice().buffer } : { id: job.id, rect: null, pixels: null });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private reply(r: StyledJobResult): void {
    this.onmessage?.({ data: r } as MessageEvent<StyledJobResult>);
  }
}

function square(): Surface {
  const s = new Surface(32, 32);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) s.data.set([200, 40, 90, 255], (y * 32 + x) * 4);
  return s;
}

const effects = [createEffect('dropShadow', { distance: 3, blur: 4 }), createEffect('outline', { width: 2 })];

describe('StyledWorker', () => {
  it('renders a copy of the pixels off the calling thread, like the renderer here', async () => {
    const fake = new FakeWorker();
    const worker = new StyledWorker(fake);
    const src = square();
    const pending = worker.render(src, effects);
    // The source stays usable: what went over is a copy, transferred.
    expect(fake.transfers[0]).toEqual([fake.jobs[0]!.pixels]);
    expect(fake.jobs[0]!.pixels).not.toBe(src.data.buffer);
    expect(src.data.byteLength).toBe(32 * 32 * 4);
    const styled = await pending;
    const here = renderStyledPixels(src, effects)!;
    expect(styled!.rect).toEqual(here.rect);
    expect(styled!.data).toEqual(here.data);
    expect(await worker.render(new Surface(8, 8), effects)).toBeNull();
    expect(worker.usable).toBe(true);
  });

  it('gives up for good when a render fails', async () => {
    const fake = new FakeWorker();
    const worker = new StyledWorker(fake);
    fake.failWith = 'out of memory';
    await expect(worker.render(square(), effects)).rejects.toThrow('out of memory');
    expect(worker.usable).toBe(false);
    expect(fake.terminated).toBe(true);
    await expect(worker.render(square(), effects)).rejects.toThrow();
    expect(fake.jobs).toHaveLength(1);
  });

  it('rejects everything in flight when the worker dies', async () => {
    const fake = new FakeWorker();
    const worker = new StyledWorker(fake);
    fake.postMessage = (job) => fake.jobs.push(job);
    const a = worker.render(square(), effects);
    const b = worker.render(square(), effects);
    fake.onerror?.({ message: 'script error' } as ErrorEvent);
    await expect(a).rejects.toThrow('script error');
    await expect(b).rejects.toThrow('script error');
    expect(worker.usable).toBe(false);
  });

  it('is absent where there is no Worker (node)', () => {
    expect(styledWorker()).toBeNull();
  });
});
