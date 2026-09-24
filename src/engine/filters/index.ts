/**
 * Pure image-processing adjustments for the editor.
 *
 * - `FILTERS` / `FILTER_LIST` / `FILTER_CATEGORIES`: the registry the
 *   Adjustments panel is built from (labels, categories, parameter controls,
 *   defaults).
 * - `applyFilter(id, pixels, params, mask?, out?)`: run any filter by id.
 * - Individual filter functions (`blur`, `hueSaturation`, …) share the shape
 *   `(src, params?, mask?, out?) => Pixels`.
 *
 * For live previews off the main thread use `FilterClient` from
 * `$engine/filters/client` (kept out of this barrel so the worker bundle
 * never imports the client that spawns it).
 */
export * from './types';
export * from './registry';
export * from './adjust';
export * from './spatial';
export {
  defaultsOf,
  normalizeParam,
  resolveParams,
  type ColorParamSpec,
  type GradientParamSpec,
  type ParamKind,
  type ParamRecord,
  type ParamSpec,
  type ParamValue,
  type SelectOption,
  type SelectParamSpec,
  type SliderParamSpec,
  type ToggleParamSpec,
} from './params';
export { isColor, luma, lumaInt, parseColor, toHex, hslToRgb, rgbToHsl, type Rgba } from './colormath';
export { gradientLutPremultiplied, gradientLutRgba8, normalizeStops, resolveStops, type GradientStop, type ResolvedStop } from './gradient';
export { boxForSigma, fromPremultiplied, gaussianBlur, toPremultiplied, blurPremultiplied } from './blur-core';
export { hash01, mulberry32 } from './prng';
