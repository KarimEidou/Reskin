import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { createDocument } from '../doc/document';
import type { RasterLayer, TextLayer } from '../doc/types';
import type { PointerInput } from '../input/pointer';
import { NO_MODIFIERS } from '../input/pointer';
import { blockTextRasterizer, pointer } from '../test-helpers';
import { Viewport } from '../viewport/viewport';
import type { OverlayPainter } from '../render/overlay';
import { textQuad } from '../text/text';
import { dragText, handlePositions, liftableBounds, textTransformParams } from './transform';
import { Surface } from '../raster/surface';
import { rectMask } from '../selection/mask';

interface Recorded {
  polylines: number[][];
  squares: number;
  circles: number;
}

function record(e: Engine): Recorded {
  const out: Recorded = { polylines: [], squares: 0, circles: 0 };
  const painter: OverlayPainter = {
    scale: e.viewport?.scale ?? 1,
    line: () => {},
    rect: () => {},
    ellipse: () => {},
    polyline: (pts) => out.polylines.push([...pts]),
    handle: (_x, _y, shape) => {
      if (shape === 'circle') out.circles++;
      else out.squares++;
    },
  };
  e.drawOverlay(painter);
  return out;
}

function withViewport(e: Engine): Engine {
  // 64 px document at 100 % = 8 screen px per document px.
  const vp = new Viewport({ docWidth: 64, docHeight: 64 });
  vp.setZoom(1);
  e.attachViewport(vp);
  return e;
}

function rasterEngine(): Engine {
  const e = withViewport(new Engine({ doc: createDocument({ pixelArt: 64 }) }));
  (e.activeLayer as RasterLayer).surface.fill(0, 255, 0, 255, { x: 10, y: 10, w: 8, h: 8 });
  e.setTool('move');
  return e;
}

function drag(e: Engine, from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}): void {
  e.pointerDown(pointer(...from, extra));
  for (let i = 1; i <= 4; i++) {
    e.pointerMove(pointer(from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4, extra));
  }
  e.pointerUp(pointer(...to, extra));
}

describe('move tool: handles before the first press', () => {
  it('shows the content box with all handles as soon as the tool is active', () => {
    const e = rasterEngine();
    const o = record(e);
    expect(o.polylines[0]).toEqual([10, 10, 18, 10, 18, 18, 10, 18]);
    expect(o.squares).toBe(8);
    expect(o.circles).toBe(1);
    expect(e.hasPending).toBe(false);
    expect(e.transformBox!.box).toEqual({ x: 10, y: 10, w: 8, h: 8 });
  });

  it('shows nothing on an empty, hidden or locked layer', () => {
    const e = withViewport(new Engine({ doc: createDocument({ pixelArt: 64 }) }));
    e.setTool('move');
    expect(record(e).polylines).toHaveLength(0);
    const f = rasterEngine();
    f.setLayerProps(f.doc.activeLayerId!, { locked: true });
    expect(record(f).polylines).toHaveLength(0);
    f.setLayerProps(f.doc.activeLayerId!, { locked: false, visible: false });
    expect(record(f).polylines).toHaveLength(0);
  });

  it('hovering a handle shows its cursor, and the first drag on it scales', () => {
    const e = rasterEngine();
    e.pointerHover(pointer(18, 18));
    expect(e.cursor.css).toBe('nwse-resize');
    e.pointerHover(pointer(14, 14));
    expect(e.cursor.css).toBe('move');
    drag(e, [18, 18], [26, 26]);
    e.commitPending();
    expect((e.activeLayer as RasterLayer).surface.alphaBounds()).toEqual({ x: 10, y: 10, w: 16, h: 16 });
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Transform']);
  });

  it('the first drag on the rotate handle rotates', () => {
    const e = rasterEngine();
    // Rotate handle: 24 screen px = 3 document px above the top edge.
    drag(e, [14, 7], [21, 14], { modifiers: { ...NO_MODIFIERS, shift: true } });
    expect(e.tools.move.params!.angle).toBeCloseTo(Math.PI / 2, 9);
    e.commitPending();
    expect((e.activeLayer as RasterLayer).surface.alphaBounds()).toEqual({ x: 10, y: 10, w: 8, h: 8 });
  });

  it('a press inside content too small for its handles moves it', () => {
    // 3 px of content at 1 screen px per document px: the handles would cover it all.
    const e = new Engine({ doc: createDocument() });
    const vp = new Viewport({ docWidth: 512, docHeight: 512 });
    vp.setZoom(1);
    e.attachViewport(vp);
    (e.activeLayer as RasterLayer).surface.fill(255, 0, 0, 255, { x: 100, y: 100, w: 3, h: 3 });
    e.setTool('move');
    e.pointerHover(pointer(102.9, 102.9));
    expect(e.cursor.css).toBe('move');
    drag(e, [102.9, 102.9], [122.9, 112.9]);
    e.commitPending();
    expect((e.activeLayer as RasterLayer).surface.alphaBounds()).toEqual({ x: 120, y: 110, w: 3, h: 3 });
    // Its corner handle is still reachable from just outside.
    e.pointerHover(pointer(126, 116));
    expect(e.cursor.css).toBe('nwse-resize');
  });

  it('liftableBounds: pixels with alpha inside any selection coverage', () => {
    const s = new Surface(16, 16);
    s.fill(0, 0, 0, 255, { x: 2, y: 3, w: 8, h: 4 });
    s.setPixel(12, 12, 0, 0, 0, 1);
    expect(liftableBounds(s, null)).toEqual({ x: 2, y: 3, w: 11, h: 10 });
    const sel = rectMask(16, 16, { x: 0, y: 0, w: 6, h: 16 });
    sel.data[5 * 16 + 9] = 1; // a barely selected pixel still counts
    expect(liftableBounds(s, sel)).toEqual({ x: 2, y: 3, w: 8, h: 4 });
    expect(liftableBounds(s, rectMask(16, 16, { x: 13, y: 0, w: 3, h: 16 }))).toBeNull();
  });

  it('transformBox is a snapshot, not the live session', () => {
    const e = rasterEngine();
    drag(e, [14, 14], [16, 14]);
    const box = e.transformBox!;
    box.cx += 100;
    box.box.x += 100;
    expect(e.tools.move.params!.cx).toBe(16);
    expect(e.transformBox!.box.x).toBe(10);
  });

  it('follows the selection and later paint (cached bounds are refreshed)', () => {
    const e = rasterEngine();
    e.selectShape('rect', { x: 0, y: 0, w: 14, h: 64 });
    expect(record(e).polylines[0]).toEqual([10, 10, 14, 10, 14, 18, 10, 18]);
    e.deselect();
    e.editLayerPixels(e.doc.activeLayerId!, 'Paint', (s) => s.setPixel(40, 40, 255, 0, 0, 255));
    expect(record(e).polylines[0]).toEqual([10, 10, 41, 10, 41, 41, 10, 41]);
    e.undo();
    expect(record(e).polylines[0]).toEqual([10, 10, 18, 10, 18, 18, 10, 18]);
  });
});

describe('move tool on text layers', () => {
  function textEngine(): { e: Engine; layer: TextLayer } {
    const e = withViewport(new Engine({ doc: createDocument({ pixelArt: 64 }), textRasterizer: blockTextRasterizer() }));
    const id = e.addTextLayer({ text: 'Yo', x: 32, y: 20, fontSize: 10, align: 'center' })!;
    e.setTool('move');
    return { e, layer: e.getLayer(id) as TextLayer };
  }

  it('moves the text as one undo entry and never rasterizes it', () => {
    const { e, layer } = textEngine();
    const o = record(e);
    // Corners and the rotate handle, no edge handles.
    expect(o.squares).toBe(4);
    expect(o.circles).toBe(1);
    drag(e, [32, 26], [40, 36]);
    expect(layer.kind).toBe('text');
    expect([layer.x, layer.y]).toEqual([40, 30]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Add text', 'Move text']);
    expect(e.composite().getPixel(40, 36)[3]).toBe(255);
    e.undo();
    expect([layer.x, layer.y]).toEqual([32, 20]);
    e.redo();
    expect([layer.x, layer.y]).toEqual([40, 30]);
  });

  it('Escape during a drag puts the text back without an entry', () => {
    const { e, layer } = textEngine();
    e.pointerDown(pointer(32, 26));
    e.pointerMove(pointer(50, 50));
    expect([layer.x, layer.y]).toEqual([50, 44]);
    e.keyDown('Escape', NO_MODIFIERS);
    expect([layer.x, layer.y]).toEqual([32, 20]);
    expect(e.history.length).toBe(1);
  });

  it('resizes through the font size about the opposite corner', () => {
    const { e, layer } = textEngine();
    const before = textQuad(layer, e.textLayout(layer));
    const t0 = textTransformParams(layer, e.textLayout(layer));
    const se = handlePositions(t0, 3).se;
    const nw = handlePositions(t0, 3).nw;
    drag(e, [se.x, se.y], [nw.x + (se.x - nw.x) * 2, nw.y + (se.y - nw.y) * 2]);
    expect(layer.fontSize).toBeCloseTo(20, 9);
    const after = textQuad(layer, e.textLayout(layer));
    expect(after[0].x).toBeCloseTo(before[0].x, 9);
    expect(after[0].y).toBeCloseTo(before[0].y, 9);
    expect(e.historyEntries.at(-1)!.label).toBe('Resize text');
    e.undo();
    expect(layer.fontSize).toBe(10);
    expect([layer.x, layer.y]).toEqual([32, 20]);
  });

  it('rotates about the block centre', () => {
    const { e, layer } = textEngine();
    const t0 = textTransformParams(layer, e.textLayout(layer));
    const h = handlePositions(t0, 3);
    drag(e, [h.rotate.x, h.rotate.y], [t0.cx + 10, t0.cy + 0.2], { modifiers: { ...NO_MODIFIERS, shift: true } });
    expect(layer.rotation).toBe(90);
    const t1 = textTransformParams(layer, e.textLayout(layer));
    expect(t1.cx).toBeCloseTo(t0.cx, 9);
    expect(t1.cy).toBeCloseTo(t0.cy, 9);
    expect(e.historyEntries.at(-1)!.label).toBe('Rotate text');
  });

  it('nudges merge into one entry; locked text is refused', () => {
    const { e, layer } = textEngine();
    e.keyDown('ArrowRight', NO_MODIFIERS);
    e.keyDown('ArrowDown', { ...NO_MODIFIERS, shift: true });
    expect([layer.x, layer.y]).toEqual([33, 30]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Add text', 'Move text']);
    const messages: string[] = [];
    e.subscribe((ev) => ev.kind === 'message' && messages.push(ev.text));
    e.setLayerProps(layer.id, { locked: true });
    drag(e, [33, 36], [40, 40]);
    expect([layer.x, layer.y]).toEqual([33, 30]);
    expect(messages[0]).toMatch(/locked/);
    expect(record(e).polylines).toHaveLength(0);
  });

  it('dragText keeps text unflipped and within the font size range', () => {
    const { e, layer } = textEngine();
    const layout = e.textLayout(layer);
    const t0 = textTransformParams(layer, layout);
    const h = handlePositions(t0, 3);
    const tiny = dragText(layer, layout, 'se', h.se, { x: h.nw.x - 30, y: h.nw.y - 30 }, NO_MODIFIERS);
    expect(tiny.fontSize).toBe(1);
    const centred = dragText(layer, layout, 'se', h.se, { x: h.se.x + (h.se.x - t0.cx), y: h.se.y + (h.se.y - t0.cy) }, {
      shift: false,
      alt: true,
    });
    expect(centred.fontSize).toBeCloseTo(20, 9);
    const t1 = textTransformParams({ ...layer, ...centred }, e.textLayout({ ...layer, ...centred } as TextLayer));
    expect(t1.cx).toBeCloseTo(t0.cx, 9);
    expect(t1.cy).toBeCloseTo(t0.cy, 9);
  });
});
