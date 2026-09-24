// Non-destructive layer effects.
//
// A styled layer is rendered as one image ("layer group"), bottom to top:
//   drop shadows → outer glows → outline (outside / centre-outer part)
//   → the layer content, restyled by colour overlays then inner shadows
//   → outline (inside / centre-inner part).
// The group is then composited onto the backdrop with the layer's blend mode
// and opacity (like a CSS element with `filter` + `mix-blend-mode`). Effects
// of the same type apply in list order. All maths is premultiplied float.

import type { LayerEffect, OutlineEffect } from '../doc/types';
import { hasActiveEffects, shadowOffset } from '../doc/effects';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage, surfaceToFloat } from '../raster/float-image';
import type { Surface } from '../raster/surface';
import { gaussianBlurPlane } from '../raster/blur';
import { dilate, erode } from '../raster/distance';
import type { Rgba } from '../color/color';
import { BLEND_FUNCTIONS } from './blend';

/** Shifts a plane by whole pixels; uncovered pixels become 0. */
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

/** Source-over of `color` with per-pixel coverage `plane`·`strength`. */
function paintPlane(dst: FloatImage, plane: Float32Array, color: Rgba, strength: number): void {
  const k = strength * color.a;
  if (k <= 0) return;
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const d = dst.data;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const a = plane[i] * k;
    if (a <= 0) continue;
    const inv = 1 - a;
    d[p] = r * a + d[p] * inv;
    d[p + 1] = g * a + d[p + 1] * inv;
    d[p + 2] = b * a + d[p + 2] * inv;
    d[p + 3] = a + d[p + 3] * inv;
  }
}

/** Source-atop: paints `color` inside the existing alpha only (alpha unchanged). */
function paintPlaneAtop(dst: FloatImage, plane: Float32Array, color: Rgba, strength: number): void {
  const k = strength * color.a;
  if (k <= 0) return;
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const d = dst.data;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const s = plane[i] * k;
    const ab = d[p + 3];
    if (s <= 0 || ab <= 0) continue;
    const inv = 1 - s;
    d[p] = r * s * ab + d[p] * inv;
    d[p + 1] = g * s * ab + d[p + 1] * inv;
    d[p + 2] = b * s * ab + d[p + 2] * inv;
  }
}

function overInto(dst: FloatImage, src: FloatImage): void {
  const d = dst.data;
  const s = src.data;
  for (let p = 0; p < d.length; p += 4) {
    const as = s[p + 3];
    if (as <= 0) continue;
    const inv = 1 - as;
    d[p] = s[p] + d[p] * inv;
    d[p + 1] = s[p + 1] + d[p + 1] * inv;
    d[p + 2] = s[p + 2] + d[p + 2] * inv;
    d[p + 3] = as + d[p + 3] * inv;
  }
}

function outlineParts(
  alpha: Float32Array,
  w: number,
  h: number,
  e: OutlineEffect,
): { behind: Float32Array | null; top: Float32Array | null } {
  const width = Math.max(0, e.width);
  if (width === 0) return { behind: null, top: null };
  const outer = e.position === 'outside' ? width : e.position === 'center' ? width / 2 : 0;
  const inner = e.position === 'inside' ? width : e.position === 'center' ? width / 2 : 0;
  const behind = outer > 0 ? dilate(alpha, w, h, outer) : null;
  let top: Float32Array | null = null;
  if (inner > 0) {
    const eroded = erode(alpha, w, h, inner);
    top = new Float32Array(alpha.length);
    for (let i = 0; i < top.length; i++) top[i] = Math.max(0, alpha[i] - eroded[i]);
  }
  return { behind, top };
}

/**
 * Renders a layer's pixels with its effects into a premultiplied float
 * image of the same size. Without active effects this is just the pixels.
 */
export function renderStyledLayer(src: Surface, effects: readonly LayerEffect[]): FloatImage {
  const content = surfaceToFloat(src);
  const active = effects.filter((e) => e.enabled && e.opacity > 0 && e.color.a > 0);
  if (!hasActiveEffects(active)) return content;
  const { width: w, height: h } = src;
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = content.data[i * 4 + 3];

  const group = createFloatImage(w, h);
  const byType = <T extends LayerEffect['type']>(t: T) =>
    active.filter((e): e is Extract<LayerEffect, { type: T }> => e.type === t);

  // Behind the content.
  for (const e of byType('dropShadow')) {
    const { dx, dy } = shadowOffset(e.angle, e.distance);
    let m: Float32Array = shiftPlane(alpha, w, h, dx, dy);
    if (e.spread > 0) m = dilate(m, w, h, e.spread);
    gaussianBlurPlane(m, w, h, Math.max(0, e.blur) / 2);
    paintPlane(group, m, e.color, e.opacity);
  }
  for (const e of byType('outerGlow')) {
    const m = e.spread > 0 ? dilate(alpha, w, h, e.spread) : alpha.slice();
    gaussianBlurPlane(m, w, h, Math.max(0, e.size) / 2);
    paintPlane(group, m, e.color, e.opacity);
  }
  const outlines = byType('outline').map((e) => ({ e, ...outlineParts(alpha, w, h, e) }));
  for (const o of outlines) if (o.behind) paintPlane(group, o.behind, o.e.color, o.e.opacity);

  // Content restyling.
  for (const e of byType('colorOverlay')) {
    const B = BLEND_FUNCTIONS[e.blend];
    const k = e.opacity * e.color.a;
    const oc = [e.color.r / 255, e.color.g / 255, e.color.b / 255];
    const d = content.data;
    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const cb = d[p + c] / a;
        d[p + c] = (cb + (B(cb, oc[c]) - cb) * k) * a;
      }
    }
  }
  for (const e of byType('innerShadow')) {
    const { dx, dy } = shadowOffset(e.angle, e.distance);
    const shifted = shiftPlane(alpha, w, h, dx, dy);
    let m: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = 1 - shifted[i];
    if (e.choke > 0) m = dilate(m, w, h, e.choke);
    gaussianBlurPlane(m, w, h, Math.max(0, e.blur) / 2);
    paintPlaneAtop(content, m, e.color, e.opacity);
  }
  overInto(group, content);

  // On top of the content.
  for (const o of outlines) if (o.top) paintPlane(group, o.top, o.e.color, o.e.opacity);
  return group;
}
