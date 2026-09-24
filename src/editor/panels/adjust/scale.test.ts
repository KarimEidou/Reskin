import { describe, expect, it } from 'vitest';
import { getFilter } from '$engine/filters';
import type { SliderParamSpec } from '$engine/filters/params';
import { getHelper, type ControlSpec } from './helper-defs';
import { scaleParams } from './scale';

const slider = (params: readonly ControlSpec[], key: string) =>
  params.find((p): p is SliderParamSpec => p.kind === 'slider' && p.key === key)!;

describe('scaleParams', () => {
  it('leaves the master size (and anything larger) alone', () => {
    const params = getFilter('blur').params;
    expect(scaleParams(params, 512)).toEqual(params);
    expect(scaleParams(params, 1024)).toEqual(params);
  });

  it('scales px defaults and ranges with a pixel-art document', () => {
    // Blur 4 px of 512 is 0.25 px of 32: the smallest step that blurs.
    expect(slider(scaleParams(getFilter('blur').params, 32), 'radius')).toMatchObject({ min: 0, max: 4, step: 0.5, default: 0.5 });
    // Glow 12 px of 512 is 1.5 px of 64.
    expect(slider(scaleParams(getFilter('glow').params, 64), 'radius')).toMatchObject({ max: 8, default: 1.5 });
    // Pixelate: a block of 1 px changes nothing, so 2 at least.
    expect(slider(scaleParams(getFilter('pixelate').params, 16), 'size')).toMatchObject({ min: 1, max: 4, default: 2 });
    expect(slider(scaleParams(getFilter('pixelate').params, 64), 'size')).toMatchObject({ max: 16, default: 2 });
    expect(slider(scaleParams(getFilter('chromaticAberration').params, 16), 'amount')).toMatchObject({ max: 1, default: 0.5 });
    expect(slider(scaleParams(getFilter('sharpen').params, 16), 'radius')).toMatchObject({ min: 0.1, max: 0.6, default: 0.2 });
    // The relief keeps its 1 px floor; one step above it shows.
    expect(slider(scaleParams(getFilter('emboss').params, 16), 'height')).toMatchObject({ min: 1, max: 1.5, default: 1.5 });
    // Helpers too: feathering the removed background.
    expect(slider(scaleParams(getHelper('removeBackground').params, 24), 'feather')).toMatchObject({ max: 1, default: 0.5 });
  });

  it('keeps every other setting as it is', () => {
    const sharpen = getFilter('sharpen').params;
    const scaled = scaleParams(sharpen, 16);
    expect(slider(scaled, 'amount')).toEqual(slider(sharpen, 'amount'));
    expect(slider(scaled, 'threshold')).toEqual(slider(sharpen, 'threshold'));
    const round = getHelper('roundCorners').params;
    expect(scaleParams(round, 16)).toEqual(round);
  });

  it('keeps each default within its (scaled) range and on the step grid', () => {
    for (const size of [16, 24, 32, 48, 64]) {
      for (const id of ['blur', 'sharpen', 'pixelate', 'emboss', 'glow', 'chromaticAberration'] as const) {
        for (const p of scaleParams(getFilter(id).params, size)) {
          if (p.kind !== 'slider') continue;
          const at = `${id}.${p.key} @${size}`;
          expect(p.default, at).toBeGreaterThanOrEqual(p.min);
          expect(p.default, at).toBeLessThanOrEqual(p.max);
          const steps = (p.default - p.min) / p.step;
          expect(Math.abs(steps - Math.round(steps)), at).toBeLessThan(1e-9);
        }
      }
    }
  });
});
