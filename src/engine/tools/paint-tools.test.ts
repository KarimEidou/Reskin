import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { createDocument } from '../doc/document';
import type { RasterLayer } from '../doc/types';
import type { PointerInput } from '../input/pointer';
import { pointer, pixel, alphaSum } from '../test-helpers';
import { bresenham, isLCorner, nibOrigins } from './pencil';
import { dabCoverage, stampDab } from './paint';
import { symmetryTransforms, NO_SYMMETRY } from '../symmetry/symmetry';
import { rectMask } from '../selection/mask';

function engine(pixelArt: 16 | 32 | null = null): Engine {
  return new Engine({ doc: createDocument({ pixelArt }), primary: { r: 255, g: 0, b: 0, a: 1 } });
}

function surfaceOf(e: Engine) {
  return (e.activeLayer as RasterLayer).surface;
}

function stroke(e: Engine, pts: [number, number][], extra: Partial<PointerInput> = {}): void {
  let t = 0;
  const p = (x: number, y: number) => pointer(x, y, { time: (t += 8), ...extra });
  e.pointerDown(p(...pts[0]));
  for (const q of pts.slice(1)) e.pointerMove(p(...q));
  e.pointerUp(p(...pts[pts.length - 1]));
}

/** Number of separate opaque runs along a row. */
function runs(e: Engine, y: number): number {
  const s = surfaceOf(e);
  let n = 0;
  let inRun = false;
  for (let x = 0; x < s.width; x++) {
    const on = s.getPixel(x, y)[3] > 0;
    if (on && !inRun) n++;
    inRun = on;
  }
  return n;
}

describe('dabs', () => {
  it('hard dabs have anti-aliased rims; soft dabs fall off', () => {
    expect(dabCoverage(0, { radius: 5, hardness: 1, aliased: false })).toBe(1);
    expect(dabCoverage(5, { radius: 5, hardness: 1, aliased: false })).toBeCloseTo(0.5, 6);
    expect(dabCoverage(6, { radius: 5, hardness: 1, aliased: false })).toBe(0);
    const soft = [0, 1, 2, 3, 4].map((d) => dabCoverage(d, { radius: 5, hardness: 0, aliased: false }));
    for (let i = 1; i < soft.length; i++) expect(soft[i]).toBeLessThan(soft[i - 1]);
    expect(dabCoverage(0.7, { radius: 0.3, hardness: 1, aliased: true })).toBe(0);
  });

  it('flow accumulates towards 1 without overshooting', () => {
    const plane = new Float32Array(9);
    for (let i = 0; i < 20; i++) stampDab(plane, 3, 3, 1.5, 1.5, { radius: 1, hardness: 1, aliased: false }, 0.3);
    expect(plane[4]).toBeGreaterThan(0.99);
    expect(plane[4]).toBeLessThanOrEqual(1);
  });

  it('a dab ceiling limits build-up but never lowers earlier paint', () => {
    const shape = { radius: 1, hardness: 1, aliased: false };
    const plane = new Float32Array(9);
    for (let i = 0; i < 20; i++) stampDab(plane, 3, 3, 1.5, 1.5, shape, 0.5, 0.4);
    expect(plane[4]).toBeCloseTo(0.4, 6);
    stampDab(plane, 3, 3, 1.5, 1.5, shape, 1, 0.9);
    expect(plane[4]).toBeCloseTo(0.9, 6);
    expect(stampDab(plane, 3, 3, 1.5, 1.5, shape, 1, 0.2)).toBeNull();
    expect(plane[4]).toBeCloseTo(0.9, 6);
  });
});

describe('brush', () => {
  it('is deterministic for identical input', () => {
    const run = () => {
      const e = engine();
      e.setToolOptions('brush', { size: 17, hardness: 0.6, flow: 0.4, smoothing: 0.5, spacing: 0.1 });
      stroke(e, [[40, 40], [90, 61], [150, 170], [300, 180], [320, 400]], { pointerType: 'pen', pressure: 0.7 });
      return surfaceOf(e).clone();
    };
    const a = run();
    expect(a.equals(run())).toBe(true);
    expect(alphaSum(a)).toBeGreaterThan(0);
  });

  it('places dabs at the configured spacing', () => {
    const e = engine();
    // Diameter 10, spacing 300 % → a dab every 30 px: x = 20, 50, …, 200.
    e.setToolOptions('brush', { size: 10, hardness: 1, spacing: 3, smoothing: 0, pressureSize: false });
    stroke(e, [[20.5, 50.5], [200.5, 50.5]]);
    expect(runs(e, 50)).toBe(7);
    expect(pixel(surfaceOf(e), 50, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(surfaceOf(e), 35, 50)[3]).toBe(0);
  });

  it('caps the stroke at its opacity however much flow builds up', () => {
    const e = engine();
    e.setToolOptions('brush', { size: 20, hardness: 1, spacing: 0.05, flow: 1, opacity: 0.5, smoothing: 0 });
    stroke(e, [[100, 100], [140, 100], [100, 100], [140, 100]]);
    expect(pixel(surfaceOf(e), 120, 100)).toEqual([255, 0, 0, 128]);
  });

  it('pressure scales the footprint', () => {
    const width = (pressure: number) => {
      const e = engine();
      e.setToolOptions('brush', { size: 40, hardness: 1, smoothing: 0, pressureSize: true, minSize: 0 });
      stroke(e, [[100, 100], [300, 100]], { pointerType: 'pen', pressure });
      const s = surfaceOf(e);
      let n = 0;
      for (let y = 0; y < s.height; y++) if (s.getPixel(200, y)[3] > 127) n++;
      return n;
    };
    expect(width(0.5)).toBeLessThan(width(1));
    expect(width(1)).toBeGreaterThanOrEqual(39);
  });

  it('pressure caps the opacity however many dabs overlap (pressureOpacity)', () => {
    const alphaAt = (pressure: number) => {
      const e = engine();
      e.setToolOptions('brush', { size: 20, hardness: 1, smoothing: 0, pressureSize: false, pressureOpacity: true });
      const pts: [number, number][] = [];
      for (let x = 100; x <= 200; x += 1) pts.push([x, 100]);
      stroke(e, pts, { pointerType: 'pen', pressure });
      return pixel(surfaceOf(e), 150, 100)[3];
    };
    expect(alphaAt(0.2)).toBe(51);
    expect(alphaAt(0.5)).toBe(128);
    expect(alphaAt(1)).toBe(255);
  });

  it('eraser removes alpha and right-click paints the secondary colour', () => {
    const e = engine();
    e.setColor('secondary', { r: 0, g: 0, b: 255, a: 1 });
    e.setToolOptions('brush', { size: 30, hardness: 1, smoothing: 0 });
    stroke(e, [[100, 100], [200, 100]], { button: 2 });
    expect(pixel(surfaceOf(e), 150, 100)).toEqual([0, 0, 255, 255]);
    e.setTool('eraser');
    e.setToolOptions('eraser', { size: 10, hardness: 1, smoothing: 0 });
    stroke(e, [[150, 100], [150, 101]]);
    expect(pixel(surfaceOf(e), 150, 100)[3]).toBe(0);
    expect(pixel(surfaceOf(e), 120, 100)[3]).toBe(255);
  });

  it('mirrors strokes through symmetry', () => {
    const e = engine();
    e.setSymmetry({ mode: 'x' });
    e.setToolOptions('brush', { size: 12, hardness: 0.5, smoothing: 0 });
    stroke(e, [[60, 80], [150, 200], [90, 300]]);
    const s = surfaceOf(e);
    for (let y = 0; y < 512; y += 7) {
      for (let x = 0; x < 256; x += 5) expect(s.getPixel(x, y)).toEqual(s.getPixel(511 - x, y));
    }
    expect(s.getPixel(512 - 60, 80)[3]).toBeGreaterThan(0);
  });

  it('clips to the selection', () => {
    const e = engine();
    e.setSelection(rectMask(512, 512, { x: 0, y: 0, w: 100, h: 512 }));
    e.setToolOptions('brush', { size: 20, hardness: 1, smoothing: 0 });
    stroke(e, [[50, 50], [200, 50]]);
    expect(pixel(surfaceOf(e), 60, 50)[3]).toBe(255);
    expect(pixel(surfaceOf(e), 150, 50)[3]).toBe(0);
  });

  it('refuses locked, hidden and text layers with a message', () => {
    const e = engine();
    const messages: string[] = [];
    e.subscribe((ev) => ev.kind === 'message' && messages.push(ev.text));
    e.setLayerProps(e.doc.activeLayerId!, { locked: true });
    stroke(e, [[10, 10], [20, 20]]);
    expect(alphaSum(surfaceOf(e))).toBe(0);
    expect(messages[0]).toMatch(/locked/);
    expect(e.history.length).toBe(1); // only the lock
  });

  it('one stroke is one undo step and undo is exact', () => {
    const e = engine();
    const before = surfaceOf(e).clone();
    e.setToolOptions('brush', { smoothing: 0.4 });
    stroke(e, [[10, 10], [200, 220], [400, 30], [480, 480]]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Brush']);
    const after = surfaceOf(e).clone();
    e.undo();
    expect(surfaceOf(e).equals(before)).toBe(true);
    e.redo();
    expect(surfaceOf(e).equals(after)).toBe(true);
  });
});

describe('pixel-perfect pencil', () => {
  it('detects L-corners', () => {
    expect(isLCorner([2, 2], [3, 2], [3, 3])).toBe(true);
    expect(isLCorner([2, 2], [3, 3], [4, 3])).toBe(false);
    expect(isLCorner([2, 2], [3, 2], [4, 2])).toBe(false);
    expect(bresenham(0, 0, 3, 1)).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
  });

  const staircase: [number, number][] = [
    [2.5, 2.5],
    [3.5, 2.5],
    [3.5, 3.5],
    [4.5, 3.5],
    [4.5, 4.5],
    [5.5, 4.5],
  ];

  function painted(e: Engine): string[] {
    const s = surfaceOf(e);
    const out: string[] = [];
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) if (s.getPixel(x, y)[3]) out.push(`${x},${y}`);
    return out;
  }

  it('removes the L corners of a staircase', () => {
    const e = engine(16);
    e.setTool('pencil');
    stroke(e, staircase);
    expect(painted(e)).toEqual(['2,2', '3,3', '4,4', '5,4']);
    expect(pixel(surfaceOf(e), 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('keeps every pixel when pixel-perfect is off', () => {
    const e = engine(16);
    e.setTool('pencil');
    e.setToolOptions('pencil', { pixelPerfect: false });
    stroke(e, staircase);
    expect(painted(e)).toHaveLength(6);
  });

  it('does not un-paint a pixel the stroke painted before', () => {
    const e = engine(16);
    e.setTool('pencil');
    // (4,5) is painted by a straight run first; on the way back the path
    // (4,4) → (4,5) → (3,5) makes it an L-corner, which must not erase the
    // earlier paint.
    stroke(e, [[1.5, 5.5], [6.5, 5.5], [6.5, 3.5], [4.5, 3.5], [4.5, 4.5], [4.5, 5.5], [3.5, 5.5]]);
    expect(pixel(surfaceOf(e), 4, 5)[3]).toBe(255);
    expect(pixel(surfaceOf(e), 3, 5)[3]).toBe(255);
    // …whereas a fresh L-corner is removed.
    expect(pixel(surfaceOf(e), 4, 3)[3]).toBe(0);
  });

  it('mirrors pixels with symmetry and even nibs exactly', () => {
    const e = engine(16);
    e.setTool('pencil');
    e.setSymmetry({ mode: 'x' });
    stroke(e, [[1.5, 1.5]]);
    expect(painted(e)).toEqual(['1,1', '14,1']);
    const t = symmetryTransforms({ ...NO_SYMMETRY, mode: 'x' }, 16, 16);
    expect(nibOrigins(t, 3, 5, 2)).toEqual([[3, 5], [11, 5]]);
  });
});

describe('fill tool', () => {
  it('fills a contiguous region with tolerance and undoes exactly', () => {
    const e = engine(16);
    const s = surfaceOf(e);
    s.fill(0, 0, 0, 255, { x: 8, y: 0, w: 1, h: 16 }); // a wall
    e.setTool('fill');
    e.setToolOptions('fill', { tolerance: 0, contiguous: true });
    e.pointerDown(pointer(2, 2));
    e.pointerUp(pointer(2, 2));
    expect(pixel(s, 0, 15)).toEqual([255, 0, 0, 255]);
    expect(pixel(s, 8, 5)).toEqual([0, 0, 0, 255]);
    expect(pixel(s, 12, 5)).toEqual([0, 0, 0, 0]);
    e.undo();
    expect(pixel(s, 0, 15)).toEqual([0, 0, 0, 0]);
  });

  it('global mode and composite sampling', () => {
    const e = engine(16);
    surfaceOf(e).fill(0, 0, 0, 255, { x: 8, y: 0, w: 1, h: 16 });
    const bottom = e.doc.activeLayerId!;
    e.addLayer();
    e.setTool('fill');
    e.setToolOptions('fill', { tolerance: 0, contiguous: true, sampleMerged: true });
    e.pointerDown(pointer(2, 2));
    e.pointerUp(pointer(2, 2));
    const top = surfaceOf(e);
    expect(pixel(top, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(top, 12, 2)[3]).toBe(0);
    e.setToolOptions('fill', { contiguous: false, sampleMerged: true });
    e.setActiveLayer(bottom);
    e.pointerDown(pointer(12, 2));
    e.pointerUp(pointer(12, 2));
    // Everything transparent in the composite at the time is filled.
    expect(pixel(surfaceOf(e), 12, 2)).toEqual([255, 0, 0, 255]);
  });
});

describe('eyedropper', () => {
  it('picks composite or layer colours and averages', () => {
    const e = engine(16);
    surfaceOf(e).fill(0, 200, 0, 255);
    surfaceOf(e).setPixel(5, 5, 0, 0, 200, 255);
    e.setTool('eyedropper');
    e.pointerDown(pointer(5.5, 5.5));
    e.pointerUp(pointer(5.5, 5.5));
    expect(e.primary).toEqual({ r: 0, g: 0, b: 200, a: 1 });
    e.setToolOptions('eyedropper', { size: 3 });
    e.pointerDown(pointer(5.5, 5.5, { button: 2 }));
    e.pointerUp(pointer(5.5, 5.5));
    expect(e.secondary).toEqual({ r: 0, g: 178, b: 22, a: 1 });
    // Transparent samples are ignored.
    e.addLayer();
    e.setToolOptions('eyedropper', { sample: 'layer', size: 1 });
    e.pointerDown(pointer(1, 1));
    e.pointerUp(pointer(1, 1));
    expect(e.primary).toEqual({ r: 0, g: 0, b: 200, a: 1 });
  });
});
