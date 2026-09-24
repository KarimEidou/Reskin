import { describe, expect, it } from 'vitest';
import { Engine, pointerInput } from '$engine/index';
import { LiveLayerEdit, discardRedo } from './live-edit';

function setup() {
  const engine = new Engine();
  const id = engine.doc.layers[0]!.id;
  engine.editLayerPixels(id, 'Paint', (s) => {
    for (let i = 0; i < s.data.length; i += 4) {
      s.data[i] = (i / 4) % 256;
      s.data[i + 1] = 40;
      s.data[i + 2] = 200;
      s.data[i + 3] = i % 12 === 0 ? 128 : 255;
    }
  });
  const layer = () => engine.getLayer(id) as { surface: { data: Uint8ClampedArray } };
  return { engine, id, layer };
}

/** Byte equality without the cost of deep-diffing 1 MB arrays. */
function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

function variant(src: Uint8ClampedArray, k: number): Uint8ClampedArray {
  const out = src.slice();
  for (let i = 0; i < out.length; i += 4) out[i] = (out[i]! + k) % 256;
  return out;
}

describe('LiveLayerEdit', () => {
  it('keeps one history entry while previewing and restores exactly on cancel', () => {
    const { engine, id, layer } = setup();
    const before = layer().surface.data.slice();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    expect(live.showing).toBe(false);
    expect(live.show(variant(live.original, 50))).toBe(true);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Paint', 'Adjust: Test']);
    expect(live.show(variant(live.original, 90))).toBe(true);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Paint', 'Adjust: Test']);
    expect(same(layer().surface.data, variant(before, 90))).toBe(true);
    expect(live.showing).toBe(true);
    live.cancel();
    expect(same(layer().surface.data, before)).toBe(true);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Paint']);
    expect(engine.canRedo).toBe(false);
    expect(live.show(variant(live.original, 5))).toBe(false);
  });

  it('commits as one undoable entry', () => {
    const { engine, id, layer } = setup();
    const before = layer().surface.data.slice();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    live.show(variant(live.original, 20));
    expect(live.commit()).toBe(true);
    expect(engine.historyEntries).toHaveLength(2);
    engine.undo();
    expect(same(layer().surface.data, before)).toBe(true);
    engine.redo();
    expect(same(layer().surface.data, variant(before, 20))).toBe(true);
  });

  it('records nothing for a no-op result', () => {
    const { engine, id } = setup();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    live.show(live.original.slice());
    expect(engine.historyEntries).toHaveLength(1);
    expect(engine.canRedo).toBe(false);
    expect(live.showing).toBe(false);
    expect(live.commit()).toBe(false);
  });

  it('keeps the redo steps while the preview matches the original', () => {
    const { engine, id } = setup();
    engine.undo();
    expect(engine.canRedo).toBe(true);
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    // Default parameters that change nothing (e.g. brightness 0).
    expect(live.show(live.original.slice())).toBe(true);
    live.cancel();
    expect(engine.canRedo).toBe(true);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Paint']);
  });

  it('goes stale while a transform is pending (undo would cancel it instead)', () => {
    const { engine, id, layer } = setup();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    engine.setTool('move');
    engine.pointerDown(pointerInput({ x: 200, y: 200 }));
    engine.pointerMove(pointerInput({ x: 240, y: 200 }));
    engine.pointerUp(pointerInput({ x: 240, y: 200 }));
    expect(engine.hasPending).toBe(true);
    expect(live.stale).toBe(true);
    const shown = layer().surface.data.slice();
    expect(live.show(variant(live.original, 30))).toBe(false);
    expect(same(layer().surface.data, shown)).toBe(true);
    expect(engine.hasPending).toBe(true);
  });

  it('goes stale when the layer is locked', () => {
    const { engine, id, layer } = setup();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    engine.setLayerProps(id, { locked: true });
    expect(live.stale).toBe(true);
    const shown = layer().surface.data.slice();
    expect(live.show(variant(live.original, 30))).toBe(false);
    expect(same(layer().surface.data, shown)).toBe(true);
  });

  it('goes stale when something else edits the document', () => {
    const { engine, id, layer } = setup();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    engine.editLayerPixels(id, 'Brush', (s) => s.data.fill(7, 0, 400));
    expect(live.stale).toBe(true);
    const after = layer().surface.data.slice();
    expect(live.show(variant(live.original, 30))).toBe(false);
    live.cancel();
    expect(same(layer().surface.data, after)).toBe(true);
    expect(engine.historyEntries).toHaveLength(3);
  });

  it('treats an undo of the preview as the end of the edit', () => {
    const { engine, id, layer } = setup();
    const before = layer().surface.data.slice();
    const live = new LiveLayerEdit(engine, id, 'Adjust: Test');
    live.show(variant(live.original, 10));
    engine.undo();
    expect(live.stale).toBe(true);
    live.cancel();
    expect(same(layer().surface.data, before)).toBe(true);
  });

  it('refuses text layers and drops redo tails on request', () => {
    const { engine } = setup();
    const text = engine.addTextLayer({ text: 'Hi' })!;
    expect(() => new LiveLayerEdit(engine, text, 'x')).toThrow();
    engine.undo();
    expect(engine.canRedo).toBe(true);
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.kind));
    discardRedo(engine);
    expect(engine.canRedo).toBe(false);
    expect(events).toContain('history');
  });
});
