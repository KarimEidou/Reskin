// Pure motion policy: how settings + system signals turn into a speed
// multiplier and a reduced-motion flag, and how durations are scaled.
// `speed.svelte.ts` holds the live, reactive values.

import type { MotionPref } from '$lib/ipc/types';

export interface MotionState {
  /** Animation speed multiplier (0.5..2; 2 = twice as fast). */
  speed: number;
  /** Reduced motion: no movement, only short fades. */
  reduced: boolean;
}

/** Longest opacity fade allowed while motion is reduced (ms, at speed 1). */
export const REDUCED_FADE_MS = 150;

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/**
 * `reduced = motion === 'reduced' || (motion === 'system' && (Windows has
 * client-area animations off || prefers-reduced-motion: reduce))`.
 */
export function resolveMotion(
  pref: MotionPref,
  animationSpeed: number,
  systemReduced: boolean,
  mediaReduced: boolean,
): MotionState {
  const reduced = pref === 'reduced' || (pref === 'system' && (systemReduced || mediaReduced));
  return { speed: clampSpeed(animationSpeed), reduced };
}

/**
 * What kind of animation a duration belongs to:
 * * `motion` — anything that moves or scales; 0 ms when motion is reduced;
 * * `fade` — pure opacity/colour changes; kept (but capped) when reduced so
 *   state changes stay perceivable without movement;
 * * `hold` — how long a state stays on screen (e.g. an error look before it
 *   settles); scaled by speed but kept when reduced, since nothing moves.
 */
export type DurationKind = 'motion' | 'fade' | 'hold';

export function scaleDuration(ms: number, state: MotionState, kind: DurationKind = 'motion'): number {
  if (!(ms > 0)) return 0;
  const scaled = ms / clampSpeed(state.speed);
  if (!state.reduced || kind === 'hold') return scaled;
  return kind === 'fade' ? Math.min(scaled, REDUCED_FADE_MS / clampSpeed(state.speed)) : 0;
}
