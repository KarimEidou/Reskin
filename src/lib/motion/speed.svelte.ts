// Global, reactive motion state. Every animation duration in the app goes
// through `dur()` (JS) or the `--motion-k` / `--motion-fade-k` custom
// properties (CSS), so the animation-speed setting and reduced motion apply
// everywhere:
//
//   el.animate(frames, { duration: dur(240) });
//   transition: transform calc(180ms * var(--motion-k)) …;
//
// `reduced = settings.motion === 'reduced' || (settings.motion === 'system'
// && (boot.systemReducedMotion || prefers-reduced-motion: reduce))`.

import type { BootInfo, MotionPref, Settings } from '$lib/ipc/types';
import { resolveMotion, scaleDuration, REDUCED_FADE_MS, type DurationKind } from './policy';

export type { DurationKind } from './policy';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/** Live motion state; read it in components/effects to react to changes. */
export const motion = $state({ speed: 1, reduced: false });

const inputs: { pref: MotionPref; speed: number; systemReduced: boolean; mediaReduced: boolean } = {
  pref: 'system',
  speed: 1,
  systemReduced: false,
  mediaReduced: false,
};

let media: MediaQueryList | null = null;

function recompute(): void {
  const next = resolveMotion(inputs.pref, inputs.speed, inputs.systemReduced, inputs.mediaReduced);
  motion.speed = next.speed;
  motion.reduced = next.reduced;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // CSS multipliers: `calc(200ms * var(--motion-k))`. Fades keep a short,
  // capped duration under reduced motion (see `dur(ms, 'fade')`).
  root.style.setProperty('--motion-k', next.reduced ? '0' : String(1 / next.speed));
  root.style.setProperty('--motion-fade-k', String(1 / next.speed));
  root.style.setProperty('--motion-fade-max', `${REDUCED_FADE_MS / next.speed}ms`);
  root.dataset.motion = next.reduced ? 'reduced' : 'full';
}

/** Initialises motion from boot info and starts following the media query. */
export function initMotion(boot: Pick<BootInfo, 'settings' | 'systemReducedMotion'>): void {
  inputs.systemReduced = boot.systemReducedMotion;
  if (!media && typeof matchMedia === 'function') {
    media = matchMedia(REDUCED_QUERY);
    media.addEventListener('change', (e) => {
      inputs.mediaReduced = e.matches;
      recompute();
    });
  }
  inputs.mediaReduced = media?.matches ?? false;
  updateMotion(boot.settings);
}

/** Applies the motion-related fields of new settings. */
export function updateMotion(settings: Pick<Settings, 'motion' | 'animationSpeed'>): void {
  inputs.pref = settings.motion;
  inputs.speed = settings.animationSpeed;
  recompute();
}

/**
 * Scales a nominal duration (ms at speed 1) by the animation-speed setting.
 * Under reduced motion, `motion` durations become 0 and `fade` durations are
 * capped to a short crossfade.
 */
export function dur(ms: number, kind: DurationKind = 'motion'): number {
  return scaleDuration(ms, motion, kind);
}
