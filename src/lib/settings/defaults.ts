// Settings defaults and normalisation, mirroring `Settings::default()` and
// `reskin_core::settings::normalize`. The web side uses them for optimistic
// updates and the e2e fake backend uses them as its "Rust".

import type { Settings } from '$lib/ipc/types';
import { canonicalHotkey } from './hotkey';

/** Every size Reskin writes into an .ico, smallest first. */
export const ICO_SIZES: readonly number[] = [16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256];
/** Sizes every .ico contains whatever the user picks. */
export const REQUIRED_ICO_SIZES: readonly number[] = [16, 32, 48, 256];
/** Pixel-art grids the editor offers. */
export const PIXEL_GRIDS: readonly number[] = [16, 24, 32, 48, 64];
export const MAX_RECENT_COLORS = 16;
export const SETTINGS_SCHEMA = 1;
export const DEFAULT_HOTKEY = 'Ctrl+Alt+Shift+R';

/** A fresh copy of the default settings. */
export function defaultSettings(): Settings {
  return {
    schema: SETTINGS_SCHEMA,
    theme: 'system',
    useAccent: true,
    boxSkin: 'glass',
    boxSize: 'medium',
    idleOpacity: 0.92,
    boxPosition: null,
    editorSize: 'medium',
    animationSpeed: 1,
    motion: 'system',
    openStyle: 'morph',
    sounds: false,
    autostart: false,
    contextMenu: false,
    hotkey: DEFAULT_HOTKEY,
    compatibilityMode: false,
    lowMemory: false,
    autoHideFullscreen: true,
    updatePins: false,
    flourish: true,
    onboarded: false,
    recentColors: [],
    icoSizes: [...ICO_SIZES],
    pixelGrid: 32,
  };
}

const clampOr = (v: number, lo: number, hi: number, nan: number) =>
  Number.isNaN(v) || typeof v !== 'number' ? nan : Math.min(hi, Math.max(lo, v));

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Brings every field into its valid range (same rules as Rust). */
export function normalizeSettings(input: Settings): Settings {
  const d = defaultSettings();
  const s: Settings = { ...input, recentColors: [...input.recentColors], icoSizes: [...input.icoSizes] };
  s.schema = SETTINGS_SCHEMA;
  s.idleOpacity = clampOr(s.idleOpacity, 0.25, 1, d.idleOpacity);
  s.animationSpeed = clampOr(s.animationSpeed, 0.5, 2, 1);
  s.icoSizes = [...new Set([...s.icoSizes.filter((n) => ICO_SIZES.includes(n)), ...REQUIRED_ICO_SIZES])].sort(
    (a, b) => a - b,
  );
  if (!PIXEL_GRIDS.includes(s.pixelGrid)) s.pixelGrid = 32;
  const colors: string[] = [];
  for (const raw of s.recentColors) {
    const c = raw.trim().toLowerCase();
    if (HEX_COLOR.test(c) && !colors.includes(c)) colors.push(c);
    if (colors.length === MAX_RECENT_COLORS) break;
  }
  s.recentColors = colors;
  s.hotkey = canonicalHotkey(s.hotkey, d.hotkey);
  return s;
}

/** Deep equality for JSON-shaped values (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ob = b as Record<string, unknown>;
  const oa = a as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(ob, k) && jsonEqual(oa[k], ob[k]));
}
