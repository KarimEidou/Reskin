// Colour plumbing shared by the panels: hex ⇄ engine Rgba, and the
// recent-colours list kept in settings (newest first, at most 16).

import { parseColor, roundRgba, toHex, type Rgba } from '$engine/index';
import { MAX_RECENT_COLORS } from '$lib/settings/defaults';
import { settings, updateSettings } from '$lib/settings/store.svelte';

/** `#rrggbb`, or `#rrggbbaa` when translucent (lower case). */
export function hexOf(c: Rgba): string {
  return toHex(roundRgba(c));
}

export function rgbaOf(text: string, fallback: Rgba = { r: 0, g: 0, b: 0, a: 1 }): Rgba {
  return parseColor(text) ?? fallback;
}

/** CSS colour for a style attribute. */
export function cssOf(c: Rgba): string {
  return hexOf(c);
}

/** The recent-colours list with `hex` moved to the front (pure; exported for tests). */
export function withRecent(list: readonly string[], hex: string, max = MAX_RECENT_COLORS): string[] {
  const h = hex.trim().toLowerCase();
  if (!/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/.test(h)) return [...list];
  return [h, ...list.filter((x) => x.toLowerCase() !== h)].slice(0, max);
}

let pending: string[] | null = null;

/** Records a committed colour in settings.recentColors (newest first, max 16). */
export function rememberColor(c: Rgba | string): void {
  const hex = typeof c === 'string' ? (parseColor(c) ? hexOf(parseColor(c)!) : c) : hexOf(c);
  const current = pending ?? settings().recentColors;
  const next = withRecent(current, hex);
  if (next.length === current.length && next.every((v, i) => v === current[i])) return;
  pending = next;
  updateSettings({ recentColors: next })
    .catch((e: unknown) => console.warn('could not save recent colours', e))
    .finally(() => {
      if (pending === next) pending = null;
    });
}
