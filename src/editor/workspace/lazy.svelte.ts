// Lazily loaded workspace pieces that only appear on demand (colour picker
// popovers, the font list, the gradient stops editor). They stay out of the
// editor's initial bundle; `preload()` warms them on idle or on hover so
// opening feels instant.

import type FontPickerComponent from './FontPicker.svelte';
import type GradientStopsComponent from './GradientStops.svelte';
import type MiniColorPickerComponent from './MiniColorPicker.svelte';

export class Lazy<T> {
  /** The loaded component (reactive), or null until it arrives. */
  current = $state.raw<T | null>(null);
  private pending: Promise<T> | null = null;

  constructor(private readonly loader: () => Promise<{ default: T }>) {}

  load(): Promise<T> {
    this.pending ??= this.loader().then(
      (m) => (this.current = m.default),
      (error: unknown) => {
        this.pending = null;
        throw error;
      },
    );
    return this.pending;
  }

  /** Starts loading without waiting (errors are logged, retried on next use). */
  preload(): void {
    this.load().catch((error: unknown) => console.warn('could not load a workspace module', error));
  }
}

export const colorPicker = new Lazy<typeof MiniColorPickerComponent>(() => import('./MiniColorPicker.svelte'));
export const fontPicker = new Lazy<typeof FontPickerComponent>(() => import('./FontPicker.svelte'));
export const gradientStops = new Lazy<typeof GradientStopsComponent>(() => import('./GradientStops.svelte'));

/** Warms every lazy piece once the page is idle. */
export function preloadWhenIdle(): () => void {
  const run = () => {
    colorPicker.preload();
    fontPicker.preload();
    gradientStops.preload();
  };
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 4000 });
    return () => cancelIdleCallback(id);
  }
  const timer = setTimeout(run, 1500);
  return () => clearTimeout(timer);
}
