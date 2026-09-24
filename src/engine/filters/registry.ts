/**
 * The filter registry: one entry per adjustment describing its UI (label,
 * category, parameter controls), its defaults and its implementation.
 * The editor builds the Adjustments panel from `FILTER_LIST` /
 * `FILTER_CATEGORIES` and runs filters through `applyFilter` (or the worker
 * client) by id.
 */
import {
  autoContrast,
  AUTO_CONTRAST_PARAMS,
  brightnessContrast,
  BRIGHTNESS_CONTRAST_PARAMS,
  colorize,
  COLORIZE_PARAMS,
  duotone,
  DUOTONE_PARAMS,
  gradientMap,
  GRADIENT_MAP_PARAMS,
  grayscale,
  GRAYSCALE_PARAMS,
  hueSaturation,
  HUE_SATURATION_PARAMS,
  invert,
  INVERT_PARAMS,
  levels,
  LEVELS_PARAMS,
  opacity,
  OPACITY_PARAMS,
  posterize,
  POSTERIZE_PARAMS,
  sepia,
  SEPIA_PARAMS,
  threshold,
  THRESHOLD_PARAMS,
  type AutoContrastParams,
  type BrightnessContrastParams,
  type ColorizeParams,
  type DuotoneParams,
  type GradientMapParams,
  type GrayscaleParams,
  type HueSaturationParams,
  type InvertParams,
  type LevelsParams,
  type OpacityParams,
  type PosterizeParams,
  type SepiaParams,
  type ThresholdParams,
} from './adjust';
import { defaultsOf, resolveParams, type ParamRecord, type ParamSpec } from './params';
import {
  blur,
  BLUR_PARAMS,
  chromaticAberration,
  CHROMATIC_ABERRATION_PARAMS,
  emboss,
  EMBOSS_PARAMS,
  glow,
  GLOW_PARAMS,
  noise,
  NOISE_PARAMS,
  pixelate,
  PIXELATE_PARAMS,
  sharpen,
  SHARPEN_PARAMS,
  sketch,
  SKETCH_PARAMS,
  vignette,
  VIGNETTE_PARAMS,
  type BlurParams,
  type ChromaticAberrationParams,
  type EmbossParams,
  type GlowParams,
  type NoiseParams,
  type PixelateParams,
  type SharpenParams,
  type SketchParams,
  type VignetteParams,
} from './spatial';
import type { Mask, Pixels } from './types';
import { deepFreeze } from './util';

/** Params type of every filter, by id. */
export interface FilterParamsMap {
  brightnessContrast: BrightnessContrastParams;
  levels: LevelsParams;
  autoContrast: AutoContrastParams;
  posterize: PosterizeParams;
  threshold: ThresholdParams;
  opacity: OpacityParams;
  hueSaturation: HueSaturationParams;
  invert: InvertParams;
  grayscale: GrayscaleParams;
  sepia: SepiaParams;
  colorize: ColorizeParams;
  duotone: DuotoneParams;
  gradientMap: GradientMapParams;
  blur: BlurParams;
  sharpen: SharpenParams;
  pixelate: PixelateParams;
  noise: NoiseParams;
  vignette: VignetteParams;
  emboss: EmbossParams;
  sketch: SketchParams;
  glow: GlowParams;
  chromaticAberration: ChromaticAberrationParams;
}

export type FilterId = keyof FilterParamsMap;

export type FilterCategory = 'light' | 'color' | 'detail' | 'stylize';

export const FILTER_CATEGORIES: readonly { id: FilterCategory; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'color', label: 'Colour' },
  { id: 'detail', label: 'Blur & detail' },
  { id: 'stylize', label: 'Stylize' },
];

/** A filter implementation: pure, optional selection mask, optional out buffer. */
export type FilterFn<P> = (src: Pixels, params?: Partial<P> | ParamRecord | null, mask?: Mask | null, out?: Pixels) => Pixels;

export interface FilterDef<P extends object = object> {
  id: FilterId;
  label: string;
  category: FilterCategory;
  /** One-line help text for tooltips. */
  description: string;
  /**
   * True when an output pixel depends on its neighbours (blur, edges…). The
   * UI should always preview these on the whole layer, preferably via the
   * worker; point filters (false) are cheap enough for the main thread.
   */
  spatial: boolean;
  /** Controls, in display order. */
  params: readonly ParamSpec[];
  /** Default value of every param (identity for tone/colour sliders where one exists). */
  defaults: Readonly<P>;
  apply: FilterFn<P>;
}

function def<P extends object>(
  id: FilterId,
  label: string,
  category: FilterCategory,
  spatial: boolean,
  description: string,
  params: readonly ParamSpec[],
  apply: FilterFn<P>,
): FilterDef<P> {
  return deepFreeze({ id, label, category, description, spatial, params, defaults: defaultsOf<P>(params), apply });
}

/** Every filter by id. */
export const FILTERS: { readonly [K in FilterId]: FilterDef<FilterParamsMap[K]> } = {
  brightnessContrast: def('brightnessContrast', 'Brightness / Contrast', 'light', false, 'Shift brightness and stretch or flatten contrast.', BRIGHTNESS_CONTRAST_PARAMS, brightnessContrast),
  levels: def('levels', 'Levels', 'light', false, 'Remap the input range with a midtone gamma.', LEVELS_PARAMS, levels),
  autoContrast: def('autoContrast', 'Auto contrast', 'light', false, 'Stretch the tonal range to full black and white.', AUTO_CONTRAST_PARAMS, autoContrast),
  posterize: def('posterize', 'Posterize', 'light', false, 'Reduce each channel to a few flat levels.', POSTERIZE_PARAMS, posterize),
  threshold: def('threshold', 'Threshold', 'light', false, 'Pure black and white split at a luminance level.', THRESHOLD_PARAMS, threshold),
  opacity: def('opacity', 'Opacity', 'light', false, 'Scale transparency.', OPACITY_PARAMS, opacity),
  hueSaturation: def('hueSaturation', 'Hue / Saturation', 'color', false, 'Rotate hues and adjust saturation and lightness.', HUE_SATURATION_PARAMS, hueSaturation),
  invert: def('invert', 'Invert', 'color', false, 'Negative of the colours; transparency is kept.', INVERT_PARAMS, invert),
  grayscale: def('grayscale', 'Grayscale', 'color', false, 'Luminance-accurate black and white.', GRAYSCALE_PARAMS, grayscale),
  sepia: def('sepia', 'Sepia', 'color', false, 'Warm antique tone.', SEPIA_PARAMS, sepia),
  colorize: def('colorize', 'Colorize', 'color', false, 'Tint to a single hue while keeping brightness.', COLORIZE_PARAMS, colorize),
  duotone: def('duotone', 'Duotone', 'color', false, 'Map shadows and highlights to two colours.', DUOTONE_PARAMS, duotone),
  gradientMap: def('gradientMap', 'Gradient map', 'color', false, 'Map brightness onto a multi-stop gradient.', GRADIENT_MAP_PARAMS, gradientMap),
  blur: def('blur', 'Blur', 'detail', true, 'Smooth Gaussian blur.', BLUR_PARAMS, blur),
  sharpen: def('sharpen', 'Sharpen', 'detail', true, 'Unsharp mask for crisper detail.', SHARPEN_PARAMS, sharpen),
  pixelate: def('pixelate', 'Pixelate', 'detail', true, 'Large square pixels.', PIXELATE_PARAMS, pixelate),
  noise: def('noise', 'Noise', 'detail', false, 'Film grain, repeatable by seed.', NOISE_PARAMS, noise),
  vignette: def('vignette', 'Vignette', 'stylize', false, 'Darken (or tint) towards the edges.', VIGNETTE_PARAMS, vignette),
  emboss: def('emboss', 'Emboss', 'stylize', true, 'Raised relief lit from one side.', EMBOSS_PARAMS, emboss),
  sketch: def('sketch', 'Sketch', 'stylize', true, 'Pencil-like edge drawing.', SKETCH_PARAMS, sketch),
  glow: def('glow', 'Glow', 'stylize', true, 'Soft bloom around bright areas.', GLOW_PARAMS, glow),
  chromaticAberration: def('chromaticAberration', 'Chromatic aberration', 'stylize', true, 'Red/blue lens fringing from the centre.', CHROMATIC_ABERRATION_PARAMS, chromaticAberration),
};

/** Every filter in panel order (grouped by category). */
export const FILTER_LIST: readonly FilterDef[] = FILTER_CATEGORIES.flatMap((c) =>
  (Object.values(FILTERS) as FilterDef[]).filter((f) => f.category === c.id),
);

export const FILTER_IDS: readonly FilterId[] = FILTER_LIST.map((f) => f.id);

export function isFilterId(id: unknown): id is FilterId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FILTERS, id);
}

/** Registry entry for an id; throws on unknown ids. */
export function getFilter<K extends FilterId>(id: K): FilterDef<FilterParamsMap[K]> {
  if (!isFilterId(id)) throw new RangeError(`unknown filter "${String(id)}"`);
  return FILTERS[id];
}

/** A fresh copy of a filter's defaults (safe to mutate, e.g. as UI state). */
export function defaultParams<K extends FilterId>(id: K): FilterParamsMap[K] {
  return defaultsOf<FilterParamsMap[K]>(getFilter(id).params);
}

/** Validates params for a filter: fills defaults, clamps ranges, drops unknown keys. */
export function normalizeFilterParams<K extends FilterId>(id: K, params?: Partial<FilterParamsMap[K]> | ParamRecord | null): FilterParamsMap[K] {
  return resolveParams<FilterParamsMap[K]>(getFilter(id).params, params);
}

/**
 * Runs a filter by id. Params may be partial or untyped (validated against
 * the registry); `mask` limits the effect to a selection; `out` receives the
 * result (it may alias `pixels`). Returns a new image unless `out` is given.
 */
export function applyFilter<K extends FilterId>(
  id: K,
  pixels: Pixels,
  params?: Partial<FilterParamsMap[K]> | ParamRecord | null,
  mask?: Mask | null,
  out?: Pixels,
): Pixels {
  const f = getFilter(id) as unknown as FilterDef<object>;
  return f.apply(pixels, resolveParams<object>(f.params, params), mask, out);
}
