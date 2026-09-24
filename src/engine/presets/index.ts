/**
 * Style presets: twelve designer looks rebuilt from the icon's own glyph
 * and colours (Glass, Neon, Mono Light/Dark, Pastel, Retro Pixel, Sticker,
 * Clay, Gradient silhouette, Fluent, Duotone, Sketch).
 *
 * ```ts
 * const result = buildPreset('glass', iconPixels, 512, { hue: 210 });
 * const thumb = compositePreset(buildPreset('neon', iconPixels, 96));
 * applyPresetResult(engine, result); // one undo step
 * ```
 *
 * Pure and deterministic (seeded); every length scales with the size.
 */
export * from './types';
export { PRESETS, PRESET_IDS, buildFromAnalysis, getPreset, isPresetId } from './presets';
export { buildPreset, compositePreset, presetDocument } from './build';
export { ANALYSIS_SIZE, FALLBACK_HUE, analyzeIcon, placeGlyph, placeIcon, type GlyphMode, type IconAnalysis } from './icon';
export { applyPresetFromLayer, applyPresetResult, commitLayerStack, insertLayer, layerImage, makeRasterLayer } from './commit';
