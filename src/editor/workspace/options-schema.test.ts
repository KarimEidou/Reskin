import { describe, expect, it } from 'vitest';
import { Engine, TOOL_ORDER, type ToolId } from '$engine/index';
import {
  choiceKey,
  choiceValue,
  formatOption,
  fromDisplay,
  fromSliderPos,
  keyStep,
  LOG_STEPS,
  SHAPE_CHOICES,
  sliderRange,
  toDisplay,
  toSliderPos,
  TOOL_OPTION_SPECS,
  visibleSpecs,
  type ChoiceSpec,
  type SliderSpec,
} from './options-schema';

const engine = new Engine();

describe('TOOL_OPTION_SPECS', () => {
  it('covers every tool', () => {
    for (const id of TOOL_ORDER) expect(TOOL_OPTION_SPECS[id]).toBeDefined();
  });

  it('only names options the engine has, with defaults inside the ranges', () => {
    for (const id of TOOL_ORDER) {
      const defaults = engine.getToolOptions(id) as unknown as Record<string, unknown>;
      for (const spec of TOOL_OPTION_SPECS[id as ToolId]) {
        expect(defaults, `${id}.${spec.key}`).toHaveProperty(spec.key);
        const v = defaults[spec.key];
        if (spec.kind === 'slider') {
          expect(typeof v).toBe('number');
          expect(v as number).toBeGreaterThanOrEqual(spec.min);
          expect(v as number).toBeLessThanOrEqual(spec.max);
        } else if (spec.kind === 'toggle') {
          expect(typeof v).toBe('boolean');
        } else {
          expect(spec.options.map((o) => o.value), `${id}.${spec.key}`).toContain(choiceKey(v));
        }
      }
    }
  });

  it('lists every shape kind', () => {
    expect(SHAPE_CHOICES.map((c) => c.value).sort()).toEqual(
      ['arrow', 'ellipse', 'heart', 'line', 'polygon', 'rect', 'roundedRect', 'squircle', 'star'].sort(),
    );
  });

  it('shows conditional options only when they apply', () => {
    const shape = TOOL_OPTION_SPECS.shape;
    const labels = (o: Record<string, unknown>) => visibleSpecs(shape, o).map((s) => s.label);
    expect(labels({ kind: 'roundedRect', stroke: false })).toContain('Corners');
    expect(labels({ kind: 'rect', stroke: false })).not.toContain('Corners');
    expect(labels({ kind: 'rect', stroke: false })).not.toContain('Width');
    expect(labels({ kind: 'rect', stroke: true })).toContain('Width');
    expect(labels({ kind: 'line', stroke: false })).toContain('Width');
    expect(labels({ kind: 'star', stroke: false })).toEqual(expect.arrayContaining(['Points', 'Inner radius']));
    expect(labels({ kind: 'polygon', stroke: false })).toContain('Sides');
    const pencil = (o: Record<string, unknown>) => visibleSpecs(TOOL_OPTION_SPECS.pencil, o).map((s) => s.key);
    expect(pencil({ size: 1 })).toContain('pixelPerfect');
    expect(pencil({ size: 3 })).not.toContain('pixelPerfect');
  });
});

describe('slider maths', () => {
  const size: SliderSpec = { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 512, step: 1, unit: 'px', log: true, priority: 1 };
  const pct: SliderSpec = { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 1 };
  const tol: SliderSpec = { kind: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1, priority: 1 };

  it('converts percentages for display and back', () => {
    expect(toDisplay(pct, 0.8)).toBe(80);
    expect(fromDisplay(pct, 80)).toBe(0.8);
    expect(fromDisplay(pct, 33.4)).toBe(0.33);
    expect(fromDisplay(pct, 150)).toBe(1);
    expect(fromDisplay(pct, -5)).toBe(0);
    expect(fromDisplay(pct, Number.NaN)).toBe(0);
  });

  it('uses a logarithmic travel for sizes, round-tripping on the step', () => {
    expect(sliderRange(size)).toEqual({ min: 0, max: LOG_STEPS, step: 1 });
    expect(toSliderPos(size, 1)).toBe(0);
    expect(toSliderPos(size, 512)).toBe(LOG_STEPS);
    expect(fromSliderPos(size, 0)).toBe(1);
    expect(fromSliderPos(size, LOG_STEPS)).toBe(512);
    for (const v of [1, 2, 8, 24, 100]) expect(fromSliderPos(size, toSliderPos(size, v))).toBe(v);
    // Big sizes are within one slider step (exact values are typed).
    expect(Math.abs(fromSliderPos(size, toSliderPos(size, 300)) - 300)).toBeLessThanOrEqual(2);
    // Small sizes get most of the travel.
    expect(toSliderPos(size, 24)).toBeGreaterThan(LOG_STEPS / 2);
  });

  it('keeps linear sliders in display units', () => {
    expect(sliderRange(pct)).toEqual({ min: 0, max: 100, step: 1 });
    expect(toSliderPos(pct, 0.5)).toBe(50);
    expect(fromSliderPos(pct, 50)).toBe(0.5);
    expect(toSliderPos(tol, 999)).toBe(255);
    expect(fromSliderPos(tol, 31.6)).toBe(32);
  });

  it('steps the value with keys, even on log sliders', () => {
    expect(keyStep(size, 24, 'ArrowRight')).toBe(25);
    expect(keyStep(size, 24, 'ArrowLeft')).toBe(23);
    expect(keyStep(size, 24, 'ArrowUp', true)).toBe(34);
    expect(keyStep(size, 24, 'PageDown')).toBe(14);
    expect(keyStep(size, 1, 'ArrowDown')).toBe(1);
    expect(keyStep(size, 24, 'Home')).toBe(1);
    expect(keyStep(size, 24, 'End')).toBe(512);
    expect(keyStep(pct, 0.8, 'ArrowRight')).toBe(0.81);
    expect(keyStep(pct, 1, 'ArrowRight')).toBe(1);
    expect(keyStep(size, 24, 'Enter')).toBeNull();
  });

  it('formats with units', () => {
    expect(formatOption(size, 24)).toBe('24 px');
    expect(formatOption(pct, 0.8)).toBe('80%');
    expect(formatOption(tol, 32)).toBe('32');
  });
});

describe('choices', () => {
  const size: ChoiceSpec = { kind: 'choice', key: 'size', label: 'Sample size', numeric: true, options: [], priority: 1 };
  const flag: ChoiceSpec = { kind: 'choice', key: 'zoomOut', label: 'Click to', options: [], priority: 1 };
  const text: ChoiceSpec = { kind: 'choice', key: 'sample', label: 'Sample', options: [], priority: 1 };

  it('parses values back into the option type', () => {
    expect(choiceValue(size, '3')).toBe(3);
    expect(choiceValue(flag, 'true')).toBe(true);
    expect(choiceValue(flag, 'false')).toBe(false);
    expect(choiceValue(text, 'layer')).toBe('layer');
    expect(choiceKey(3)).toBe('3');
    expect(choiceKey(false)).toBe('false');
  });
});
