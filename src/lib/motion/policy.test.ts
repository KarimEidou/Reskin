import { describe, expect, it } from 'vitest';
import { clampSpeed, resolveMotion, scaleDuration, REDUCED_FADE_MS } from './policy';
import { cubicBezier, ease, linearEasing } from './easing';

describe('resolveMotion', () => {
  it('follows the system signals only in system mode', () => {
    expect(resolveMotion('system', 1, false, false).reduced).toBe(false);
    expect(resolveMotion('system', 1, true, false).reduced).toBe(true);
    expect(resolveMotion('system', 1, false, true).reduced).toBe(true);
    expect(resolveMotion('full', 1, true, true).reduced).toBe(false);
    expect(resolveMotion('reduced', 1, false, false).reduced).toBe(true);
  });

  it('clamps the speed multiplier', () => {
    expect(resolveMotion('full', 5, false, false).speed).toBe(2);
    expect(clampSpeed(0.1)).toBe(0.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });
});

describe('scaleDuration', () => {
  it('divides by the speed multiplier', () => {
    expect(scaleDuration(400, { speed: 2, reduced: false })).toBe(200);
    expect(scaleDuration(400, { speed: 0.5, reduced: false })).toBe(800);
    expect(scaleDuration(-5, { speed: 1, reduced: false })).toBe(0);
  });

  it('removes movement but keeps short fades when reduced', () => {
    expect(scaleDuration(400, { speed: 1, reduced: true })).toBe(0);
    expect(scaleDuration(400, { speed: 1, reduced: true }, 'fade')).toBe(REDUCED_FADE_MS);
    expect(scaleDuration(80, { speed: 1, reduced: true }, 'fade')).toBe(80);
    expect(scaleDuration(400, { speed: 2, reduced: true }, 'fade')).toBe(REDUCED_FADE_MS / 2);
  });

  it('keeps hold times under reduced motion', () => {
    expect(scaleDuration(900, { speed: 1, reduced: true }, 'hold')).toBe(900);
    expect(scaleDuration(900, { speed: 2, reduced: false }, 'hold')).toBe(450);
  });
});

describe('easing', () => {
  it('evaluates cubic-bezier curves like CSS', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const t of [0, 0.1, 0.5, 0.9, 1]) expect(linear(t)).toBeCloseTo(t, 6);
    // `ease` (0.25, 0.1, 0.25, 1) at 50 % is ≈ 0.8024 in browsers.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(ease.standard(0)).toBe(0);
    expect(ease.standard(1)).toBe(1);
    expect(ease.overshoot(0.6)).toBeGreaterThan(1);
  });

  it('samples functions into CSS linear()', () => {
    expect(linearEasing((t) => t, 3)).toBe('linear(0, 0.5, 1)');
  });
});
