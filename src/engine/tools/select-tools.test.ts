import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { createDocument } from '../doc/document';
import type { RasterLayer } from '../doc/types';
import type { Modifiers, PointerInput } from '../input/pointer';
import { NO_MODIFIERS } from '../input/pointer';
import { pointer } from '../test-helpers';
import { maskBounds, rectMask } from '../selection/mask';
import type { SelectionMask } from '../selection/mask';
import { snap45 } from './lasso';
import type { OverlayPainter } from '../render/overlay';

function engine(pixelArt: 16 | 32 | 64 | null = null): Engine {
  return new Engine({ doc: createDocument({ pixelArt }) });
}

function surfaceOf(e: Engine) {
  return (e.activeLayer as RasterLayer).surface;
}

const SHIFT: Modifiers = { ...NO_MODIFIERS, shift: true };
const ALT: Modifiers = { ...NO_MODIFIERS, alt: true };
const BOTH: Modifiers = { ...NO_MODIFIERS, shift: true, alt: true };

function coverage(m: SelectionMask | null): number {
  if (!m) return 0;
  let n = 0;
  for (const v of m.data) n += v;
  return n / 255;
}

/** Freehand lasso along `pts` (densified so every edge has samples). */
function lasso(e: Engine, pts: [number, number][], extra: Partial<PointerInput> = {}): void {
  e.pointerDown(pointer(...pts[0], extra));
  for (let i = 1; i <= pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i % pts.length];
    for (let k = 1; k <= 8; k++) e.pointerMove(pointer(ax + ((bx - ax) * k) / 8, ay + ((by - ay) * k) / 8, extra));
  }
  e.pointerUp(pointer(...pts[0], extra));
}

let clock = 0;
function click(e: Engine, x: number, y: number, extra: Partial<PointerInput> = {}): void {
  clock += 1000;
  e.pointerDown(pointer(x, y, { time: clock, ...extra }));
  e.pointerUp(pointer(x, y, { time: clock + 5, ...extra }));
}

describe('lasso (freehand)', () => {
  it('selects the drawn outline with an anti-aliased edge; area matches', () => {
    const e = engine();
    e.setTool('lasso');
    // A right triangle with legs of 200 px: area 20 000 px².
    lasso(e, [[100.3, 100.2], [300.3, 100.2], [100.3, 300.2]]);
    const sel = e.doc.selection!;
    expect(coverage(sel)).toBeCloseTo(20000, -1);
    expect(Math.abs(coverage(sel) - 20000) / 20000).toBeLessThan(0.002);
    expect(sel.data[150 * 512 + 150]).toBe(255);
    expect(sel.data[250 * 512 + 250]).toBe(0);
    expect(sel.data.some((v) => v > 0 && v < 255)).toBe(true);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Lasso select']);
  });

  it('is whole-pixel in pixel-art documents and with antialias off', () => {
    const e = engine(32);
    e.setTool('lasso');
    lasso(e, [[2, 2], [30, 4], [16, 30]]);
    expect(e.doc.selection!.data.every((v) => v === 0 || v === 255)).toBe(true);
    const f = engine();
    f.setTool('lasso');
    f.setToolOptions('lasso', { antialias: false });
    lasso(f, [[10, 10], [200, 40], [60, 300]]);
    expect(f.doc.selection!.data.every((v) => v === 0 || v === 255)).toBe(true);
  });

  it('modifiers pick add / subtract / intersect like the marquees', () => {
    const e = engine(64);
    e.setTool('lasso');
    const square = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
    lasso(e, square(0, 0, 20));
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    lasso(e, square(30, 30, 10), { modifiers: SHIFT });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    lasso(e, square(0, 0, 20), { modifiers: ALT });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 30, y: 30, w: 10, h: 10 });
    lasso(e, square(35, 35, 20), { modifiers: BOTH });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 35, y: 35, w: 5, h: 5 });
    // The `mode` option applies without modifiers.
    e.setToolOptions('lasso', { mode: 'add' });
    lasso(e, square(0, 0, 4));
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(e.history.length).toBe(5);
  });

  it('a click deselects; Escape during the drag cancels', () => {
    const e = engine(64);
    e.selectShape('rect', { x: 0, y: 0, w: 10, h: 10 });
    e.setTool('lasso');
    e.pointerDown(pointer(30, 30));
    e.pointerMove(pointer(50, 30));
    e.pointerMove(pointer(50, 50));
    expect(e.keyDown('Escape', NO_MODIFIERS)).toBe(true);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    click(e, 40, 40);
    expect(e.doc.selection).toBeNull();
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Rectangle select', 'Deselect']);
  });

  it('a figure-eight selects both lobes (nonzero rule), not a deselect', () => {
    const e = engine(64);
    e.selectShape('rect', { x: 50, y: 50, w: 5, h: 5 });
    e.setTool('lasso');
    e.setToolOptions('lasso', { antialias: false });
    // Two triangles of opposite winding meeting at (20, 20): signed area 0.
    lasso(e, [[10, 10], [30, 30], [30, 10], [10, 30]]);
    const sel = e.doc.selection!;
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Rectangle select', 'Lasso select']);
    expect(sel.data[20 * 64 + 12]).toBe(255); // left lobe
    expect(sel.data[20 * 64 + 28]).toBe(255); // right lobe
    expect(sel.data[12 * 64 + 20]).toBe(0); // between the lobes
    expect(coverage(sel)).toBeCloseTo(200, -1);
  });

  it('feathers when asked', () => {
    const e = engine();
    e.setTool('lasso');
    e.setToolOptions('lasso', { feather: 6 });
    lasso(e, [[100, 100], [300, 100], [300, 300], [100, 300]]);
    const sel = e.doc.selection!;
    expect(sel.data[200 * 512 + 100]).toBeGreaterThan(64);
    expect(sel.data[200 * 512 + 100]).toBeLessThan(192);
    expect(sel.data[200 * 512 + 200]).toBe(255);
  });
});

describe('lasso (polygon)', () => {
  function polygonEngine(): Engine {
    const e = engine();
    e.setTool('lasso');
    e.setToolOptions('lasso', { kind: 'polygon' });
    return e;
  }

  it('clicks add corners; Enter closes into one entry', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    click(e, 50, 40);
    expect(e.hasPending).toBe(true);
    expect(e.doc.selection).toBeNull();
    expect(e.keyDown('Enter', NO_MODIFIERS)).toBe(true);
    expect(e.hasPending).toBe(false);
    const sel = e.doc.selection!;
    expect(coverage(sel)).toBeCloseTo(600, -1);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Lasso select']);
  });

  it('double-click or a click on the first corner closes', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    click(e, 50, 50);
    // Second press of a double-click, right after the last one.
    e.pointerDown(pointer(50, 50, { time: clock + 100 }));
    e.pointerUp(pointer(50, 50, { time: clock + 105 }));
    expect(e.hasPending).toBe(false);
    expect(coverage(e.doc.selection)).toBeCloseTo(800, -1);

    const f = polygonEngine();
    click(f, 10, 10);
    click(f, 50, 10);
    click(f, 30, 40);
    click(f, 10.1, 10.1);
    expect(f.hasPending).toBe(false);
    expect(coverage(f.doc.selection)).toBeCloseTo(600, -1);
  });

  it('Backspace removes the last corner, Escape and undo discard the polygon', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    click(e, 60, 60);
    e.keyDown('Backspace', NO_MODIFIERS);
    click(e, 50, 40);
    e.keyDown('Enter', NO_MODIFIERS);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 10, y: 10, w: 40, h: 30 });

    const f = polygonEngine();
    click(f, 10, 10);
    click(f, 50, 10);
    expect(f.keyDown('Escape', NO_MODIFIERS)).toBe(true);
    expect(f.hasPending).toBe(false);
    click(f, 10, 10);
    click(f, 50, 10);
    expect(f.canUndo).toBe(true);
    expect(f.undo()).toBe(true);
    expect(f.hasPending).toBe(false);
    expect(f.history.length).toBe(0);
  });

  it('switching tools closes the polygon with its options; Shift snaps edges to 45°', () => {
    const e = polygonEngine();
    e.setToolOptions('lasso', { antialias: false });
    click(e, 10, 10);
    click(e, 40, 12, { modifiers: SHIFT }); // snapped to horizontal
    click(e, 40, 40);
    e.setTool('brush');
    const sel = e.doc.selection!;
    expect(sel.data.every((v) => v === 0 || v === 255)).toBe(true);
    expect(maskBounds(sel)).toEqual({ x: 10, y: 10, w: 30, h: 30 });
    const q = snap45({ x: 0, y: 0 }, { x: 10, y: 9 }, true);
    expect(q.x).toBeCloseTo(q.y, 9);
  });

  it('Delete removes the last corner too, and leaves the pixels alone', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    click(e, 60, 60);
    expect(e.keyDown('Delete', NO_MODIFIERS)).toBe(true);
    expect(e.tools.lasso.polygon).toEqual([10, 10, 50, 10]);
    expect(e.hasPending).toBe(true);
    // The last corner gone, the polygon itself goes; Delete is then the UI's again.
    expect(e.keyDown('Delete', NO_MODIFIERS)).toBe(true);
    expect(e.keyDown('Delete', NO_MODIFIERS)).toBe(true);
    expect(e.hasPending).toBe(false);
    expect(e.keyDown('Delete', NO_MODIFIERS)).toBe(false);
    expect(e.history.length).toBe(0);
  });

  it('Backspace during a press drops that corner; the rest of the press is ignored', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    e.pointerDown(pointer(50, 50, { time: (clock += 1000) }));
    e.pointerMove(pointer(52, 50, { time: clock + 10 }));
    expect(e.keyDown('Backspace', NO_MODIFIERS)).toBe(true);
    e.pointerMove(pointer(60, 60, { time: clock + 20 }));
    e.pointerUp(pointer(60, 60, { time: clock + 30 }));
    expect(e.tools.lasso.polygon).toEqual([10, 10, 50, 10]);
  });

  it('an Escape during a press drops only that corner', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    e.pointerDown(pointer(50, 50, { time: (clock += 1000) }));
    e.pointerCancel();
    expect(e.hasPending).toBe(true);
    const tool = e.tools.lasso;
    expect(tool.polygon).toEqual([10, 10, 50, 10]);
  });

  it('keeps the polygon visible while a Space-pan override is active', () => {
    const e = polygonEngine();
    click(e, 10, 10);
    click(e, 50, 10);
    const calls: string[] = [];
    const painter: OverlayPainter = {
      scale: 8,
      line: () => calls.push('line'),
      rect: () => calls.push('rect'),
      ellipse: () => calls.push('ellipse'),
      polyline: () => calls.push('polyline'),
      handle: () => calls.push('handle'),
    };
    e.setToolOverride('hand');
    e.drawOverlay(painter);
    expect(calls).toContain('polyline');
    expect(calls.filter((c) => c === 'handle')).toHaveLength(2);
  });
});

describe('magic wand', () => {
  function stripes(): Engine {
    const e = engine(16);
    const s = surfaceOf(e);
    s.fill(100, 100, 100, 255);
    s.fill(110, 110, 110, 255, { x: 4, y: 0, w: 2, h: 16 }); // Δ 10
    s.fill(0, 0, 0, 255, { x: 8, y: 0, w: 1, h: 16 }); // wall
    s.fill(111, 111, 111, 255, { x: 12, y: 0, w: 2, h: 16 }); // Δ 11, beyond the wall
    e.setTool('magicWand');
    return e;
  }

  it('selects within the tolerance, contiguous or global', () => {
    const e = stripes();
    e.setToolOptions('magicWand', { tolerance: 10, antialias: false });
    click(e, 1, 1);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 8, h: 16 });
    e.setToolOptions('magicWand', { tolerance: 9 });
    click(e, 1, 1);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 4, h: 16 });
    e.setToolOptions('magicWand', { tolerance: 10, contiguous: false });
    click(e, 1, 1);
    const sel = e.doc.selection!;
    expect(sel.data[9]).toBe(255); // beyond the wall, same grey
    expect(sel.data[12]).toBe(0); // Δ 11
    expect(sel.data[8]).toBe(0); // the wall
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Magic wand', 'Magic wand', 'Magic wand']);
  });

  it('modifier ops, and composite sampling', () => {
    const e = stripes();
    e.setToolOptions('magicWand', { tolerance: 0, antialias: false });
    click(e, 1, 1);
    click(e, 4, 1, { modifiers: SHIFT });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 6, h: 16 });
    click(e, 1, 1, { modifiers: ALT });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 4, y: 0, w: 2, h: 16 });
    e.selectAll();
    click(e, 4, 1, { modifiers: BOTH });
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 4, y: 0, w: 2, h: 16 });
    expect(e.doc.selection!.data[0]).toBe(0);
    // An empty layer on top: 'layer' sampling sees transparency, 'composite' the stripes.
    e.addLayer();
    e.setToolOptions('magicWand', { tolerance: 0 });
    click(e, 1, 1);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    e.setToolOptions('magicWand', { sampleMerged: true });
    click(e, 1, 1);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 4, h: 16 });
  });

  it('anti-aliases the edge except in pixel-art documents', () => {
    const e = engine();
    surfaceOf(e).fill(255, 0, 0, 255, { x: 100, y: 100, w: 50, h: 50 });
    e.setTool('magicWand');
    click(e, 120, 120);
    const sel = e.doc.selection!;
    expect(sel.data[120 * 512 + 120]).toBe(255);
    expect(sel.data[120 * 512 + 100]).toBe(223);
    expect(sel.data[120 * 512 + 99]).toBe(32);
    const p = stripes();
    click(p, 1, 1);
    expect(p.doc.selection!.data.every((v) => v === 0 || v === 255)).toBe(true);
  });
});

describe('selection commands', () => {
  it('grow, shrink and border are single undoable steps', () => {
    const e = engine(64);
    expect(e.growSelection(2)).toBe(false); // nothing selected
    e.selectShape('rect', { x: 20, y: 20, w: 20, h: 20 });
    expect(e.growSelection(3)).toBe(true);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 17, y: 17, w: 26, h: 26 });
    expect(e.shrinkSelection(5)).toBe(true);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 22, y: 22, w: 16, h: 16 });
    expect(e.borderSelection(4)).toBe(true);
    const band = e.doc.selection!;
    expect(band.data[30 * 64 + 30]).toBe(0);
    expect(band.data[30 * 64 + 22]).toBe(255);
    expect(band.data[30 * 64 + 20]).toBe(255);
    expect(band.data[30 * 64 + 19]).toBe(0);
    // Pixel-art documents stay whole-pixel.
    expect(band.data.every((v) => v === 0 || v === 255)).toBe(true);
    expect(e.historyEntries.map((h) => h.label)).toEqual([
      'Rectangle select',
      'Grow selection',
      'Shrink selection',
      'Border selection',
    ]);
    e.undo();
    e.undo();
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 17, y: 17, w: 26, h: 26 });
  });

  it('refuses to shrink the selection away', () => {
    const e = engine(64);
    const messages: string[] = [];
    e.subscribe((ev) => ev.kind === 'message' && messages.push(ev.text));
    e.selectShape('rect', { x: 20, y: 20, w: 6, h: 6 });
    expect(e.shrinkSelection(4)).toBe(false);
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 20, y: 20, w: 6, h: 6 });
    expect(messages).toHaveLength(1);
    expect(e.history.length).toBe(1);
  });

  it('selects a layer by its alpha, with ops', () => {
    const e = engine(16);
    const s = surfaceOf(e);
    s.fill(255, 0, 0, 255, { x: 2, y: 2, w: 4, h: 4 });
    s.setPixel(10, 10, 0, 0, 0, 90);
    expect(e.selectByAlpha()).toBe(true);
    // Pixel-art documents threshold at 50 %.
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 2, y: 2, w: 4, h: 4 });
    const n = engine();
    surfaceOf(n).setPixel(10, 10, 0, 0, 0, 90);
    n.selectByAlpha();
    expect(n.doc.selection!.data[10 * 512 + 10]).toBe(90);
    // Intersect with a rect.
    e.selectShape('rect', { x: 0, y: 0, w: 4, h: 16 });
    e.selectByAlpha(e.doc.activeLayerId, 'intersect');
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 2, y: 2, w: 2, h: 4 });
    expect(e.historyEntries.at(-1)!.label).toBe('Select layer pixels');
    const empty = e.addLayer()!;
    expect(e.selectByAlpha(empty)).toBe(false);
  });

  it('selectPolygon combines like the tools', () => {
    const e = engine(64);
    expect(e.selectPolygon([0, 0, 10, 0])).toBe(false);
    e.selectPolygon([0, 0, 32, 0, 32, 32, 0, 32]);
    e.selectPolygon([16, 0, 64, 0, 64, 64, 16, 64], 'subtract');
    expect(maskBounds(e.doc.selection!)).toEqual({ x: 0, y: 0, w: 16, h: 32 });
    expect(e.doc.selection).toEqual(rectMask(64, 64, { x: 0, y: 0, w: 16, h: 32 }));
  });
});
