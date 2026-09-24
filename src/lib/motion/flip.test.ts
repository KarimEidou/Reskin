import { beforeEach, describe, expect, it, vi } from 'vitest';

// The live motion state is a Svelte rune module; replace it with a plain
// object the tests control.
const state = vi.hoisted(() => ({ speed: 1, reduced: false }));
vi.mock('./speed.svelte', async () => {
  const { scaleDuration } = await import('./policy');
  return { motion: state, dur: (ms: number, kind?: 'motion' | 'fade') => scaleDuration(ms, state, kind) };
});

import {
  animateFlip,
  applyFlip,
  flipCss,
  flipTransform,
  IDENTITY,
  mixFlip,
  toRect,
  type FlipOrigin,
} from './flip';
import { createSpring, SPRINGS } from './spring';

const box = { x: 40, y: 500, w: 148, h: 148 };
const panel = { x: 0, y: 0, width: 1080, height: 720 };

function fakeElement() {
  const calls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const el = {
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ frames, options });
      return { finished: Promise.resolve() } as unknown as Animation;
    },
  } as unknown as Element;
  return { el, calls };
}

beforeEach(() => {
  state.speed = 1;
  state.reduced = false;
});

describe('flip math', () => {
  it('normalises DOMRect-like and IPC rects', () => {
    expect(toRect(panel)).toEqual({ x: 0, y: 0, w: 1080, h: 720 });
    expect(toRect(box)).toEqual(box);
  });

  for (const origin of ['top-left', 'center'] as FlipOrigin[]) {
    it(`inverse transform maps last onto first (${origin})`, () => {
      const t = flipTransform(box, panel, origin);
      const mapped = applyFlip(panel, t, origin);
      expect(mapped.x).toBeCloseTo(box.x, 9);
      expect(mapped.y).toBeCloseTo(box.y, 9);
      expect(mapped.w).toBeCloseTo(box.w, 9);
      expect(mapped.h).toBeCloseTo(box.h, 9);
    });
  }

  it('computes the classic top-left FLIP values', () => {
    const t = flipTransform({ x: 10, y: 20, w: 50, h: 25 }, { x: 110, y: 220, w: 100, h: 100 });
    expect(t).toEqual({ translate: { x: -100, y: -200 }, scale: { x: 0.5, y: 0.25 } });
  });

  it('computes centre-anchored values', () => {
    const t = flipTransform({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, w: 20, h: 40 }, 'center');
    expect(t).toEqual({ translate: { x: -105, y: -115 }, scale: { x: 0.5, y: 0.25 } });
  });

  it('is identity for equal rects and survives zero-size targets', () => {
    expect(flipTransform(box, box)).toEqual(IDENTITY);
    expect(flipTransform(box, { x: 0, y: 0, w: 0, h: 0 }).scale).toEqual({ x: 1, y: 1 });
  });

  it('interpolates towards identity', () => {
    const t = flipTransform({ x: 0, y: 0, w: 50, h: 50 }, { x: 100, y: 40, w: 100, h: 200 });
    expect(mixFlip(t, 0)).toEqual(t);
    expect(mixFlip(t, 1)).toEqual(IDENTITY);
    expect(mixFlip(t, 0.5)).toEqual({ translate: { x: -50, y: -20 }, scale: { x: 0.75, y: 0.625 } });
  });

  it('formats CSS transforms', () => {
    expect(flipCss({ translate: { x: 1.23456, y: -2 }, scale: { x: 0.5, y: 1 / 3 } })).toBe(
      'translate(1.235px, -2px) scale(0.5, 0.333)',
    );
  });
});

describe('animateFlip', () => {
  it('springs from the inverse transform to identity', () => {
    const { el, calls } = fakeElement();
    animateFlip(el, box, panel, { opacity: [0.5, 1] });
    expect(calls).toHaveLength(1);
    const { frames, options } = calls[0]!;
    expect(frames[0]).toMatchObject({
      transform: flipCss(flipTransform(box, panel)),
      transformOrigin: '0 0',
      opacity: 0.5,
      offset: 0,
    });
    expect(frames.at(-1)).toMatchObject({ transform: flipCss(IDENTITY), opacity: 1, offset: 1 });
    expect(options.easing).toBe('linear');
    expect(options.duration).toBeCloseTo(createSpring(SPRINGS.morph).settleTime() * 1000, 6);
  });

  it('honours the animation speed, custom springs and extra properties', () => {
    const { el, calls } = fakeElement();
    state.speed = 2;
    animateFlip(el, box, panel, {
      ...SPRINGS.snappy,
      origin: 'center',
      extra: (p) => ({ borderRadius: `${Math.round(30 * (1 - p))}px` }),
    });
    const { frames, options } = calls[0]!;
    expect(options.duration).toBeCloseTo((createSpring(SPRINGS.snappy).settleTime() * 1000) / 2, 6);
    expect(frames[0]).toMatchObject({ transformOrigin: '50% 50%', borderRadius: '30px' });
    expect(frames.at(-1)).toMatchObject({ borderRadius: '0px' });
    expect(frames[0]).not.toHaveProperty('opacity');
  });

  it('does not move under reduced motion', () => {
    const { el, calls } = fakeElement();
    state.reduced = true;
    animateFlip(el, box, panel, { opacity: [0, 1] });
    const { frames, options } = calls[0]!;
    expect(frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(frames.some((f) => 'transform' in f)).toBe(false);
    expect(options.duration).toBeGreaterThan(0);
    expect(options.duration).toBeLessThanOrEqual(150);

    animateFlip(el, box, panel, { reduced: false });
    expect(calls[1]!.frames.length).toBeGreaterThan(2);
  });
});
