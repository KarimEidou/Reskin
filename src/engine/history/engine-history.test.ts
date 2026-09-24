// The engine's public history API: whole-stack replacement, live layer
// previews and sealing (what the sidebar panels build on).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../engine';
import type { EngineEvent } from '../engine';
import { createRasterLayer } from '../doc/document';
import type { RasterLayer } from '../doc/types';
import { Surface } from '../raster/surface';
import { pointer } from '../test-helpers';

/** An engine whose only layer holds a deterministic pattern, with a clean history. */
function setup(): { engine: Engine; id: string; layer: () => RasterLayer } {
  const engine = new Engine();
  const id = engine.doc.layers[0]!.id;
  const layer = () => engine.getLayer(id) as RasterLayer;
  const d = layer().surface.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (i / 4) % 256;
    d[i + 1] = 40;
    d[i + 2] = 200;
    d[i + 3] = i % 12 === 0 ? 128 : 255;
  }
  return { engine, id, layer };
}

function collect(engine: Engine): EngineEvent[] {
  const out: EngineEvent[] = [];
  engine.subscribe((e) => out.push(e));
  return out;
}

/** Byte equality without the cost of deep-diffing 1 MB arrays. */
function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

/** The pattern with channel 0 shifted by `k` (every pixel changes). */
function variant(src: Uint8ClampedArray, k: number): Uint8ClampedArray {
  const out = src.slice();
  for (let i = 0; i < out.length; i += 4) out[i] = (out[i]! + k) % 256;
  return out;
}

function image(data: Uint8ClampedArray) {
  return { width: 512, height: 512, data };
}

function labels(engine: Engine): string[] {
  return engine.historyEntries.map((e) => e.label);
}

function solidLayer(engine: Engine, name: string, rgba: [number, number, number, number]): RasterLayer {
  const s = new Surface(engine.doc.width, engine.doc.height);
  s.fill(...rgba);
  return createRasterLayer(engine.doc, { name, surface: s });
}

describe('Engine.replaceLayers', () => {
  it('replaces the stack as one step; undo/redo are byte-identical', () => {
    const { engine } = setup();
    const before = engine.doc.layers.slice();
    const composite = engine.composite().data.slice();
    const events = collect(engine);
    const top = solidLayer(engine, 'Top', [255, 0, 0, 255]);
    const bottom = solidLayer(engine, 'Bottom', [0, 0, 255, 255]);
    const entry = engine.replaceLayers([bottom, top], { label: 'Style: Test' });
    expect(entry).toBe(engine.currentEntryId);
    expect(labels(engine)).toEqual(['Style: Test']);
    expect(engine.doc.layers).toEqual([bottom, top]);
    // The active layer was replaced: the top layer becomes active.
    expect(engine.doc.activeLayerId).toBe(top.id);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['layers', 'history']));
    const styled = engine.composite().data.slice();

    engine.undo();
    expect(engine.doc.layers).toEqual(before);
    expect(same(engine.composite().data, composite)).toBe(true);
    engine.redo();
    expect(engine.doc.layers).toEqual([bottom, top]);
    expect(same(engine.composite().data, styled)).toBe(true);
  });

  it('keeps the active layer when it stays, or takes the one given', () => {
    const { engine, id } = setup();
    const extra = solidLayer(engine, 'Extra', [1, 2, 3, 255]);
    engine.replaceLayers([extra, engine.getLayer(id)!], { label: 'Add' });
    expect(engine.doc.activeLayerId).toBe(id);
    engine.replaceLayers(engine.doc.layers, { label: 'Pick', activeLayerId: extra.id });
    expect(engine.doc.activeLayerId).toBe(extra.id);
  });

  it('refuses stacks that do not fit the document', () => {
    const { engine, id } = setup();
    const own = engine.getLayer(id)!;
    const small: RasterLayer = { ...createRasterLayer(engine.doc, { name: 'Small' }), surface: new Surface(16, 16) };
    expect(() => engine.replaceLayers([], { label: 'x' })).toThrow(RangeError);
    expect(() => engine.replaceLayers([own, small], { label: 'x' })).toThrow(RangeError);
    expect(() => engine.replaceLayers([own, own], { label: 'x' })).toThrow(RangeError);
    expect(() => engine.replaceLayers([own], { label: 'x', activeLayerId: 'nope' })).toThrow(RangeError);
    expect(engine.historyEntries).toHaveLength(0);
  });

  it('commits a pending transform first, as its own step', () => {
    const { engine } = setup();
    engine.setTool('move');
    engine.pointerDown(pointer(200, 200));
    engine.pointerMove(pointer(240, 200));
    engine.pointerUp(pointer(240, 200));
    expect(engine.hasPending).toBe(true);
    engine.replaceLayers([solidLayer(engine, 'New', [9, 9, 9, 255])], { label: 'Replace' });
    expect(engine.hasPending).toBe(false);
    expect(labels(engine)).toEqual(['Move', 'Replace']);
  });

  it('leaves out a text layer that closing the inline editor removes (the stack was built with it)', () => {
    const { engine, id } = setup();
    // A text layer just added and left empty: closing its editor rolls it back.
    const text = engine.addTextLayer({ text: '' })!;
    engine.beginTextEdit(text);
    const extra = solidLayer(engine, 'Sticker', [1, 2, 3, 255]);
    const layers = [...engine.doc.layers, extra];
    // Its editor's layer was active: it cannot stay active once it is gone.
    engine.replaceLayers(layers, { label: 'Add sticker', activeLayerId: engine.doc.activeLayerId });
    expect(engine.textEditLayerId).toBeNull();
    expect(engine.doc.layers.map((l) => l.id)).toEqual([id, extra.id]);
    expect(engine.doc.activeLayerId).toBe(id);
    expect(labels(engine)).toEqual(['Add sticker']);
    engine.undo();
    expect(engine.doc.layers.map((l) => l.id)).toEqual([id]);
  });

  describe('merging', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('merges replacements with the same key into one step that undoes to the first "before"', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { engine } = setup();
      const before = engine.doc.layers.slice();
      const first = engine.replaceLayers([solidLayer(engine, 'A', [255, 0, 0, 255])], { label: 'Style', mergeKey: 'style' });
      vi.advanceTimersByTime(500);
      const second = engine.replaceLayers([solidLayer(engine, 'B', [0, 255, 0, 255])], { label: 'Style', mergeKey: 'style' });
      expect(second).toBe(first);
      expect(labels(engine)).toEqual(['Style']);
      expect(engine.doc.layers.map((l) => l.name)).toEqual(['B']);
      // Past the default one-second window: a new step.
      vi.advanceTimersByTime(1500);
      engine.replaceLayers([solidLayer(engine, 'C', [0, 0, 255, 255])], { label: 'Style', mergeKey: 'style' });
      expect(labels(engine)).toEqual(['Style', 'Style']);
      engine.undo();
      engine.undo();
      expect(engine.doc.layers).toEqual(before);
    });

    it('merges without a time limit while it is the latest change (Infinity)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { engine } = setup();
      const opts = { label: 'Style', mergeKey: 'look', mergeWindowMs: Infinity };
      engine.replaceLayers([solidLayer(engine, 'A', [255, 0, 0, 255])], opts);
      vi.advanceTimersByTime(60_000);
      engine.replaceLayers([solidLayer(engine, 'B', [0, 255, 0, 255])], opts);
      expect(labels(engine)).toEqual(['Style']);
      engine.addLayer();
      engine.replaceLayers([solidLayer(engine, 'C', [0, 0, 255, 255])], opts);
      expect(labels(engine)).toEqual(['Style', 'New layer', 'Style']);
    });
  });
});

describe('Engine.sealHistory', () => {
  it('keeps two separate slider drags inside the merge window as two steps', () => {
    const { engine, id } = setup();
    for (const o of [0.9, 0.8]) engine.setLayerProps(id, { opacity: o }, { merge: 'opacity' });
    expect(engine.historyEntries).toHaveLength(1);
    engine.sealHistory();
    for (const o of [0.7, 0.6]) engine.setLayerProps(id, { opacity: o }, { merge: 'opacity' });
    expect(engine.historyEntries).toHaveLength(2);
    engine.undo();
    expect(engine.getLayer(id)!.opacity).toBe(0.8);
    engine.undo();
    expect(engine.getLayer(id)!.opacity).toBe(1);
  });

  it('also stops a stack replacement from merging', () => {
    const { engine } = setup();
    const opts = { label: 'Style', mergeKey: 'look', mergeWindowMs: Infinity };
    engine.replaceLayers([solidLayer(engine, 'A', [255, 0, 0, 255])], opts);
    engine.sealHistory();
    engine.replaceLayers([solidLayer(engine, 'B', [0, 255, 0, 255])], opts);
    expect(labels(engine)).toEqual(['Style', 'Style']);
  });

  it('seals the step an undo exposes, so the next drag does not merge into it', () => {
    const { engine, id } = setup();
    engine.setLayerProps(id, { opacity: 0.9 }, { merge: 'opacity' });
    engine.addLayer();
    engine.undo();
    engine.sealHistory();
    engine.setLayerProps(id, { opacity: 0.5 }, { merge: 'opacity' });
    expect(engine.historyEntries).toHaveLength(2);
    engine.undo();
    expect(engine.getLayer(id)!.opacity).toBe(0.9);
  });

  it('is harmless on an empty history', () => {
    const engine = new Engine();
    engine.sealHistory();
    expect(engine.historyEntries).toHaveLength(0);
  });
});

describe('Engine.beginPreview', () => {
  it('shows updates on the canvas without touching the history', () => {
    const { engine, id, layer } = setup();
    const original = layer().surface.data.slice();
    const events = collect(engine);
    const p = engine.beginPreview('Adjust: Test')!;
    expect(engine.preview).toBe(p);
    expect(p.state).toBe('open');
    expect(same(p.original.data, original)).toBe(true);
    expect(p.update(image(variant(original, 50)))).toBe(true);
    expect(same(layer().surface.data, variant(original, 50))).toBe(true);
    expect(p.changed).toBe(true);
    expect(engine.historyEntries).toHaveLength(0);
    expect(events.some((e) => e.kind === 'history')).toBe(false);
    expect(events).toContainEqual({ kind: 'preview', layerId: id, state: 'open' });
    expect(events).toContainEqual({ kind: 'pixels', layerId: id, rect: { x: 0, y: 0, w: 512, h: 512 } });
    // Undo is possible (it would revert the preview) even with no entries.
    expect(engine.canUndo).toBe(true);
  });

  it('redraws only the tiles an update changes', () => {
    const { engine, id, layer } = setup();
    const p = engine.beginPreview('Adjust: Test')!;
    const next = layer().surface.data.slice();
    next[(70 * 512 + 130) * 4] ^= 0xff;
    const events = collect(engine);
    p.update(image(next));
    expect(events).toEqual([{ kind: 'pixels', layerId: id, rect: { x: 128, y: 64, w: 64, h: 64 } }]);
    events.length = 0;
    p.update(image(next));
    expect(events).toEqual([]);
  });

  it('commits many updates as exactly one entry; undo/redo are byte-identical', () => {
    const { engine, layer } = setup();
    const original = layer().surface.data.slice();
    const p = engine.beginPreview('Adjust: Test')!;
    for (const k of [10, 20, 30]) p.update(image(variant(original, k)));
    expect(p.commit()).toBe(true);
    expect(p.state).toBe('committed');
    expect(engine.preview).toBeNull();
    expect(labels(engine)).toEqual(['Adjust: Test']);
    engine.undo();
    expect(same(layer().surface.data, original)).toBe(true);
    engine.redo();
    expect(same(layer().surface.data, variant(original, 30))).toBe(true);
    // Ended previews ignore further calls.
    expect(p.update(image(original))).toBe(false);
    expect(p.commit()).toBe(false);
  });

  it('stores only the tiles that differ from the original', () => {
    const { engine, layer } = setup();
    const p = engine.beginPreview('Adjust: Test')!;
    p.update((s) => s.fill(255, 255, 255, 255, { x: 0, y: 0, w: 64, h: 64 }));
    p.commit();
    expect(engine.historyEntries[0]!.bytes).toBeLessThan(64 * 64 * 4 * 2);
    engine.undo();
    expect(layer().surface.getPixel(10, 10)).not.toEqual([255, 255, 255, 255]);
  });

  it('hands render functions the original pixels every time', () => {
    const { engine, layer } = setup();
    const original = layer().surface.data.slice();
    const p = engine.beginPreview('Adjust: Test')!;
    p.update(image(variant(original, 99)));
    let seen: Uint8ClampedArray | null = null;
    p.update((s) => {
      seen = s.data.slice();
      s.data[0] = 7;
    });
    expect(same(seen!, original)).toBe(true);
    expect(layer().surface.data[0]).toBe(7);
    expect(same(layer().surface.data.subarray(4), original.subarray(4))).toBe(true);
  });

  it('cancel restores the layer byte for byte and keeps the redo steps', () => {
    const { engine, id, layer } = setup();
    engine.setLayerProps(id, { opacity: 0.5 });
    engine.undo();
    expect(engine.canRedo).toBe(true);
    const original = layer().surface.data.slice();
    const events = collect(engine);
    const p = engine.beginPreview('Adjust: Test')!;
    p.update(image(variant(original, 70)));
    p.cancel();
    expect(p.state).toBe('cancelled');
    expect(engine.preview).toBeNull();
    expect(same(layer().surface.data, original)).toBe(true);
    expect(events).toContainEqual({ kind: 'preview', layerId: id, state: 'cancelled' });
    expect(events.filter((e) => e.kind === 'history')).toHaveLength(0);
    expect(engine.canRedo).toBe(true);
    engine.redo();
    expect(engine.getLayer(id)!.opacity).toBe(0.5);
  });

  it('records nothing for an identity preview and keeps the redo steps', () => {
    const { engine, id, layer } = setup();
    engine.setLayerProps(id, { opacity: 0.5 });
    engine.undo();
    const original = layer().surface.data.slice();
    const p = engine.beginPreview('Adjust: Test')!;
    p.update(image(variant(original, 5)));
    p.update(image(original.slice()));
    expect(p.changed).toBe(false);
    expect(p.commit()).toBe(false);
    expect(p.state).toBe('committed');
    expect(engine.historyEntries).toHaveLength(1);
    expect(engine.canRedo).toBe(true);
    expect(same(layer().surface.data, original)).toBe(true);
  });

  it('commits pending work, an inline text edit and another preview before it begins', () => {
    const { engine, id, layer } = setup();
    const original = layer().surface.data.slice();
    const first = engine.beginPreview('Adjust: One')!;
    first.update(image(variant(original, 1)));
    const second = engine.beginPreview('Adjust: Two')!;
    expect(first.state).toBe('committed');
    expect(labels(engine)).toEqual(['Adjust: One']);
    expect(same(second.original.data, variant(original, 1))).toBe(true);
    second.cancel();

    engine.setTool('move');
    engine.pointerDown(pointer(200, 200));
    engine.pointerMove(pointer(240, 200));
    engine.pointerUp(pointer(240, 200));
    expect(engine.hasPending).toBe(true);
    engine.beginPreview('Adjust: Three', { layerId: id })!.cancel();
    expect(engine.hasPending).toBe(false);
    expect(labels(engine)).toEqual(['Adjust: One', 'Move']);

    const text = engine.addTextLayer({ text: 'Hi' })!;
    engine.beginTextEdit(text);
    engine.beginPreview('Adjust: Four', { layerId: id })!.cancel();
    expect(engine.textEditLayerId).toBeNull();
  });

  it('refuses missing, text and locked layers with a message', () => {
    const { engine, id } = setup();
    const events = collect(engine);
    expect(engine.beginPreview('x', { layerId: 'missing' })).toBeNull();
    const text = engine.addTextLayer({ text: 'Hi' })!;
    expect(engine.beginPreview('x', { layerId: text })).toBeNull();
    engine.setLayerProps(id, { locked: true });
    expect(engine.beginPreview('x', { layerId: id })).toBeNull();
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(3);
    expect(engine.preview).toBeNull();
  });

  it('rejects results of another size', () => {
    const { engine } = setup();
    const p = engine.beginPreview('x')!;
    expect(() => p.update({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) })).toThrow(RangeError);
  });

  describe('goes stale (original restored, event observed)', () => {
    /** A preview showing a change; `prepare` runs on the engine first. */
    function started(prepare?: (engine: Engine, id: string) => void) {
      const s = setup();
      prepare?.(s.engine, s.id);
      const original = s.layer().surface.data.slice();
      const p = s.engine.beginPreview('Adjust: Test')!;
      p.update(image(variant(original, 40)));
      const events = collect(s.engine);
      const staleSeen = () => events.some((e) => e.kind === 'preview' && e.state === 'stale');
      return { ...s, original, p, staleSeen };
    }

    it('when its layer is locked', () => {
      const { engine, id, layer, original, p, staleSeen } = started();
      engine.setLayerProps(id, { locked: true });
      expect(p.state).toBe('stale');
      expect(staleSeen()).toBe(true);
      expect(same(layer().surface.data, original)).toBe(true);
      expect(labels(engine)).toEqual(['Lock layer']);
      expect(p.update(image(variant(original, 1)))).toBe(false);
      expect(same(layer().surface.data, original)).toBe(true);
    });

    it('when its layer is deleted (undoing the delete shows the original)', () => {
      const { engine, id, original, p, staleSeen } = started();
      engine.addLayer();
      engine.deleteLayer(id);
      expect(p.state).toBe('stale');
      expect(staleSeen()).toBe(true);
      engine.undo();
      expect(same((engine.getLayer(id) as RasterLayer).surface.data, original)).toBe(true);
    });

    it('when the document is replaced', () => {
      const { engine, p, staleSeen } = started();
      engine.newDocument();
      expect(p.state).toBe('stale');
      expect(staleSeen()).toBe(true);
      expect(engine.preview).toBeNull();
    });

    it('when the history moves underneath it (redo, jump, clear, another edit)', () => {
      // A step that redo / a jump can bring back.
      const undone = (e: Engine, id: string) => {
        e.setLayerProps(id, { opacity: 0.5 });
        e.undo();
      };
      for (const move of [
        (e: Engine) => e.redo(),
        (e: Engine) => e.jumpTo(1),
        (e: Engine) => e.clearHistory(),
        (e: Engine) => e.selectAll(),
        (e: Engine) => e.addLayer(),
      ]) {
        const { engine, layer, original, p, staleSeen } = started(undone);
        move(engine);
        expect(p.state).toBe('stale');
        expect(staleSeen()).toBe(true);
        expect(same(layer().surface.data, original)).toBe(true);
      }
    });

    it('when an editing tool starts a gesture, so painting never captures the preview', () => {
      const { engine, layer, original, p } = started();
      engine.setTool('brush');
      engine.pointerDown(pointer(100, 100));
      expect(p.state).toBe('stale');
      engine.pointerMove(pointer(160, 120));
      engine.pointerUp(pointer(160, 120));
      expect(labels(engine)).toEqual(['Brush']);
      engine.undo();
      expect(same(layer().surface.data, original)).toBe(true);
    });

    it('but not while panning or picking colours', () => {
      const { engine, p } = started();
      for (const tool of ['hand', 'eyedropper'] as const) {
        engine.setTool(tool);
        engine.pointerDown(pointer(100, 100));
        engine.pointerUp(pointer(100, 100));
      }
      expect(p.state).toBe('open');
    });

    it('but not when redo or a jump to the current step have nothing to do', () => {
      const { engine, layer, original, p } = started();
      const shown = layer().surface.data.slice();
      expect(engine.redo()).toBe(false);
      engine.jumpTo(engine.historyIndex);
      expect(p.state).toBe('open');
      expect(same(layer().surface.data, shown)).toBe(true);
      expect(same(shown, original)).toBe(false);
    });
  });

  it('undo reverts a shown preview as a step that redo brings back', () => {
    const { engine, id, layer } = setup();
    engine.setLayerProps(id, { opacity: 0.5 });
    const original = layer().surface.data.slice();
    const p = engine.beginPreview('Adjust: Test')!;
    p.update(image(variant(original, 33)));
    expect(engine.undo()).toBe(true);
    expect(p.state).toBe('committed');
    expect(same(layer().surface.data, original)).toBe(true);
    // Only the preview was undone.
    expect(engine.getLayer(id)!.opacity).toBe(0.5);
    expect(engine.historyIndex).toBe(1);
    expect(engine.canRedo).toBe(true);
    engine.redo();
    expect(same(layer().surface.data, variant(original, 33))).toBe(true);
  });

  it('undo with a preview showing nothing ends it and undoes the last step', () => {
    const { engine, id } = setup();
    engine.setLayerProps(id, { opacity: 0.5 });
    const p = engine.beginPreview('Adjust: Test')!;
    expect(engine.undo()).toBe(true);
    expect(p.state).toBe('stale');
    expect(engine.getLayer(id)!.opacity).toBe(1);
  });

  it('ends with the engine', () => {
    const { engine, layer } = setup();
    const original = layer().surface.data.slice();
    const p = engine.beginPreview('x')!;
    p.update(image(variant(original, 3)));
    engine.dispose();
    expect(p.state).toBe('stale');
    expect(same(layer().surface.data, original)).toBe(true);
    expect(engine.beginPreview('y')).toBeNull();
  });
});
