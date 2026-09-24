import { describe, expect, it } from 'vitest';
import {
  createSpring,
  springEasing,
  springKeyframes,
  SPRINGS,
  type SpringParams,
} from './spring';

/** Reference solution: RK4 integration of m·x'' = −k·(x − 1) − c·x'. */
function integrate(p: SpringParams, until: number, dt = 1e-4): Array<[number, number, number]> {
  let x = 0;
  let v = p.velocity;
  const acc = (xx: number, vv: number) => (-p.stiffness * (xx - 1) - p.damping * vv) / p.mass;
  const out: Array<[number, number, number]> = [];
  const steps = Math.round(until / dt);
  for (let i = 0; i <= steps; i++) {
    if (i % 100 === 0) out.push([i * dt, x, v]);
    const k1x = v;
    const k1v = acc(x, v);
    const k2x = v + (dt / 2) * k1v;
    const k2v = acc(x + (dt / 2) * k1x, v + (dt / 2) * k1v);
    const k3x = v + (dt / 2) * k2v;
    const k3v = acc(x + (dt / 2) * k2x, v + (dt / 2) * k2v);
    const k4x = v + dt * k3v;
    const k4v = acc(x + dt * k3x, v + dt * k3v);
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return out;
}

const CASES: Record<string, SpringParams> = {
  underdamped: { stiffness: 300, damping: 12, mass: 1, velocity: 0 },
  critical: { stiffness: 100, damping: 20, mass: 1, velocity: 0 },
  overdamped: { stiffness: 100, damping: 45, mass: 2, velocity: 0 },
  withVelocity: { stiffness: 250, damping: 18, mass: 1.5, velocity: 6 },
  criticalWithVelocity: { stiffness: 400, damping: 40, mass: 1, velocity: -3 },
};

describe('createSpring', () => {
  for (const [name, params] of Object.entries(CASES)) {
    it(`matches numeric integration (${name})`, () => {
      const spring = createSpring(params);
      for (const [t, x, v] of integrate(params, 1.5)) {
        expect(spring.position(t)).toBeCloseTo(x, 5);
        expect(spring.velocity(t)).toBeCloseTo(v, 3);
      }
    });
  }

  it('classifies damping', () => {
    expect(createSpring(CASES.underdamped).dampingRatio).toBeLessThan(1);
    expect(createSpring(CASES.critical).dampingRatio).toBeCloseTo(1, 9);
    expect(createSpring(CASES.overdamped).dampingRatio).toBeGreaterThan(1);
  });

  it('starts at 0 with the initial velocity and ends at 1', () => {
    const s = createSpring(CASES.withVelocity);
    expect(s.position(0)).toBe(0);
    expect(s.velocity(0)).toBe(6);
    expect(s.position(10)).toBeCloseTo(1, 9);
  });

  it('overshoots only when underdamped', () => {
    const peak = (p: SpringParams) => {
      const s = createSpring(p);
      let max = 0;
      for (let t = 0; t < 3; t += 0.001) max = Math.max(max, s.position(t));
      return max;
    };
    expect(peak(CASES.underdamped)).toBeGreaterThan(1.3);
    expect(peak(CASES.critical)).toBeLessThanOrEqual(1);
    expect(peak(CASES.overdamped)).toBeLessThanOrEqual(1);
  });

  it('rejects invalid parameters', () => {
    expect(() => createSpring({ stiffness: 0 })).toThrow(RangeError);
    expect(() => createSpring({ mass: -1 })).toThrow(RangeError);
    expect(() => createSpring({ damping: -1 })).toThrow(RangeError);
    expect(() => createSpring({ velocity: Number.NaN })).toThrow(RangeError);
  });
});

describe('settleTime', () => {
  for (const [name, params] of Object.entries({ ...CASES, ...SPRINGS })) {
    it(`is the exact moment the spring comes to rest (${name})`, () => {
      const s = createSpring(params);
      const rest = { restDelta: 0.001, restSpeed: 0.01 };
      const T = s.settleTime(rest);
      const moving = (t: number) =>
        Math.abs(1 - s.position(t)) > rest.restDelta || Math.abs(s.velocity(t)) > rest.restSpeed;
      // Never moving again after T…
      for (let t = T; t < T * 4 + 1; t += 0.0005) expect(moving(t)).toBe(false);
      // …but still moving within the last 2 ms before it.
      let movedLate = false;
      for (let t = T - 0.002; t < T; t += 0.0001) movedLate ||= moving(t);
      expect(movedLate).toBe(true);
    });
  }

  it('grows as the tolerance tightens', () => {
    const s = createSpring(SPRINGS.morph);
    expect(s.settleTime({ restDelta: 1e-4, restSpeed: 1e-3 })).toBeGreaterThan(s.settleTime());
  });

  it('pins the preset durations', () => {
    const ms = (p: SpringParams) => createSpring(p).settleTime() * 1000;
    expect(ms(SPRINGS.morph)).toBeGreaterThan(440);
    expect(ms(SPRINGS.morph)).toBeLessThan(520);
    expect(ms(SPRINGS.snappy)).toBeLessThan(ms(SPRINGS.morph));
    expect(ms(SPRINGS.gentle)).toBeGreaterThan(ms(SPRINGS.morph));
  });
});

describe('springKeyframes', () => {
  it('samples from → to with an exact end frame and the settle duration', () => {
    const { keyframes, duration } = springKeyframes(10, 110, {
      ...SPRINGS.morph,
      render: (v) => ({ transform: `translateX(${v}px)` }),
    });
    const settle = createSpring(SPRINGS.morph).settleTime() * 1000;
    expect(duration).toBeCloseTo(settle, 6);
    expect(keyframes.length).toBe(Math.ceil(duration / (1000 / 60)) + 1);
    expect(keyframes[0]).toEqual({ transform: 'translateX(10px)', offset: 0 });
    expect(keyframes.at(-1)).toEqual({ transform: 'translateX(110px)', offset: 1 });
    const offsets = keyframes.map((k) => k.offset as number);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
  });

  it('keeps vector components in step and follows the spring curve', () => {
    const spring = createSpring(SPRINGS.bouncy);
    const seen: Array<[number[], number]> = [];
    const { keyframes } = springKeyframes([0, 100], [50, 0], {
      ...SPRINGS.bouncy,
      render: (v, p) => {
        seen.push([v, p]);
        return { opacity: String(v[0]! / 50) };
      },
    });
    expect(seen).toHaveLength(keyframes.length);
    const settle = spring.settleTime();
    seen.forEach(([[a, b], p], i) => {
      expect(a).toBeCloseTo(50 * p, 9);
      expect(b).toBeCloseTo(100 - 100 * p, 9);
      if (i < seen.length - 1) {
        expect(p).toBeCloseTo(spring.position((i / (seen.length - 1)) * settle), 9);
      }
    });
    // The bouncy preset overshoots on the way.
    expect(Math.max(...seen.map(([, p]) => p))).toBeGreaterThan(1.05);
  });

  it('scales its timeline and sampling', () => {
    const base = springKeyframes(0, 1, { render: (v) => ({ opacity: String(v) }) });
    const slow = springKeyframes(0, 1, { timeScale: 2, render: (v) => ({ opacity: String(v) }) });
    const coarse = springKeyframes(0, 1, { frameMs: 50, render: (v) => ({ opacity: String(v) }) });
    expect(slow.duration).toBeCloseTo(base.duration * 2, 6);
    expect(slow.keyframes.length).toBeGreaterThan(base.keyframes.length);
    expect(coarse.keyframes.length).toBe(Math.ceil(base.duration / 50) + 1);
    expect(() => springKeyframes(0, 1, { timeScale: 0, render: () => ({}) })).toThrow(RangeError);
    expect(() => springKeyframes([0], [1, 2], { render: () => ({}) })).toThrow(RangeError);
  });
});

describe('springEasing', () => {
  it('produces a CSS linear() curve from 0 to 1', () => {
    const { easing, duration } = springEasing(SPRINGS.snappy);
    expect(easing.startsWith('linear(0, ')).toBe(true);
    expect(easing.endsWith(', 1)')).toBe(true);
    expect(duration).toBeCloseTo(createSpring(SPRINGS.snappy).settleTime() * 1000, 6);
    expect(springEasing(SPRINGS.snappy, { timeScale: 0.5 }).duration).toBeCloseTo(duration / 2, 6);
  });
});
