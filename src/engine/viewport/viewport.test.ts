import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, Viewport, clampZoom } from './viewport';
import { seededRandom } from '../test-helpers';

describe('Viewport', () => {
  it('fits the document with padding and centres it', () => {
    const v = new Viewport({ viewWidth: 1000, viewHeight: 600 });
    expect(v.zoom).toBeCloseTo((600 - 48) / 512, 10);
    const tl = v.docToScreen(0, 0);
    const br = v.docToScreen(512, 512);
    expect(tl.y).toBeCloseTo(24, 9);
    expect(br.y).toBeCloseTo(576, 9);
    expect((tl.x + br.x) / 2).toBeCloseTo(500, 9);
  });

  it('screen ↔ doc transforms are inverse at any zoom/pan', () => {
    const v = new Viewport({ viewWidth: 800, viewHeight: 700 });
    const r = seededRandom(4);
    for (let i = 0; i < 200; i++) {
      v.setZoom(MIN_ZOOM + r() * (MAX_ZOOM - MIN_ZOOM), r() * 800, r() * 700);
      v.panBy((r() - 0.5) * 100, (r() - 0.5) * 100);
      const x = r() * 512;
      const y = r() * 512;
      const s = v.docToScreen(x, y);
      const d = v.screenToDoc(s.x, s.y);
      expect(d.x).toBeCloseTo(x, 6);
      expect(d.y).toBeCloseTo(y, 6);
    }
  });

  it('zooms around the anchor point', () => {
    const v = new Viewport({ viewWidth: 800, viewHeight: 800 });
    const anchor = { x: 300, y: 350 };
    const before = v.screenToDoc(anchor.x, anchor.y);
    v.zoomBy(3, anchor.x, anchor.y);
    const after = v.screenToDoc(anchor.x, anchor.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('clamps zoom to 0.25×–32×', () => {
    const v = new Viewport();
    v.setZoom(1000);
    expect(v.zoom).toBe(32);
    v.setZoom(0.001);
    expect(v.zoom).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
    v.setZoom(1);
    v.zoomStep(1);
    expect(v.zoom).toBe(1.5);
    v.zoomStep(-1);
    v.zoomStep(-1);
    expect(v.zoom).toBeCloseTo(2 / 3, 10);
  });

  it('shows the pixel grid from 8 screen px per document px', () => {
    const v = new Viewport();
    v.setZoom(7.9);
    expect(v.gridVisible()).toBe(false);
    v.setZoom(8);
    expect(v.gridVisible()).toBe(true);
  });

  it('pixel-art documents use a master-relative zoom', () => {
    const v = new Viewport({ docWidth: 32, docHeight: 32 });
    v.setZoom(1);
    expect(v.scale).toBe(16);
    expect(v.gridVisible()).toBe(true);
    v.setDocSize(512, 512);
    expect(v.scale).toBe(1);
  });

  it('keeps part of the document on screen when panning', () => {
    const v = new Viewport({ viewWidth: 400, viewHeight: 400 });
    v.panBy(-10000, 10000);
    const r = v.docRectToScreen({ x: 0, y: 0, w: 512, h: 512 });
    expect(r.x + r.w).toBeGreaterThanOrEqual(v.keepVisible - 1e-9);
    expect(r.y).toBeLessThanOrEqual(400 - v.keepVisible + 1e-9);
  });

  it('reports the visible document rect and notifies listeners', () => {
    const v = new Viewport({ viewWidth: 256, viewHeight: 256 });
    v.setZoom(2, 0, 0);
    v.restore({ zoom: 2, panX: 0, panY: 0 });
    expect(v.visibleDocRect()).toEqual({ x: 0, y: 0, w: 128, h: 128 });
    let calls = 0;
    const off = v.subscribe(() => calls++);
    v.panBy(-10, 0);
    off();
    v.panBy(-10, 0);
    expect(calls).toBe(1);
  });
});
