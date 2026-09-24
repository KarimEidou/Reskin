import { describe, expect, it } from 'vitest';
import { History } from './history';
import type { Command } from './history';
import { PixelTransaction } from './pixel-transaction';
import { PropsCommand, StackCommand, captureStack } from './commands';
import { createDocument, createRasterLayer } from '../doc/document';
import type { Doc, RasterLayer } from '../doc/types';
import { seededRandom } from '../test-helpers';

/** A command that only carries a size, for cap tests. */
function sized(label: string, bytes: number): Command<null> {
  return { label, bytes, undo: () => [], redo: () => [] };
}

function paintRandom(layer: RasterLayer, seed: number, rect: { x: number; y: number; w: number; h: number }): PixelTransaction {
  const tx = new PixelTransaction(layer);
  tx.touch(rect);
  const r = seededRandom(seed);
  const s = layer.surface;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      s.setPixel(x, y, r() * 256, r() * 256, r() * 256, r() * 256);
    }
  }
  return tx;
}

function docWithLayer(): { doc: Doc; layer: RasterLayer } {
  const doc = createDocument();
  return { doc, layer: doc.layers[0] as RasterLayer };
}

describe('History', () => {
  it('undo/redo restores byte-identical pixels', () => {
    const { doc, layer } = docWithLayer();
    const h = new History<Doc>();
    const states = [layer.surface.clone()];
    const rects = [
      { x: 10, y: 10, w: 100, h: 90 },
      { x: 60, y: 0, w: 300, h: 20 },
      { x: 0, y: 0, w: 512, h: 512 },
      { x: 500, y: 500, w: 12, h: 12 },
    ];
    rects.forEach((rect, i) => {
      const cmd = paintRandom(layer, i + 1, rect).commit(`paint ${i}`);
      h.push(cmd!);
      states.push(layer.surface.clone());
    });
    for (let i = rects.length - 1; i >= 0; i--) {
      h.undo(doc);
      expect(layer.surface.equals(states[i])).toBe(true);
    }
    expect(h.undo(doc)).toBeNull();
    for (let i = 1; i <= rects.length; i++) {
      h.redo(doc);
      expect(layer.surface.equals(states[i])).toBe(true);
    }
    h.jumpTo(doc, 1);
    expect(layer.surface.equals(states[1])).toBe(true);
    h.jumpTo(doc, 4);
    expect(layer.surface.equals(states[4])).toBe(true);
  });

  it('stores only tiles that actually changed', () => {
    const { layer } = docWithLayer();
    const tx = new PixelTransaction(layer);
    tx.touch({ x: 0, y: 0, w: 512, h: 512 }); // touched everything…
    layer.surface.setPixel(70, 70, 1, 2, 3, 4); // …but changed one pixel
    const cmd = tx.commit('dot')!;
    expect(cmd.tiles.map((t) => t.index)).toEqual([9]);
    expect(cmd.bytes).toBeLessThan(64 * 64 * 4 + 512);
    const noop = new PixelTransaction(layer);
    noop.touch({ x: 0, y: 0, w: 10, h: 10 });
    expect(noop.commit('nothing')).toBeNull();
  });

  it('cancel restores the base', () => {
    const { layer } = docWithLayer();
    const before = layer.surface.clone();
    const tx = paintRandom(layer, 5, { x: 3, y: 3, w: 40, h: 40 });
    expect(tx.cancel()).toEqual({ x: 3, y: 3, w: 40, h: 40 });
    expect(layer.surface.equals(before)).toBe(true);
  });

  it('drops the oldest entries past the byte cap (keeping the newest)', () => {
    const h = new History<null>({ maxBytes: 1000 });
    for (let i = 0; i < 5; i++) h.push(sized(`c${i}`, 300));
    expect(h.entries.map((e) => e.label)).toEqual(['c2', 'c3', 'c4']);
    expect(h.index).toBe(3);
    expect(h.totalBytes).toBe(900);
    expect(h.droppedCount).toBe(2);
    h.push(sized('huge', 5000));
    expect(h.entries.map((e) => e.label)).toEqual(['huge']);
    h.maxBytes = 100;
    expect(h.length).toBe(1);
  });

  it('prefers dropping redo entries when nothing is applied', () => {
    const h = new History<null>({ maxBytes: 10_000 });
    for (let i = 0; i < 3; i++) h.push(sized(`c${i}`, 300));
    h.jumpTo(null, 0);
    h.maxBytes = 650;
    expect(h.entries.map((e) => e.label)).toEqual(['c0', 'c1']);
    expect(h.index).toBe(0);
  });

  it('push discards the redo tail', () => {
    const h = new History<null>();
    h.push(sized('a', 1));
    h.push(sized('b', 1));
    h.undo(null);
    h.push(sized('c', 1));
    expect(h.entries.map((e) => e.label)).toEqual(['a', 'c']);
    expect(h.canRedo).toBe(false);
  });

  it('merges pushes with the same key inside the window', () => {
    let now = 0;
    const { doc, layer } = docWithLayer();
    const h = new History<Doc>({ now: () => now });
    const op = (v: number) => {
      const cmd = new PropsCommand('Layer opacity', layer, { opacity: layer.opacity }, { opacity: v });
      cmd.redo();
      h.push(cmd, { mergeKey: 'opacity' });
    };
    op(0.9);
    now = 500;
    op(0.8);
    now = 900;
    op(0.7);
    expect(h.length).toBe(1);
    now = 5000;
    op(0.6); // outside the window → new entry
    expect(h.length).toBe(2);
    h.undo(doc);
    expect(layer.opacity).toBe(0.7);
    h.undo(doc);
    expect(layer.opacity).toBe(1);
  });

  it('merges consecutive pixel edits into one tile set', () => {
    const { doc, layer } = docWithLayer();
    const h = new History<Doc>();
    const before = layer.surface.clone();
    h.push(paintRandom(layer, 1, { x: 0, y: 0, w: 70, h: 10 }).commit('nudge')!, { mergeKey: 'nudge' });
    h.push(paintRandom(layer, 2, { x: 60, y: 0, w: 100, h: 100 }).commit('nudge')!, { mergeKey: 'nudge' });
    const after = layer.surface.clone();
    expect(h.length).toBe(1);
    h.undo(doc);
    expect(layer.surface.equals(before)).toBe(true);
    h.redo(doc);
    expect(layer.surface.equals(after)).toBe(true);
  });

  it('structural commands swap layer lists and count detached layers', () => {
    const { doc } = docWithLayer();
    const h = new History<Doc>();
    const extra = createRasterLayer(doc);
    const before = captureStack(doc);
    const cmd = new StackCommand('Add', before, { layers: [...doc.layers, extra], activeLayerId: extra.id });
    cmd.redo(doc);
    h.push(cmd);
    expect(cmd.bytes).toBeGreaterThanOrEqual(512 * 512 * 4);
    expect(doc.layers).toHaveLength(2);
    h.undo(doc);
    expect(doc.layers).toHaveLength(1);
    expect(doc.activeLayerId).toBe(before.activeLayerId);
  });

  it('clear empties everything', () => {
    const h = new History<null>();
    h.push(sized('a', 10));
    h.clear();
    expect(h.length).toBe(0);
    expect(h.canUndo).toBe(false);
  });
});
