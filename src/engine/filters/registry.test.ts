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

  it('is fast enough for live preview at 512×512', () => {
    const big = randomPixels(512, 512, 1);
    const times: Record<string, number> = {};
    for (const id of FILTER_IDS) {
      const t = performance.now();
      applyFilter(id, big, defaultParams(id));
      times[id] = performance.now() - t;
    }
    // Generous guard against accidental O(n·r) or per-pixel allocation regressions.
    for (const [id, ms] of Object.entries(times)) expect(ms, id).toBeLessThan(2500);
  });
});
