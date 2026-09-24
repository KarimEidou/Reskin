/**
 * Style preset model: a preset is a pure function that turns an icon into a
 * small layer stack (backdrop, styled icon, optional gloss) with layer
 * effects. Every length is relative to the output size, so a preset renders
 * the same design at 96 px (thumbnail) and 512 px (document).
 */
import type { BackdropShape } from '../backdrop/shapes';
import type { BlendMode, LayerEffect } from '../doc/types';
import type { Pixels } from '../filters/types';

export type PresetId =
  | 'glass'
  | 'neon'
  | 'monoLight'
  | 'monoDark'
  | 'pastel'
  | 'retroPixel'
  | 'sticker'
  | 'clay'
  | 'gradientSilhouette'
  | 'fluent'
  | 'duotone'
  | 'sketch';

export type PresetLayerRole = 'backdrop' | 'decor' | 'icon' | 'gloss';

/** One layer of a preset's output, bottom → top. */
export interface PresetLayer {
  name: string;
  role: PresetLayerRole;
  /** size × size, straight RGBA. */
  pixels: Pixels;
  opacity: number;
  blend: BlendMode;
  /** Non-destructive effects, pixel values already scaled to the output size. */
  effects: LayerEffect[];
}

export interface PresetResult {
  id: PresetId;
  size: number;
  layers: PresetLayer[];
  /** Index (into `layers`) of the styled icon layer. */
  iconIndex: number;
}

/** User-tunable variations every preset understands. */
export interface PresetOptions {
  /** Accent hue in degrees; null = derived from the icon's own colours. */
  hue: number | null;
  /** Strength of the preset's signature treatment, 0..1 (0.5 = as designed). */
  intensity: number;
  /** Backdrop shape; null = the preset's own choice. */
  shape: BackdropShape | null;
  /** Seed for the few randomised details (confetti, paper grain). */
  seed: number;
}

export const DEFAULT_PRESET_OPTIONS: Readonly<PresetOptions> = Object.freeze({
  hue: null,
  intensity: 0.5,
  shape: null,
  seed: 1,
});

export interface PresetInfo {
  id: PresetId;
  label: string;
  /** One line for tooltips. */
  description: string;
  /** Default backdrop shape (what `shape: null` means). */
  shape: BackdropShape;
  /** What the intensity slider changes, for its label. */
  intensityLabel: string;
  /** Whether the accent hue changes this preset. */
  usesHue: boolean;
}
