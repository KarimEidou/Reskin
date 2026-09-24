import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { createDocument } from '../doc/document';
import type { RasterLayer, TextLayer } from '../doc/types';
import type { PointerInput } from '../input/pointer';
import { NO_MODIFIERS } from '../input/pointer';
import { pointer, pixel, alphaSum, blockTextRasterizer } from '../test-helpers';
import { renderGradient } from './gradient';
import { Surface } from '../raster/surface';
import { createGradient } from '../color/gradient';
import { dragTransform, handlePositions, hitTestTransform, initialTransform, transformCorners } from './transform';
import { shapeDragBox } from './shape';
import { maskBounds } from '../selection/mask';
import type { EngineEvent } from '../engine';
import { Viewport } from '../viewport/viewport';

const RED = { r: 255, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 255, a: 1 };

function engine(pixelArt: 16 | 32 | 64 | null = null): Engine {
  return new Engine({ doc: createDocument({ pixelArt }), primary: RED, secondary: BLUE });
}

function surfaceOf(e: Engine) {
  return (e.activeLayer as RasterLayer).surface;
}

function drag(e: Engine, from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}): void {
  e.pointerDown(pointer(...from, extra));
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    e.pointerMove(pointer(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, extra));
  }
  e.pointerUp(pointer(...to, extra));
}

describe('gradient', () => {
  it('lands exactly on the stop colours at the endpoints (dithered)', () => {
    const s = new Surface(64, 1);
    renderGradient(s.data, s.data, 64, { x: 0, y: 0, w: 64, h: 1 }, {
      spec: createGradient({ r: 10, g: 200, b: 30, a: 1 }, { r: 250, g: 20, b: 140, a: 1 }),
      x0: 0.5,
      y0: 0.5,
      x1: 63.5,
      y1: 0.5,
      opacity: 1,
      dither: true,
      selection: null,
    });
    expect(pixel(s, 0, 0)).toEqual([10, 200, 30, 255]);
    expect(pixel(s, 63, 0)).toEqual([250, 20, 140, 255]);
    // Monotonic red ramp in between (dither never exceeds ±1).
    for (let x = 1; x < 64; x++) expect(s.getPixel(x, 0)[0]).toBeGreaterThanOrEqual(s.getPixel(x - 1, 0)[0] - 1);
  });

  it('draws primary → secondary with the tool and undoes', () => {
    const e = engine(64);
    e.setTool('gradient');
    drag(e, [0.5, 10], [63.5, 10]);
    const s = surfaceOf(e);
    expect(pixel(s, 0, 30)).toEqual([255, 0, 0, 255]);
    expect(pixel(s, 63, 0)).toEqual([0, 0, 255, 255]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Gradient']);
    e.undo();
    expect(alphaSum(surfaceOf(e))).toBe(0);
  });

  it('a click without a drag does nothing', () => {
    const e = engine(16);
    e.setTool('gradient');
    drag(e, [5, 5], [5.2, 5]);
    expect(alphaSum(surfaceOf(e))).toBe(0);
    expect(e.history.length).toBe(0);
  });

  it('radial and custom stops', () => {
    const e = engine(64);
    e.setTool('gradient');
    e.setToolOptions('gradient', {
      kind: 'radial',
      source: 'custom',
      stops: [
        { offset: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      dither: false,
    });
    drag(e, [32, 32], [32, 0]);
    const s = surfaceOf(e);
    // Pixel (32,32)'s centre is 0.7 px from the origin: t ≈ 0.022.
    expect(pixel(s, 32, 32)[3]).toBe(249);
    expect(pixel(s, 0, 0)[3]).toBe(0);
    expect(s.getPixel(32, 16)[3]).toBeGreaterThan(100);
    expect(s.getPixel(32, 16)[3]).toBeLessThan(160);
  });
});

describe('shape tool', () => {
  it('constrains and centres drags', () => {
    expect(shapeDragBox('rect', { x: 10, y: 10 }, { x: 30, y: 15 }, true, false)).toEqual({
      from: { x: 10, y: 10 },
      to: { x: 30, y: 30 },
    });
    expect(shapeDragBox('ellipse', { x: 10, y: 10 }, { x: 15, y: 20 }, false, true)).toEqual({
      from: { x: 5, y: 0 },
      to: { x: 15, y: 20 },
    });
    const line = shapeDragBox('line', { x: 0, y: 0 }, { x: 10, y: 1 }, true, false);
    expect(line.to.y).toBeCloseTo(0, 9);
  });

  it('fills an ellipse with the primary colour, area ≈ πab', () => {
    const e = engine();
    e.setTool('shape');
    e.setToolOptions('shape', { kind: 'ellipse', fill: true, stroke: false });
    drag(e, [100, 100], [300, 200]);
    const area = alphaSum(surfaceOf(e)) / 255;
    expect(area / (Math.PI * 100 * 50)).toBeCloseTo(1, 2);
    expect(pixel(surfaceOf(e), 200, 150)).toEqual([255, 0, 0, 255]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Ellipse']);
  });

  it('strokes with the secondary colour when filling too', () => {
    const e = engine();
    e.setTool('shape');
    e.setToolOptions('shape', { kind: 'rect', fill: true, stroke: true, strokeWidth: 10 });
    drag(e, [100, 100], [200, 200]);
    const s = surfaceOf(e);
    expect(pixel(s, 102, 150)).toEqual([0, 0, 255, 255]);
    expect(pixel(s, 150, 150)).toEqual([255, 0, 0, 255]);
    expect(pixel(s, 99, 150)[3]).toBe(0);
  });

  it('is aliased in pixel-art documents', () => {
    const e = engine(32);
    e.setTool('shape');
    e.setToolOptions('shape', { kind: 'ellipse' });
    drag(e, [2, 2], [30, 30]);
    const d = surfaceOf(e).data;
    for (let i = 3; i < d.length; i += 4) expect(d[i] === 0 || d[i] === 255).toBe(true);
  });

  it('previews live and replaces the preview on every move', () => {
    const e = engine(64);
    e.setTool('shape');
    e.setToolOptions('shape', { kind: 'rect' });
    e.pointerDown(pointer(0, 0));
    e.pointerMove(pointer(60, 60));
    expect(alphaSum(surfaceOf(e))).toBe(60 * 60 * 255);
    e.pointerMove(pointer(10, 10));
    expect(alphaSum(surfaceOf(e))).toBe(10 * 10 * 255);
    e.pointerCancel();
    expect(alphaSum(surfaceOf(e))).toBe(0);
    expect(e.history.length).toBe(0);
  });
});

describe('marquee selection', () => {
  it('selects, adds with Shift, subtracts with Alt, deselects on click', () => {
    const e = engine(64);
    e.setTool('selectRect');
    drag(e, [0, 0], [20, 20]);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    drag(e, [40, 40], [50, 50], { modifiers: { ...NO_MODIFIERS, shift: true } });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    drag(e, [0, 0], [64, 30], { modifiers: { ...NO_MODIFIERS, alt: true } });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 40, y: 40, w: 10, h: 10 });
    drag(e, [5, 5], [5, 5]);
    expect(e.doc.selection).toBeNull();
    e.undo();
    expect(e.doc.selection).not.toBeNull();
  });

  it('ellipse select', () => {
    const e = engine(64);
    e.setTool('selectEllipse');
    drag(e, [0, 0], [64, 64]);
    expect(e.doc.selection!.data[32 * 64 + 32]).toBe(255);
    expect(e.doc.selection!.data[0]).toBe(0);
  });
});

describe('transform math', () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };

  it('hit-tests handles, rotation zone and body', () => {
    const t = initialTransform(box);
    expect(hitTestTransform(t, 10, 20, 4, 20)).toBe('nw');
    expect(hitTestTransform(t, 110, 45, 4, 20)).toBe('e');
    expect(hitTestTransform(t, 60, 0, 4, 20)).toBe('rotate');
    expect(hitTestTransform(t, 60, 45, 4, 20)).toBe('move');
    expect(hitTestTransform(t, 115, 75, 4, 20)).toBe('rotate');
    expect(hitTestTransform(t, 300, 300, 4, 20)).toBeNull();
    expect(handlePositions(t, 20).rotate).toEqual({ x: 60, y: 0 });
  });

  it('scales from the opposite handle, or the centre with Alt', () => {
    const t = initialTransform(box);
    const s = dragTransform(t, 'se', { x: 110, y: 70 }, { x: 210, y: 120 }, { shift: false, alt: false });
    expect(s.sx).toBeCloseTo(2, 9);
    expect(s.sy).toBeCloseTo(2, 9);
    const c = transformCorners(s);
    expect(c[0].x).toBeCloseTo(10, 9);
    expect(c[0].y).toBeCloseTo(20, 9);
    const a = dragTransform(t, 'e', { x: 110, y: 45 }, { x: 160, y: 45 }, { shift: false, alt: true });
    expect(a.sx).toBeCloseTo(2, 9);
    expect(a.cx).toBeCloseTo(60, 9);
    const u = dragTransform(t, 'se', { x: 110, y: 70 }, { x: 310, y: 80 }, { shift: true, alt: false });
    expect(u.sx).toBeCloseTo(u.sy, 9);
    expect(u.sx).toBeCloseTo(3, 9);
  });

  it('rotates with 15° snapping and moves by whole pixels', () => {
    const t = initialTransform(box);
    const r = dragTransform(t, 'rotate', { x: 60, y: 0 }, { x: 101, y: 44 }, { shift: true, alt: false });
    expect(r.angle).toBeCloseTo(Math.PI / 2, 9);
    const m = dragTransform(t, 'move', { x: 0, y: 0 }, { x: 3.4, y: -2.6 }, { shift: false, alt: false });
    expect([m.cx, m.cy]).toEqual([63, 42]);
    const locked = dragTransform(t, 'move', { x: 0, y: 0 }, { x: 10, y: 3 }, { shift: true, alt: false });
    expect(locked.cy).toBe(45);
  });
});

describe('move / transform tool', () => {
  function withSquare(): Engine {
    const e = engine(64);
    // A realistic view: 64 px pixel art at 100 % = 8 screen px per pixel, so
    // handle tolerances (screen px) are under a document pixel.
    const vp = new Viewport({ docWidth: 64, docHeight: 64 });
    vp.setZoom(1);
    e.attachViewport(vp);
    surfaceOf(e).fill(0, 255, 0, 255, { x: 10, y: 10, w: 8, h: 8 });
    e.setTool('move');
    return e;
  }

  it('moves pixels exactly and commits one entry on Enter', () => {
    const e = withSquare();
    const before = surfaceOf(e).clone();
    drag(e, [12, 12], [22, 17]);
    expect(e.hasPending).toBe(true);
    expect(e.keyDown('Enter', NO_MODIFIERS)).toBe(true);
    const s = surfaceOf(e);
    expect(s.alphaBounds()).toEqual({ x: 20, y: 15, w: 8, h: 8 });
    expect(pixel(s, 20, 15)).toEqual([0, 255, 0, 255]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Move']);
    e.undo();
    expect(surfaceOf(e).equals(before)).toBe(true);
  });

  it('scales with a corner handle and commits on tool switch', () => {
    const e = withSquare();
    // First drag lifts and moves nothing (start = end), second scales.
    drag(e, [14, 14], [14, 14]);
    drag(e, [18, 18], [26, 26]);
    e.setTool('brush');
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 10, y: 10, w: 16, h: 16 });
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Transform']);
  });

  it('undo during a pending transform cancels it', () => {
    const e = withSquare();
    const before = surfaceOf(e).clone();
    drag(e, [12, 12], [40, 40]);
    expect(e.undo()).toBe(true);
    expect(e.hasPending).toBe(false);
    expect(surfaceOf(e).equals(before)).toBe(true);
    expect(e.history.length).toBe(0);
  });

  it('moves only the selection and the selection follows', () => {
    const e = withSquare();
    e.selectShape('rect', { x: 10, y: 10, w: 4, h: 8 });
    drag(e, [11, 11], [11, 31]);
    e.commitPending();
    const s = surfaceOf(e);
    expect(pixel(s, 11, 11)[3]).toBe(0);
    expect(pixel(s, 15, 11)[3]).toBe(255);
    expect(pixel(s, 11, 31)).toEqual([0, 255, 0, 255]);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 10, y: 30, w: 4, h: 8 });
    e.undo();
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 10, y: 10, w: 4, h: 8 });
  });

  it('nudges with arrow keys and cancels with Escape', () => {
    const e = withSquare();
    e.keyDown('ArrowRight', { ...NO_MODIFIERS, shift: true });
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 20, y: 10, w: 8, h: 8 });
    e.keyDown('Escape', NO_MODIFIERS);
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 10, y: 10, w: 8, h: 8 });
  });

  it('reports an empty layer', () => {
    const e = engine(16);
    e.setTool('move');
    const msgs: EngineEvent[] = [];
    e.subscribe((ev) => ev.kind === 'message' && msgs.push(ev));
    drag(e, [1, 1], [5, 5]);
    expect(msgs).toHaveLength(1);
    expect(e.hasPending).toBe(false);
  });
});

describe('text tool', () => {
  it('creates a text layer, edits it as one step, and drops it if left empty', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 64 }), textRasterizer: blockTextRasterizer(), primary: RED });
    const edits: (string | null)[] = [];
    e.subscribe((ev) => ev.kind === 'textEdit' && edits.push(ev.layerId));
    e.setTool('text');
    e.setToolOptions('text', { fontSize: 10 });
    e.pointerDown(pointer(32, 10));
    e.pointerUp(pointer(32, 10));
    const id = e.textEditLayerId!;
    expect(edits).toEqual([id]);
    const layer = e.getLayer(id) as TextLayer;
    expect(layer.kind).toBe('text');
    expect(layer.color).toEqual(RED);
    e.updateText(id, { text: 'H' });
    e.updateText(id, { text: 'Hi' });
    e.endTextEdit();
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Add text', 'Edit text']);
    expect(layer.name).toBe('Hi');
    expect(layer.cache).not.toBeNull();
    expect(e.composite().getPixel(32, 20)).toEqual([255, 0, 0, 255]);

    // Clicking elsewhere and typing nothing leaves no trace.
    e.pointerDown(pointer(10, 50));
    e.pointerUp(pointer(10, 50));
    expect(e.doc.layers).toHaveLength(3);
    e.endTextEdit();
    expect(e.doc.layers).toHaveLength(2);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Add text', 'Edit text']);
    expect(e.canRedo).toBe(false);
  });

  it('text typed and then erased also leaves no trace', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 64 }), textRasterizer: blockTextRasterizer() });
    e.setTool('text');
    e.setToolOptions('text', { fontSize: 10 });
    e.pointerDown(pointer(20, 20));
    e.pointerUp(pointer(20, 20));
    const id = e.textEditLayerId!;
    e.updateText(id, { text: 'ab' });
    e.updateText(id, { text: '' });
    e.endTextEdit();
    expect(e.doc.layers).toHaveLength(1);
    expect(e.history.length).toBe(0);
  });

  it('clicking existing text re-opens it; dragging moves it', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 64 }), textRasterizer: blockTextRasterizer() });
    const id = e.addTextLayer({ text: 'Yo', x: 32, y: 20, fontSize: 10 })!;
    e.setTool('text');
    e.pointerDown(pointer(32, 25));
    e.pointerUp(pointer(32, 25));
    expect(e.textEditLayerId).toBe(id);
    e.endTextEdit();
    drag(e, [32, 25], [40, 35]);
    const l = e.getLayer(id) as TextLayer;
    expect([l.x, l.y]).toEqual([40, 30]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Add text', 'Edit text']);
  });
});
