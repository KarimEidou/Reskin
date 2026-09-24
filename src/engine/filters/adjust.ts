/**
 * Point adjustments: each output pixel depends only on the same input pixel
 * (plus, for auto-contrast, the image histogram). Tone curves go through
 * 256-entry lookup tables; alpha is preserved unless the filter is about
 * alpha (opacity).
 *
 * Every function has the shape `(src, params?, mask?, out?) => Pixels`; see
 * `types.ts` for the purity / mask / out-buffer contract.
 */
import { colorOr, hslToRgb, luma, lumaInt, rgbToHsl } from './colormath';
import { gradientLutRgba8, resolveStops, type GradientStop } from './gradient';
import { color, gradient, resolveParams, slider, toggle, type ParamRecord, type ParamSpec } from './params';
import type { Mask, Pixels } from './types';
import { applyRgbLut, beginOutput, finishOutput, identityOutput } from './util';

type In<P> = Partial<P> | ParamRecord | null;

// ---------------------------------------------------------------------------
// Brightness / contrast

export interface BrightnessContrastParams {
  /** −100..100: shifts every channel by ±255 at the extremes. */
  brightness: number;
  /** −100..100: −100 flattens to mid-grey, +100 is nearly a threshold. */
  contrast: number;
}

export const BRIGHTNESS_CONTRAST_PARAMS: readonly ParamSpec[] = [
  slider('brightness', 'Brightness', -100, 100, 1, 0),
  slider('contrast', 'Contrast', -100, 100, 1, 0),
];

/** v' = F·(v − 128) + 128 + 2.55·brightness, F the classic contrast factor. */
export function brightnessContrast(src: Pixels, params?: In<BrightnessContrastParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { brightness, contrast } = resolveParams<BrightnessContrastParams>(BRIGHTNESS_CONTRAST_PARAMS, params);
  if (brightness === 0 && contrast === 0) return identityOutput(src, mask, out);
  const c = contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = brightness * 2.55;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = f * (v - 128) + 128 + b;
  return applyRgbLut(src, lut, mask, out);
}

// ---------------------------------------------------------------------------
// Hue / saturation / lightness

export interface HueSaturationParams {
  /** Hue rotation in degrees, −180..180. */
  hue: number;
  /** −100 (greyscale) .. 100 (doubled HSL saturation). */
  saturation: number;
  /** −100 (black) .. 100 (white). */
  lightness: number;
}

export const HUE_SATURATION_PARAMS: readonly ParamSpec[] = [
  slider('hue', 'Hue', -180, 180, 1, 0, '°'),
  slider('saturation', 'Saturation', -100, 100, 1, 0),
  slider('lightness', 'Lightness', -100, 100, 1, 0),
];

const hsl = new Float64Array(3);
const rgb = new Float64Array(3);

/** HSL-model hue rotation, multiplicative saturation and lightness towards black/white. */
export function hueSaturation(src: Pixels, params?: In<HueSaturationParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { hue, saturation, lightness } = resolveParams<HueSaturationParams>(HUE_SATURATION_PARAMS, params);
  if (hue === 0 && saturation === 0 && lightness === 0) return identityOutput(src, mask, out);
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  const satK = 1 + saturation / 100;
  const lt = lightness / 100;
  for (let i = 0; i < s.length; i += 4) {
    rgbToHsl(s[i] / 255, s[i + 1] / 255, s[i + 2] / 255, hsl);
    let sat = hsl[1] * satK;
    if (sat > 1) sat = 1;
    let l = hsl[2];
    l = lt >= 0 ? l + (1 - l) * lt : l * (1 + lt);
    hslToRgb(hsl[0] + hue, sat, l, rgb);
    d[i] = rgb[0] * 255;
    d[i + 1] = rgb[1] * 255;
    d[i + 2] = rgb[2] * 255;
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Invert

export type InvertParams = Record<string, never>;
export const INVERT_PARAMS: readonly ParamSpec[] = [];

const INVERT_LUT = (() => {
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) t[v] = 255 - v;
  return t;
})();

/** RGB → 255 − RGB; alpha preserved. */
export function invert(src: Pixels, _params?: In<InvertParams>, mask?: Mask | null, out?: Pixels): Pixels {
  return applyRgbLut(src, INVERT_LUT, mask, out);
}

// ---------------------------------------------------------------------------
// Grayscale

export interface AmountParams {
  /** 0..100 % blend between the original and the full effect. */
  amount: number;
}
export type GrayscaleParams = AmountParams;

export const GRAYSCALE_PARAMS: readonly ParamSpec[] = [slider('amount', 'Amount', 0, 100, 1, 100, '%')];

/** Rec.709 luma (0.2126 R + 0.7152 G + 0.0722 B), blended by `amount`. */
export function grayscale(src: Pixels, params?: In<GrayscaleParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount } = resolveParams<GrayscaleParams>(GRAYSCALE_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const t = amount / 100;
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i];
    const g = s[i + 1];
    const b = s[i + 2];
    const y = lumaInt(r, g, b);
    d[i] = r + (y - r) * t;
    d[i + 1] = g + (y - g) * t;
    d[i + 2] = b + (y - b) * t;
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Sepia

export type SepiaParams = AmountParams;
export const SEPIA_PARAMS: readonly ParamSpec[] = [slider('amount', 'Amount', 0, 100, 1, 100, '%')];

/** The classic sepia matrix, blended by `amount`. */
export function sepia(src: Pixels, params?: In<SepiaParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount } = resolveParams<SepiaParams>(SEPIA_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const t = amount / 100;
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i];
    const g = s[i + 1];
    const b = s[i + 2];
    let sr = 0.393 * r + 0.769 * g + 0.189 * b;
    let sg = 0.349 * r + 0.686 * g + 0.168 * b;
    let sb = 0.272 * r + 0.534 * g + 0.131 * b;
    if (sr > 255) sr = 255;
    if (sg > 255) sg = 255;
    if (sb > 255) sb = 255;
    d[i] = r + (sr - r) * t;
    d[i + 1] = g + (sg - g) * t;
    d[i + 2] = b + (sb - b) * t;
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Luminance-indexed colour maps (colorize, duotone, gradient map)

/** Maps each pixel through a 256-entry RGB table indexed by its luma, blended by t. */
function lumaMap(src: Pixels, lut: Uint8ClampedArray, t: number, mask: Mask | null | undefined, out: Pixels | undefined): Pixels {
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i];
    const g = s[i + 1];
    const b = s[i + 2];
    const o = lumaInt(r, g, b) * 4;
    d[i] = r + (lut[o] - r) * t;
    d[i + 1] = g + (lut[o + 1] - g) * t;
    d[i + 2] = b + (lut[o + 2] - b) * t;
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

export interface ColorizeParams {
  /** Tint hue in degrees 0..360. */
  hue: number;
  /** Tint saturation 0..100 %. */
  saturation: number;
  amount: number;
}

export const COLORIZE_PARAMS: readonly ParamSpec[] = [
  slider('hue', 'Hue', 0, 360, 1, 210, '°'),
  slider('saturation', 'Saturation', 0, 100, 1, 60, '%'),
  slider('amount', 'Amount', 0, 100, 1, 100, '%'),
];

/**
 * Tints to one hue/saturation while keeping each pixel's Rec.709 luma: the
 * tint colour is scaled towards black below its own luma and mixed towards
 * white above it, both of which preserve luma exactly.
 */
export function colorize(src: Pixels, params?: In<ColorizeParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { hue, saturation, amount } = resolveParams<ColorizeParams>(COLORIZE_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  hslToRgb(hue, saturation / 100, 0.5, rgb);
  const cr = rgb[0];
  const cg = rgb[1];
  const cb = rgb[2];
  const yc = luma(cr, cg, cb);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) {
    const y = v / 255;
    let r: number, g: number, b: number;
    if (y <= yc) {
      const k = yc > 0 ? y / yc : 0;
      r = cr * k;
      g = cg * k;
      b = cb * k;
    } else {
      const u = yc < 1 ? (y - yc) / (1 - yc) : 1;
      r = cr + (1 - cr) * u;
      g = cg + (1 - cg) * u;
      b = cb + (1 - cb) * u;
    }
    lut[v * 4] = r * 255;
    lut[v * 4 + 1] = g * 255;
    lut[v * 4 + 2] = b * 255;
    lut[v * 4 + 3] = 255;
  }
  return lumaMap(src, lut, amount / 100, mask, out);
}

export interface DuotoneParams {
  /** Colour for black (luma 0). */
  shadows: string;
  /** Colour for white (luma 255). */
  highlights: string;
  amount: number;
}

export const DUOTONE_PARAMS: readonly ParamSpec[] = [
  color('shadows', 'Shadows', '#1d1a4f'),
  color('highlights', 'Highlights', '#ffc857'),
  slider('amount', 'Amount', 0, 100, 1, 100, '%'),
];

/** Maps luma onto a two-colour ramp (shadows → highlights). */
export function duotone(src: Pixels, params?: In<DuotoneParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { shadows, highlights, amount } = resolveParams<DuotoneParams>(DUOTONE_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const a = colorOr(shadows, '#000000');
  const b = colorOr(highlights, '#ffffff');
  const stops = [
    { offset: 0, rgba: [a[0], a[1], a[2], 255] as [number, number, number, number] },
    { offset: 1, rgba: [b[0], b[1], b[2], 255] as [number, number, number, number] },
  ];
  return lumaMap(src, gradientLutRgba8(stops, 256), amount / 100, mask, out);
}

export interface GradientMapParams {
  /** Stops mapped by luma: offset 0 = black, 1 = white. Stop alpha is ignored. */
  stops: GradientStop[];
  reverse: boolean;
  amount: number;
}

export const GRADIENT_MAP_DEFAULT_STOPS: readonly GradientStop[] = [
  { offset: 0, color: '#140b34' },
  { offset: 0.35, color: '#84206b' },
  { offset: 0.7, color: '#f57a3a' },
  { offset: 1, color: '#fff3b0' },
];

export const GRADIENT_MAP_PARAMS: readonly ParamSpec[] = [
  gradient('stops', 'Gradient', GRADIENT_MAP_DEFAULT_STOPS),
  toggle('reverse', 'Reverse', false),
  slider('amount', 'Amount', 0, 100, 1, 100, '%'),
];

/** Maps luma through an N-stop gradient. */
export function gradientMap(src: Pixels, params?: In<GradientMapParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { stops, reverse, amount } = resolveParams<GradientMapParams>(GRADIENT_MAP_PARAMS, params);
  if (amount === 0) return identityOutput(src, mask, out);
  const resolved = resolveStops(stops, GRADIENT_MAP_DEFAULT_STOPS).map((s) => ({
    offset: reverse ? 1 - s.offset : s.offset,
    rgba: [s.rgba[0], s.rgba[1], s.rgba[2], 255] as [number, number, number, number],
  }));
  if (reverse) resolved.reverse();
  return lumaMap(src, gradientLutRgba8(resolved, 256), amount / 100, mask, out);
}

// ---------------------------------------------------------------------------
// Posterize / threshold

export interface PosterizeParams {
  /** Levels per channel, 2..32. */
  levels: number;
}

export const POSTERIZE_PARAMS: readonly ParamSpec[] = [slider('levels', 'Levels', 2, 32, 1, 4)];

/** Quantises each channel to `levels` evenly spaced values (0 and 255 included). */
export function posterize(src: Pixels, params?: In<PosterizeParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { levels } = resolveParams<PosterizeParams>(POSTERIZE_PARAMS, params);
  const n = levels - 1;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (Math.round((v / 255) * n) * 255) / n;
  return applyRgbLut(src, lut, mask, out);
}

export interface ThresholdParams {
  /** Luma at or above this becomes white, below becomes black. */
  level: number;
}

export const THRESHOLD_PARAMS: readonly ParamSpec[] = [slider('level', 'Level', 0, 255, 1, 128)];

/** Black/white by integer Rec.709 luma: luma ≥ level → white. */
export function threshold(src: Pixels, params?: In<ThresholdParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { level } = resolveParams<ThresholdParams>(THRESHOLD_PARAMS, params);
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const v = lumaInt(s[i], s[i + 1], s[i + 2]) >= level ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = s[i + 3];
  }
  return finishOutput(src, dst, mask, out);
}

// ---------------------------------------------------------------------------
// Levels / auto-contrast

export interface LevelsParams {
  inBlack: number;
  inWhite: number;
  /** Midtone gamma, 0.1..5 (>1 brightens). */
  gamma: number;
  outBlack: number;
  outWhite: number;
}

export const LEVELS_PARAMS: readonly ParamSpec[] = [
  slider('inBlack', 'Input black', 0, 254, 1, 0),
  slider('inWhite', 'Input white', 1, 255, 1, 255),
  slider('gamma', 'Gamma', 0.1, 5, 0.01, 1),
  slider('outBlack', 'Output black', 0, 255, 1, 0),
  slider('outWhite', 'Output white', 0, 255, 1, 255),
];

/** Builds the levels transfer curve (exported for the UI's curve preview). */
export function levelsLut(p: LevelsParams): Uint8ClampedArray {
  const inBlack = Math.min(p.inBlack, 254);
  const inWhite = Math.max(p.inWhite, inBlack + 1);
  const invGamma = 1 / p.gamma;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let t = (v - inBlack) / (inWhite - inBlack);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    lut[v] = p.outBlack + Math.pow(t, invGamma) * (p.outWhite - p.outBlack);
  }
  return lut;
}

/** Input range → gamma → output range, on R, G and B. */
export function levels(src: Pixels, params?: In<LevelsParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const p = resolveParams<LevelsParams>(LEVELS_PARAMS, params);
  if (p.inBlack === 0 && p.inWhite === 255 && p.gamma === 1 && p.outBlack === 0 && p.outWhite === 255) {
    return identityOutput(src, mask, out);
  }
  return applyRgbLut(src, levelsLut(p), mask, out);
}

export interface AutoContrastParams {
  /** Percentage of samples clipped at each end, 0..10. */
  clip: number;
}

export const AUTO_CONTRAST_PARAMS: readonly ParamSpec[] = [slider('clip', 'Clip', 0, 10, 0.1, 0.5, '%')];

/**
 * Stretches the combined R/G/B histogram of the visible (and, with a mask,
 * selected) pixels to the full range. All channels share one mapping, so
 * hues do not shift.
 */
export function autoContrast(src: Pixels, params?: In<AutoContrastParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { clip } = resolveParams<AutoContrastParams>(AUTO_CONTRAST_PARAMS, params);
  const s = src.data;
  const hist = new Float64Array(256);
  let total = 0;
  for (let p = 0, i = 0; i < s.length; p++, i += 4) {
    if (s[i + 3] === 0 || (mask && mask[p] === 0)) continue;
    hist[s[i]]++;
    hist[s[i + 1]]++;
    hist[s[i + 2]]++;
    total += 3;
  }
  if (total === 0) return identityOutput(src, mask, out);
  const cut = (total * clip) / 100;
  let lo = 0;
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > cut) {
      lo = v;
      break;
    }
  }
  let hi = 255;
  for (let v = 255, acc = 0; v >= 0; v--) {
    acc += hist[v];
    if (acc > cut) {
      hi = v;
      break;
    }
  }
  if (hi <= lo || (lo === 0 && hi === 255)) return identityOutput(src, mask, out);
  const lut = new Uint8ClampedArray(256);
  const k = 255 / (hi - lo);
  for (let v = 0; v < 256; v++) lut[v] = (v - lo) * k;
  return applyRgbLut(src, lut, mask, out);
}

// ---------------------------------------------------------------------------
// Opacity

export interface OpacityParams {
  /** Alpha scale 0..100 %. */
  amount: number;
}

export const OPACITY_PARAMS: readonly ParamSpec[] = [slider('amount', 'Opacity', 0, 100, 1, 100, '%')];

/** Multiplies alpha by amount / 100. */
export function opacity(src: Pixels, params?: In<OpacityParams>, mask?: Mask | null, out?: Pixels): Pixels {
  const { amount } = resolveParams<OpacityParams>(OPACITY_PARAMS, params);
  if (amount === 100) return identityOutput(src, mask, out);
  const k = amount / 100;
  const dst = beginOutput(src, mask, out);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = s[i];
    d[i + 1] = s[i + 1];
    d[i + 2] = s[i + 2];
    d[i + 3] = s[i + 3] * k;
  }
  return finishOutput(src, dst, mask, out);
}
