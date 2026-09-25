// Applies the theme to the document: `data-theme` (dark | light),
// `data-compat` (opaque compatibility mode) and the accent custom properties
// consumed by tokens.css. With `theme: 'system'` it follows
// `prefers-color-scheme` live.

import './tokens.css';
import type { Settings, ThemeMode } from '$lib/ipc/types';
import {
  accentRamp,
  parseHex,
  readableOn,
  rgbToOklch,
  rgbTriplet,
  toHex,
  withContrast,
  withLightness,
  type Rgb,
} from './color';

/** Reskin's own accent, used when the Windows accent is off or unknown. */
export const BRAND_ACCENT = '#7c5cff';

export type ResolvedTheme = 'dark' | 'light';

export interface ThemeInput {
  settings: Pick<Settings, 'theme' | 'useAccent' | 'compatibilityMode'>;
  /** Windows accent `#rrggbb` (BootInfo, re-read when the window gains focus). */
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
 * What accents are drawn on with the least contrast to them (tokens.css):
 * in dark, the editor panel's fill (`--glass-fill-strong`) over a white
 * wallpaper, rounded up — lighter than every dark surface; in light, the
 * darkest surface (`--surface-sunken`).
 */
const LEAST_CONTRAST_SURFACE: Readonly<Record<ResolvedTheme, Rgb>> = {
  dark: parseHex('#26282f')!,
  light: parseHex('#eceef2')!,
};

/**
 * WCAG AA against every surface and the panel: 3:1 for accent fills
 * (switches, selection marks), 4.5:1 for accent text (and the focus ring,
 * drawn in it).
 */
const MIN_FILL_CONTRAST = 3;
const MIN_TEXT_CONTRAST = 4.5;

/**
 * Accent custom properties for a theme. Fills use a lighter shade on dark
 * and a darker one on light (as Windows does) so text on them stays legible.
 * Windows lets the accent be any colour: a fill or text shade that would
 * not stand out from every surface of the theme and from the panel goes
 * further (lighter on dark, darker on light) until it does, hover and
 * pressed in step with the fill; accents that already do are used as they
 * are.
 */
export function accentVars(accent: Rgb, theme: ResolvedTheme): Record<string, string> {
  const ramp = accentRamp(accent);
  const dark = theme === 'dark';
  const surface = LEAST_CONTRAST_SURFACE[theme];
  const towards = dark ? 'lighter' : 'darker';
  const shade = dark ? ramp.light1 : ramp.dark1;
  const fill = withContrast(shade, surface, MIN_FILL_CONTRAST, towards);
  const shift = rgbToOklch(fill).l - rgbToOklch(shade).l;
  const inStep = (rgb: Rgb) => (shift === 0 ? rgb : withLightness(rgb, rgbToOklch(rgb).l + shift));
  const hover = inStep(dark ? ramp.light2 : ramp.base);
  const pressed = inStep(dark ? ramp.base : ramp.dark2);
  const text = withContrast(dark ? ramp.light3 : ramp.dark2, surface, MIN_TEXT_CONTRAST, towards);
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
