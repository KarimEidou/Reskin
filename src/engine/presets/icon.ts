/**
 * Icon analysis for the style presets: what is the icon's "glyph" (the
 * shape a designer would restyle) and what is its accent colour?
 *
 * - Cut-out icons (a shape on transparency) → the glyph is the silhouette.
 * - Plate icons (a symmetric tile or disc, flat or gradient filled, with a
 *   mark on it — a letter, a line drawing) → the glyph is the mark: pixels
 *   that differ from a smooth model of the plate colour, un-mixed so its
 *   anti-aliased edge survives, and coloured without plate fringes.
 * - Busy full-bleed images (photos) → a two-tone stencil (Otsu threshold,
 *   the minority tone is the figure).
 * - Cut-outs made of flat colour regions (a multi-colour logo) → the
 *   silhouette with thin gaps along the colour boundaries, so a one-colour
 *   rendering still shows the logo's structure.
 *
 * Everything runs at a fixed working resolution, so a thumbnail and a
 * full-size render of the same preset make the same decisions.
 */
import { dominantColors } from '../color/median-cut';
import { gaussianBlur } from '../filters/blur-core';
import { createPixels, type Pixels } from '../filters/types';
import { fitAndCenter } from '../helpers/trim';
import { alphaPlane, clamp01, dilatePlane, erodePlane, hsl, lumaPlane, maskPixels, multiplyPlanes, planeArea, planeBounds, smoothstep, toHsl, type Plane, type Rgba } from './paint';

/** Analysis resolution (px). */
export const ANALYSIS_SIZE = 256;

export type GlyphMode = 'silhouette' | 'segments' | 'plate' | 'stencil' | 'empty';

export interface IconAnalysis {
  size: number;
  /** The icon trimmed to its visible content and fitted to size × size. */
  fitted: Pixels;
  /** Glyph coverage (0..1) at analysis resolution. */
  glyph: Plane;
  /** The icon's own colours where the glyph is (alpha = glyph coverage). */
  glyphPixels: Pixels;
  mode: GlyphMode;
  /** The most characteristic vivid colour of the icon. */
  accent: Rgba;
  /** Hue of `accent`, degrees. */
  hue: number;
  /** True when the icon has (almost) no saturated colour. */
  achromatic: boolean;
  /** Mean luma (0..1) of the glyph's own colours. */
  glyphLuma: number;
}

/** Hue used when an icon has no colour of its own (Reskin violet-blue). */
export const FALLBACK_HUE = 238;

function rgbDistance(a: readonly number[], b: readonly number[]): number {
  const dr = a[0]! - b[0]!;
  const dg = a[1]! - b[1]!;
  const db = a[2]! - b[2]!;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/**
 * True when every row and column crosses the shape in one run (gaps under
 * 2 % of the size are ignored): plates are rounded rectangles, circles,
 * squircles — not flames or letters.
 */
function orthogonallyConvex(alpha: Plane, size: number): boolean {
  const gapMax = Math.max(1, Math.round(size * 0.02));
  const check = (at: (i: number, j: number) => number) => {
    for (let i = 0; i < size; i++) {
      let runs = 0;
      let gap = 0;
      let inside = false;
      for (let j = 0; j < size; j++) {
        const on = at(i, j) >= 0.5;
        if (on) {
          if (!inside && (runs === 0 || gap > gapMax)) runs++;
          inside = true;
          gap = 0;
        } else {
          if (inside) gap = 0;
          inside = false;
          gap++;
        }
        if (runs > 1) return false;
      }
    }
    return true;
  };
  return check((y, x) => alpha[y * size + x]!) && check((x, y) => alpha[y * size + x]!);
}

function colorDistance(d: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const dr = d[i]! - r;
  const dg = d[i + 1]! - g;
  const db = d[i + 2]! - b;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/** Tolerance (0..255 RMS) for "same colour as the plate". */
const PLATE_TOLERANCE = 34;

/**
 * IoU of the opaque shape with its mirror images (left-right and
 * top-bottom): plates are symmetric tiles, discs and squircles; a folder
 * with its tab or a speech bubble is not.
 */
function symmetry(alpha: Plane, size: number): number {
  // Mirror about the solid shape's own box (a baked-in drop shadow shifts
  // the image's trimmed bounds).
  const b = planeBounds(alpha, size, 0.5);
  if (!b) return 0;
  const x1 = b.x + b.w - 1;
  const y1 = b.y + b.h - 1;
  const on = (x: number, y: number) => alpha[y * size + x]! >= 0.5;
  let inter = 0;
  let union = 0;
  for (let y = b.y; y <= y1; y++) {
    for (let x = b.x; x <= x1; x++) {
      const a = on(x, y);
      const h = on(b.x + x1 - x, y);
      const v = on(x, b.y + y1 - y);
      if (a && h && v) inter++;
      if (a || h || v) union++;
    }
  }
  return union ? inter / union : 0;
}

/**
 * The mark on a plate: pixels that differ from a smooth model of the plate
 * colour. The model is a wide coverage-weighted blur of the plate that
 * iteratively leaves out pixels not matching it, so flat, linear and radial
 * fills are all followed while a letter or a line drawing is excluded.
 */
function plateGlyph(fitted: Pixels, alpha: Plane, size: number): Plane | null {
  const inset = Math.max(2, Math.round(size * 0.045));
  const interior = erodePlane(alpha, size, inset * 0.6);
  const n = size * size;
  const d = fitted.data;
  const sigma = size * 0.06;
  const est = new Float32Array(n * 4);
  const dist = new Float32Array(n);
  let weight = new Float32Array(n);
  for (let i = 0; i < n; i++) weight[i] = interior[i]! > 0.5 ? 1 : 0;
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < n; i++) {
      const w = weight[i]!;
      est[i * 4] = d[i * 4]! * w;
      est[i * 4 + 1] = d[i * 4 + 1]! * w;
      est[i * 4 + 2] = d[i * 4 + 2]! * w;
      est[i * 4 + 3] = w;
    }
    gaussianBlur(est, size, size, 4, sigma);
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = est[i * 4 + 3]!;
      if (w < 1e-3 || alpha[i]! < 0.5) {
        dist[i] = 0;
        continue;
      }
      const v = colorDistance(d, i * 4, est[i * 4]! / w, est[i * 4 + 1]! / w, est[i * 4 + 2]! / w);
      dist[i] = v;
      next[i] = interior[i]! > 0.5 ? 1 - smoothstep(PLATE_TOLERANCE * 0.6, PLATE_TOLERANCE, v) : 0;
    }
    weight = next;
  }
  // The model must be smooth: a steep change inside it means differently
  // coloured regions meet (a multi-colour logo), not a gradient plate.
  const steps: number[] = [];
  const k = Math.max(2, Math.round(size / 128));
  for (let y = k; y < size - k; y += 2) {
    for (let x = k; x < size - k; x += 2) {
      const i = y * size + x;
      if (interior[i]! < 1) continue;
      const at = (j: number) => {
        const w = est[j * 4 + 3]! || 1;
        return [est[j * 4]! / w, est[j * 4 + 1]! / w, est[j * 4 + 2]! / w];
      };
      steps.push(Math.max(rgbDistance(at(i - k), at(i + k)), rgbDistance(at(i - k * size), at(i + k * size))) / (2 * k));
    }
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => a - b);
  const rough = steps[Math.floor(steps.length * 0.95)]! * (size / 256);
  if (rough > 1.9) return null;

  let opaque = 0;
  let matching = 0;
  const strong: number[] = [];
  for (let i = 0; i < n; i++) {
    if (alpha[i]! < 0.5) continue;
    opaque++;
    if (dist[i]! <= PLATE_TOLERANCE) matching++;
    else if (interior[i]! > 0.99) strong.push(dist[i]!);
  }
  if (opaque === 0) return null;
  // Coverage from un-mixing: a pixel halfway between plate and mark colour
  // is half covered, so the mark keeps its anti-aliased edge. `full` is the
  // distance of the mark's solid pixels.
  strong.sort((a, b) => a - b);
  const full = Math.max(PLATE_TOLERANCE * 1.6, strong.length ? strong[Math.floor(strong.length * 0.7)]! : PLATE_TOLERANCE * 2);
  const lo = PLATE_TOLERANCE * 0.5;
  const glyph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (dist[i]! <= lo) continue;
    glyph[i] = clamp01((dist[i]! - lo) / (full - lo)) * interior[i]!;
  }
  const share = planeArea(glyph) / opaque;
  // A plate is mostly plate colour, and its mark is neither a speck nor everything.
  if (matching / opaque < 0.35 || share < 0.02 || share > 0.62) return null;
  return glyph;
}

/**
 * Colours for a mark cut from a plate: edge pixels are a blend of mark and
 * plate, so each pixel takes the colour of the solid mark nearby (a
 * coverage-weighted blur), keeping edges free of plate-coloured fringes.
 */
function bleedColors(fitted: Pixels, glyph: Plane, size: number): Pixels {
  const n = size * size;
  const acc = new Float32Array(n * 4);
  const d = fitted.data;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(glyph[i]!, 4);
    acc[i * 4] = d[i * 4]! * w;
    acc[i * 4 + 1] = d[i * 4 + 1]! * w;
    acc[i * 4 + 2] = d[i * 4 + 2]! * w;
    acc[i * 4 + 3] = w;
  }
  gaussianBlur(acc, size, size, 4, Math.max(1, size * 0.008));
  const out = createPixels(size, size);
  for (let i = 0; i < n; i++) {
    const w = acc[i * 4 + 3]!;
    const g = glyph[i]!;
    if (g <= 0) continue;
    if (w > 1e-4 && g < 0.98) {
      out.data[i * 4] = acc[i * 4]! / w;
      out.data[i * 4 + 1] = acc[i * 4 + 1]! / w;
      out.data[i * 4 + 2] = acc[i * 4 + 2]! / w;
    } else {
      out.data[i * 4] = d[i * 4]!;
      out.data[i * 4 + 1] = d[i * 4 + 1]!;
      out.data[i * 4 + 2] = d[i * 4 + 2]!;
    }
    out.data[i * 4 + 3] = Math.round(g * 255);
  }
  return out;
}

/** Otsu threshold (0..1) of luma over opaque pixels. */
function otsu(luma: Plane, alpha: Plane): number {
  const hist = new Float64Array(64);
  let total = 0;
  for (let i = 0; i < luma.length; i++) {
    const a = alpha[i]!;
    if (a < 0.5) continue;
    hist[Math.min(63, Math.floor(luma[i]! * 64))]! += 1;
    total++;
  }
  if (total === 0) return 0.5;
  let sum = 0;
  for (let k = 0; k < 64; k++) sum += k * hist[k]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestK = 32;
  for (let k = 0; k < 64; k++) {
    wB += hist[k]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += k * hist[k]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestK = k;
    }
  }
  return (bestK + 1) / 64;
}

function stencilGlyph(fitted: Pixels, alpha: Plane): Plane {
  const luma = lumaPlane(fitted);
  const t = otsu(luma, alpha);
  let below = 0;
  let count = 0;
  for (let i = 0; i < luma.length; i++) {
    if (alpha[i]! < 0.5) continue;
    count++;
    if (luma[i]! < t) below++;
  }
  const darkIsFigure = below <= count / 2;
  const out = new Float32Array(luma.length);
  for (let i = 0; i < out.length; i++) {
    const s = smoothstep(t - 0.035, t + 0.035, luma[i]!);
    out[i] = (darkIsFigure ? 1 - s : s) * alpha[i]!;
  }
  return out;
}

/**
 * The silhouette cut along strong internal colour boundaries, or null when
 * there are none (single-colour or smoothly shaded icons) or too many
 * (detailed artwork, where cut lines would turn into noise).
 */
function segmentGlyph(fitted: Pixels, alpha: Plane, size: number): Plane | null {
  const d = fitted.data;
  const edge = new Float32Array(size * size);
  const pm = (i: number, c: number) => d[i * 4 + c]! * (d[i * 4 + 3]! / 255);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const i = y * size + x;
      if (alpha[i]! < 0.5) continue;
      let m = 0;
      for (const j of [i + 1, i + size]) {
        if (alpha[j]! < 0.5) continue;
        for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(pm(i, c) - pm(j, c)));
      }
      edge[i] = smoothstep(28, 60, m);
    }
  }
  const gapW = size * 0.012;
  const interior = erodePlane(alpha, size, gapW * 2.5);
  for (let i = 0; i < edge.length; i++) edge[i] = edge[i]! * interior[i]!;
  const gaps = dilatePlane(edge, size, gapW);
  const area = planeArea(alpha);
  const cut = planeArea(multiplyPlanes(gaps, alpha));
  if (cut < area * 0.015 || cut > area * 0.2) return null;
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = alpha[i]! * (1 - gaps[i]!);
  return out;
}

function pickAccent(fitted: Pixels, size: number): { accent: Rgba; achromatic: boolean } {
  const colors = dominantColors(fitted.data, size, size, { count: 6, alphaThreshold: 160 });
  let best: Rgba | null = null;
  let bestScore = 0;
  for (const dc of colors) {
    const { r, g, b } = dc.color;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    const val = max / 255;
    const score = Math.pow(dc.share, 0.6) * sat * (0.35 + val) * (val < 0.18 ? 0.2 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = [r, g, b, 255];
    }
  }
  if (!best || bestScore < 0.05) return { accent: hsl(FALLBACK_HUE, 0.8, 0.6), achromatic: true };
  return { accent: best, achromatic: false };
}

/** Analyses an icon (any size, straight RGBA). */
export function analyzeIcon(icon: Pixels, size = ANALYSIS_SIZE): IconAnalysis {
  const fitted = fitAndCenter(icon, size, { paddingRatio: 0, trim: true });
  const alpha = alphaPlane(fitted);
  const { accent, achromatic } = pickAccent(fitted, size);
  const hue = toHsl(accent)[0];
  const bounds = planeBounds(alpha, size, 0.5);
  if (!bounds) {
    return {
      size,
      fitted,
      glyph: new Float32Array(size * size),
      glyphPixels: fitted,
      mode: 'empty',
      accent,
      hue,
      achromatic,
      glyphLuma: 0.5,
    };
  }
  const fill = planeArea(alpha) / (bounds.w * bounds.h);
  let glyph: Plane | null = null;
  let mode: GlyphMode = 'silhouette';
  if (fill >= 0.7 && orthogonallyConvex(alpha, size) && symmetry(alpha, size) >= 0.9) {
    glyph = plateGlyph(fitted, alpha, size);
    if (glyph) mode = 'plate';
  }
  if (!glyph) {
    // Flat colour regions: keep the silhouette, cut along their boundaries.
    glyph = segmentGlyph(fitted, alpha, size);
    if (glyph) mode = 'segments';
  }
  if (!glyph && fill >= 0.86) {
    // A busy full-bleed picture: a two-tone stencil of it.
    glyph = stencilGlyph(fitted, alpha);
    mode = 'stencil';
    if (planeArea(glyph) < planeArea(alpha) * 0.04) {
      glyph = null;
      mode = 'silhouette';
    }
  }
  glyph ??= alpha;
  const glyphPixels = mode === 'plate' ? bleedColors(fitted, glyph, size) : maskPixels(fitted, glyph);
  let lw = 0;
  let ls = 0;
  const d = fitted.data;
  for (let i = 0; i < glyph.length; i++) {
    const g = glyph[i]!;
    if (g <= 0.05) continue;
    lw += g;
    ls += g * ((0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255);
  }
  return { size, fitted, glyph, glyphPixels, mode, accent, hue, achromatic, glyphLuma: lw > 0 ? ls / lw : 0.5 };
}

/** The glyph (own colours) trimmed and fitted into size × size with `padding` (fraction per side). */
export function placeGlyph(a: IconAnalysis, size: number, padding: number): Pixels {
  return fitAndCenter(a.glyphPixels, size, { paddingRatio: padding, trim: true, threshold: 8 });
}

/** The whole icon fitted into size × size with `padding`. */
export function placeIcon(a: IconAnalysis, size: number, padding: number): Pixels {
  return fitAndCenter(a.fitted, size, { paddingRatio: padding, trim: true });
}
