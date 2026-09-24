/**
 * Spatial filters: the output depends on neighbouring pixels. Anything that
 * averages colours does so on premultiplied data so transparent pixels never
 * bleed black (or any other stored colour) into edges.
 *
 * Same `(src, params?, mask?, out?) => Pixels` shape as `adjust.ts`.
 */
import { blurPremultiplied, fromPremultiplied, gaussianBlur, toPremultiplied } from './blur-core';
import { colorOr, luma } from './colormath';
import { color, resolveParams, select, slider, toggle, type ParamRecord, type ParamSpec } from './params';
import { hash01, seedOf } from './prng';
import type { Mask, Pixels } from './types';
import { beginOutput, finishOutput, identityOutput, smoothstep } from './util';

type In<P> = Partial<P> | ParamRecord | null;

/** Bilinear sample of a single-channel float image with edge clamping. */
function sample1(buf: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const top = buf[y0 * w + x0] + (buf[y0 * w + x1] - buf[y0 * w + x0]) * fx;
  const bot = buf[y1 * w + x0] + (buf[y1 * w + x1] - buf[y1 * w + x0]) * fx;
  return top + (bot - top) * fy;
}

/** Bilinear sample of channel `c` and alpha of a premultiplied RGBA float image (edge clamped) into out[0], out[1]. */
function sampleChannelAlpha(buf: Float32Array, w: number, h: number, x: number, y: number, c: number, out: Float64Array): void {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  out[0] = buf[i00 + c] * w00 + buf[i10 + c] * w10 + buf[i01 + c] * w01 + buf[i11 + c] * w11;
  out[1] = buf[i00 + 3] * w00 + buf[i10 + 3] * w10 + buf[i01 + 3] * w01 + buf[i11 + 3] * w11;
}

// ---------------------------------------------------------------------------
// Blur

export interface BlurParams {
  /** Gaussian standard deviation in px (CSS `blur()` semantics), 0..64. */
  radius: number;
}

export const BLUR_PARAMS: readonly ParamSpec[] = [slider('radius', 'Radius', 0, 64, 0.5, 4, 'px')];

/** Gaussian blur (3 fractional box passes per axis) on premultiplied data; edges extend. */
export function blur(src: Pixels, params?: In<BlurParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { radius } = resolveParams<BlurParams>(BLUR_PARAMS, params);
  if (radius <= 0) return identityOutput(src, mask, out);
  const dst = beginOutput(src, mask, out);
  fromPremultiplied(blurPremultiplied(src, radius), dst.data);
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Sharpen (unsharp mask)

export interface SharpenParams {
  /** Strength 0..500 %. */
  amount: number;
  /** Blur radius (σ px) defining the detail scale, 0.1..20. */
  radius: number;
  /** Minimum luma difference (0..255) before a pixel is sharpened. */
  threshold: number;
}

export const SHARPEN_PARAMS: readonly ParamSpec[] = [
  slider('amount', 'Amount', 0, 500, 1, 100, '%'),
  slider('radius', 'Radius', 0.1, 20, 0.1, 1.5, 'px'),
  slider('threshold', 'Threshold', 0, 255, 1, 0),
];

/** Unsharp mask: v + amount·(v − blur(v)) where |Δluma| ≥ threshold. Alpha preserved. */
export function sharpen(src: Pixels, params?: In<SharpenParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount, radius, threshold } = resolveParams<SharpenParams>(SHARPEN_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const buf = blurPremultiplied(src, radius);
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  const k = amount / 100;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i];
    const g = s[i + 1];
    const b = s[i + 2];
    const a = s[i + 3];
    const ba = buf[i + 3];
    if (a === 0 || ba <= 1e-4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
      continue;
    }
    const inv = 255 / ba;
    const br = buf[i] * inv;
    const bg = buf[i + 1] * inv;
    const bb = buf[i + 2] * inv;
    const dy = luma(r, g, b) - luma(br, bg, bb);
    if ((dy < 0 ? -dy : dy) < threshold) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    } else {
      d[i] = r + (r - br) * k;
      d[i + 1] = g + (g - bg) * k;
      d[i + 2] = b + (b - bb) * k;
    }
    d[i + 3] = a;
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Pixelate

export interface PixelateParams {
  /** Block edge in px, 1..128. */
  size: number;
}

export const PIXELATE_PARAMS: readonly ParamSpec[] = [slider('size', 'Block size', 1, 128, 1, 8, 'px')];

/**
 * Replaces each block with its alpha-weighted average colour and mean alpha.
 * The block grid is centred on the image so symmetric art stays symmetric.
 */
export function pixelate(src: Pixels, params?: In<PixelateParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { size } = resolveParams<PixelateParams>(PIXELATE_PARAMS, params);
  if (size <= 1) return identityOutput(src, mask, out);
  const { width: w, height: h } = src;
  const s = src.data;
  // Compute into scratch: blocks read pixels other blocks may overwrite when out aliases src.
  const res = new Uint8ClampedArray(s.length);
  const remX = w % size;
  const remY = h % size;
  const ox = remX === 0 ? 0 : Math.floor((remX - size) / 2);
  const oy = remY === 0 ? 0 : Math.floor((remY - size) / 2);
  for (let by = oy; by < h; by += size) {
    const y0 = by < 0 ? 0 : by;
    const y1 = by + size > h ? h : by + size;
    for (let bx = ox; bx < w; bx += size) {
      const x0 = bx < 0 ? 0 : bx;
      const x1 = bx + size > w ? w : bx + size;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
          const a = s[i + 3];
          sr += s[i] * a;
          sg += s[i + 1] * a;
          sb += s[i + 2] * a;
          sa += a;
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      const r = sa > 0 ? sr / sa : 0;
      const g = sa > 0 ? sg / sa : 0;
      const b = sa > 0 ? sb / sa : 0;
      const a = sa / count;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
          res[i] = r;
          res[i + 1] = g;
          res[i + 2] = b;
          res[i + 3] = a;
        }
      }
    }
  }
  const dst = beginOutput(src, mask, out);
  dst.data.set(res);
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Noise

export interface NoiseParams {
  /** Strength 0..100 (standard deviation = amount / 2 levels). */
  amount: number;
  distribution: 'uniform' | 'gaussian';
  /** Same offset on R, G and B (luminance grain) instead of per channel. */
  monochrome: boolean;
  seed: number;
}

export const NOISE_PARAMS: readonly ParamSpec[] = [
  slider('amount', 'Amount', 0, 100, 1, 15, '%'),
  select(
    'distribution',
    'Distribution',
    [
      { value: 'uniform', label: 'Uniform' },
      { value: 'gaussian', label: 'Gaussian' },
    ],
    'gaussian',
  ),
  toggle('monochrome', 'Monochrome', true),
  slider('seed', 'Seed', 0, 9999, 1, 1),
];

/**
 * Adds seeded noise to R, G, B (alpha preserved). The value at each pixel is
 * a hash of (x, y, seed), so it is deterministic and independent of the mask
 * or processing order.
 */
export function noise(src: Pixels, params?: In<NoiseParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount, distribution, monochrome, seed } = resolveParams<NoiseParams>(NOISE_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const sigma = amount / 2;
  const gaussian = distribution === 'gaussian';
  const uniformScale = sigma * Math.sqrt(3) * 2; // uniform on ±σ√3 has std σ
  const sd = seedOf(seed);
  const w = src.width;
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  const sampleAt = (x: number, y: number, salt: number): number => {
    if (!gaussian) return (hash01(x, y, sd, salt) - 0.5) * uniformScale;
    // Box–Muller from two independent hashes.
    const u1 = hash01(x, y, sd, salt * 2 + 101) || 1e-12;
    const u2 = hash01(x, y, sd, salt * 2 + 102);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
  };
  for (let p = 0, i = 0; i < s.length; p++, i += 4) {
    const x = p % w;
    const y = (p - x) / w;
    if (monochrome) {
      const n = sampleAt(x, y, 0);
      d[i] = s[i] + n;
      d[i + 1] = s[i + 1] + n;
      d[i + 2] = s[i + 2] + n;
    } else {
      d[i] = s[i] + sampleAt(x, y, 1);
      d[i + 1] = s[i + 1] + sampleAt(x, y, 2);
      d[i + 2] = s[i + 2] + sampleAt(x, y, 3);
    }
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Vignette

export interface VignetteParams {
  /** Strength 0..100 %. */
  amount: number;
  /** Where the vignette reaches full strength, as % of the half-size (100 = edge midpoints). */
  radius: number;
  /** Width of the falloff as % of the radius. */
  softness: number;
  color: string;
}

export const VIGNETTE_PARAMS: readonly ParamSpec[] = [
  slider('amount', 'Amount', 0, 100, 1, 50, '%'),
  slider('radius', 'Radius', 0, 150, 1, 110, '%'),
  slider('softness', 'Softness', 0, 100, 1, 60, '%'),
  color('color', 'Colour', '#000000'),
];

/** Elliptical (canvas-shaped) vignette blending RGB towards `color`; alpha preserved. */
export function vignette(src: Pixels, params?: In<VignetteParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const p = resolveParams<VignetteParams>(VIGNETTE_PARAMS, params);
  const { width: w, height: h } = src;
  if (p.amount === 0 || w === 0 || h === 0) return identityOutput(src, mask, out);
  const [vr, vg, vb] = colorOr(p.color, '#000000');
  const strength = p.amount / 100;
  const hx = w / 2;
  const hy = h / 2;
  const r = p.radius / 100;
  const soft = p.softness / 100;
  const aa = 1.5 / Math.max(1, Math.min(hx, hy));
  const e0 = r * (1 - soft);
  const e1 = Math.max(r, e0 + aa);
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let y = 0, i = 0; y < h; y++) {
    const dy = (y + 0.5 - hy) / hy;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = (x + 0.5 - hx) / hx;
      const t = smoothstep(e0, e1, Math.sqrt(dx * dx + dy * dy)) * strength;
      d[i] = s[i] + (vr - s[i]) * t;
      d[i + 1] = s[i + 1] + (vg - s[i + 1]) * t;
      d[i + 2] = s[i + 2] + (vb - s[i + 2]) * t;
      d[i + 3] = s[i + 3];
    }
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Emboss

export interface EmbossParams {
  /** Light direction in degrees, counter-clockwise from east (135 = top-left). */
  angle: number;
  /** Relief sampling distance in px, 1..10. */
  height: number;
  /** Relief strength 0..500 %. */
  amount: number;
  /** Apply the relief as light/shade over the original colours instead of grey. */
  keepColor: boolean;
}

export const EMBOSS_PARAMS: readonly ParamSpec[] = [
  slider('angle', 'Angle', 0, 360, 1, 135, '°'),
  slider('height', 'Height', 1, 10, 0.5, 2, 'px'),
  slider('amount', 'Amount', 0, 500, 1, 100, '%'),
  toggle('keepColor', 'Keep colour', false),
];

/**
 * Directional relief of a height field made from luma and alpha (transparent
 * = 0, opaque black = ½, opaque white = 1), so an icon's silhouette embosses
 * as well as its interior detail. Alpha preserved.
 */
export function emboss(src: Pixels, params?: In<EmbossParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const p = resolveParams<EmbossParams>(EMBOSS_PARAMS, params);
  const { width: w, height: h } = src;
  const s = src.data;
  const n = w * h;
  const field = new Float32Array(n);
  for (let q = 0, i = 0; q < n; q++, i += 4) {
    field[q] = (s[i + 3] / 255) * (0.5 + luma(s[i], s[i + 1], s[i + 2]) / 510);
  }
  const rad = (p.angle * Math.PI) / 180;
  const lx = Math.cos(rad) * p.height;
  const ly = -Math.sin(rad) * p.height;
  const gain = (p.amount / 100) * 255;
  const dst = beginOutput(src, mask, out);
  const d = dst.data;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const e = sample1(field, w, h, x - lx, y - ly) - sample1(field, w, h, x + lx, y + ly);
      const shade = e * gain;
      if (p.keepColor) {
        d[i] = s[i] + shade;
        d[i + 1] = s[i + 1] + shade;
        d[i + 2] = s[i + 2] + shade;
      } else {
        const v = 128 + shade;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
      d[i + 3] = s[i + 3];
    }
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Sketch / edges

export interface SketchParams {
  /** Edge gain 0..400 %. */
  strength: number;
  /** Dark lines on white (pencil) instead of light lines on black. */
  invert: boolean;
  /** Lines take the pixel's own colour instead of grey. */
  colored: boolean;
}

export const SKETCH_PARAMS: readonly ParamSpec[] = [
  slider('strength', 'Strength', 0, 400, 1, 100, '%'),
  toggle('invert', 'Pencil (invert)', true),
  toggle('colored', 'Coloured lines', false),
];

function sobelMag(f: Float32Array, w: number, h: number, x: number, y: number): number {
  const xl = x > 0 ? x - 1 : 0;
  const xr = x < w - 1 ? x + 1 : w - 1;
  const yt = y > 0 ? y - 1 : 0;
  const yb = y < h - 1 ? y + 1 : h - 1;
  const tl = f[yt * w + xl];
  const t = f[yt * w + x];
  const tr = f[yt * w + xr];
  const l = f[y * w + xl];
  const r = f[y * w + xr];
  const bl = f[yb * w + xl];
  const b = f[yb * w + x];
  const br = f[yb * w + xr];
  const gx = tr + 2 * r + br - (tl + 2 * l + bl);
  const gy = bl + 2 * b + br - (tl + 2 * t + tr);
  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * Sobel edge magnitude of luma (composited over mid-grey) and of alpha, so
 * both interior detail and the silhouette draw lines. A unit step edge maps
 * to full strength at 100 %. Alpha preserved.
 */
export function sketch(src: Pixels, params?: In<SketchParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const p = resolveParams<SketchParams>(SKETCH_PARAMS, params);
  const { width: w, height: h } = src;
  const s = src.data;
  const n = w * h;
  const lum = new Float32Array(n);
  const alp = new Float32Array(n);
  for (let q = 0, i = 0; q < n; q++, i += 4) {
    const a = s[i + 3] / 255;
    lum[q] = (luma(s[i], s[i + 1], s[i + 2]) / 255) * a + 0.5 * (1 - a);
    alp[q] = a;
  }
  const gain = p.strength / 100 / 4;
  const dst = beginOutput(src, mask, out);
  const d = dst.data;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let m = Math.max(sobelMag(lum, w, h, x, y), sobelMag(alp, w, h, x, y)) * gain;
      if (m > 1) m = 1;
      if (p.colored) {
        const base = p.invert ? 255 : 0;
        d[i] = base + (s[i] - base) * m;
        d[i + 1] = base + (s[i + 1] - base) * m;
        d[i + 2] = base + (s[i + 2] - base) * m;
      } else {
        const v = p.invert ? 255 * (1 - m) : 255 * m;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
      d[i + 3] = s[i + 3];
    }
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Glow (bloom)

export interface GlowParams {
  /** Luma above which pixels start to glow, 0..255. */
  threshold: number;
  /** Bloom spread (σ px), 0..64. */
  radius: number;
  /** Bloom strength 0..300 %. */
  intensity: number;
}

export const GLOW_PARAMS: readonly ParamSpec[] = [
  slider('threshold', 'Threshold', 0, 255, 1, 160),
  slider('radius', 'Radius', 0, 64, 0.5, 12, 'px'),
  slider('intensity', 'Intensity', 0, 300, 1, 100, '%'),
];

/**
 * Bloom: bright-pass (linear ramp above `threshold`) → Gaussian blur →
 * screen-blend over the original, all premultiplied, so the glow can spill
 * past an icon's silhouette onto transparent pixels.
 */
export function glow(src: Pixels, params?: In<GlowParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const p = resolveParams<GlowParams>(GLOW_PARAMS, params);
  if (p.intensity === 0) return identityOutput(src, mask, out);
  const { width: w, height: h } = src;
  const s = src.data;
  const bright = new Float32Array(s.length);
  const span = 256 - p.threshold;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3];
    if (a === 0) continue;
    let k = (luma(s[i], s[i + 1], s[i + 2]) - p.threshold + 1) / span;
    if (k <= 0) continue;
    if (k > 1) k = 1;
    const pm = (a / 255) * k;
    bright[i] = s[i] * pm;
    bright[i + 1] = s[i + 1] * pm;
    bright[i + 2] = s[i + 2] * pm;
    bright[i + 3] = a * k;
  }
  gaussianBlur(bright, w, h, 4, p.radius);
  const gain = p.intensity / 100;
  const orig = toPremultiplied(src);
  const res = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) {
    let g = bright[i] * gain;
    if (g > 255) g = 255;
    const o = orig[i];
    res[i] = o + g - (o * g) / 255;
  }
  const dst = beginOutput(src, mask, out);
  fromPremultiplied(res, dst.data);
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Chromatic aberration

export interface ChromaticAberrationParams {
  /** Channel displacement at the corners, in px (red outwards, blue inwards). */
  amount: number;
}

export const CHROMATIC_ABERRATION_PARAMS: readonly ParamSpec[] = [slider('amount', 'Amount', 0, 32, 0.5, 4, 'px')];

/**
 * Radial lateral chromatic aberration: red is magnified and blue shrunk
 * about the centre, green stays put. Each channel carries its own alpha
 * (sampled premultiplied), so fringes appear past an icon's edge too.
 */
export function chromaticAberration(src: Pixels, params?: In<ChromaticAberrationParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount } = resolveParams<ChromaticAberrationParams>(CHROMATIC_ABERRATION_PARAMS, params);
  const { width: w, height: h } = src;
  if (amount === 0 || w === 0 || h === 0) return identityOutput(src, mask, out);
  const buf = toPremultiplied(src);
  const cx = w / 2;
  const cy = h / 2;
  const k = amount / Math.hypot(cx, cy);
  const sr = 1 - k; // red samples nearer the centre → magnified
  const sb = 1 + k; // blue samples further out → shrunk
  const tmp = new Float64Array(2);
  const res = new Float32Array(buf.length);
  for (let y = 0, i = 0; y < h; y++) {
    const vy = y + 0.5 - cy;
    for (let x = 0; x < w; x++, i += 4) {
      const vx = x + 0.5 - cx;
      sampleChannelAlpha(buf, w, h, cx + vx * sr - 0.5, cy + vy * sr - 0.5, 0, tmp);
      const pr = tmp[0];
      const ar = tmp[1];
      sampleChannelAlpha(buf, w, h, cx + vx * sb - 0.5, cy + vy * sb - 0.5, 2, tmp);
      const pb = tmp[0];
      const ab = tmp[1];
      const pg = buf[i + 1];
      const ag = buf[i + 3];
      const a = ar > ag ? (ar > ab ? ar : ab) : ag > ab ? ag : ab;
      res[i] = pr;
      res[i + 1] = pg;
      res[i + 2] = pb;
      res[i + 3] = a;
    }
  }
  const dst = beginOutput(src, mask, out);
  fromPremultiplied(res, dst.data);
  return finishOutput(src, dst, mask, out);
}
