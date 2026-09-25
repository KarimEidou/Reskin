import { describe, expect, it } from 'vitest';
import {
  accentRamp,
  contrast,
  luminance,
  oklchToRgb,
  parseHex,
  readableOn,
  rgbToOklch,
  rgbTriplet,
  toHex,
  withContrast,
  withLightness,
} from './color';
import { accentVars, effectiveAccent, resolveTheme, BRAND_ACCENT } from './theme';

describe('hex', () => {
  it('parses short, long and alpha forms', () => {
    expect(parseHex('#0078d4')).toEqual({ r: 0, g: 120, b: 212 });
    expect(parseHex('fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#11223344')).toEqual({ r: 0x11, g: 0x22, b: 0x33 });
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('blue')).toBeNull();
  });

  it('formats', () => {
    expect(toHex({ r: 0, g: 120.4, b: 300 })).toBe('#0078ff');
    expect(rgbTriplet({ r: 1.4, g: 2.6, b: 3 })).toBe('1 3 3');
  });
});

describe('oklch', () => {
  it('round-trips sRGB colours', () => {
    for (const hex of ['#0078d4', '#7c5cff', '#ff7ab6', '#000000', '#ffffff', '#808080', '#1fc8e3']) {
      const rgb = parseHex(hex)!;
      expect(toHex(oklchToRgb(rgbToOklch(rgb)))).toBe(hex);
    }
  });

  it('matches reference values', () => {
    const white = rgbToOklch({ r: 255, g: 255, b: 255 });
    expect(white.l).toBeCloseTo(1, 4);
    expect(white.c).toBeCloseTo(0, 4);
    const red = rgbToOklch({ r: 255, g: 0, b: 0 });
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
  });

  it('maps out-of-gamut colours back by reducing chroma', () => {
    const rgb = oklchToRgb({ l: 0.9, c: 0.4, h: 264 });
    for (const v of [rgb.r, rgb.g, rgb.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
    expect(rgbToOklch(rgb).l).toBeCloseTo(0.9, 2);
  });
});

describe('contrast', () => {
  it('computes WCAG values', () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 6);
    expect(readableOn(parseHex('#0078d4')!)).toEqual({ r: 255, g: 255, b: 255 });
    expect(readableOn(parseHex('#99ebff')!)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('moves a colour just far enough for a contrast', () => {
    const surface = parseHex('#eceef2')!;
    const gold = parseHex('#c08a00')!;
    expect(contrast(gold, surface)).toBeLessThan(4.5);
    const text = withContrast(gold, surface, 4.5, 'darker');
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    // Just far enough: a step less would not do.
    expect(contrast(withLightness(text, rgbToOklch(text).l + 0.01), surface)).toBeLessThan(4.5);
    expect(Math.abs(rgbToOklch(text).h - rgbToOklch(gold).h)).toBeLessThan(4);
    expect(Object.values(text).every(Number.isInteger)).toBe(true);

    const dark = parseHex('#23262e')!;
    const grey = parseHex('#656361')!;
    expect(contrast(grey, dark)).toBeLessThan(3);
    const fill = withContrast(grey, dark, 3, 'lighter');
    expect(contrast(fill, dark)).toBeGreaterThanOrEqual(3);
    expect(rgbToOklch(fill).l).toBeGreaterThan(rgbToOklch(grey).l);
  });

  it('keeps a colour that has the contrast, and gives what it can when none has', () => {
    const blue = parseHex('#0078d4')!;
    expect(withContrast(blue, parseHex('#ffffff')!, 4.5, 'darker')).toBe(blue);
    // Nothing lighter than mid-grey has 7:1 against it: white is the most.
    expect(withContrast(parseHex('#999999')!, parseHex('#777777')!, 7, 'lighter')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('accent ramp', () => {
  it('steps lightness evenly and keeps the hue', () => {
    const base = parseHex('#0078d4')!;
    const ramp = accentRamp(base);
    const l = (k: keyof typeof ramp) => rgbToOklch(ramp[k]).l;
    expect(l('light1')).toBeGreaterThan(l('base'));
    expect(l('light2')).toBeGreaterThan(l('light1'));
    expect(l('light3')).toBeGreaterThan(l('light2'));
    expect(l('dark1')).toBeLessThan(l('base'));
    expect(l('dark3')).toBeLessThan(l('dark2'));
    const hue = rgbToOklch(base).h;
    for (const k of ['light1', 'light3', 'dark1', 'dark3', 'vivid'] as const) {
      expect(Math.abs(rgbToOklch(ramp[k]).h - hue)).toBeLessThan(4);
    }
  });

  it('never invents a hue for grey accents', () => {
    expect(rgbToOklch(accentRamp(parseHex('#777777')!).vivid).c).toBeLessThan(0.01);
  });
});

describe('theme resolution', () => {
  it('resolves system mode from the colour scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls back to the brand accent', () => {
    expect(effectiveAccent(false, '#0078d4')).toEqual(parseHex(BRAND_ACCENT));
    expect(effectiveAccent(true, null)).toEqual(parseHex(BRAND_ACCENT));
    expect(effectiveAccent(true, 'nonsense')).toEqual(parseHex(BRAND_ACCENT));
    expect(effectiveAccent(true, '#0078d4')).toEqual(parseHex('#0078d4'));
  });

  it('derives legible accent variables for both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const vars = accentVars(parseHex('#0078d4')!, theme);
      expect(vars['--accent-base']).toBe('#0078d4');
      expect(vars['--accent-rgb']).toMatch(/^\d+ \d+ \d+$/);
      const fill = parseHex(vars['--accent']!)!;
      const on = parseHex(vars['--on-accent']!)!;
      expect(contrast(fill, on)).toBeGreaterThanOrEqual(4.5);
    }
    // Dark theme fills are lighter than light theme fills.
    const dark = rgbToOklch(parseHex(accentVars(parseHex('#0078d4')!, 'dark')['--accent']!)!).l;
    const light = rgbToOklch(parseHex(accentVars(parseHex('#0078d4')!, 'light')['--accent']!)!).l;
    expect(dark).toBeGreaterThan(light);
  });
});
