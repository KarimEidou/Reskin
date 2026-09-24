import { describe, expect, it } from 'vitest';
import type { LayerEffect, OutlineEffect } from '../doc/types';
import { createEffect, hasActiveEffects, shadowOffset } from '../doc/effects';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage, floatToSurface, surfaceToFloat } from '../raster/float-image';
import { Surface } from '../raster/surface';
import { gaussianBlurPlane } from '../raster/blur';
import { dilate, erode } from '../raster/distance';
import type { Rgba } from '../color/color';
import { BLEND_FUNCTIONS } from './blend';
import { effectsReach, renderStyledLayer, renderStyledPixels, renderStyledRect, styledBounds } from './effects';

// ---- reference: the straightforward whole-layer renderer ----------------------------
// (full-size planes and the raster/ blur and distance functions; the fast
// renderer must compute the same values).

function shiftPlane(plane: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  if (ix === 0 && iy === 0) return plane.slice();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    const x0 = Math.max(0, ix);
    const x1 = Math.min(w, w + ix);
    if (x1 <= x0) continue;
    out.set(plane.subarray(sy * w + x0 - ix, sy * w + x1 - ix), y * w + x0);
  }
  return out;
}

function paint(dst: FloatImage, plane: Float32Array, color: Rgba, strength: number, atop: boolean): void {
  const k = strength * color.a;
  if (k <= 0) return;
  const c = [color.r / 255, color.g / 255, color.b / 255];
  const d = dst.data;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const a = plane[i] * k;
    const ab = d[p + 3];
    if (a <= 0 || (atop && ab <= 0)) continue;
    const inv = 1 - a;
    for (let j = 0; j < 3; j++) d[p + j] = (atop ? c[j] * a * ab : c[j] * a) + d[p + j] * inv;
    if (!atop) d[p + 3] = a + d[p + 3] * inv;
  }
}

function reference(src: Surface, effects: readonly LayerEffect[]): FloatImage {
  const content = surfaceToFloat(src);
  const active = effects.filter((e) => e.enabled && e.opacity > 0 && e.color.a > 0);
  if (!hasActiveEffects(active)) return content;
  const { width: w, height: h } = src;
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = content.data[i * 4 + 3];
  const group = createFloatImage(w, h);
  const of = <T extends LayerEffect['type']>(t: T) => active.filter((e): e is Extract<LayerEffect, { type: T }> => e.type === t);
  for (const e of of('dropShadow')) {
    const { dx, dy } = shadowOffset(e.angle, e.distance);
    let m: Float32Array = shiftPlane(alpha, w, h, dx, dy);
    if (e.spread > 0) m = dilate(m, w, h, e.spread);
    gaussianBlurPlane(m, w, h, Math.max(0, e.blur) / 2);
    paint(group, m, e.color, e.opacity, false);
  }
  for (const e of of('outerGlow')) {
    const m = e.spread > 0 ? dilate(alpha, w, h, e.spread) : alpha.slice();
    gaussianBlurPlane(m, w, h, Math.max(0, e.size) / 2);
    paint(group, m, e.color, e.opacity, false);
  }
  const widths = (e: OutlineEffect) => {
    const width = Math.max(0, e.width);
    return {
      outer: e.position === 'outside' ? width : e.position === 'center' ? width / 2 : 0,
      inner: e.position === 'inside' ? width : e.position === 'center' ? width / 2 : 0,
    };
  };
  for (const e of of('outline')) {
    const { outer } = widths(e);
    if (outer > 0) paint(group, dilate(alpha, w, h, outer), e.color, e.opacity, false);
  }
  for (const e of of('colorOverlay')) {
    const B = BLEND_FUNCTIONS[e.blend];
    const k = e.opacity * e.color.a;
    const oc = [e.color.r / 255, e.color.g / 255, e.color.b / 255];
    const d = content.data;
    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const cb = d[p + c] / a;
        d[p + c] = (cb + (B(cb, oc[c]!) - cb) * k) * a;
      }
    }
  }
  for (const e of of('innerShadow')) {
    const { dx, dy } = shadowOffset(e.angle, e.distance);
    const shifted = shiftPlane(alpha, w, h, dx, dy);
    let m: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = 1 - shifted[i]!;
    if (e.choke > 0) m = dilate(m, w, h, e.choke);
    gaussianBlurPlane(m, w, h, Math.max(0, e.blur) / 2);
    paint(content, m, e.color, e.opacity, true);
  }
  const d = group.data;
  const s = content.data;
  for (let p = 0; p < d.length; p += 4) {
    const as = s[p + 3]!;
    if (as <= 0) continue;
    const inv = 1 - as;
    for (let j = 0; j < 3; j++) d[p + j] = s[p + j]! + d[p + j]! * inv;
    d[p + 3] = as + d[p + 3]! * inv;
  }
  for (const e of of('outline')) {
    const { inner } = widths(e);
    if (inner <= 0) continue;
    const eroded = erode(alpha, w, h, inner);
    const top = new Float32Array(n);
    for (let i = 0; i < n; i++) top[i] = Math.max(0, alpha[i]! - eroded[i]!);
    paint(group, top, e.color, e.opacity, false);
  }
  return group;
}

// ---- fixtures -------------------------------------------------------------------------

/** An icon-like layer: a soft-edged disc, a hard square and a stray dot. */
function icon(size = 96, cx = 44, cy = 50): Surface {
  const s = new Surface(size, size);
  const set = (x: number, y: number, a: number, r = 220, g = 90, b = 40) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    s.data[i] = r;
    s.data[i + 1] = g;
    s.data[i + 2] = b;
    s.data[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, 22.5 - d));
      if (a > 0) set(x, y, Math.round(a * 255), 30 + x, 200 - y, 120);
    }
  }
  for (let y = 58; y < 70; y++) for (let x = 60; x < 74; x++) set(x, y, 255, 40, 160, 255);
  set(12, 80, 128);
  return s;
}

const red: Rgba = { r: 255, g: 0, b: 0, a: 1 };

const CASES: Record<string, LayerEffect[]> = {
  'drop shadow': [createEffect('dropShadow', { distance: 6, blur: 10 })],
  'drop shadow, spread, small blur': [createEffect('dropShadow', { angle: 30, distance: 3, blur: 2.4, spread: 3 })],
  'drop shadow, no blur': [createEffect('dropShadow', { distance: 4, blur: 0 })],
  'outer glow': [createEffect('outerGlow', { size: 14 })],
  'outer glow, spread': [createEffect('outerGlow', { size: 3, spread: 5 })],
  'outline outside': [createEffect('outline', { width: 5, color: red })],
  'outline centre': [createEffect('outline', { width: 6.5, position: 'center' })],
  'outline inside': [createEffect('outline', { width: 3, position: 'inside', color: red })],
  'colour overlay': [createEffect('colorOverlay', { blend: 'multiply', opacity: 0.6 })],
  'inner shadow': [createEffect('innerShadow', { distance: 5, blur: 7, choke: 2 })],
  'three effects': [
    createEffect('dropShadow', { distance: 5, blur: 9 }),
    createEffect('outerGlow', { size: 10, spread: 1 }),
    createEffect('outline', { width: 3 }),
  ],
  'everything, twice': [
    createEffect('outline', { width: 2, position: 'center' }),
    createEffect('dropShadow', { distance: 7, blur: 12, spread: 1 }),
    createEffect('innerShadow', { distance: 3, blur: 1.2 }),
    createEffect('colorOverlay', { color: { r: 10, g: 200, b: 90, a: 0.5 } }),
    createEffect('outerGlow', { size: 6 }),
    createEffect('dropShadow', { angle: 300, distance: 2, blur: 3.5 }),
    createEffect('outline', { width: 4, color: red }),
  ],
};

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

// ---- tests --------------------------------------------------------------------------------

describe('renderStyledLayer', () => {
  for (const [name, effects] of Object.entries(CASES)) {
    it(`matches the whole-layer reference: ${name}`, () => {
      for (const src of [icon(), icon(96, 20, 18)]) {
        const ref = reference(src, effects);
        const out = renderStyledLayer(src, effects);
        expect(maxDiff(out.data, ref.data)).toBeLessThan(1e-6);
        expect(floatToSurface(out).data).toEqual(floatToSurface(ref).data);
      }
    });
  }

  it('keeps an empty layer empty and passes plain pixels through', () => {
    const empty = new Surface(32, 32);
    expect(renderStyledLayer(empty, CASES['three effects']!).data.every((v) => v === 0)).toBe(true);
    const src = icon();
    expect(renderStyledLayer(src, []).data).toEqual(surfaceToFloat(src).data);
    expect(renderStyledLayer(src, [createEffect('dropShadow', { enabled: false })]).data).toEqual(surfaceToFloat(src).data);
  });
});

describe('effectsReach and styledBounds', () => {
  it('bound everything the effects draw', () => {
    for (const [name, effects] of Object.entries(CASES)) {
      const src = icon();
      const bounds = styledBounds(src, effects)!;
      const ref = floatToSurface(reference(src, effects));
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          const inside = x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.w && y < bounds.y + bounds.h;
          if (!inside) expect(ref.data[(y * src.width + x) * 4 + 3], `${name} at ${x},${y}`).toBe(0);
        }
      }
    }
  });

  it('grow with shadow offsets and blur, not with a colour overlay', () => {
    expect(effectsReach([createEffect('colorOverlay')])).toBe(0);
    expect(effectsReach([createEffect('dropShadow', { distance: 10, blur: 0, angle: 180 })])).toBe(10);
    // Blur 12 is σ 6: three box passes of radius 5, 5 and 6.
    expect(effectsReach([createEffect('dropShadow', { distance: 10, blur: 12, angle: 180 })])).toBe(10 + 16);
    expect(effectsReach([createEffect('outline', { width: 4.5 })])).toBe(6);
    expect(effectsReach([createEffect('dropShadow', { enabled: false, distance: 50 })])).toBe(0);
    expect(styledBounds(new Surface(8, 8), [createEffect('outline')])).toBeNull();
  });
});

describe('renderStyledPixels and renderStyledRect', () => {
  it('give the reference pixels, cropped', () => {
    for (const effects of Object.values(CASES)) {
      const src = icon();
      const ref = floatToSurface(reference(src, effects));
      const styled = renderStyledPixels(src, effects)!;
      const { rect, data } = styled;
      for (let y = 0; y < rect.h; y++) {
        const row = ref.data.subarray(((rect.y + y) * src.width + rect.x) * 4, ((rect.y + y) * src.width + rect.x + rect.w) * 4);
        expect(data.subarray(y * rect.w * 4, (y + 1) * rect.w * 4)).toEqual(row);
      }
    }
  });

  it('re-render any rect from the pixels around it', () => {
    const rects = [
      { x: 40, y: 40, w: 12, h: 9 },
      { x: 0, y: 0, w: 30, h: 20 },
      { x: 70, y: 55, w: 26, h: 41 },
      { x: 10, y: 75, w: 5, h: 5 },
    ];
    for (const effects of Object.values(CASES)) {
      const src = icon();
      const ref = floatToSurface(reference(src, effects));
      const buffer = new Uint8ClampedArray(64 * 64 * 4);
      for (const rect of rects) {
        const { data } = renderStyledRect(src, effects, rect, buffer);
        expect(data.length).toBe(rect.w * rect.h * 4);
        let worst = 0;
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w * 4; x++) {
            const r = ref.data[((rect.y + y) * src.width + rect.x) * 4 + x]!;
            worst = Math.max(worst, Math.abs(data[y * rect.w * 4 + x]! - r));
          }
        }
        expect(worst).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reuses the buffer it is given', () => {
    const buffer = new Uint8ClampedArray(96 * 96 * 4);
    const styled = renderStyledPixels(icon(), CASES['three effects']!, buffer)!;
    expect(styled.data.buffer).toBe(buffer.buffer);
    expect(renderStyledRect(icon(), CASES['outer glow']!, { x: 1, y: 1, w: 4, h: 4 }, buffer).data.buffer).toBe(buffer.buffer);
  });
});
