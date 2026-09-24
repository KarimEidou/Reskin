import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROJECT_LAYERS,
  PROJECT_VERSION,
  ProjectError,
  deserializeProject,
  looksLikeProject,
  migrateProject,
  projectToJson,
  serializeProject,
} from './project';
import { Autosave } from './autosave';
import { bestFrameIndex, fitAndCenter, importLayer, surfaceFromImageData } from './import';
import { createDocument, createRasterLayer, createTextLayer } from '../doc/document';
import { createEffect } from '../doc/effects';
import type { Doc, RasterLayer, TextLayer } from '../doc/types';
import { Surface } from '../raster/surface';
import { encodeBase64 } from '../util/base64';
import { OutputLimitError, deflate, inflate } from '../util/compress';
import { seededRandom } from '../test-helpers';

function randomize(s: Surface, seed: number): void {
  const r = seededRandom(seed);
  for (let i = 0; i < s.data.length; i++) s.data[i] = Math.floor(r() * 256);
}

function richDoc(): Doc {
  const doc = createDocument({ name: 'Rich', source: { kind: 'shortcut', name: 'App', path: 'C:\\Users\\a\\Desktop\\App.lnk' }, createdAt: 1234 });
  randomize((doc.layers[0] as RasterLayer).surface, 1);
  const second = createRasterLayer(doc, {
    name: 'Glow',
    opacity: 0.4,
    blend: 'screen',
    locked: true,
    effects: [createEffect('dropShadow', { distance: 3 }), createEffect('outline', { position: 'inside' })],
  });
  randomize(second.surface, 2);
  const text = createTextLayer(doc, { text: 'Hi\nthere', fontSize: 40, rotation: 12, color: { r: 1, g: 2, b: 3, a: 0.5 } });
  text.visible = false;
  doc.layers.push(second, text);
  doc.activeLayerId = second.id;
  return doc;
}

describe('.reskin projects', () => {
  it('round-trips with byte-identical pixels and all props', async () => {
    const doc = richDoc();
    const json = await serializeProject(doc);
    expect(looksLikeProject(json)).toBe(true);
    const back = await deserializeProject(json);
    expect(back.width).toBe(512);
    expect(back.meta).toEqual(doc.meta);
    expect(back.activeLayerId).toBe(doc.activeLayerId);
    expect(back.layers.map((l) => l.id)).toEqual(doc.layers.map((l) => l.id));
    for (let i = 0; i < 2; i++) {
      const a = doc.layers[i] as RasterLayer;
      const b = back.layers[i] as RasterLayer;
      expect(b.surface.equals(a.surface)).toBe(true);
      expect({ ...b, surface: null }).toEqual({ ...a, surface: null });
    }
    const t = back.layers[2] as TextLayer;
    expect({ ...t, cache: null, cacheKey: null }).toEqual({ ...(doc.layers[2] as TextLayer), cache: null, cacheKey: null });
    // New ids never collide with loaded ones.
    expect(back.seq).toBeGreaterThanOrEqual(3);
  });

  it('snapshots pixels when serialization starts', async () => {
    const doc = createDocument({ pixelArt: 16 });
    const s = (doc.layers[0] as RasterLayer).surface;
    s.fill(1, 2, 3, 255);
    const pending = serializeProject(doc);
    s.fill(9, 9, 9, 9); // an edit while the compressor is still running
    const back = await deserializeProject(await pending);
    expect((back.layers[0] as RasterLayer).surface.getPixel(5, 5)).toEqual([1, 2, 3, 255]);
  });

  it('round-trips pixel-art documents', async () => {
    const doc = createDocument({ pixelArt: 24 });
    randomize((doc.layers[0] as RasterLayer).surface, 9);
    const back = await deserializeProject(await projectToJson(doc));
    expect(back.pixelArt).toEqual({ grid: 24 });
    expect((back.layers[0] as RasterLayer).surface.equals((doc.layers[0] as RasterLayer).surface)).toBe(true);
  });

  it('migrates version 0 (opacity 0..100, no ids/effects)', async () => {
    const px = new Uint8Array(16 * 16 * 4).fill(200);
    const v0 = {
      format: 'reskin',
      version: 0,
      size: 16,
      name: 'Old',
      layers: [
        { name: 'Base', visible: true, opacity: 100, pixels: encodeBase64(await deflate(px)) },
        { name: 'Top', visible: false, opacity: 35, blend: 'multiply', pixels: encodeBase64(await deflate(px)) },
      ],
    };
    const p = migrateProject(JSON.stringify(v0));
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.layers.map((l) => [l.id, l.opacity, l.locked, l.effects.length])).toEqual([
      ['L1', 1, false, 0],
      ['L2', 0.35, false, 0],
    ]);
    expect(p.activeLayerId).toBe('L2');
    const doc = await deserializeProject(v0);
    expect(doc.width).toBe(16);
    expect(doc.pixelArt).toEqual({ grid: 16 });
    expect(doc.layers[1].blend).toBe('multiply');
    expect((doc.layers[0] as RasterLayer).surface.getPixel(3, 3)).toEqual([200, 200, 200, 200]);
    expect(doc.meta.name).toBe('Old');
  });

  it('rejects invalid files with a path', async () => {
    const good = JSON.parse(await serializeProject(createDocument({ pixelArt: 16 })));
    const bad = (patch: (o: Record<string, unknown>) => void) => {
      const o = structuredClone(good);
      patch(o);
      return o;
    };
    await expect(deserializeProject('{nope')).rejects.toThrow(ProjectError);
    await expect(deserializeProject({ format: 'other', version: 1 })).rejects.toThrow(/not a Reskin project/);
    await expect(deserializeProject(bad((o) => (o.version = 99)))).rejects.toThrow(/newer version/);
    await expect(deserializeProject(bad((o) => ((o.layers as { opacity: number }[])[0].opacity = 2)))).rejects.toThrow(
      /layers\[0\]\.opacity/,
    );
    await expect(deserializeProject(bad((o) => ((o.layers as { blend: string }[])[0].blend = 'plus')))).rejects.toThrow(
      /unknown blend mode/,
    );
    await expect(deserializeProject(bad((o) => (o.height = 17)))).rejects.toThrow(/square/);
    await expect(deserializeProject(bad((o) => (o.layers = [])))).rejects.toThrow(/at least one layer/);
    await expect(deserializeProject(bad((o) => ((o.layers as { pixels: string }[])[0].pixels = 'AAAA')))).rejects.toThrow(
      /corrupt pixel data/,
    );
    const short = encodeBase64(await deflate(new Uint8Array(10)));
    await expect(deserializeProject(bad((o) => ((o.layers as { pixels: string }[])[0].pixels = short)))).rejects.toThrow(
      /expected 1024 bytes/,
    );
    await expect(
      deserializeProject(bad((o) => ((o.layers as { effects: unknown[] }[])[0].effects = [{ type: 'bevel' }]))),
    ).rejects.toThrow(/effects\[0\]\.type/);
  });

  it('only accepts the 512 master or a pixel-art grid as the document size', async () => {
    const good = JSON.parse(await serializeProject(createDocument({ pixelArt: 16 })));
    await expect(deserializeProject({ ...good, width: 16, height: 16, pixelArt: null })).rejects.toThrow(
      /width: expected 512/,
    );
    await expect(deserializeProject({ ...good, width: 4096, height: 4096, pixelArt: null })).rejects.toThrow(/width/);
    await expect(deserializeProject({ ...good, width: 20, height: 20, pixelArt: { grid: 20 } })).rejects.toThrow(
      /pixelArt\.grid/,
    );
    const v0 = { format: 'reskin', version: 0, size: 100, layers: [] };
    expect(() => migrateProject(v0)).toThrow(/size: expected 512/);
  });

  it('caps the layer count', async () => {
    const good = JSON.parse(await serializeProject(createDocument({ pixelArt: 16 })));
    const layers = Array.from({ length: MAX_PROJECT_LAYERS + 1 }, (_, i) => ({ ...good.layers[0], id: `L${i + 1}` }));
    await expect(deserializeProject({ ...good, layers })).rejects.toThrow(/at most 256 layers/);
  });

  it('stops inflating pixel blobs that decompress past the layer size (zip bombs)', async () => {
    const good = JSON.parse(await serializeProject(createDocument({ pixelArt: 16 })));
    // 1 MB of zeros deflates to about 1 KB, but a 16×16 layer holds only 1024 bytes.
    good.layers[0].pixels = encodeBase64(await deflate(new Uint8Array(1 << 20)));
    await expect(deserializeProject(good)).rejects.toThrow(/layers\[0\]\.pixels: more than 1024 bytes/);
    good.layers[0].pixels = 'A'.repeat(4096);
    await expect(deserializeProject(good)).rejects.toThrow(/pixel data is too long/);
  });

  it('fills missing effect fields from defaults', async () => {
    const good = JSON.parse(await serializeProject(createDocument({ pixelArt: 16 })));
    good.layers[0].effects = [{ type: 'outerGlow', size: 3 }];
    const doc = await deserializeProject(good);
    expect(doc.layers[0].effects[0]).toEqual({ ...createEffect('outerGlow'), size: 3 });
  });
});

describe('zlib helpers', () => {
  it('round-trip and enforce an output limit', async () => {
    const data = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) % 251);
    const z = await deflate(data);
    expect(await inflate(z)).toEqual(data);
    expect(await inflate(z, data.length)).toEqual(data);
    await expect(inflate(z, data.length - 1)).rejects.toBeInstanceOf(OutputLimitError);
    await expect(inflate(Uint8Array.of(1, 2, 3))).rejects.toThrow();
  });
});

describe('Autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces bursts of changes into one save', async () => {
    const saved: string[] = [];
    let n = 0;
    const a = new Autosave({ produce: () => `v${++n}`, save: async (d) => void saved.push(d), delayMs: 1000, maxWaitMs: 5000 });
    for (let i = 0; i < 5; i++) {
      a.schedule();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual(['v1']);
    expect(a.pending).toBe(false);
  });

  it('saves at least every maxWait during continuous edits', async () => {
    const saved: string[] = [];
    const a = new Autosave({ produce: () => 'x', save: async (d) => void saved.push(d), delayMs: 1000, maxWaitMs: 3000 });
    for (let i = 0; i < 20; i++) {
      a.schedule();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(saved.length).toBeGreaterThanOrEqual(3);
  });

  it('flushes immediately and never overlaps saves', async () => {
    let active = 0;
    let maxActive = 0;
    const saved: number[] = [];
    let n = 0;
    const a = new Autosave({
      produce: () => String(++n),
      save: async (d) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 100));
        saved.push(Number(d));
        active--;
      },
      delayMs: 10,
    });
    a.schedule();
    await vi.advanceTimersByTimeAsync(20); // first save running
    a.schedule(); // change during the save
    const flushed = a.flush();
    await vi.advanceTimersByTimeAsync(500);
    await flushed;
    expect(saved).toEqual([1, 2]);
    expect(maxActive).toBe(1);
    a.dispose();
    a.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([1, 2]);
  });

  it('skips the save when produce has nothing to save', async () => {
    const saved: string[] = [];
    let data: string | null = null;
    const a = new Autosave({ produce: () => data, save: async (d) => void saved.push(d), delayMs: 10 });
    a.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual([]);
    expect(a.pending).toBe(false);
    data = 'edited';
    a.schedule();
    await a.flush();
    expect(saved).toEqual(['edited']);
  });

  it('write replaces the pending change and keeps the order of saves', async () => {
    const saved: string[] = [];
    const a = new Autosave({
      produce: () => 'produced',
      save: async (d) => {
        await new Promise((r) => setTimeout(r, 100));
        saved.push(d);
      },
      delayMs: 10,
    });
    a.schedule();
    await vi.advanceTimersByTimeAsync(20); // "produced" is being saved
    a.schedule(); // a change nobody has saved yet…
    const written = a.write('given'); // …replaced by this data
    expect(a.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await written;
    expect(saved).toEqual(['produced', 'given']);
  });

  it('enqueue runs after the saves before it and rejects with its own failure', async () => {
    const order: string[] = [];
    const a = new Autosave({
      produce: () => 'x',
      save: async () => {
        await new Promise((r) => setTimeout(r, 100));
        order.push('save');
      },
      delayMs: 10,
    });
    a.schedule();
    await vi.advanceTimersByTimeAsync(20);
    const failing = a.enqueue(async () => {
      order.push('task');
      throw new Error('locked');
    });
    const next = a.enqueue(async () => {
      order.push('after');
      return 42;
    });
    const rejected = expect(failing).rejects.toThrow('locked');
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(await next).toBe(42);
    expect(order).toEqual(['save', 'task', 'after']);
  });

  it('reports errors and keeps working', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const saved: string[] = [];
    const a = new Autosave({
      produce: () => 'd',
      save: async (d) => {
        if (fail) throw new Error('disk full');
        saved.push(d);
      },
      delayMs: 10,
      onError: (e) => errors.push(e),
    });
    a.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toHaveLength(1);
    fail = false;
    a.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toEqual(['d']);
  });
});

describe('import helpers', () => {
  it('fits and centres with padding (contain)', () => {
    const src = new Surface(200, 100);
    src.fill(255, 0, 0, 255);
    const out = fitAndCenter(src, { size: 512, padding: 16 });
    expect(out.alphaBounds()).toEqual({ x: 16, y: 136, w: 480, h: 240 });
    expect(out.getPixel(256, 256)).toEqual([255, 0, 0, 255]);
  });

  it('covers, trims and keeps small icons crisp', () => {
    const src = new Surface(40, 20);
    src.fill(0, 0, 255, 255, { x: 10, y: 5, w: 20, h: 10 });
    const trimmed = fitAndCenter(src, { size: 64, trim: true, fit: 'contain' });
    expect(trimmed.alphaBounds()).toEqual({ x: 0, y: 16, w: 64, h: 32 });
    const cover = fitAndCenter(src, { size: 64, trim: true, fit: 'cover' });
    expect(cover.alphaBounds()).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    const tiny = new Surface(2, 2);
    tiny.setPixel(0, 0, 255, 255, 255, 255);
    const crisp = fitAndCenter(tiny, { size: 8 });
    expect(crisp.getPixel(3, 3)).toEqual([255, 255, 255, 255]);
    expect(crisp.getPixel(4, 4)).toEqual([0, 0, 0, 0]);
    const noUp = fitAndCenter(tiny, { size: 8, allowUpscale: false });
    expect(noUp.alphaBounds()).toEqual({ x: 3, y: 3, w: 1, h: 1 });
  });

  it('builds layers from ImageData-like objects and picks the best frame', () => {
    const doc = createDocument({ pixelArt: 32 });
    const img = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) };
    const layer = importLayer(doc, surfaceFromImageData(img), 'Icon');
    expect(layer.surface.width).toBe(32);
    expect(layer.surface.alphaBounds()).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(bestFrameIndex([{ width: 16, height: 16 }, { width: 256, height: 256 }, { width: 48, height: 48 }])).toBe(1);
    expect(bestFrameIndex([])).toBe(-1);
  });
});
