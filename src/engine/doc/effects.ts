// Layer effect defaults and helpers.

import type { EffectOf, EffectType, LayerEffect, OutlinePosition } from './types';
import { EFFECT_TYPES, MAX_PARAM_PX, isBlendMode } from './types';
import { clampRgba } from '../color/color';
import { clamp, clamp01, isFiniteNumber } from '../util/math';

const DEFAULTS: { [T in EffectType]: () => EffectOf<T> } = {
  dropShadow: () => ({
    type: 'dropShadow',
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0.45,
    angle: 120,
    distance: 8,
    blur: 12,
    spread: 0,
  }),
  outerGlow: () => ({
    type: 'outerGlow',
    enabled: true,
    color: { r: 255, g: 255, b: 190, a: 1 },
    opacity: 0.75,
    size: 16,
    spread: 0,
  }),
  outline: () => ({
    type: 'outline',
    enabled: true,
    color: { r: 255, g: 255, b: 255, a: 1 },
    opacity: 1,
    width: 8,
    position: 'outside',
  }),
  colorOverlay: () => ({
    type: 'colorOverlay',
    enabled: true,
    color: { r: 124, g: 92, b: 255, a: 1 },
    opacity: 1,
    blend: 'normal',
  }),
  innerShadow: () => ({
    type: 'innerShadow',
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0.5,
    angle: 120,
    distance: 6,
    blur: 10,
    choke: 0,
  }),
};

/** A new effect of `type` with sensible defaults for a 512 px icon. */
export function createEffect<T extends EffectType>(type: T, overrides: Partial<EffectOf<T>> = {}): EffectOf<T> {
  return { ...DEFAULTS[type](), ...overrides, type } as EffectOf<T>;
}

export function cloneEffect<E extends LayerEffect>(e: E): E {
  return { ...e, color: { ...e.color } };
}

export function cloneEffects(effects: readonly LayerEffect[]): LayerEffect[] {
  return effects.map(cloneEffect);
}

const OUTLINE_POSITIONS: readonly OutlinePosition[] = ['outside', 'center', 'inside'];

/**
 * A copy of `e` with every field valid: numbers finite and in range (opacity
 * 0..1, sizes/distances 0..MAX_PARAM_PX), colour clamped, enums known;
 * anything missing or unusable takes the default. Unknown effect types
 * throw a RangeError.
 */
export function normalizeEffect<E extends LayerEffect>(e: E): E {
  if (!(EFFECT_TYPES as readonly string[]).includes(e.type)) throw new RangeError(`Unknown effect type ${e.type}`);
  const def = DEFAULTS[e.type]() as unknown as Record<string, unknown>;
  const src = e as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { type: e.type };
  for (const [k, d] of Object.entries(def)) {
    if (k === 'type') continue;
    const v = src[k];
    if (k === 'color') out[k] = v && typeof v === 'object' ? clampRgba(v as never) : { ...(d as object) };
    else if (k === 'blend') out[k] = isBlendMode(v) ? v : d;
    else if (k === 'position') out[k] = OUTLINE_POSITIONS.includes(v as OutlinePosition) ? v : d;
    else if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
    else if (!isFiniteNumber(v)) out[k] = d;
    else if (k === 'opacity') out[k] = clamp01(v);
    else if (k === 'angle') out[k] = v;
    else out[k] = clamp(v, 0, MAX_PARAM_PX);
  }
  return out as unknown as E;
}

export function normalizeEffects(effects: readonly LayerEffect[]): LayerEffect[] {
  return effects.map(normalizeEffect);
}

export function hasActiveEffects(effects: readonly LayerEffect[]): boolean {
  return effects.some((e) => e.enabled && e.opacity > 0 && e.color.a > 0);
}

/** Scales the pixel-sized parameters (used when a document is resized). */
export function scaleEffect<E extends LayerEffect>(e: E, k: number): E {
  const out = cloneEffect(e);
  switch (out.type) {
    case 'dropShadow':
      out.distance *= k;
      out.blur *= k;
      out.spread *= k;
      break;
    case 'outerGlow':
      out.size *= k;
      out.spread *= k;
      break;
    case 'outline':
      out.width *= k;
      break;
    case 'innerShadow':
      out.distance *= k;
      out.blur *= k;
      out.choke *= k;
      break;
    case 'colorOverlay':
      break;
  }
  return out;
}

/** Offset (dx, dy) in px for a light-source `angle` (degrees) and `distance`. */
export function shadowOffset(angle: number, distance: number): { dx: number; dy: number } {
  const a = (angle * Math.PI) / 180;
  return { dx: -Math.cos(a) * distance, dy: Math.sin(a) * distance };
}
