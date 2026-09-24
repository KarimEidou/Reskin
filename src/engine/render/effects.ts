// Non-destructive layer effects.
//
// A styled layer is rendered as one image ("layer group"), bottom to top:
//   drop shadows → outer glows → outline (outside / centre-outer part)
//   → the layer content, restyled by colour overlays then inner shadows
//   → outline (inside / centre-inner part).
// The group is then composited onto the backdrop with the layer's blend mode
// and opacity (like a CSS element with `filter` + `mix-blend-mode`). Effects
// of the same type apply in list order. All maths is premultiplied float.
//
// Every effect is local: it draws at most `effectsReach` px beyond the
// layer's pixels and reads at most that far from a pixel. The renderer
// therefore only works on a bounded area — the layer's pixels grown by the
// reach for a whole layer (`renderStyledLayer`, `renderStyledPixels`), or a
// changed rect plus the reach around it (`renderStyledRect`) — in reusable
// work buffers (./effect-kernels.ts), and computes the same values as a
// pass over the whole layer would.

import type { LayerEffect, OutlineEffect } from '../doc/types';
import { hasActiveEffects, shadowOffset } from '../doc/effects';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage, surfaceToFloat } from '../raster/float-image';
import type { Surface } from '../raster/surface';
import type { Rgba } from '../color/color';
import type { Rect } from '../util/rect';
import { clipRect, inflateRect } from '../util/rect';
import { BLEND_FUNCTIONS } from './blend';
import { EffectScratch, blurPlane, blurReach, dilatePlane, dilateReach, innerBandPlane } from './effect-kernels';

const INV255 = 1 / 255;

/** Work buffers of this thread's renders (a render never outlives its call). */
const scratch = new EffectScratch();

/** The effects that draw something, in list order. */
function activeOf(effects: readonly LayerEffect[]): LayerEffect[] {
  return effects.filter((e) => e.enabled && e.opacity > 0 && e.color.a > 0);
}

/** A shadow's offset in whole pixels. */
function offsetOf(e: { angle: number; distance: number }): { ix: number; iy: number } {
  const { dx, dy } = shadowOffset(e.angle, e.distance);
  return { ix: Math.round(dx), iy: Math.round(dy) };
}

/** Outline widths outside and inside the shape's edge, px. */
function outlineWidths(e: OutlineEffect): { outer: number; inner: number } {
  const width = Math.max(0, e.width);
  return {
    outer: e.position === 'outside' ? width : e.position === 'center' ? width / 2 : 0,
    inner: e.position === 'inside' ? width : e.position === 'center' ? width / 2 : 0,
  };
}

/** How far one effect draws beyond the layer's pixels and reads around a pixel (px, per axis). */
function reachOf(e: LayerEffect): number {
  switch (e.type) {
    case 'dropShadow':
    case 'innerShadow': {
      const { ix, iy } = offsetOf(e);
      const grow = e.type === 'dropShadow' ? e.spread : e.choke;
      return Math.max(Math.abs(ix), Math.abs(iy)) + dilateReach(grow) + blurReach(Math.max(0, e.blur) / 2);
    }
    case 'outerGlow':
      return dilateReach(e.spread) + blurReach(Math.max(0, e.size) / 2);
    case 'outline': {
      const { outer, inner } = outlineWidths(e);
      return Math.max(dilateReach(outer), dilateReach(inner));
    }
    case 'colorOverlay':
      return 0;
  }
}

/**
 * How far (px, per axis) the active effects reach: a styled pixel depends
 * only on the layer's pixels this close, and nothing is drawn farther than
 * this from the layer's pixels.
 */
export function effectsReach(effects: readonly LayerEffect[]): number {
  let reach = 0;
  for (const e of activeOf(effects)) reach = Math.max(reach, reachOf(e));
  return reach;
}

/** Bounds of the pixels with alpha > 0, or null for an empty surface. */
function contentBounds(src: Surface): Rect | null {
  const { width: w, height: h, data } = src;
  let x0 = w;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4 + 3;
    let first = -1;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4] !== 0) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--) {
      if (data[row + x * 4] !== 0) {
        last = x;
        break;
      }
    }
    if (y0 < 0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  return y0 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Where the styled layer can have pixels: the layer's pixels grown by the
 * effects' reach, within the layer. Null when the layer is empty.
 */
export function styledBounds(src: Surface, effects: readonly LayerEffect[]): Rect | null {
  const content = contentBounds(src);
  return content && clipRect(inflateRect(content, effectsReach(effects)), src.width, src.height);
}

/** Copies `alpha` shifted by whole pixels into `out`; uncovered pixels become 0. */
function shiftInto(alpha: Float32Array, out: Float32Array, w: number, h: number, ix: number, iy: number): void {
  if (ix === 0 && iy === 0) {
    out.set(alpha);
    return;
  }
  out.fill(0);
  const x0 = Math.max(0, ix);
  const x1 = Math.min(w, w + ix);
  if (x1 <= x0) return;
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    out.set(alpha.subarray(sy * w + x0 - ix, sy * w + x1 - ix), y * w + x0);
  }
}

/** Source-over of `color` with per-pixel coverage `plane`·`strength`. */
function paintPlane(dst: Float32Array, plane: Float32Array, color: Rgba, strength: number): void {
  const k = strength * color.a;
  if (k <= 0) return;
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const a = plane[i] * k;
    if (a <= 0) continue;
    const inv = 1 - a;
    dst[p] = r * a + dst[p] * inv;
    dst[p + 1] = g * a + dst[p + 1] * inv;
    dst[p + 2] = b * a + dst[p + 2] * inv;
    dst[p + 3] = a + dst[p + 3] * inv;
  }
}

/** Source-atop: paints `color` inside the existing alpha only (alpha unchanged). */
function paintPlaneAtop(dst: Float32Array, plane: Float32Array, color: Rgba, strength: number): void {
  const k = strength * color.a;
  if (k <= 0) return;
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const s = plane[i] * k;
    const ab = dst[p + 3];
    if (s <= 0 || ab <= 0) continue;
    const inv = 1 - s;
    dst[p] = r * s * ab + dst[p] * inv;
    dst[p + 1] = g * s * ab + dst[p + 1] * inv;
    dst[p + 2] = b * s * ab + dst[p + 2] * inv;
  }
}

function overInto(dst: Float32Array, src: Float32Array): void {
  for (let p = 0; p < dst.length; p += 4) {
    const as = src[p + 3];
    if (as <= 0) continue;
    const inv = 1 - as;
    dst[p] = src[p] + dst[p] * inv;
    dst[p + 1] = src[p + 1] + dst[p + 1] * inv;
    dst[p + 2] = src[p + 2] + dst[p + 2] * inv;
    dst[p + 3] = as + dst[p + 3] * inv;
  }
}

/**
 * Renders the styled layer over `area` (layer px) and returns its
 * premultiplied RGBA group, `area`-sized, in the scratch buffers (valid
 * until the next render). Pixels farther than the reach from the edges of
 * `area` that are not edges of the layer equal those of a whole-layer pass.
 */
function styleArea(src: Surface, active: readonly LayerEffect[], area: Rect): Float32Array {
  const { w, h } = area;
  const n = w * h;
  scratch.reset();
  const content = scratch.plane(4 * n);
  const alpha = scratch.plane(n);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    let si = ((area.y + y) * src.width + area.x) * 4;
    for (let x = 0, i = y * w, di = i * 4; x < w; x++, i++, di += 4, si += 4) {
      const a = s[si + 3] * INV255;
      if (a === 0) {
        content[di] = content[di + 1] = content[di + 2] = content[di + 3] = 0;
        alpha[i] = 0;
        continue;
      }
      const k = a * INV255;
      content[di] = s[si] * k;
      content[di + 1] = s[si + 1] * k;
      content[di + 2] = s[si + 2] * k;
      content[di + 3] = a;
      alpha[i] = content[di + 3];
    }
  }
  const group = scratch.zeroed(4 * n);
  const m = scratch.plane(n);
  const tmp = scratch.plane(n);

  // Behind the content.
  for (const e of active) {
    if (e.type !== 'dropShadow') continue;
    const { ix, iy } = offsetOf(e);
    shiftInto(alpha, m, w, h, ix, iy);
    if (e.spread > 0) dilatePlane(m, m, w, h, e.spread, scratch);
    blurPlane(m, w, h, Math.max(0, e.blur) / 2, tmp, scratch);
    paintPlane(group, m, e.color, e.opacity);
  }
  for (const e of active) {
    if (e.type !== 'outerGlow') continue;
    if (e.spread > 0) dilatePlane(alpha, m, w, h, e.spread, scratch);
    else m.set(alpha);
    blurPlane(m, w, h, Math.max(0, e.size) / 2, tmp, scratch);
    paintPlane(group, m, e.color, e.opacity);
  }
  for (const e of active) {
    if (e.type !== 'outline') continue;
    const { outer } = outlineWidths(e);
    if (outer <= 0) continue;
    dilatePlane(alpha, m, w, h, outer, scratch);
    paintPlane(group, m, e.color, e.opacity);
  }

  // Content restyling.
  for (const e of active) {
    if (e.type !== 'colorOverlay') continue;
    const B = BLEND_FUNCTIONS[e.blend];
    const k = e.opacity * e.color.a;
    const oc = [e.color.r / 255, e.color.g / 255, e.color.b / 255];
    for (let p = 0; p < content.length; p += 4) {
      const a = content[p + 3];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const cb = content[p + c] / a;
        content[p + c] = (cb + (B(cb, oc[c]) - cb) * k) * a;
      }
    }
  }
  for (const e of active) {
    if (e.type !== 'innerShadow') continue;
    const { ix, iy } = offsetOf(e);
    shiftInto(alpha, m, w, h, ix, iy);
    for (let i = 0; i < n; i++) m[i] = 1 - m[i];
    if (e.choke > 0) dilatePlane(m, m, w, h, e.choke, scratch);
    blurPlane(m, w, h, Math.max(0, e.blur) / 2, tmp, scratch);
    paintPlaneAtop(content, m, e.color, e.opacity);
  }
  overInto(group, content);

  // On top of the content.
  for (const e of active) {
    if (e.type !== 'outline') continue;
    const { inner } = outlineWidths(e);
    if (inner <= 0) continue;
    innerBandPlane(alpha, m, w, h, inner, scratch);
    paintPlane(group, m, e.color, e.opacity);
  }
  return group;
}

/**
 * Renders a layer's pixels with its effects into a premultiplied float
 * image of the same size (the exact path: export, thumbnails, the
 * reference compositor). Without active effects this is just the pixels.
 */
export function renderStyledLayer(src: Surface, effects: readonly LayerEffect[]): FloatImage {
  const active = activeOf(effects);
  if (!hasActiveEffects(active)) return surfaceToFloat(src);
  const out = createFloatImage(src.width, src.height);
  const area = styledBounds(src, active);
  if (!area) return out;
  const group = styleArea(src, active, area);
  const row = area.w * 4;
  for (let y = 0; y < area.h; y++) {
    out.data.set(group.subarray(y * row, (y + 1) * row), ((area.y + y) * src.width + area.x) * 4);
  }
  return out;
}

/** Premultiplied float → straight 8-bit, `rect` of an `area`-sized group into a `rect`-sized buffer. */
function writeStraight(group: Float32Array, area: Rect, rect: Rect, out: Uint8ClampedArray): void {
  for (let y = 0; y < rect.h; y++) {
    let si = ((rect.y - area.y + y) * area.w + (rect.x - area.x)) * 4;
    let di = y * rect.w * 4;
    for (let x = 0; x < rect.w; x++, si += 4, di += 4) {
      const a = group[si + 3];
      // Below half an 8-bit step the pixel rounds to fully transparent.
      if (a < 0.5 / 255) {
        out[di] = out[di + 1] = out[di + 2] = out[di + 3] = 0;
        continue;
      }
      const k = 255 / a;
      out[di] = group[si] * k;
      out[di + 1] = group[si + 1] * k;
      out[di + 2] = group[si + 2] * k;
      out[di + 3] = a * 255;
    }
  }
}

/** Straight RGBA8 pixels of a rect of a styled layer (row-major, `rect.w`·`rect.h`·4 bytes). */
export interface StyledPixels {
  rect: Rect;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * The whole styled layer as straight RGBA8, cropped to where it can have
 * pixels (`styledBounds`); null when the layer is empty. Equal to
 * `floatToSurface(renderStyledLayer(src, effects))` there. `out` is used
 * when it is large enough (the result is then a view of its start).
 */
export function renderStyledPixels(
  src: Surface,
  effects: readonly LayerEffect[],
  out?: Uint8ClampedArray<ArrayBuffer>,
): StyledPixels | null {
  const active = activeOf(effects);
  const rect = styledBounds(src, active);
  if (!rect) return null;
  const data = sized(out, rect);
  writeStraight(styleArea(src, active, rect), rect, rect, data);
  return { rect, data };
}

/**
 * `rect` (layer px, inside the layer) of the styled layer as straight RGBA8,
 * reading only the layer's pixels within the effects' reach of it — the
 * cheap way to follow a small change of the pixels. Equal to
 * `floatToSurface(renderStyledLayer(src, effects))` in `rect`, up to float
 * rounding (at most 1 of 255, rarely).
 */
export function renderStyledRect(
  src: Surface,
  effects: readonly LayerEffect[],
  rect: Rect,
  out?: Uint8ClampedArray<ArrayBuffer>,
): StyledPixels {
  const active = activeOf(effects);
  const area = clipRect(inflateRect(rect, effectsReach(active)), src.width, src.height) ?? rect;
  const data = sized(out, rect);
  writeStraight(styleArea(src, active, area), area, rect, data);
  return { rect, data };
}

/** A `rect`-sized byte view of `out` when it is large enough, else a new buffer. */
function sized(out: Uint8ClampedArray<ArrayBuffer> | undefined, rect: Rect): Uint8ClampedArray<ArrayBuffer> {
  const len = rect.w * rect.h * 4;
  return out && out.length >= len ? out.subarray(0, len) : new Uint8ClampedArray(len);
}
