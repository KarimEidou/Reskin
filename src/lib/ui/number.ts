// Number formatting and snapping for numeric inputs (NumberField, Slider).
// Pure, so the edge cases (trailing zeros, float noise, exponent steps) are
// unit tested in node.

/** Largest number of decimals we ever show or keep. */
const MAX_DECIMALS = 10;

/**
 * Decimal places a value on a `step` grid needs: 1 → 0, 0.25 → 2,
 * 1e-3 → 3, 0.1 + 0.2 → 1 (float noise is ignored).
 */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step === 0) return 0;
  const s = Math.abs(step);
  for (let d = 0; d < MAX_DECIMALS; d++) {
    const scaled = s * 10 ** d;
    if (Math.abs(Math.round(scaled) - scaled) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return MAX_DECIMALS;
}

/**
 * Formats `v` with at most `decimals` places and no trailing zeros
 * (`10` → "10", `2.50` → "2.5", `-0` → "0"). Non-finite values give "".
 */
export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '';
  let s = v.toFixed(Math.min(MAX_DECIMALS, Math.max(0, decimals)));
  // Only a fractional part may lose zeros: "100" must stay "100".
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export interface NumberRange {
  min: number;
  max: number;
  step: number;
}

/** Decimals needed to represent every value of the range's step grid. */
export function rangeDecimals({ min, step }: Pick<NumberRange, 'min' | 'step'>): number {
  return Math.max(stepDecimals(step), Number.isFinite(min) ? stepDecimals(min) : 0);
}

/**
 * Snaps `v` to the step grid anchored at `min` (or 0 when unbounded), then
 * clamps it into [min, max]. Float noise is rounded away. A step ≤ 0 only
 * clamps. NaN stays NaN.
 */
export function snapToStep(v: number, { min, max, step }: NumberRange): number {
  if (Number.isNaN(v)) return v;
  if (!(step > 0) || !Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  const base = Number.isFinite(min) ? min : 0;
  const snapped = base + Math.round((v - base) / step) * step;
  const clamped = Math.min(max, Math.max(min, snapped));
  return Number(clamped.toFixed(rangeDecimals({ min, step })));
}
