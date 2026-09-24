// Layer effect defaults and helpers.

import type { EffectOf, EffectType, LayerEffect } from './types';

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
