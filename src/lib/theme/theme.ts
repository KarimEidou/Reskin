// Applies the theme to the document: `data-theme` (dark | light),
// `data-compat` (opaque compatibility mode) and the accent custom properties
// consumed by tokens.css. With `theme: 'system'` it follows
// `prefers-color-scheme` live.

import './tokens.css';
import type { Settings, ThemeMode } from '$lib/ipc/types';
import { accentRamp, parseHex, readableOn, rgbTriplet, toHex, type Rgb } from './color';

/** Reskin's own accent, used when the Windows accent is off or unknown. */
export const BRAND_ACCENT = '#7c5cff';

export type ResolvedTheme = 'dark' | 'light';

export interface ThemeInput {
  settings: Pick<Settings, 'theme' | 'useAccent' | 'compatibilityMode'>;
  /** Windows accent `#rrggbb` (from boot / `accent_color`). */
  accent?: string | null;
  /** Force the system scheme instead of reading `prefers-color-scheme`. */
  systemDark?: boolean;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode;
  return systemDark ? 'dark' : 'light';
}

/** The accent actually used: Windows' when enabled and valid, else the brand's. */
export function effectiveAccent(useAccent: boolean, accent: string | null | undefined): Rgb {
  return (useAccent && accent ? parseHex(accent) : null) ?? parseHex(BRAND_ACCENT)!;
}

/**
 * Accent custom properties for a theme. Fills use a lighter shade on dark
 * and a darker one on light (as Windows does) so text on them stays legible.
 */
export function accentVars(accent: Rgb, theme: ResolvedTheme): Record<string, string> {
  const ramp = accentRamp(accent);
  const fill = theme === 'dark' ? ramp.light1 : ramp.dark1;
  const hover = theme === 'dark' ? ramp.light2 : ramp.base;
  const pressed = theme === 'dark' ? ramp.base : ramp.dark2;
  const text = theme === 'dark' ? ramp.light3 : ramp.dark2;
  const vars: Record<string, Rgb> = {
    'accent-base': ramp.base,
    accent: fill,
    'accent-hover': hover,
    'accent-pressed': pressed,
    'accent-text': text,
    'on-accent': readableOn(fill),
    'accent-vivid': ramp.vivid,
    'accent-light': ramp.light2,
    'accent-dark': ramp.dark2,
  };
  const out: Record<string, string> = {};
  for (const [name, rgb] of Object.entries(vars)) {
    out[`--${name}`] = toHex(rgb);
    out[`--${name}-rgb`] = rgbTriplet(rgb);
  }
  return out;
}

let last: ThemeInput | null = null;
let media: MediaQueryList | null = null;
let resolved: ResolvedTheme = 'dark';

function systemPrefersDark(input: ThemeInput): boolean {
  if (input.systemDark !== undefined) return input.systemDark;
  return media?.matches ?? true;
}

/**
 * Applies theme, compatibility mode and accent to `<html>`. Call again with
 * new settings/accent whenever they change; the latest input is re-applied
 * automatically when the system colour scheme flips.
 */
export function applyTheme(input: ThemeInput): ResolvedTheme {
  last = input;
  if (!media && typeof matchMedia === 'function') {
    media = matchMedia(DARK_QUERY);
    media.addEventListener('change', () => {
      if (last && last.settings.theme === 'system' && last.systemDark === undefined) applyTheme(last);
    });
  }
  resolved = resolveTheme(input.settings.theme, systemPrefersDark(input));
  if (typeof document === 'undefined') return resolved;

  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.compat = input.settings.compatibilityMode ? 'true' : 'false';
  root.style.colorScheme = resolved;
  const vars = accentVars(effectiveAccent(input.settings.useAccent, input.accent), resolved);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  return resolved;
}

/** The theme currently applied. */
export function currentTheme(): ResolvedTheme {
  return resolved;
}
