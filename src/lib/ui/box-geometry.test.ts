import { describe, expect, it } from 'vitest';
import { defaultSettings } from '$lib/settings/defaults';
import {
  collapseItems,
  FIRST_RUN_HINT,
  handoffProps,
  iconRect,
  ICON_FRACTION,
  RING_GAP,
  RING_STROKE,
  metricsFor,
  physicalToCss,
  ringRadius,
  ringRect,
  roundedRectPath,
  STATE_TRANSFORM,
  transformCss,
  visualRadius,
  visualRect,
  windowRect,
} from './box-geometry';

const M = metricsFor('medium');

describe('box geometry', () => {
  it('mirrors BoxMetrics::for_size', () => {
    expect(M).toEqual({ window: 148, visual: 120, margin: 14, radius: 30 });
    expect(metricsFor('small')).toEqual({ window: 124, visual: 96, margin: 14, radius: 24 });
    expect(metricsFor('large')).toEqual({ window: 176, visual: 148, margin: 14, radius: 36 });
  });

  it('centres the visual box and the icon', () => {
    expect(windowRect(M, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 148, h: 148 });
    expect(visualRect(M)).toEqual({ x: 14, y: 14, w: 120, h: 120 });
    expect(visualRect(M, { x: 100, y: 50 })).toEqual({ x: 114, y: 64, w: 120, h: 120 });
    const icon = iconRect(M);
    expect(icon.w).toBeCloseTo(120 * ICON_FRACTION, 9);
    expect(icon.x + icon.w / 2).toBeCloseTo(74, 9);
    expect(icon.y + icon.h / 2).toBeCloseTo(74, 9);
  });

  it('applies the resting transform of a state', () => {
    const armed = visualRect(M, undefined, 'armed');
    expect(armed.w).toBeCloseTo(129.6, 9);
    expect(armed.x + armed.w / 2).toBeCloseTo(74, 9);
    // Armed swelling stays inside the window.
    expect(armed.x).toBeGreaterThan(0);
    expect(armed.x + armed.w).toBeLessThan(M.window);
    const hover = visualRect(M, undefined, 'hover');
    expect(hover.y + hover.h / 2).toBeCloseTo(72, 9);
    expect(visualRadius(M, 'armed')).toBeCloseTo(32.4, 9);
  });

  it('keeps every state inside the window', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const m = metricsFor(size);
      for (const state of Object.keys(STATE_TRANSFORM) as Array<keyof typeof STATE_TRANSFORM>) {
        const r = visualRect(m, undefined, state);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(m.window);
        expect(r.y + r.h).toBeLessThanOrEqual(m.window);
      }
      const ring = ringRect(m);
      expect(ring.x).toBeGreaterThan(0);
      expect(ring.x + ring.w).toBeLessThan(m.window);
    }
  });

  it('puts the compat-mode ring inside the visual box (the window region)', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const m = metricsFor(size);
      const v = visualRect(m);
      const ring = ringRect(m, undefined, true);
      // Stroke included, the ring stays inside the clipped visual box.
      expect(ring.x - RING_STROKE / 2).toBeGreaterThan(v.x);
      expect(ring.x + ring.w + RING_STROKE / 2).toBeLessThan(v.x + v.w);
      expect(ring.w).toBeCloseTo(m.visual - 2 * RING_GAP, 9);
      expect(ringRadius(m, true)).toBe(m.radius - RING_GAP);
      expect(ringRadius(m)).toBe(m.radius + RING_GAP);
    }
    expect(ringRect(M, { x: 100, y: 10 }, true)).toEqual({ x: 119, y: 29, w: 110, h: 110 });
  });

  it('formats transforms', () => {
    expect(transformCss(STATE_TRANSFORM.idle)).toBe('none');
    expect(transformCss(STATE_TRANSFORM.armed)).toBe('scale(1.08, 1.08)');
    expect(transformCss(STATE_TRANSFORM.hover)).toBe('translateY(-2px) scale(1.02, 1.02)');
    expect(transformCss(STATE_TRANSFORM.flying)).toBe('rotate(-5deg) scale(1.05, 0.96)');
  });

  it('builds a clockwise rounded-rect path from the top centre', () => {
    const d = roundedRectPath({ x: 0, y: 0, w: 100, h: 60 }, 10);
    expect(d.startsWith('M50 0 H90 A10 10 0 0 1 100 10 V50')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    // Radius is clamped to half the short side.
    expect(roundedRectPath({ x: 0, y: 0, w: 20, h: 10 }, 50)).toContain('A5 5');
  });

  it('converts physical drop positions to CSS px', () => {
    expect(physicalToCss({ x: 150, y: 75 }, 1.5)).toEqual({ x: 100, y: 50 });
    expect(physicalToCss({ x: 10, y: 10 }, 0)).toEqual({ x: 10, y: 10 });
  });

  it('describes the handoff picture the editor proxy must reproduce', () => {
    const settings = { ...defaultSettings(), boxSkin: 'aurora' as const, boxSize: 'large' as const, idleOpacity: 0.6 };
    const items = [{ icon: 'data:image/png;base64,AAA' }, { icon: null }];
    expect(handoffProps(settings, items, true)).toEqual({
      metrics: metricsFor('large'),
      skin: 'aurora',
      state: 'idle',
      icon: 'data:image/png;base64,AAA',
      count: 2,
      progress: null,
      opacity: 0.6,
      compat: false,
      reducedMotion: true,
      hint: null,
    });
    // A click handoff (start view) shows the empty box; the first-run
    // welcome collapses onto the hint the box then shows.
    expect(handoffProps(settings, [], false)).toMatchObject({ icon: null, count: 0, hint: null });
    expect(handoffProps(settings, [], false, undefined, FIRST_RUN_HINT).hint).toBe(FIRST_RUN_HINT);
    expect(handoffProps(settings, items, false, undefined, FIRST_RUN_HINT).hint).toBeNull();
  });

  it('describes what the box holds at the end of a close handoff', () => {
    // A plain close brings back the empty box, whatever icon Rust passes.
    expect(collapseItems('hide', 'data:new')).toEqual([]);
    // After an apply the box carries the new icon (one item, no badge).
    expect(collapseItems('fly', 'data:new')).toEqual([{ icon: 'data:new' }]);
    expect(collapseItems('celebrate', null)).toEqual([{ icon: null }]);
    expect(handoffProps(defaultSettings(), collapseItems('celebrate', 'data:new'), false)).toMatchObject({
      state: 'idle',
      icon: 'data:new',
      count: 1,
    });
  });
});
