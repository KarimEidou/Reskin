// Document model types.
//
// A document is square: 512×512 for normal icons (MASTER_SIZE), or
// grid×grid pixels in pixel-art mode (displayed and exported with
// nearest-neighbour scaling). Layers are ordered bottom → top
// (`layers[0]` is the bottom-most; a Layers panel shows them reversed).

import type { Rgba } from '../color/color';
import type { Surface } from '../raster/surface';
import type { SelectionMask } from '../selection/mask';
import type { ItemKind } from '$lib/ipc/types';

export const MASTER_SIZE = 512;

export const PIXEL_GRIDS = [16, 24, 32, 48, 64] as const;
export type PixelGrid = (typeof PIXEL_GRIDS)[number];

export function isPixelGrid(n: unknown): n is PixelGrid {
  return (PIXEL_GRIDS as readonly unknown[]).includes(n);
}

/** The 12 separable W3C blend modes, named like CSS `mix-blend-mode`. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export function isBlendMode(v: unknown): v is BlendMode {
  return (BLEND_MODES as readonly unknown[]).includes(v);
}

// ---------------------------------------------------------------------------
// Layer effects (non-destructive, rendered by render/effects.ts)
//
// Distances are in document pixels. Angles follow the "light source"
// convention: 120° = light from the upper left, so the shadow falls to the
// lower right. Blur/size values are Gaussian radii (≈ 2σ).
// ---------------------------------------------------------------------------

export const EFFECT_TYPES = ['dropShadow', 'outerGlow', 'outline', 'colorOverlay', 'innerShadow'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

interface EffectBase {
  enabled: boolean;
  color: Rgba;
  /** 0..1, multiplied with the colour's own alpha. */
  opacity: number;
}

export interface DropShadowEffect extends EffectBase {
  type: 'dropShadow';
  angle: number;
  distance: number;
  blur: number;
  /** Grows the shadow shape before blurring, px. */
  spread: number;
}

export interface OuterGlowEffect extends EffectBase {
  type: 'outerGlow';
  /** Blur radius, px. */
  size: number;
  /** Grows the glow shape before blurring, px. */
  spread: number;
}

export type OutlinePosition = 'outside' | 'center' | 'inside';

export interface OutlineEffect extends EffectBase {
  type: 'outline';
  width: number;
  position: OutlinePosition;
}

export interface ColorOverlayEffect extends EffectBase {
  type: 'colorOverlay';
  blend: BlendMode;
}

export interface InnerShadowEffect extends EffectBase {
  type: 'innerShadow';
  angle: number;
  distance: number;
  blur: number;
  /** Grows the shadow inwards before blurring, px. */
  choke: number;
}

export type LayerEffect =
  | DropShadowEffect
  | OuterGlowEffect
  | OutlineEffect
  | ColorOverlayEffect
  | InnerShadowEffect;

export type EffectOf<T extends EffectType> = Extract<LayerEffect, { type: T }>;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface LayerCommon {
  /** Unique within the document. */
  id: string;
  name: string;
  visible: boolean;
  /** Locked layers cannot be painted, filled, moved or merged into. */
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  effects: LayerEffect[];
}

export interface RasterLayer extends LayerCommon {
  kind: 'raster';
  /** Document-sized, straight alpha. */
  surface: Surface;
}

export type TextAlign = 'left' | 'center' | 'right';

/** Editable text properties. (x, y) is the anchor: top of the first line,
 * at the left edge / centre / right edge depending on `align`. Rotation
 * (degrees, clockwise) is about the anchor. */
export interface TextProps {
  text: string;
  fontFamily: string;
  /** px */
  fontSize: number;
  /** 100..900 */
  weight: number;
  italic: boolean;
  align: TextAlign;
  color: Rgba;
  x: number;
  y: number;
  rotation: number;
  /** Line height as a multiple of fontSize. */
  lineHeight: number;
}

export const TEXT_PROP_KEYS = [
  'text',
  'fontFamily',
  'fontSize',
  'weight',
  'italic',
  'align',
  'color',
  'x',
  'y',
  'rotation',
  'lineHeight',
] as const satisfies readonly (keyof TextProps)[];

export interface TextLayer extends LayerCommon, TextProps {
  kind: 'text';
  /** Rasterised text (document-sized), refreshed when props change. */
  cache: Surface | null;
  /** Identifies what `cache` was rendered from (see text/text.ts). */
  cacheKey: string | null;
}

export type Layer = RasterLayer | TextLayer;
export type LayerKind = Layer['kind'];

/** Properties every layer kind shares and `setLayerProps` can change. */
export type LayerProps = Pick<LayerCommon, 'name' | 'visible' | 'locked' | 'opacity' | 'blend' | 'effects'>;

export const LAYER_PROP_KEYS = [
  'name',
  'visible',
  'locked',
  'opacity',
  'blend',
  'effects',
] as const satisfies readonly (keyof LayerProps)[];

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** Where the design came from (for the Library / history). */
export interface SourceInfo {
  kind: ItemKind | 'blank';
  name: string;
  /** Display path of the original item, if any. */
  path: string | null;
}

export interface DocMeta {
  name: string;
  source: SourceInfo | null;
  /** Unix ms. */
  createdAt: number;
}

export interface PixelArtSettings {
  grid: PixelGrid;
}

export interface Doc {
  width: number;
  height: number;
  /** Non-null in pixel-art mode; then width = height = grid. */
  pixelArt: PixelArtSettings | null;
  /** Bottom → top. */
  layers: Layer[];
  activeLayerId: string | null;
  /** Soft selection (0..255 per pixel), or null = everything. */
  selection: SelectionMask | null;
  meta: DocMeta;
  /** Counter for generated layer ids. */
  seq: number;
}
