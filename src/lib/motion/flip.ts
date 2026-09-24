// FLIP (First, Last, Invert, Play) helpers.
//
// Lay the element out at its final place ("last"), then animate from the
// inverse transform that makes it cover its old place ("first") back to
// identity. Only `transform` (plus optional `opacity` / extra properties)
// is animated, so the whole thing runs on the compositor.

import type { Rect } from '$lib/ipc/types';
import { clamp, lerp } from './easing';
import { SPRINGS, springKeyframes, type SpringParams } from './spring';
import { dur, motion } from './speed.svelte';

/** An IPC `Rect` ({x, y, w, h}) or anything DOMRect-like. */
export type RectInput = Rect | { x: number; y: number; width: number; height: number };

export interface FlipTransform {
  translate: { x: number; y: number };
  scale: { x: number; y: number };
}

/** Where the scale is anchored (maps to `transform-origin`). */
export type FlipOrigin = 'top-left' | 'center';

export const IDENTITY: FlipTransform = Object.freeze({
  translate: Object.freeze({ x: 0, y: 0 }),
  scale: Object.freeze({ x: 1, y: 1 }),
}) as FlipTransform;

export function toRect(r: RectInput): Rect {
  return 'w' in r ? { x: r.x, y: r.y, w: r.w, h: r.h } : { x: r.x, y: r.y, w: r.width, h: r.height };
}

/**
 * The inverse transform: applied (with the given origin) to an element laid
 * out at `to`, it makes the element cover `from` exactly. Animate it to
 * identity to play `from → to`.
 */
export function flipTransform(
  from: RectInput,
  to: RectInput,
  origin: FlipOrigin = 'top-left',
): FlipTransform {
  const a = toRect(from);
  const b = toRect(to);
  const scale = { x: b.w === 0 ? 1 : a.w / b.w, y: b.h === 0 ? 1 : a.h / b.h };
  const translate =
    origin === 'top-left'
      ? { x: a.x - b.x, y: a.y - b.y }
      : { x: a.x + a.w / 2 - (b.x + b.w / 2), y: a.y + a.h / 2 - (b.y + b.h / 2) };
  return { translate, scale };
}

/** Where `rect` ends up under transform `t` (the inverse of `flipTransform`). */
export function applyFlip(rect: RectInput, t: FlipTransform, origin: FlipOrigin = 'top-left'): Rect {
  const r = toRect(rect);
  const w = r.w * t.scale.x;
  const h = r.h * t.scale.y;
  if (origin === 'top-left') return { x: r.x + t.translate.x, y: r.y + t.translate.y, w, h };
  const cx = r.x + r.w / 2 + t.translate.x;
  const cy = r.y + r.h / 2 + t.translate.y;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Interpolates `t` (p = 0) towards identity (p = 1). */
export function mixFlip(t: FlipTransform, p: number): FlipTransform {
  return {
    translate: { x: lerp(t.translate.x, 0, p), y: lerp(t.translate.y, 0, p) },
    scale: { x: lerp(t.scale.x, 1, p), y: lerp(t.scale.y, 1, p) },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function flipCss(t: FlipTransform): string {
  return `translate(${round(t.translate.x)}px, ${round(t.translate.y)}px) scale(${round(t.scale.x)}, ${round(t.scale.y)})`;
}

export interface AnimateFlipOptions extends Partial<SpringParams> {
  /** Scale anchor (default top-left). */
  origin?: FlipOrigin;
  /** Override the global reduced-motion flag. */
  reduced?: boolean;
  /** Opacity animated alongside, `[from, to]`. */
  opacity?: readonly [number, number];
  /** Extra keyframe properties for spring progress p (e.g. clip-path, radius). */
  extra?: (progress: number) => Keyframe;
  /** WAAPI fill mode (default 'none'). */
  fill?: FillMode;
}

/**
 * Plays `first → last` on `el`, which must already be laid out at `last`.
 * Uses the morph spring by default (override any spring parameter), scaled
 * by the animation-speed setting. Under reduced motion nothing moves: the
 * element appears in place with a short opacity fade (when `opacity` is
 * given). Always returns the Animation so callers can `await a.finished`.
 */
export function animateFlip(
  el: Element,
  first: RectInput,
  last: RectInput,
  opts: AnimateFlipOptions = {},
): Animation {
  const origin = opts.origin ?? 'top-left';
  const fill = opts.fill ?? 'none';
  const [o0, o1] = opts.opacity ?? [1, 1];
  const reduced = opts.reduced ?? motion.reduced;

  if (reduced) {
    const frames: Keyframe[] = opts.opacity ? [{ opacity: o0 }, { opacity: o1 }] : [{}, {}];
    return el.animate(frames, { duration: dur(160, 'fade'), easing: 'linear', fill });
  }

  const inverse = flipTransform(first, last, origin);
  const transformOrigin = origin === 'center' ? '50% 50%' : '0 0';
  const spring: SpringParams = {
    stiffness: opts.stiffness ?? SPRINGS.morph.stiffness,
    damping: opts.damping ?? SPRINGS.morph.damping,
    mass: opts.mass ?? SPRINGS.morph.mass,
    velocity: opts.velocity ?? SPRINGS.morph.velocity,
  };
  const { keyframes, duration } = springKeyframes(0, 1, {
    ...spring,
    timeScale: 1 / motion.speed,
    render: (p) => ({
      transform: flipCss(mixFlip(inverse, p)),
      transformOrigin,
      ...(opts.opacity ? { opacity: round(lerp(o0, o1, clamp(p, 0, 1))) } : {}),
      ...opts.extra?.(p),
    }),
  });
  return el.animate(keyframes, { duration, easing: 'linear', fill });
}
