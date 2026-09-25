// WCAG AA for the theme as tokens.css defines it: text colours on every
// surface (and on the translucent editor panel's fill over any wallpaper),
// and the accent colours theme.ts derives from any Windows accent.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accentRamp, contrast, parseHex, rgbToOklch, toHex, type Rgb } from './color';
import { accentVars, BRAND_ACCENT } from './theme';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');

/** The custom properties a rule of tokens.css sets. */
function rule(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {\n`);
  if (start < 0) throw new Error(`tokens.css has no ${selector} rule`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

const dark = rule(':root');
const light = { ...dark, ...rule(":root[data-theme='light']") };
const compat = rule(":root[data-compat='true']");
const THEMES = {
  dark,
  light,
  'dark, compatibility mode': { ...dark, ...compat },
  'light, compatibility mode': { ...light, ...compat, ...rule(":root[data-compat='true'][data-theme='light']") },
};
/** The wallpaper that takes the most contrast from text on the panel it shows through. */
const WALLPAPER: Record<keyof typeof THEMES, Rgb> = {
  dark: { r: 255, g: 255, b: 255 },
  light: { r: 0, g: 0, b: 0 },
  'dark, compatibility mode': { r: 255, g: 255, b: 255 },
  'light, compatibility mode': { r: 0, g: 0, b: 0 },
};

/** A colour token: `#rrggbb`, or `rgb(r g b / a)` with its alpha. */
function paint(value: string): { rgb: Rgb; alpha: number } {
  const hex = parseHex(value);
  if (hex) return { rgb: hex, alpha: 1 };
  const m = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  expect(m, `a colour: ${value}`).not.toBeNull();
  return { rgb: { r: Number(m![1]), g: Number(m![2]), b: Number(m![3]) }, alpha: m![4] ? Number(m![4]) : 1 };
}

function over(value: string, under: Rgb): Rgb {
  const { rgb, alpha } = paint(value);
  const mix = (top: number, bottom: number) => top * alpha + bottom * (1 - alpha);
  return { r: mix(rgb.r, under.r), g: mix(rgb.g, under.g), b: mix(rgb.b, under.b) };
}

const SURFACES = ['bg', 'surface-1', 'surface-2', 'surface-3', 'surface-overlay', 'surface-sunken'];

/** What text is drawn on: the surfaces and the editor panel (its fill over the worst wallpaper). */
function backgrounds(theme: keyof typeof THEMES): Record<string, Rgb> {
  const tokens = THEMES[theme];
  const out: Record<string, Rgb> = Object.fromEntries(SURFACES.map((s) => [s, paint(tokens[s]!).rgb]));
  out['panel'] = over(tokens['glass-fill-strong']!, WALLPAPER[theme]);
  return out;
}

/** Contrast failures of `texts` on `bgs`, e.g. "--text-3 on panel: 4.12". */
function below(ratio: number, texts: Record<string, Rgb>, bgs: Record<string, Rgb>): string[] {
  const failures: string[] = [];
  for (const [text, color] of Object.entries(texts)) {
    for (const [name, bg] of Object.entries(bgs)) {
      const c = contrast(color, bg);
      if (c < ratio) failures.push(`${text} on ${name}: ${c.toFixed(2)}`);
    }
  }
  return failures;
}

describe('text tokens', () => {
  for (const theme of Object.keys(THEMES) as Array<keyof typeof THEMES>) {
    const tokens = THEMES[theme];
    const texts = (names: string[]) => Object.fromEntries(names.map((n) => [`--${n}`, paint(tokens[n]!).rgb]));

    it(`keep 4.5:1 on every surface and on the panel (${theme})`, () => {
      const all = texts(['text', 'text-2', 'text-3', 'danger', 'warning', 'success']);
      expect(below(4.5, all, backgrounds(theme))).toEqual([]);
    });

    it(`keep 4.5:1 inside controls (${theme})`, () => {
      const controls = Object.fromEntries(
        Object.entries(backgrounds(theme)).map(([name, bg]) => [`a control on ${name}`, over(tokens['control-fill']!, bg)]),
      );
      expect(below(4.5, texts(['text', 'text-2', 'text-3']), controls)).toEqual([]);
    });
  }

  it('have rgb twins that match', () => {
    for (const tokens of Object.values(THEMES)) {
      for (const [name, value] of Object.entries(tokens)) {
        const twin = tokens[`${name}-rgb`];
        if (!twin || !parseHex(value)) continue;
        const { r, g, b } = parseHex(value)!;
        expect(twin, `--${name}-rgb`).toBe(`${r} ${g} ${b}`);
      }
    }
  });
});

/** Windows' accent palette (Settings → Personalization → Colours), the brand violet and the extremes. */
const ACCENTS = [
  '#FFB900', '#FF8C00', '#F7630C', '#CA5010', '#DA3B01', '#EF6950', '#D13438', '#FF4343',
  '#E74856', '#E81123', '#EA005E', '#C30052', '#E3008C', '#BF0077', '#C239B3', '#9A0089',
  '#0078D4', '#0063B1', '#8E8CD8', '#6B69D6', '#8764B8', '#744DA9', '#B146C2', '#881798',
  '#0099BC', '#2D7D9A', '#00B7C3', '#038387', '#00B294', '#018574', '#00CC6A', '#10893E',
  '#7A7574', '#5D5A58', '#68768A', '#515C6B', '#567C73', '#486860', '#498205', '#107C10',
  '#767676', '#4C4A48', '#69797E', '#4A5459', '#647C64', '#525E54', '#847545', '#7E735F',
  BRAND_ACCENT, '#FFFFFF', '#000000',
];

describe('accent colours', () => {
  for (const variant of Object.keys(THEMES) as Array<keyof typeof THEMES>) {
    it(`stand out from every surface and the panel, whatever the Windows accent (${variant})`, () => {
      const theme = variant.startsWith('dark') ? 'dark' : 'light';
      const surfaces = Object.values(backgrounds(variant));
      const failures: string[] = [];
      for (const accent of ACCENTS) {
        const vars = accentVars(parseHex(accent)!, theme);
        const color = (name: string) => parseHex(vars[`--${name}`]!)!;
        const worst = (c: Rgb) => Math.min(...surfaces.map((s) => contrast(c, s)));
        const checks = {
          'accent text': worst(color('accent-text')) >= 4.5,
          'accent fill': worst(color('accent')) >= 3,
          'text on the fill': contrast(color('on-accent'), color('accent')) >= 4.5,
        };
        for (const [what, ok] of Object.entries(checks)) if (!ok) failures.push(`${accent}: ${what}`);
      }
      expect(failures).toEqual([]);
    });
  }

  for (const theme of ['dark', 'light'] as const) {
    it(`moves hover and pressed with a fill that had to move (${theme})`, () => {
      const moved = ACCENTS.filter((accent) => {
        const ramp = accentRamp(parseHex(accent)!);
        return accentVars(parseHex(accent)!, theme)['--accent'] !== toHex(theme === 'dark' ? ramp.light1 : ramp.dark1);
      });
      expect(moved.length).toBeGreaterThan(0);
      for (const accent of moved) {
        const vars = accentVars(parseHex(accent)!, theme);
        const l = (name: string) => rgbToOklch(parseHex(vars[`--${name}`]!)!).l;
        // Pressed stays darker than the fill, hover lighter.
        expect(l('accent-pressed'), `${accent} pressed`).toBeLessThan(l('accent'));
        expect(l('accent-hover'), `${accent} hover`).toBeGreaterThan(l('accent'));
      }
    });
  }

  it('leaves accents that stand out as they are', () => {
    // Windows' default blue keeps its ramp's shades.
    expect(accentVars(parseHex('#0078d4')!, 'dark')['--accent']).toBe('#3294f3');
    expect(accentVars(parseHex('#0078d4')!, 'light')['--accent']).toBe('#0061ad');
    // Yellow gold's text on light surfaces had 2.6:1: it goes darker, same hue.
    const gold = rgbToOklch(parseHex('#FFB900')!);
    const text = rgbToOklch(parseHex(accentVars(parseHex('#FFB900')!, 'light')['--accent-text']!)!);
    expect(text.l).toBeLessThan(gold.l - 0.16);
    expect(Math.abs(text.h - gold.h)).toBeLessThan(4);
  });
});
