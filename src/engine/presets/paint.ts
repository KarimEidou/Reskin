/**
 * Small, pure painting helpers the presets are built from: coverage planes
 * (Float32 0..1 per pixel), colour / gradient fills, blurs, morphology,
 * rings and straight-alpha compositing. Colours are RGBA8 tuples.
 */
import { hslToRgb, rgbToHsl, type Rgba } from '../filters/colormath';
import { createPixels, type Pixels } from '../filters/types';
import { gaussianBlurPlane } from '../raster/blur';
import { dilate, distanceTransform, erode } from '../raster/distance';

export type Plane = Float32Array;
export type { Rgba };

/** A per-pixel colour source: writes RGBA8 for pixel centre (x + ½, y + ½) into `out`. */
export type Shader = (x: number, y: number, out: Rgba) => void;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** HSL (h degrees, s/l 0..1) → RGBA8 tuple. */
export function hsl(h: number, s: number, l: number, a = 1): Rgba {
  const out = [0, 0, 0];
  hslToRgb(h, clamp01(s), clamp01(l), out);
  return [Math.round(out[0]! * 255), Math.round(out[1]! * 255), Math.round(out[2]! * 255), Math.round(clamp01(a) * 255)];
}

/** RGBA8 → [h, s, l]. */
export function toHsl(c: Rgba): [number, number, number] {
  const out = [0, 0, 0];
  rgbToHsl(c[0] / 255, c[1] / 255, c[2] / 255, out);
  return [out[0]!, out[1]!, out[2]!];
}

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return [r, g, b, a];
}

/** Parses `#rgb[a]` / `#rrggbb[aa]` (preset code only uses literal hex). */
export function hex(s: string): Rgba {
  const h = s.replace('#', '');
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const v = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), full.length >= 8 ? v(6) : 255];
}

export function withAlpha(c: Rgba, a: number): Rgba {
  return [c[0], c[1], c[2], Math.round(clamp01(a) * 255)];
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const u = clamp01(t);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
}

/** `#rrggbb[aa]` for effect colours and specs. */
export function toHexString(c: Rgba): string {
  const x = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${x(c[0])}${x(c[1])}${x(c[2])}${c[3] < 255 ? x(c[3]) : ''}`;
}

/** Engine `Rgba` ({r, g, b: 0..255, a: 0..1}) for layer effects. */
export function effectColor(c: Rgba): { r: number; g: number; b: number; a: number } {
  return { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: c[3] / 255 };
}

/** Relative luma 0..1 of an RGBA8 colour (sRGB weights, gamma-encoded). */
export function lumaOf(c: Rgba): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

export function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function alphaPlane(p: Pixels): Plane {
  const n = p.width * p.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = p.data[i * 4 + 3]! / 255;
  return out;
}

export function blurPlane(plane: Plane, size: number, sigma: number): Plane {
  const out = plane.slice();
  gaussianBlurPlane(out, size, size, sigma);
  return out;
}

/** Rounds a shape's corners: blur, then re-threshold around ½ with an anti-aliased edge. */
export function smoothShape(plane: Plane, size: number, radius: number): Plane {
  if (radius <= 0.3) return plane.slice();
  const b = blurPlane(plane, size, radius);
  // Edge width ≈ 1 px after the blur's slope (≈ 1 / (σ·√(2π))).
  const k = 0.5 / Math.max(1, radius * 1.2533);
  for (let i = 0; i < b.length; i++) b[i] = smoothstep(0.5 - k, 0.5 + k, b[i]!);
  return b;
}

export function dilatePlane(plane: Plane, size: number, radius: number): Plane {
  return dilate(plane, size, size, radius);
}

export function erodePlane(plane: Plane, size: number, radius: number): Plane {
  return erode(plane, size, size, radius);
}

/** Signed distance (px, negative inside) to the ½-coverage boundary. */
export function signedDistance(plane: Plane, size: number): Float32Array {
  const outside = distanceTransform(size, size, (i) => plane[i]! >= 0.5);
  const inside = distanceTransform(size, size, (i) => plane[i]! < 0.5);
  const out = new Float32Array(plane.length);
  for (let i = 0; i < out.length; i++) out[i] = plane[i]! >= 0.5 ? -(inside[i]! - 0.5) : outside[i]! - 0.5;
  return out;
}

/** Anti-aliased band of `width` px centred on the shape's outline. */
export function ringPlane(plane: Plane, size: number, width: number): Plane {
  const sd = signedDistance(plane, size);
  const hw = width / 2;
  const out = new Float32Array(plane.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(hw + 0.5 - Math.abs(sd[i]!));
  return out;
}

export function multiplyPlanes(a: Plane, b: Plane): Plane {
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i]! * b[i]!;
  return out;
}

export function scalePlane(a: Plane, k: number): Plane {
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(a[i]! * k);
  return out;
}

/** Bounding box of coverage above `threshold`, or null. */
export function planeBounds(plane: Plane, size: number, threshold = 0.02): { x: number; y: number; w: number; h: number } | null {
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (plane[y * size + x]! <= threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function planeArea(plane: Plane): number {
  let s = 0;
  for (let i = 0; i < plane.length; i++) s += plane[i]!;
  return s;
}

// ---------------------------------------------------------------------------
// Shaders & fills
// ---------------------------------------------------------------------------

export function solid(c: Rgba): Shader {
  return (_x, _y, out) => {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = c[3];
  };
}

export type Stop = readonly [offset: number, color: Rgba];

function sampleStops(stops: readonly Stop[], t: number, out: Rgba): void {
  const u = clamp01(t);
  let k = 0;
  while (k + 1 < stops.length && stops[k + 1]![0] <= u) k++;
  const a = stops[k]!;
  const b = stops[Math.min(stops.length - 1, k + 1)]!;
  const span = b[0] - a[0];
  const f = span > 0 ? clamp01((u - a[0]) / span) : 0;
  // Premultiplied interpolation so transparent stops do not grey the ramp.
  const aa = a[1][3] / 255;
  const ba = b[1][3] / 255;
  const al = aa + (ba - aa) * f;
  for (let c = 0; c < 3; c++) {
    const v = a[1][c]! * aa + (b[1][c]! * ba - a[1][c]! * aa) * f;
    out[c] = al > 1e-6 ? v / al : 0;
  }
  out[3] = al * 255;
}

/**
 * CSS-style linear gradient across a box (angle 0 = to top, 90 = to right,
 * 180 = to bottom).
 */
export function linear(box: { x: number; y: number; w: number; h: number }, angleDeg: number, stops: readonly Stop[]): Shader {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(box.w * dx) + Math.abs(box.h * dy) || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return (x, y, out) => sampleStops(stops, ((x + 0.5 - cx) * dx + (y + 0.5 - cy) * dy) / len + 0.5, out);
}

export function radial(cx: number, cy: number, r: number, stops: readonly Stop[]): Shader {
  return (x, y, out) => sampleStops(stops, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / (r || 1), out);
}

/** Paints `shader` with per-pixel coverage `plane` into a new straight-alpha image. */
export function fillPlane(plane: Plane, size: number, shader: Shader): Pixels {
  const out = createPixels(size, size);
  const d = out.data;
  const c: Rgba = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const cov = plane[i]!;
      if (cov <= 0) continue;
      shader(x, y, c);
      const o = i * 4;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3] * cov;
    }
  }
  return out;
}

/** A copy of `p` with alpha multiplied by `plane`. */
export function maskPixels(p: Pixels, plane: Plane): Pixels {
  const out = createPixels(p.width, p.height);
  out.data.set(p.data);
  const d = out.data;
  for (let i = 0; i < plane.length; i++) d[i * 4 + 3] = d[i * 4 + 3]! * plane[i]!;
  return out;
}

/** Source-over of `src` onto `dst` (both straight RGBA8, same size), in place. */
export function over(dst: Pixels, src: Pixels, opacity = 1): void {
  const d = dst.data;
  const s = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = (s[i + 3]! / 255) * opacity;
    if (sa <= 0) continue;
    const da = d[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    const k = da * (1 - sa);
    d[i] = (s[i]! * sa + d[i]! * k) / oa;
    d[i + 1] = (s[i + 1]! * sa + d[i + 1]! * k) / oa;
    d[i + 2] = (s[i + 2]! * sa + d[i + 2]! * k) / oa;
    d[i + 3] = oa * 255;
  }
}

/** Source-atop: paints `src` only where `dst` has alpha (alpha unchanged). */
export function atop(dst: Pixels, src: Pixels, opacity = 1): void {
  const d = dst.data;
  const s = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = (s[i + 3]! / 255) * opacity;
    if (sa <= 0 || d[i + 3] === 0) continue;
    d[i] = s[i]! * sa + d[i]! * (1 - sa);
    d[i + 1] = s[i + 1]! * sa + d[i + 1]! * (1 - sa);
    d[i + 2] = s[i + 2]! * sa + d[i + 2]! * (1 - sa);
  }
}

/** Composites a stack of images (bottom first) into one. */
export function flattenStack(size: number, layers: readonly { pixels: Pixels; opacity?: number }[]): Pixels {
  const out = createPixels(size, size);
  for (const l of layers) over(out, l.pixels, l.opacity ?? 1);
  return out;
}

/** Converts straight RGBA to 0..1 luma per pixel (alpha ignored). */
export function lumaPlane(p: Pixels): Plane {
  const n = p.width * p.height;
  const out = new Float32Array(n);
  const d = p.data;
  for (let i = 0; i < n; i++) out[i] = (0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255;
  return out;
}

/** Straight RGBA image with every pixel set to one colour and alpha from `plane`. */
export function tint(plane: Plane, size: number, c: Rgba): Pixels {
  return fillPlane(plane, size, solid(c));
}
