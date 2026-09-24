import { describe, expect, it } from 'vitest';
import { Viewport } from '$engine/index';
import {
  backingSize,
  clamp01,
  formatZoom,
  isFitted,
  mixView,
  physicalPointIn,
  splitFromStageX,
  textEditorBox,
  wheelZoom,
} from './geometry';

describe('backingSize', () => {
  it('scales CSS px by the device pixel ratio and rounds', () => {
    expect(backingSize(700, 500, 1)).toEqual({ width: 700, height: 500 });
    expect(backingSize(700, 500, 1.5)).toEqual({ width: 1050, height: 750 });
    expect(backingSize(333.3, 200.2, 1.25)).toEqual({ width: 417, height: 250 });
  });

  it('prefers the exact device-pixel box when the browser reports it', () => {
    expect(backingSize(333.3, 200.2, 1.25, { inlineSize: 416, blockSize: 251 })).toEqual({ width: 416, height: 251 });
  });

  it('never returns an empty or invalid store', () => {
    expect(backingSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
    expect(backingSize(10, 10, Number.NaN)).toEqual({ width: 10, height: 10 });
    expect(backingSize(10, 10, 2, { inlineSize: 0, blockSize: 0 })).toEqual({ width: 20, height: 20 });
  });
});

describe('document ↔ stage mapping', () => {
  const t = { scale: 2, panX: 40, panY: 10 };

  it('maps a stage x to the split position, clamped to the document', () => {
    expect(splitFromStageX(40 + 512, t, 512)).toBeCloseTo(0.5);
    expect(splitFromStageX(40 + 256, t, 512)).toBeCloseTo(0.25);
    expect(splitFromStageX(0, t, 512)).toBe(0);
    expect(splitFromStageX(5000, t, 512)).toBe(1);
    expect(splitFromStageX(10, { scale: 0, panX: 0, panY: 0 }, 512)).toBe(0.5);
  });

  it('agrees with the engine viewport', () => {
    const vp = new Viewport({ viewWidth: 800, viewHeight: 600 });
    vp.setZoom(2, 123, 77);
    const d = vp.screenToDoc(400, 300);
    expect(splitFromStageX(400, vp, 512)).toBeCloseTo(d.x / 512, 9);
  });
});

describe('textEditorBox', () => {
  const layout = { width: 100, height: 60, lineHeight: 30 };
  const t = { scale: 2, panX: 10, panY: 20 };

  it('anchors left-aligned text at its left edge', () => {
    const b = textEditorBox({ x: 50, y: 40, align: 'left', rotation: 0, fontSize: 25, lineHeight: 1.2 }, layout, t);
    expect(b.left).toBe(10 + 100);
    expect(b.top).toBe(20 + 80);
    expect(b.width).toBe(200 + 4);
    expect(b.height).toBe(120);
    expect(b.fontSize).toBe(50);
    expect(b.lineHeight).toBe(60);
    expect(b.originX).toBe(0);
  });

  it('centres centred text on the anchor and rotates about it', () => {
    const b = textEditorBox({ x: 50, y: 40, align: 'center', rotation: 15, fontSize: 25, lineHeight: 1.2 }, layout, t);
    expect(b.left + b.originX).toBe(10 + 100);
    expect(b.originX).toBe(b.width / 2);
    expect(b.rotation).toBe(15);
  });

  it('ends right-aligned text at the anchor', () => {
    const b = textEditorBox({ x: 50, y: 40, align: 'right', rotation: 0, fontSize: 25, lineHeight: 1.2 }, layout, t);
    expect(b.left + b.width).toBe(10 + 100);
  });

  it('keeps an empty text editable (one line, a caret wide)', () => {
    const b = textEditorBox(
      { x: 0, y: 0, align: 'left', rotation: 0, fontSize: 40, lineHeight: 1.2 },
      { width: 0, height: 0, lineHeight: 48 },
      { scale: 1, panX: 0, panY: 0 },
    );
    expect(b.width).toBeGreaterThanOrEqual(30);
    expect(b.height).toBe(48);
  });
});

describe('formatZoom', () => {
  it('shows whole percentages, a decimal only below 10 %', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(1 / 3)).toBe('33%');
    expect(formatZoom(32)).toBe('3200%');
    expect(formatZoom(0.0625)).toBe('6.3%');
    expect(formatZoom(0.05)).toBe('5%');
    expect(formatZoom(0)).toBe('—');
    expect(formatZoom(Number.NaN)).toBe('—');
  });
});

describe('wheelZoom', () => {
  it('steps for mouse wheel notches', () => {
    expect(wheelZoom(100, 0)).toEqual({ kind: 'step', direction: -1 });
    expect(wheelZoom(-120, 0)).toEqual({ kind: 'step', direction: 1 });
    expect(wheelZoom(3, 1)).toEqual({ kind: 'step', direction: -1 });
  });

  it('zooms smoothly for touchpad deltas (in = negative delta)', () => {
    const inward = wheelZoom(-8, 0);
    const outward = wheelZoom(8, 0);
    expect(inward?.kind).toBe('smooth');
    expect(inward && inward.kind === 'smooth' && inward.factor).toBeGreaterThan(1);
    expect(outward && outward.kind === 'smooth' && outward.factor).toBeLessThan(1);
  });

  it('ignores empty deltas', () => {
    expect(wheelZoom(0, 0)).toBeNull();
    expect(wheelZoom(Number.NaN, 0)).toBeNull();
  });
});

describe('isFitted', () => {
  it('is true right after fit and false after zooming or panning', () => {
    const vp = new Viewport({ viewWidth: 700, viewHeight: 540 });
    vp.fit();
    expect(isFitted(vp)).toBe(true);
    vp.panBy(20, 0);
    expect(isFitted(vp)).toBe(false);
    vp.fit();
    vp.zoomStep(1);
    expect(isFitted(vp)).toBe(false);
    vp.fit();
    vp.setViewSize(900, 540); // the height still limits: same fit
    expect(isFitted(vp)).toBe(true);
    vp.setViewSize(900, 800); // taller: the fit zoom grows
    expect(isFitted(vp)).toBe(false);
  });
});

describe('mixView', () => {
  it('interpolates zoom geometrically and pan linearly', () => {
    const a = { zoom: 1, panX: 0, panY: 0 };
    const b = { zoom: 4, panX: 100, panY: -50 };
    expect(mixView(a, b, 0)).toEqual(a);
    expect(mixView(a, b, 1)).toEqual(b);
    const mid = mixView(a, b, 0.5);
    expect(mid.zoom).toBeCloseTo(2);
    expect(mid.panX).toBe(50);
    expect(mid.panY).toBe(-25);
    expect(mixView(a, b, 2)).toEqual(b);
  });
});

describe('physicalPointIn', () => {
  it('converts physical drag positions to CSS px', () => {
    const rect = { left: 100, top: 50, right: 300, bottom: 250 };
    expect(physicalPointIn({ x: 300, y: 150 }, 1.5, rect)).toBe(true);
    expect(physicalPointIn({ x: 140, y: 150 }, 1.5, rect)).toBe(false);
    expect(physicalPointIn({ x: 150, y: 60 }, 0, rect)).toBe(true);
  });
});

describe('clamp01', () => {
  it('clamps and rejects NaN', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
