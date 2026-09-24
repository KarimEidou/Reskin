import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '$engine/index';
import { PanelsClient, type WorkerLike } from '../worker/client';
import { handlePanelMessage, type PanelMessage } from '../worker/protocol';
import { LayerThumbs } from './thumbs.svelte';

afterEach(() => {
  vi.useRealTimers();
});

/** A worker that answers every request on the next microtask. */
function inlineWorker(): WorkerLike & { requests: number } {
  const w: WorkerLike & { requests: number } = {
    requests: 0,
    onmessage: null,
    onerror: null,
    postMessage(message) {
      w.requests++;
      const { response } = handlePanelMessage(message as PanelMessage);
      queueMicrotask(() => w.onmessage?.({ data: response } as MessageEvent));
    },
    terminate() {},
  };
  return w;
}

function paint(engine: Engine, value: number): void {
  const id = engine.doc.layers[0]!.id;
  engine.editLayerPixels(id, 'Paint', (s) => s.data.fill(value, 0, 4096));
}

describe('LayerThumbs', () => {
  it('renders dirty layers through the session worker', async () => {
    vi.useFakeTimers();
    const engine = new Engine();
    const client = new PanelsClient(inlineWorker());
    const thumbs = new LayerThumbs(engine, client, 16);
    await vi.advanceTimersByTimeAsync(500);
    const id = engine.doc.layers[0]!.id;
    expect(thumbs.thumbs[id]?.width).toBe(16);
    thumbs.dispose();
    client.dispose();
  });

  it('stops retrying once the worker is gone for good', async () => {
    vi.useFakeTimers();
    const engine = new Engine();
    const client = new PanelsClient(inlineWorker());
    const request = vi.spyOn(client, 'request');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thumbs = new LayerThumbs(engine, client, 16);
    await vi.advanceTimersByTimeAsync(500);
    client.dispose();
    const before = request.mock.calls.length;
    paint(engine, 200);
    await vi.advanceTimersByTimeAsync(5000);
    // One attempt for the new pixels, then nothing: no timer loop, and no failure reported.
    expect(request.mock.calls.length).toBe(before + 1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    thumbs.dispose();
  });
});
