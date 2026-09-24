import { describe, expect, it } from 'vitest';
import * as adjust from './adjust';
import { isColor } from './colormath';
import * as api from './index';
import * as spatial from './spatial';
import { applyFilter, defaultParams, FILTER_CATEGORIES, FILTER_IDS, FILTER_LIST, FILTERS, getFilter, isFilterId, normalizeFilterParams, type FilterId } from './registry';
import { randomPixels } from './test-utils';
import { clonePixels } from './types';

const EXPECTED_IDS = [
  'brightnessContrast',
  'hueSaturation',
  'invert',
  'grayscale',
  'sepia',
  'colorize',
  'duotone',
  'gradientMap',
  'posterize',
  'threshold',
  'blur',
  'sharpen',
  'pixelate',
  'noise',
  'vignette',
  'emboss',
  'sketch',
  'glow',
  'chromaticAberration',
  'levels',
  'autoContrast',
  'opacity',
];

/** Filters that may legitimately change alpha. */
const ALPHA_CHANGING = new Set<FilterId>(['opacity', 'blur', 'pixelate', 'glow', 'chromaticAberration']);

describe('filter registry', () => {
  it('has an entry for every adjustment in the spec, keyed by its id', () => {
    expect([...FILTER_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
    for (const [key, def] of Object.entries(FILTERS)) {
      expect(def.id).toBe(key);
      expect(isFilterId(key)).toBe(true);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(FILTER_CATEGORIES.some((c) => c.id === def.category)).toBe(true);
      expect(typeof def.apply).toBe('function');
    }
    expect(FILTER_LIST).toHaveLength(EXPECTED_IDS.length);
    expect(isFilterId('nope')).toBe(false);
    expect(isFilterId('toString')).toBe(false);
  });

  it('every parameter descriptor is well formed and its default is valid', () => {
    for (const def of FILTER_LIST) {
      const keys = new Set<string>();
      for (const p of def.params) {
        expect(keys.has(p.key)).toBe(false);
        keys.add(p.key);
        expect(p.label.length).toBeGreaterThan(0);
        switch (p.kind) {
          case 'slider':
            expect(p.min).toBeLessThan(p.max);
            expect(p.step).toBeGreaterThan(0);
            expect(p.default).toBeGreaterThanOrEqual(p.min);
            expect(p.default).toBeLessThanOrEqual(p.max);
            break;
          case 'color':
            expect(isColor(p.default)).toBe(true);
            break;
          case 'toggle':
            expect(typeof p.default).toBe('boolean');
            break;
          case 'select':
            expect(p.options.some((o) => o.value === p.default)).toBe(true);
            break;
          case 'gradient':
            expect(p.default.length).toBeGreaterThanOrEqual(p.minStops);
            expect(p.default.every((s) => isColor(s.color) && s.offset >= 0 && s.offset <= 1)).toBe(true);
            break;
        }
        expect((def.defaults as Record<string, unknown>)[p.key]).toEqual(p.default);
      }
      expect(Object.keys(def.defaults).sort()).toEqual([...keys].sort());
    }
  });

  it('runs every filter with its defaults, without touching the input', () => {
    const src = randomPixels(9, 7, 11);
    const copy = clonePixels(src);
    for (const id of FILTER_IDS) {
      const out = applyFilter(id, src, defaultParams(id));
      expect(out.width).toBe(9);
      expect(out.height).toBe(7);
      expect(out.data).toHaveLength(src.data.length);
      expect(out.data).not.toBe(src.data);
      if (!ALPHA_CHANGING.has(id)) {
        for (let i = 3; i < src.data.length; i += 4) expect(out.data[i]).toBe(src.data[i]);
      }
    }
    expect(src.data).toEqual(copy.data);
  });

  it('handles empty and 1×1 images', () => {
    for (const id of FILTER_IDS) {
      expect(applyFilter(id, api.createPixels(0, 0)).data).toHaveLength(0);
      expect(applyFilter(id, api.solidPixels(1, 1, 10, 20, 30, 40)).data).toHaveLength(4);
    }
  });

  it('applyFilter matches calling the function directly', () => {
    const src = randomPixels(8, 8, 3, true);
    expect(applyFilter('blur', src, { radius: 2 }).data).toEqual(spatial.blur(src, { radius: 2 }).data);
    expect(applyFilter('hueSaturation', src, { hue: 40 }).data).toEqual(adjust.hueSaturation(src, { hue: 40 }).data);
    expect(applyFilter('noise', src, { seed: 9 }).data).toEqual(api.noise(src, { seed: 9 }).data);
  });

  it('normalises params: defaults, clamping, rounding, unknown keys dropped', () => {
    expect(normalizeFilterParams('posterize', { levels: 1000 })).toEqual({ levels: 32 });
    expect(normalizeFilterParams('posterize', { levels: 3.6 })).toEqual({ levels: 4 });
    expect(normalizeFilterParams('blur', { radius: -5, bogus: 1 } as never)).toEqual({ radius: 0 });
    expect(normalizeFilterParams('noise', { distribution: 'weird' } as never).distribution).toBe('gaussian');
    expect(normalizeFilterParams('vignette', { color: 'not a colour' }).color).toBe('#000000');
    expect(normalizeFilterParams('sketch', { invert: 'yes' } as never).invert).toBe(true);
    expect(normalizeFilterParams('blur', { radius: Number.NaN })).toEqual({ radius: 4 });
    expect(normalizeFilterParams('blur', 'junk' as never)).toEqual({ radius: 4 });
    expect(normalizeFilterParams('gradientMap', { stops: [{ offset: 0.5, color: '#fff' }] }).stops).toEqual(FILTERS.gradientMap.defaults.stops);
  });

  it('defaultParams returns fresh, mutable copies', () => {
    const a = defaultParams('gradientMap');
    a.stops[0].color = '#123456';
    expect(defaultParams('gradientMap').stops[0].color).not.toBe('#123456');
    expect(Object.isFrozen(FILTERS.gradientMap.defaults)).toBe(true);
    expect(Object.isFrozen(FILTERS.gradientMap.defaults.stops[0])).toBe(true);
    expect(Object.isFrozen(FILTERS.blur.params[0])).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(() => getFilter('nope' as FilterId)).toThrow(RangeError);
    expect(() => applyFilter('nope' as FilterId, randomPixels(2, 2))).toThrow(RangeError);
  });

  /** Best of `runs` wall-clock timings (ms), after one warm-up call. */
  const bestOf = (runs: number, fn: () => unknown): number => {
    fn();
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  it('is fast enough for live preview at 512×512', { timeout: 120_000 }, () => {
    const big = randomPixels(512, 512, 1);
    // Non-identity settings so no filter takes its early-out path.
    const busy: { [K in FilterId]?: Record<string, unknown> } = {
      brightnessContrast: { brightness: 10, contrast: 20 },
      hueSaturation: { hue: 40, saturation: 20, lightness: 10 },
      levels: { gamma: 1.4 },
      opacity: { amount: 50 },
      noise: { monochrome: false },
      glow: { threshold: 0, radius: 64 },
      blur: { radius: 64 },
      sharpen: { radius: 20 },
    };
    const mask = new Uint8Array(512 * 512).fill(128);
    for (const id of FILTER_IDS) {
      const params = { ...defaultParams(id), ...busy[id] };
      // Typically 1–60 ms. The bound only has to catch algorithmic
      // regressions (an O(n·r) blur at r = 64 is 10–60× slower), so it is
      // generous enough for a heavily loaded shared machine.
      expect(bestOf(3, () => applyFilter(id, big, params, mask)), id).toBeLessThan(1500);
    }
  });

  it('spatial filters cost the same at any radius (no O(r) per-pixel work)', () => {
    const img = randomPixels(256, 256, 2);
    const cases: [FilterId, string, number, number][] = [
      ['blur', 'radius', 1, 64],
      ['sharpen', 'radius', 0.5, 20],
      ['glow', 'radius', 1, 64],
      ['pixelate', 'size', 2, 128],
      ['emboss', 'height', 1, 10],
    ];
    for (const [id, key, small, large] of cases) {
      const tSmall = bestOf(4, () => applyFilter(id, img, { [key]: small, threshold: 0 }));
      const tLarge = bestOf(4, () => applyFilter(id, img, { [key]: large, threshold: 0 }));
      // An O(r) implementation would be ~20–60× slower at the large radius.
      expect(tLarge, `${id} ${key}=${large} took ${tLarge.toFixed(1)} ms vs ${tSmall.toFixed(1)} ms`).toBeLessThan(tSmall * 3 + 5);
    }
  });
});
