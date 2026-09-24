/**
 * BackdropSpec: a resolution-independent description of an icon backdrop.
 * Every length is a fraction of the output size, so one spec renders
 * identically at 16 px and 512 px.
 */
import { isColor } from '../filters/colormath';
import { normalizeStops, type GradientStop } from '../filters/gradient';
import { deepFreeze } from '../filters/util';
import { BACKDROP_SHAPES, type BackdropShape, type BlobOptions } from './shapes';

export type BackdropFill =
  | { type: 'solid'; color: string }
  /** CSS-style linear gradient across the shape's box: angle 0 = to top, 90 = to right, 180 = to bottom. */
  | { type: 'linear'; angle: number; stops: GradientStop[] }
  /** Radial gradient: centre (cx, cy) and radius as fractions of the shape's box. */
  | { type: 'radial'; cx: number; cy: number; radius: number; stops: GradientStop[] };

export type BackdropFillType = BackdropFill['type'];

/** Top highlight: a soft-gradient ellipse clipped to the shape. */
export interface BackdropGloss {
  /** Peak opacity 0..1. */
  opacity: number;
  /** How far down the shape the highlight reaches, 0.2..1 of its height. */
  size: number;
  color: string;
}

export type BorderPosition = 'inside' | 'center' | 'outside';

export interface BackdropBorder {
  /** Stroke width as a fraction of the output size, 0..0.2. */
  width: number;
  color: string;
  position: BorderPosition;
}

export interface BackdropShadow {
  /** Offsets as fractions of the output size, −0.25..0.25. */
  offsetX: number;
  offsetY: number;
  /** Gaussian σ as a fraction of the output size, 0..0.2. */
  blur: number;
  color: string;
  /** 0..1, multiplied with the colour's own alpha. */
  opacity: number;
}

export interface BackdropSpec {
  shape: BackdropShape;
  /** Margin around the shape's box, fraction of the output size, 0..0.45. */
  inset: number;
  /** Corner radius for rounded / hexagon / shield, fraction of the shape box, 0..0.5. */
  cornerRadius: number;
  /** Squircle superellipse exponent, 2..12. */
  squircleExponent: number;
  hexOrientation: 'pointy' | 'flat';
  blob: BlobOptions;
  fill: BackdropFill;
  gloss: BackdropGloss | null;
  border: BackdropBorder | null;
  shadow: BackdropShadow | null;
}

/** Partial spec accepted by `renderBackdrop` / `resolveBackdropSpec`. `true` enables an effect with defaults. */
export interface BackdropSpecInput {
  shape?: BackdropShape;
  inset?: number;
  cornerRadius?: number;
  squircleExponent?: number;
  hexOrientation?: 'pointy' | 'flat';
  blob?: Partial<BlobOptions>;
  fill?: Partial<BackdropFill> & { type?: BackdropFillType };
  gloss?: Partial<BackdropGloss> | boolean | null;
  border?: Partial<BackdropBorder> | boolean | null;
  shadow?: Partial<BackdropShadow> | boolean | null;
}

export const DEFAULT_STOPS: readonly GradientStop[] = deepFreeze([
  { offset: 0, color: '#6e8bff' },
  { offset: 1, color: '#3b3fd8' },
]);

export const DEFAULT_GLOSS: Readonly<BackdropGloss> = deepFreeze({ opacity: 0.35, size: 0.55, color: '#ffffff' });
export const DEFAULT_BORDER: Readonly<BackdropBorder> = deepFreeze({ width: 0.02, color: '#ffffff', position: 'inside' });
export const DEFAULT_SHADOW: Readonly<BackdropShadow> = deepFreeze({ offsetX: 0, offsetY: 0.02, blur: 0.025, color: '#000000', opacity: 0.35 });
export const DEFAULT_BLOB: Readonly<BlobOptions> = deepFreeze({ seed: 1, points: 6, variance: 0.45 });

/** The default spec (deeply frozen; `resolveBackdropSpec()` returns a mutable copy). */
export const DEFAULT_BACKDROP: Readonly<BackdropSpec> = deepFreeze({
  shape: 'squircle',
  inset: 0.08,
  cornerRadius: 0.22,
  squircleExponent: 5,
  hexOrientation: 'pointy',
  blob: { ...DEFAULT_BLOB },
  fill: { type: 'linear', angle: 180, stops: DEFAULT_STOPS.map((s) => ({ ...s })) },
  gloss: null,
  border: null,
  shadow: { ...DEFAULT_SHADOW },
} satisfies BackdropSpec);

function n(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return v < min ? min : v > max ? max : v;
}

function c(v: unknown, def: string): string {
  return isColor(v) ? v : def;
}

function stops(v: unknown): GradientStop[] {
  const s = normalizeStops(v, DEFAULT_STOPS);
  return s.length > 16 ? s.slice(0, 16) : s;
}

function resolveFill(f: BackdropSpecInput['fill']): BackdropFill {
  const d = DEFAULT_BACKDROP.fill as Extract<BackdropFill, { type: 'linear' }>;
  if (!f || typeof f !== 'object') return { type: 'linear', angle: d.angle, stops: stops(d.stops) };
  const src = f as Record<string, unknown>;
  const type: BackdropFillType = src.type === 'solid' || src.type === 'radial' || src.type === 'linear' ? src.type : 'linear';
  switch (type) {
    case 'solid':
      return { type, color: c(src.color, DEFAULT_STOPS[0].color) };
    case 'linear':
      return { type, angle: n(src.angle, 180, -360, 720), stops: stops(src.stops) };
    case 'radial':
      return {
        type,
        cx: n(src.cx, 0.5, -1, 2),
        cy: n(src.cy, 0.35, -1, 2),
        radius: n(src.radius, 0.75, 0.01, 4),
        stops: stops(src.stops),
      };
  }
}

function enabled<T extends object>(v: Partial<T> | boolean | null | undefined, fallback: T | null): Partial<T> | null {
  if (v === undefined) return fallback ? { ...fallback } : null;
  if (v === null || v === false) return null;
  if (v === true) return {};
  return v;
}

/** Fills in defaults and clamps every field; always returns a complete, valid spec. */
export function resolveBackdropSpec(input?: BackdropSpecInput | null): BackdropSpec {
  const i = input ?? {};
  const D = DEFAULT_BACKDROP;
  const shape = BACKDROP_SHAPES.some((s) => s.id === i.shape) ? (i.shape as BackdropShape) : D.shape;
  const blobIn = i.blob ?? {};
  const gloss = enabled<BackdropGloss>(i.gloss, D.gloss);
  const border = enabled<BackdropBorder>(i.border, D.border);
  const shadow = enabled<BackdropShadow>(i.shadow, D.shadow);
  return {
    shape,
    inset: n(i.inset, D.inset, 0, 0.45),
    cornerRadius: n(i.cornerRadius, D.cornerRadius, 0, 0.5),
    squircleExponent: n(i.squircleExponent, D.squircleExponent, 2, 12),
    hexOrientation: i.hexOrientation === 'flat' ? 'flat' : i.hexOrientation === 'pointy' ? 'pointy' : D.hexOrientation,
    blob: {
      seed: Math.trunc(n(blobIn.seed, DEFAULT_BLOB.seed, 0, 0xffffffff)),
      points: Math.round(n(blobIn.points, DEFAULT_BLOB.points, 3, 16)),
      variance: n(blobIn.variance, DEFAULT_BLOB.variance, 0, 1),
    },
    fill: resolveFill(i.fill),
    gloss: gloss && {
      opacity: n(gloss.opacity, DEFAULT_GLOSS.opacity, 0, 1),
      size: n(gloss.size, DEFAULT_GLOSS.size, 0.2, 1),
      color: c(gloss.color, DEFAULT_GLOSS.color),
    },
    border: border && {
      width: n(border.width, DEFAULT_BORDER.width, 0, 0.2),
      color: c(border.color, DEFAULT_BORDER.color),
      position: border.position === 'center' || border.position === 'outside' || border.position === 'inside' ? border.position : DEFAULT_BORDER.position,
    },
    shadow: shadow && {
      offsetX: n(shadow.offsetX, DEFAULT_SHADOW.offsetX, -0.25, 0.25),
      offsetY: n(shadow.offsetY, DEFAULT_SHADOW.offsetY, -0.25, 0.25),
      blur: n(shadow.blur, DEFAULT_SHADOW.blur, 0, 0.2),
      color: c(shadow.color, DEFAULT_SHADOW.color),
      opacity: n(shadow.opacity, DEFAULT_SHADOW.opacity, 0, 1),
    },
  };
}

export interface BackdropStyle {
  id: string;
  label: string;
  spec: BackdropSpec;
}

const style = (id: string, label: string, spec: BackdropSpecInput): BackdropStyle => ({ id, label, spec: resolveBackdropSpec(spec) });

/** Named starter styles for the backdrop picker (deeply frozen; use `backdropStyle(id)` for a mutable copy). */
export const BACKDROP_STYLES: readonly BackdropStyle[] = deepFreeze([
  style('ocean', 'Ocean', {
    shape: 'squircle',
    fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#5ac8fa' }, { offset: 1, color: '#0a64d8' }] },
    gloss: { opacity: 0.3, size: 0.5 },
  }),
  style('sunset', 'Sunset', {
    shape: 'circle',
    fill: {
      type: 'linear',
      angle: 135,
      stops: [{ offset: 0, color: '#ffb36b' }, { offset: 0.55, color: '#ff5e7e' }, { offset: 1, color: '#9b3dd6' }],
    },
  }),
  style('mint', 'Mint', {
    shape: 'rounded',
    cornerRadius: 0.24,
    fill: { type: 'solid', color: '#3ddc97' },
    border: { width: 0.02, color: '#ffffff80', position: 'inside' },
  }),
  style('graphite', 'Graphite', {
    shape: 'hexagon',
    cornerRadius: 0.06,
    fill: { type: 'radial', cx: 0.5, cy: 0.3, radius: 0.8, stops: [{ offset: 0, color: '#5a5f6b' }, { offset: 1, color: '#16181d' }] },
    border: { width: 0.018, color: '#d4af37', position: 'inside' },
  }),
  style('crest', 'Crest', {
    shape: 'shield',
    cornerRadius: 0.08,
    fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#d7263d' }, { offset: 1, color: '#6b0f2a' }] },
    border: { width: 0.024, color: '#ffd166', position: 'inside' },
    gloss: { opacity: 0.25, size: 0.4 },
  }),
  style('bubble', 'Bubble', {
    shape: 'blob',
    blob: { seed: 7, points: 6, variance: 0.5 },
    fill: { type: 'radial', cx: 0.4, cy: 0.3, radius: 0.9, stops: [{ offset: 0, color: '#ffd1f0' }, { offset: 1, color: '#a78bfa' }] },
  }),
  style('paper', 'Paper', {
    shape: 'rounded',
    cornerRadius: 0.2,
    fill: { type: 'solid', color: '#f7f5f0' },
    border: { width: 0.008, color: '#00000026', position: 'inside' },
    shadow: { offsetY: 0.015, blur: 0.02, opacity: 0.25 },
  }),
  style('neon', 'Neon', {
    shape: 'squircle',
    fill: { type: 'solid', color: '#12131a' },
    border: { width: 0.028, color: '#39ff88', position: 'center' },
    shadow: { offsetY: 0, blur: 0.035, color: '#39ff88', opacity: 0.55 },
  }),
]);

/** A copy of a starter style's spec, or undefined for an unknown id. */
export function backdropStyle(id: string): BackdropSpec | undefined {
  const s = BACKDROP_STYLES.find((x) => x.id === id);
  return s ? resolveBackdropSpec(s.spec) : undefined;
}
