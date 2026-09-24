import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createRasterLayer, createTextLayer } from '../doc/document';
import type { Doc, RasterLayer } from '../doc/types';
import { seededRandom } from '../test-helpers';
import { handleEncode, ProjectEncoder, type EncodeRequest, type EncoderWorker } from './encoder';
import { deserializeProject, serializeProject } from './project';

function sampleDoc(): Doc {
  const doc = createDocument({ name: 'Sample', source: { kind: 'shortcut', name: 'App', path: 'C:\\App.lnk' }, createdAt: 7 });
  const r = seededRandom(3);
  const base = doc.layers[0] as RasterLayer;
  for (let i = 0; i < base.surface.data.length; i++) base.surface.data[i] = Math.floor(r() * 256);
  const glow = createRasterLayer(doc, { name: 'Glow', opacity: 0.5 });
  glow.surface.data.fill(200);
  doc.layers.push(glow, createTextLayer(doc, { text: 'Hi', fontSize: 48 }));
  return doc;
}

/** A worker stand-in: records what it is sent; the test answers. */
class FakeWorker implements EncoderWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  posted: { message: EncodeRequest; transfer: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push({ message: message as EncodeRequest, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Runs what the real worker runs for request `n` and answers. */
  async answer(n = 0): Promise<void> {
    const res = await handleEncode(this.posted[n]!.message);
    this.onmessage?.({ data: res } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectEncoder', () => {
  it('encodes on the calling thread without a worker, exactly like serializeProject', async () => {
    const doc = sampleDoc();
    const encoder = new ProjectEncoder({ worker: false });
    expect(encoder.mode).toBe('sync');
    expect(await encoder.encode(doc, { savedAt: 1 })).toBe(await serializeProject(doc, { savedAt: 1 }));
  });

  it('hands the worker raw pixel copies (transferred) and leaves compression to it', async () => {
    const doc = sampleDoc();
    const worker = new FakeWorker();
    const encoder = new ProjectEncoder({ worker });
    expect(encoder.mode).toBe('worker');
    const json = encoder.encode(doc, { savedAt: 1 });
    const [{ message, transfer }] = worker.posted;
    const rasters = message!.snapshot.layers.filter((l) => l.kind === 'raster');
    expect(rasters).toHaveLength(2);
    for (const l of rasters) {
      // Not encoded yet: the calling thread only copied the pixels…
      expect(l.pixels).toBeInstanceOf(Uint8Array);
      expect(l.pixels.length).toBe(512 * 512 * 4);
      // …and gives the copies away instead of cloning them again.
      expect(transfer).toContain(l.pixels.buffer);
    }
    expect(rasters[0]!.pixels.buffer).not.toBe((doc.layers[0] as RasterLayer).surface.data.buffer);
    await worker.answer();
    const text = await json;
    expect(text).toBe(await serializeProject(doc, { savedAt: 1 }));
    const back = await deserializeProject(text);
    expect((back.layers[0] as RasterLayer).surface.data).toEqual((doc.layers[0] as RasterLayer).surface.data);
  });

  it('encodes the document as it was when asked, whatever happens meanwhile', async () => {
    const doc = sampleDoc();
    const before = await serializeProject(doc, { savedAt: 1 });
    const worker = new FakeWorker();
    const encoder = new ProjectEncoder({ worker });
    const json = encoder.encode(doc, { savedAt: 1 });
    (doc.layers[1] as RasterLayer).surface.data.fill(9);
    doc.layers.pop();
    doc.meta.name = 'Renamed';
    await worker.answer();
    expect(await json).toBe(before);
  });

  it('a failing worker fails what it had; later requests run on the calling thread', async () => {
    const doc = sampleDoc();
    const worker = new FakeWorker();
    const encoder = new ProjectEncoder({ worker });
    const lost = encoder.encode(doc);
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(lost).rejects.toThrow('boom');
    expect(worker.terminated).toBe(true);
    expect(encoder.mode).toBe('sync');
    expect(await encoder.encode(doc, { savedAt: 2 })).toBe(await serializeProject(doc, { savedAt: 2 }));
  });

  it('reports an encoding error as a rejection', async () => {
    const worker = new FakeWorker();
    const encoder = new ProjectEncoder({ worker });
    const json = encoder.encode(sampleDoc());
    worker.onmessage?.({ data: { id: worker.posted[0]!.message.id, error: 'out of memory' } } as MessageEvent);
    await expect(json).rejects.toThrow('out of memory');
  });

  it('dispose stops the worker and rejects running and later requests', async () => {
    const worker = new FakeWorker();
    const encoder = new ProjectEncoder({ worker });
    const running = encoder.encode(sampleDoc());
    encoder.dispose();
    encoder.dispose();
    expect(worker.terminated).toBe(true);
    await expect(running).rejects.toThrow('closed');
    await expect(encoder.encode(sampleDoc())).rejects.toThrow('closed');
    // A late answer from the stopped worker changes nothing.
    await worker.answer();
  });

  it('spawns its module worker by default', () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        constructor(url: URL, opts: WorkerOptions) {
          super();
          urls.push(`${url.pathname} ${opts.type}`);
        }
      },
    );
    const encoder = new ProjectEncoder();
    expect(encoder.mode).toBe('worker');
    expect(urls).toEqual([expect.stringMatching(/project\.worker\.ts module$/)]);
    encoder.dispose();
  });
});
