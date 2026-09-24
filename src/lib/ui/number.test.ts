import { describe, expect, it } from 'vitest';
import { formatNumber, rangeDecimals, snapToStep, stepDecimals } from './number';

describe('stepDecimals', () => {
  it('counts the decimals of a step, ignoring float noise', () => {
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(10)).toBe(0);
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(0.1 + 0.2)).toBe(1);
    expect(stepDecimals(1e-3)).toBe(3);
    expect(stepDecimals(-0.05)).toBe(2);
    expect(stepDecimals(0)).toBe(0);
    expect(stepDecimals(Number.NaN)).toBe(0);
  });
});

describe('formatNumber', () => {
  it('keeps the zeros of whole numbers', () => {
    // Regression: a trailing-zero strip used to turn 10 into "1" and 200 into "2".
    expect(formatNumber(10, 0)).toBe('10');
    expect(formatNumber(200, 0)).toBe('200');
    expect(formatNumber(0, 0)).toBe('0');
    expect(formatNumber(100, 2)).toBe('100');
  });

  it('drops only trailing zeros of the fraction', () => {
    expect(formatNumber(2.5, 2)).toBe('2.5');
    expect(formatNumber(2.05, 2)).toBe('2.05');
    expect(formatNumber(10.0, 1)).toBe('10');
    expect(formatNumber(1 / 3, 3)).toBe('0.333');
  });

  it('never shows negative zero or non-finite values', () => {
    expect(formatNumber(-0, 0)).toBe('0');
    expect(formatNumber(-0.0001, 2)).toBe('0');
    expect(formatNumber(Number.POSITIVE_INFINITY, 0)).toBe('');
    expect(formatNumber(Number.NaN, 2)).toBe('');
  });
});

describe('snapToStep', () => {
  it('snaps to the grid anchored at min and clamps', () => {
    expect(snapToStep(7.4, { min: 0, max: 100, step: 5 })).toBe(5);
    expect(snapToStep(7.6, { min: 0, max: 100, step: 5 })).toBe(10);
    expect(snapToStep(150, { min: 0, max: 100, step: 5 })).toBe(100);
    expect(snapToStep(-3, { min: 0, max: 100, step: 5 })).toBe(0);
    expect(snapToStep(2, { min: 0.5, max: 10, step: 1 })).toBe(2.5);
  });

  it('rounds float noise away', () => {
    expect(snapToStep(0.1 + 0.2, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    expect(snapToStep(0.7, { min: 0, max: 2, step: 0.05 })).toBe(0.7);
  });

  it('works unbounded and without a step', () => {
    const open = { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, step: 1 };
    expect(snapToStep(-12.6, open)).toBe(-13);
    expect(snapToStep(3.14159, { min: 0, max: 10, step: 0 })).toBe(3.14159);
    expect(Number.isNaN(snapToStep(Number.NaN, open))).toBe(true);
  });

  it('keeps the min offset decimals', () => {
    expect(rangeDecimals({ min: 0.5, step: 1 })).toBe(1);
    expect(rangeDecimals({ min: Number.NEGATIVE_INFINITY, step: 0.25 })).toBe(2);
  });
});
