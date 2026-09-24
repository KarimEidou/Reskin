import { describe, expect, it } from 'vitest';
import { Engine, createEffect, renderSizes } from '$engine/index';
import { layerThumbnail } from '$engine/doc/thumbnails';
import { getSticker, renderSticker, renderStickerStamp } from '$engine/stickers';
import { PanelsClient, isCancelled, type WorkerLike } from './client';
import type { PanelMessage } from './protocol';
import { handlePanelMessage } from './protocol';
import { docFromSnapshot, snapshotDoc, snapshotLayer } from './snapshot';

function sampleEngine(): Engine {
  const e = new Engine();
  const id = e.doc.layers[0]!.id;
  e.editLayerPixels(id, 'Paint', (s) => {
    for (let y = 100; y < 400; y++) {
      for (let x = 120; x < 380; x++) {
        const i = (y * 512 + x) * 4;
        s.data[i] = x % 256;
        s.data[i + 1] = 90;
        s.data[i + 2] = y % 256;
        s.data[i + 3] = 255;
      }
    }
  });
  e.setLayerProps(id, { effects: [createEffect('dropShadow')], opacity: 0.8 });
  const hidden = e.addLayer({ name: 'Hidden' })!;
  e.setLayerProps(hidden, { visible: false });
  return e;
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

describe('snapshots', () => {
  it('copy the visible layers and rebuild an equivalent document', () => {
    const e = sampleEngine();
    const snap = snapshotDoc(e.doc);
    expect(snap.layers.map((l) => l.name)).toEqual(['Layer 1']);
    expect(snap.layers[0]!.data === (e.doc.layers[0] as { surface: { data: Uint8ClampedArray } }).surface.data).toBe(false);
    const doc = docFromSnapshot(snap);
    const a = renderSizes(e.doc, [16, 48]);
    const b = renderSizes(doc, [16, 48]);
    for (let k = 0; k < a.length; k++) expect(same(a[k]!.surface.data, b[k]!.surface.data)).toBe(true);
    expect(snapshotLayer(e.getLayer(e.addTextLayer({ text: '' })!)!)).toBeNull();
  });
});

describe('worker requests', () => {
  it('renders export sizes exactly like the engine', () => {
    const e = sampleEngine();
    const { response } = handlePanelMessage({ op: 'renderSizes', reqId: 7, doc: snapshotDoc(e.doc), sizes: [16, 32] });
    expect(response.reqId).toBe(7);
    const result = (response as { result: { size: number; pixels: { data: Uint8ClampedArray } }[] }).result;
    const want = renderSizes(e.doc, [16, 32]);
    expect(result.map((r) => r.size)).toEqual([16, 32]);
    result.forEach((r, i) => expect(same(r.pixels.data, want[i]!.surface.data)).toBe(true));
  });

  it('makes layer thumbnails with the engine function', () => {
    const e = sampleEngine();
    const layer = e.doc.layers[0]!;
    const { response } = handlePanelMessage({ op: 'layerThumbs', reqId: 1, layers: [snapshotLayer(layer)!], size: 40, crisp: false });
    const [thumb] = (response as { result: { width: number; data: Uint8ClampedArray }[] }).result;
    expect(thumb!.width).toBe(40);
    expect(same(thumb!.data, layerThumbnail(layer, 40)!.data)).toBe(true);
  });

  it('runs helpers, stickers and presets; reports errors without throwing', () => {
    const star = handlePanelMessage({ op: 'sticker', reqId: 2, id: 'star', size: 64, box: 40, color: '#ff0000', outline: null }).response as { result: { data: Uint8ClampedArray } };
    expect(same(star.result.data, renderSticker(getSticker('star')!, { size: 64, box: 40, color: '#ff0000' }).data)).toBe(true);

    const icon = renderSticker(getSticker('heart')!, { size: 128 });
    const badge = handlePanelMessage({ op: 'helper', reqId: 3, id: 'badge', pixels: icon, values: { text: '3', color: '#00aa00', position: 'tl', size: 40 }, mask: null }).response as { result: { data: Uint8ClampedArray } };
    expect(same(badge.result.data, icon.data)).toBe(false);

    const thumb = handlePanelMessage({ op: 'presetThumb', reqId: 4, iconKey: 'heart', icon, id: 'neon', size: 64, options: {} }).response as { result: { width: number } };
    expect(thumb.result.width).toBe(64);
    const built = handlePanelMessage({ op: 'presetBuild', reqId: 5, iconKey: 'heart', icon, id: 'glass', size: 64, options: { hue: 120 } }).response as { result: { layers: unknown[] } };
    expect(built.result.layers.length).toBeGreaterThanOrEqual(2);

    const bad = handlePanelMessage({ op: 'sticker', reqId: 6, id: 'nope', size: 64, box: 40, color: null, outline: null }).response;
    expect(bad).toEqual({ reqId: 6, error: 'unknown sticker "nope"' });

    const outline = { color: '#ffffff', width: 3 };
    const stamp = handlePanelMessage({ op: 'stickerStamp', reqId: 7, id: 'heart', box: 50, color: '#2255ff', outline }).response as { result: { width: number; data: Uint8ClampedArray } };
    const want = renderStickerStamp(getSticker('heart')!, { box: 50, color: '#2255ff', outline })!;
    expect(stamp.result.width).toBe(want.width);
    expect(same(stamp.result.data, want.data)).toBe(true);
  });
});

describe('PanelsClient', () => {
  it('runs on the calling thread without workers, latest request per channel wins', async () => {
    const client = new PanelsClient(false);
    expect(client.mode).toBe('sync');
    const req = (id: string) => client.request({ op: 'sticker', id, size: 16, box: 12, color: null, outline: null }, { channel: 'c' });
    const first = req('star');
    const second = req('heart');
    second.catch(() => {});
    const third = req('bolt');
    await expect(first).resolves.toMatchObject({ width: 16 });
    await expect(second).rejects.toSatisfy(isCancelled);
    await expect(third).resolves.toMatchObject({ width: 16 });
    const later = req('plus');
    later.catch(() => {});
    client.cancel('c');
    await expect(later).rejects.toSatisfy(isCancelled);
    await expect(client.request({ op: 'sticker', id: 'nope', size: 16, box: 12, color: null, outline: null })).rejects.toThrow('unknown sticker');
    client.dispose();
  });

  it('terminates its worker once and rejects every later request', async () => {
    let terminated = 0;
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => terminated++ };
    const client = new PanelsClient(fake);
    const running = client.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null });
    client.dispose();
    client.dispose();
    expect(terminated).toBe(1);
    await expect(running).rejects.toSatisfy(isCancelled);
    await expect(client.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null })).rejects.toSatisfy(isCancelled);
    expect(client.mode).toBe('sync');
    expect(client.pending).toBe(0);
  });

  it('hands the worker one request at a time, user requests before background work', async () => {
    const posted: PanelMessage[] = [];
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => posted.push(m as PanelMessage),
      terminate: () => {},
    };
    const client = new PanelsClient(fake);
    const sent = () => posted.map((m) => (m as { id: string }).id);
    const reply = (i: number) => fake.onmessage!({ data: { reqId: posted[i]!.reqId, result: (posted[i] as { id: string }).id } } as MessageEvent);
    const sticker = (id: string) => ({ op: 'sticker' as const, id, size: 16, box: 12, color: null, outline: null });

    const a = client.request(sticker('a'), { channel: 'thumb-a', priority: 'low' });
    const b = client.request(sticker('b'), { channel: 'thumb-b', priority: 'low' });
    const c = client.request(sticker('c'));
    expect(sent()).toEqual(['a']);
    expect(client.pending).toBe(3);
    reply(0);
    await expect(a).resolves.toBe('a');
    expect(sent()).toEqual(['a', 'c']);
    reply(1);
    await expect(c).resolves.toBe('c');
    expect(sent()).toEqual(['a', 'c', 'b']);

    // While b runs: a newer request replaces its channel's unstarted one,
    // and cancelling drops a waiting request without computing it.
    const e = client.request(sticker('e'), { channel: 'thumb-e', priority: 'low' });
    const f = client.request(sticker('f'), { channel: 'thumb-e', priority: 'low' });
    await expect(e).rejects.toSatisfy(isCancelled);
    client.cancel('thumb-e');
    await expect(f).rejects.toSatisfy(isCancelled);
    const g = client.request(sticker('g'), { channel: 'thumb-e', priority: 'low' });
    reply(2);
    await expect(b).resolves.toBe('b');
    expect(sent()).toEqual(['a', 'c', 'b', 'g']);
    reply(3);
    await expect(g).resolves.toBe('g');
    expect(client.pending).toBe(0);
    client.dispose();
  });
});
