// CSS previews of gradient stops (unit tested).

import { toCssRgb, type GradientStop } from '$engine/index';

/** `linear-gradient(to right, …)` for stops in any order (sorted, offsets clamped). */
export function gradientCss(stops: readonly GradientStop[]): string {
  if (stops.length === 0) return 'linear-gradient(to right, transparent, transparent)';
  const sorted = [...stops]
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color }))
    .sort((a, b) => a.offset - b.offset);
  const parts = sorted.map((s) => `${toCssRgb(s.color)} ${round(s.offset * 100)}%`);
  if (parts.length === 1) parts.push(parts[0]!);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
