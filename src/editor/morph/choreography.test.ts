import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ speed: 1, reduced: false }));
vi.mock('$lib/motion/speed.svelte', async () => {
  const { scaleDuration } = await import('$lib/motion/policy');
  return { motion: state, dur: (ms: number, kind?: 'motion' | 'fade') => scaleDuration(ms, state, kind) };
});

import { applyFlip } from '$lib/motion/flip';
import { clipFrame, morphTimeline, playCollapse, playExpand, shellFrame, type MorphGeometry } from './choreography';

const g: MorphGeometry = {
  // The editor always contains the box (Rust place_editor).
  box: { x: 934, y: 574, w: 120, h: 120 },
  boxRadius: 30,
  panel: { x: 12, y: 12, w: 1056, h: 696 },
  panelRadius: 16,
};

/** Parses `translate(x, y) scale(sx, sy)`. */
function parseTransform(t: string) {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(t)!;
  return { translate: { x: +m[1]!, y: +m[2]! }, scale: { x: +m[3]!, y: +m[4]! } };
}

function fakeEl() {
  const calls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const el = {
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ frames, options });
      return { finished: Promise.resolve() } as unknown as Animation;
    },
  } as unknown as HTMLElement;
  return { el, calls };
}

beforeEach(() => {
  state.speed = 1;
  state.reduced = false;
});

describe('frames', () => {
  it('the shell starts exactly on the box and ends on the panel', () => {
    const start = parseTransform(shellFrame(g, 0).transform as string);
    const at = applyFlip(g.panel, start);
    // flipCss keeps 3 decimals of scale: well under a pixel.
    expect(Math.abs(at.x - g.box.x)).toBeLessThan(0.01);
    expect(Math.abs(at.y - g.box.y)).toBeLessThan(0.01);
    expect(Math.abs(at.w - g.box.w)).toBeLessThan(0.5);
    expect(Math.abs(at.h - g.box.h)).toBeLessThan(0.5);
    expect(shellFrame(g, 1).transform).toBe('translate(0px, 0px) scale(1, 1)');
    expect(shellFrame(g, 1).borderRadius).toBe('16px / 16px');
  });

  it('counter-scales the radius so corners stay round', () => {
    const f = shellFrame(g, 0);
    const { scale } = parseTransform(f.transform as string);
    const [rx, ry] = (f.borderRadius as string).split(' / ').map((v) => parseFloat(v));
    // Visual radius = CSS radius × scale on each axis = the box radius.
    expect(rx! * scale.x).toBeCloseTo(30, 0);
    expect(ry! * scale.y).toBeCloseTo(30, 0);
  });

  it('clips the content to the shell', () => {
    expect(clipFrame(g, 0).clipPath).toBe('inset(562px 14px 14px 922px round 30px)');
    expect(clipFrame(g, 1).clipPath).toBe('inset(0px 0px 0px 0px round 16px)');
    // Overshoot never produces negative insets.
    expect(clipFrame(g, 1.02).clipPath).toBe('inset(0px 0px 0px 0px round 16px)');
  });
});

describe('timeline', () => {
  it('lasts about 480 ms at speed 1 and scales with the speed', () => {
    const d1 = morphTimeline().duration;
    expect(d1).toBeGreaterThan(420);
    expect(d1).toBeLessThan(560);
    state.speed = 2;
    expect(morphTimeline().duration).toBeCloseTo(d1 / 2, 6);
  });

  it('samples evenly with exact ends', () => {
    const frames = morphTimeline().keyframes((p) => ({ opacity: p }));
    expect(frames[0]).toMatchObject({ offset: 0, opacity: 0 });
    expect(frames.at(-1)).toMatchObject({ offset: 1, opacity: 1 });
    expect(frames.length).toBeGreaterThan(20);
  });

  it('samples a part of itself, played at its place in time', () => {
    const tl = morphTimeline();
    const whole = tl.keyframes((p, t) => ({ opacity: p, t }));
    const part = tl.keyframes((p, t) => ({ opacity: p, t }), 0.25, 0.5);
    expect(part[0]).toMatchObject({ offset: 0, t: 0.25 });
    expect(part.at(-1)).toMatchObject({ offset: 1, t: 0.5 });
    // Still one sample per frame, on the same spring.
    expect(part.length).toBeGreaterThanOrEqual(Math.floor(whole.length / 4));
    expect(part.length).toBeLessThanOrEqual(Math.ceil(whole.length / 4) + 1);
    const mid = whole.find((f) => f.t === 0.5);
    if (mid) expect(part.at(-1)!.opacity).toBeCloseTo(mid.opacity as number, 9);
    expect(tl.span(0.25, 0.5)).toEqual({ duration: tl.duration / 4, delay: tl.duration / 4 });
  });
});

/** Every property a keyframe list animates. */
const animated = (frames: Keyframe[]) =>
  new Set(frames.flatMap((f) => Object.keys(f).filter((k) => k !== 'offset' && k !== 'easing' && k !== 'composite')));

describe('play', () => {
  it('morphs shell, content, proxy and flyer on one timeline', () => {
    const shell = fakeEl();
    const shadow = fakeEl();
    const content = fakeEl();
    const proxy = fakeEl();
    const flyer = fakeEl();
    const region = fakeEl();
    const anims = playExpand(
      {
        shell: shell.el,
        shadow: shadow.el,
        content: content.el,
        proxy: proxy.el,
        regions: [region.el, region.el],
        flyer: { el: flyer.el, from: { x: 957, y: 597, w: 74, h: 74 }, to: { x: 400, y: 200, w: 280, h: 280 } },
      },
      g,
      true,
    );
    expect(anims).toHaveLength(8);
    const d = shell.calls[0]!.options.duration;
    expect(proxy.calls[0]!.options.duration).toBe(d);
    expect(flyer.calls[0]!.options.duration).toBe(d);
    // Everything that moves shares the main thread (see MAIN_THREAD).
    expect(flyer.calls[0]!.frames[0]).toHaveProperty('outlineOffset');
    expect(proxy.calls[0]!.frames[0]).toHaveProperty('outlineOffset');
    // Regions stagger 30 ms apart.
    const [a, b] = region.calls.map((c) => c.options.delay as number);
    expect(b! - a!).toBeCloseTo(30, 6);
    // The proxy fades out, the shell fades in.
    expect(proxy.calls[0]!.frames.at(-1)!.opacity).toBe(0);
    expect(shell.calls[0]!.frames.at(-1)!.opacity).toBe(1);
  });

  it('keeps every frame of the open cheap to paint', () => {
    const shell = fakeEl();
    const shadow = fakeEl();
    const content = fakeEl();
    playExpand({ shell: shell.el, shadow: shadow.el, content: content.el, proxy: null, regions: [] }, g, true);
    const d = shell.calls[0]!.options.duration as number;
    // The blurred shadow never moves (the shell repaints every frame): it
    // fades in as the shell settles, ending with the morph.
    expect(shadow.calls).toHaveLength(1);
    const fade = shadow.calls[0]!;
    expect([...animated(fade.frames)].filter((k) => k !== 'outlineOffset')).toEqual(['opacity']);
    expect(fade.frames.map((f) => f.opacity)).toEqual([0, 1]);
    expect((fade.options.delay as number) + (fade.options.duration as number)).toBeCloseTo(d, 6);
    expect(fade.options.delay as number).toBeGreaterThan(d / 2);
    // The content is clipped only from when it starts to show.
    const [clip, opacity] = content.calls;
    expect(animated(clip!.frames)).toEqual(new Set(['clipPath']));
    expect(clip!.options.delay).toBe(opacity!.options.delay);
    expect((clip!.options.delay as number) + (clip!.options.duration as number)).toBeCloseTo(d, 6);
  });

  it('crossfades without moving under reduced motion', () => {
    state.reduced = true;
    const shell = fakeEl();
    const shadow = fakeEl();
    const content = fakeEl();
    const proxy = fakeEl();
    playExpand({ shell: shell.el, shadow: shadow.el, content: content.el, proxy: proxy.el, regions: [] }, g, true);
    for (const c of [shell, shadow, content, proxy]) {
      expect(c.calls).toHaveLength(1);
      expect(c.calls[0]!.frames.every((f) => !('transform' in f))).toBe(true);
      expect(c.calls[0]!.options.duration).toBeLessThanOrEqual(150);
    }
  });

  it('collapses back onto the proxy', () => {
    const shell = fakeEl();
    const shadow = fakeEl();
    const content = fakeEl();
    const proxy = fakeEl();
    playCollapse({ shell: shell.el, shadow: shadow.el, content: content.el, proxy: proxy.el, regions: [] }, g, true);
    const last = shell.calls[0]!.frames.at(-1)!;
    const at = applyFlip(g.panel, parseTransform(last.transform as string));
    expect(at.x).toBeCloseTo(g.box.x, 1);
    expect(last.opacity).toBe(0);
    expect(proxy.calls[0]!.frames.at(-1)!.opacity).toBe(1);
    expect(proxy.calls[0]!.frames.at(-1)!.transform).toBe('translate(0px, 0px) scale(1)');
    expect(content.calls[0]!.frames.at(-1)!.opacity).toBe(0);
  });

  it('stops painting the content and the shadow as soon as they are gone', () => {
    const shell = fakeEl();
    const shadow = fakeEl();
    const content = fakeEl();
    playCollapse({ shell: shell.el, shadow: shadow.el, content: content.el, proxy: null, regions: [] }, g, true);
    const d = shell.calls[0]!.options.duration as number;
    const [fade, clip] = content.calls;
    const gone = fade!.options.duration as number;
    expect(gone).toBeLessThan(d / 3);
    // The clip follows the shrinking shell only while the content shows…
    expect(animated(clip!.frames)).toEqual(new Set(['clipPath']));
    expect(clip!.options.duration).toBeCloseTo(gone, 6);
    expect(clip!.frames[0]!.clipPath).toBe(clipFrame(g, 1).clipPath);
    // …and the shadow fades with it, never moving.
    expect(shadow.calls).toHaveLength(1);
    expect(shadow.calls[0]!.options.duration).toBe(gone);
    expect([...animated(shadow.calls[0]!.frames)].filter((k) => k !== 'outlineOffset')).toEqual(['opacity']);
    expect(shadow.calls[0]!.frames.map((f) => f.opacity)).toEqual([1, 0]);
  });
});
