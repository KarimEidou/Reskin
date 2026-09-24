import { describe, expect, it } from 'vitest';
import { OneEuroFilter, OneEuroFilter2D, smoothingToOneEuro } from './one-euro';
import { StrokeSampler } from './stroke-sampler';
import { coalescedEvents, toPointerInputs } from './coalesced';
import type { PointerEventLike } from './coalesced';
import { normalizePressure, pointerInput } from './pointer';
import { seededRandom } from '../test-helpers';

function variance(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

describe('1€ filter', () => {
  it('suppresses jitter on a slow/still signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.01, dCutoff: 1 });
    const r = seededRandom(3);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 400; i++) {
      const v = 100 + (r() - 0.5) * 4; // ±2 px jitter around 100
      raw.push(v);
      out.push(f.filter(v, i * 8));
    }
    const settle = 100;
    expect(variance(out.slice(settle))).toBeLessThan(variance(raw.slice(settle)) / 10);
    expect(Math.abs(out[out.length - 1] - 100)).toBeLessThan(1);
  });

  it('lags less on fast motion with a higher beta', () => {
    const lagFor = (beta: number) => {
      const f = new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      let v = 0;
      for (let i = 0; i <= 60; i++) v = f.filter(i * 20, i * 8); // 2500 px/s ramp
      return 1200 - v;
    };
    expect(lagFor(0.05)).toBeLessThan(lagFor(0) / 5);
    expect(lagFor(0)).toBeGreaterThan(0);
  });

  it('passes the first sample through and tolerates repeated timestamps', () => {
    const f = new OneEuroFilter2D({ minCutoff: 1, beta: 0, dCutoff: 1 });
    expect(f.filter(5, 6, 100)).toEqual({ x: 5, y: 6 });
    const p = f.filter(15, 6, 100);
    expect(p.x).toBeGreaterThan(5);
    expect(p.x).toBeLessThan(15);
    f.reset();
    expect(f.filter(50, 50, 0)).toEqual({ x: 50, y: 50 });
  });

  it('maps the smoothing amount', () => {
    expect(smoothingToOneEuro(0)).toBeNull();
    const lo = smoothingToOneEuro(0.1)!;
    const hi = smoothingToOneEuro(1)!;
    expect(hi.minCutoff).toBeLessThan(lo.minCutoff);
    expect(hi.minCutoff).toBeCloseTo(0.5, 10);
  });
});

describe('StrokeSampler', () => {
  const pt = (x: number, y: number, pressure = 1) => ({ x, y, pressure, tiltX: 0, tiltY: 0 });

  it('places dabs at exact spacing along the path', () => {
    const s = new StrokeSampler(() => 2.5);
    expect(s.begin(pt(0, 0))).toHaveLength(1);
    const dabs = s.add(pt(100, 0));
    expect(dabs).toHaveLength(40);
    dabs.forEach((d, i) => expect(d.x).toBeCloseTo(2.5 * (i + 1), 9));
    expect(dabs[39].distance).toBeCloseTo(100, 9);
  });

  it('carries leftover distance across segments', () => {
    const s = new StrokeSampler(() => 10);
    s.begin(pt(0, 0));
    expect(s.add(pt(6, 0))).toHaveLength(0);
    const d = s.add(pt(6, 8)); // 8 more px along y; next dab 4 px into this segment
    expect(d).toHaveLength(1);
    expect(d[0].x).toBeCloseTo(6, 9);
    expect(d[0].y).toBeCloseTo(4, 9);
    expect(s.distance).toBeCloseTo(14, 9);
  });

  it('interpolates pressure and adapts spacing', () => {
    const s = new StrokeSampler((d) => 1 + d.pressure * 9);
    s.begin(pt(0, 0, 0));
    const dabs = s.add(pt(100, 0, 1));
    expect(dabs[0].x).toBeCloseTo(1, 9);
    expect(dabs[0].pressure).toBeCloseTo(0.01, 9);
    // Spacing grows with pressure: gaps increase along the stroke.
    const gaps = dabs.slice(1).map((d, i) => d.x - dabs[i].x);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
  });

  it('is deterministic', () => {
    const run = () => {
      const s = new StrokeSampler((d) => 0.5 + d.pressure);
      const out = s.begin(pt(1, 1, 0.2));
      out.push(...s.add(pt(40, 17, 0.9)), ...s.add(pt(-3, 60, 0.4)));
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('pointer helpers', () => {
  it('normalizes pressure per device', () => {
    expect(normalizePressure('mouse', 0.5)).toBe(1);
    expect(normalizePressure('pen', 0.3)).toBe(0.3);
    expect(normalizePressure('pen', 2)).toBe(1);
    expect(pointerInput({ x: 1, y: 2 }).modifiers.shift).toBe(false);
  });

  it('expands coalesced events into document samples', () => {
    const base: PointerEventLike = {
      clientX: 10,
      clientY: 20,
      pressure: 0.4,
      tiltX: 5,
      tiltY: -5,
      timeStamp: 100,
      button: -1,
      pointerType: 'pen',
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    };
    const e: PointerEventLike = {
      ...base,
      getCoalescedEvents: () => [
        { ...base, clientX: 8, timeStamp: 96, shiftKey: false },
        { ...base, clientX: 10, timeStamp: 100, shiftKey: false },
      ],
    };
    expect(coalescedEvents(e)).toHaveLength(2);
    const map = (x: number, y: number) => ({ x: x / 2, y: y / 2, screenX: x, screenY: y });
    const ps = toPointerInputs(e, map, 0);
    expect(ps.map((p) => p.x)).toEqual([4, 5]);
    expect(ps[0]).toMatchObject({ pressure: 0.4, pointerType: 'pen', button: 0, screenX: 8, time: 96 });
    expect(ps.every((p) => p.modifiers.shift)).toBe(true);
  });
});
