import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ speed: 1, reduced: false }));
vi.mock('$lib/motion/speed.svelte', async () => {
  const { scaleDuration } = await import('$lib/motion/policy');
  return { motion: state, dur: (ms: number, kind?: 'motion' | 'fade') => scaleDuration(ms, state, kind) };
});

import { applyFlip } from '$lib/motion/flip';
import {
  clipAt,
  clipFrame,
  CONTENT_OPACITY,
  contentFrame,
  morphTimeline,
  playCollapse,
  playExpand,
  shellFrame,
  type MorphGeometry,
  type MorphParts,
} from './choreography';

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

/** Parses `translate(x, y)`. */
function parseTranslate(t: string) {
  const m = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(t)!;
  return { x: +m[1]!, y: +m[2]! };
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

/** The panel's parts as fakes (and the parts to pass). */
function fakeParts(opts: { proxy?: boolean; regions?: number } = {}) {
  const [shell, shadow, clip, content, proxy] = [fakeEl(), fakeEl(), fakeEl(), fakeEl(), fakeEl()];
  const region = fakeEl();
  const parts: MorphParts = {
    shell: shell.el,
    shadow: shadow.el,
    clip: clip.el,
    content: content.el,
    proxy: opts.proxy === false ? null : proxy.el,
    regions: Array.from({ length: opts.regions ?? 0 }, () => region.el),
  };
  return { parts, shell, shadow, clip, content, proxy, region };
}

/** Every property a keyframe list animates. */
const animated = (frames: Keyframe[]) =>
  new Set(frames.flatMap((f) => Object.keys(f).filter((k) => k !== 'offset' && k !== 'easing' && k !== 'composite')));

/** Where an animation starts and ends on the timeline (ms). */
const span = (options: KeyframeAnimationOptions) => {
  const delay = Number(options.delay ?? 0);
  return { from: delay, to: delay + Number(options.duration) };
};

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
    for (const p of [0, 0.3, 0.6, 0.9]) {
      const f = shellFrame(g, p);
      const { scale } = parseTransform(f.transform as string);
      const [rx, ry] = (f.borderRadius as string).split(' / ').map((v) => parseFloat(v));
      // Visual radius = CSS radius × scale on each axis = the radius of the moment.
      const r = 30 + (16 - 30) * p;
      expect(rx! * scale.x).toBeCloseTo(r, 0);
      expect(ry! * scale.y).toBeCloseTo(r, 0);
    }
  });

  it('keeps the radius at rest once the corners are round to half a pixel with it', () => {
    let settledAt = Infinity;
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const f = shellFrame(g, p);
      const { scale } = parseTransform(f.transform as string);
      const [rx, ry] = (f.borderRadius as string).split(' / ').map((v) => parseFloat(v));
      const r = 30 + (16 - 30) * p;
      // On screen the corners are never further than that from round…
      expect(Math.abs(rx! * scale.x - r)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(ry! * scale.y - r)).toBeLessThanOrEqual(0.5 + 1e-6);
      if (f.borderRadius === '16px / 16px') settledAt = Math.min(settledAt, p);
      // …and once they keep the radius at rest, they keep it to the end.
      else expect(p).toBeLessThan(settledAt);
    }
    // The last stretch of the motion paints the shell no more.
    expect(settledAt).toBeGreaterThan(0.95);
    expect(settledAt).toBeLessThan(0.99);
  });

  it('clips the content to the shell, the panel at most', () => {
    expect(clipAt(g, 0)).toEqual({ x: 922, y: 562, w: 120, h: 120, r: 30 });
    expect(clipAt(g, 1)).toEqual({ x: 0, y: 0, w: 1056, h: 696, r: 16 });
    // Overshoot never shows more than the panel.
    expect(clipAt(g, 1.02)).toEqual(clipAt(g, 1));
    const f = clipFrame(g, 0.5);
    expect(f).toEqual({ transform: 'translate(461px, 281px)', width: '588px', height: '408px', borderRadius: '23px' });
    // At rest: the clip's place in MorphFrame's CSS.
    expect(clipFrame(g, 1)).toEqual({ transform: 'translate(0px, 0px)', width: '1056px', height: '696px', borderRadius: '16px' });
  });

  it('keeps the content in place inside its clip', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1, 1.02]) {
      const clip = parseTranslate(clipFrame(g, p).transform as string);
      const content = parseTranslate(contentFrame(g, p).transform as string);
      expect(clip.x + content.x).toBe(0);
      expect(clip.y + content.y).toBe(0);
    }
    // On the main thread's clock with the clip (see MAIN_THREAD).
    expect(contentFrame(g, 0.5)).toHaveProperty('outlineOffset');
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
    // Samples and keyframes are the same frames.
    expect(tl.samples(0.25, 0.5).map((s) => s.offset)).toEqual(part.map((f) => f.offset));
  });
});

describe('play', () => {
  it('morphs shell, content, proxy and flyer on one timeline', () => {
    const { parts, shell, clip, content, proxy, region } = fakeParts({ regions: 2 });
    const flyer = fakeEl();
    const anims = playExpand(
      { ...parts, flyer: { el: flyer.el, from: { x: 957, y: 597, w: 74, h: 74 }, to: { x: 400, y: 200, w: 280, h: 280 } } },
      g,
      true,
    );
    // Shell, clip, content (clip and fade), shadow, two regions, proxy, flyer.
    expect(anims).toHaveLength(9);
    const d = shell.calls[0]!.options.duration as number;
    expect(flyer.calls[0]!.options.duration).toBe(d);
    // Everything that moves shares the main thread (see MAIN_THREAD).
    expect(flyer.calls[0]!.frames[0]).toHaveProperty('outlineOffset');
    expect(proxy.calls[0]!.frames[0]).toHaveProperty('outlineOffset');
    // Regions stagger 30 ms apart, fading in without moving (a moving
    // region would pull the layers above it into layers of their own).
    const [a, b] = region.calls.map((c) => c.options.delay as number);
    expect(b! - a!).toBeCloseTo(30, 6);
    for (const c of region.calls) expect(animated(c.frames)).toEqual(new Set(['opacity']));
    // The proxy fades out, the shell fades in.
    expect(proxy.calls[0]!.frames.at(-1)!.opacity).toBe(0);
    expect(shell.calls[0]!.frames.at(-1)!.opacity).toBe(1);
    // The content's clip and the content follow the shell, frame for frame.
    const [move] = content.calls;
    expect(clip.calls[0]!.frames.map((f) => f.offset)).toEqual(move!.frames.map((f) => f.offset));
    expect(clip.calls[0]!.options).toMatchObject({ delay: move!.options.delay, duration: move!.options.duration });
  });

  it('shows what the icon lands on only as it settles there', () => {
    const { parts, shell } = fakeParts();
    const flyer = fakeEl();
    const doc = fakeEl();
    const docShadow = fakeEl();
    playExpand(
      {
        ...parts,
        flyer: {
          el: flyer.el,
          from: { x: 957, y: 597, w: 74, h: 74 },
          to: { x: 400, y: 200, w: 280, h: 280 },
          landing: [doc.el, docShadow.el],
        },
      },
      g,
      true,
    );
    const d = shell.calls[0]!.options.duration as number;
    const icon = flyer.calls[0]!;
    const iconOpacity = (at: number) => {
      // The icon's keyframe at time `at` (ms): its frames are evenly spaced over d.
      const i = Math.round((at / d) * (icon.frames.length - 1));
      return icon.frames[i]!.opacity as number;
    };
    for (const landed of [doc, docShadow]) {
      expect(landed.calls).toHaveLength(1);
      const fade = landed.calls[0]!;
      expect([...animated(fade.frames)].filter((k) => k !== 'outlineOffset')).toEqual(['opacity']);
      // On the icon's clock (the main thread).
      expect(fade.frames[0]).toHaveProperty('outlineOffset');
      // Hidden while the icon flies (held so, not animated: nothing to
      // draw), then the two cross-fade to the end: never both apart, never
      // neither.
      const { from, to } = span(fade.options);
      expect(fade.options.fill).toBe('both');
      expect(fade.frames[0]!.opacity).toBe(0);
      expect(fade.frames.at(-1)!.opacity).toBe(1);
      expect(to).toBeCloseTo(d, 6);
      expect(from).toBeGreaterThanOrEqual(d / 2 - 20);
      expect(iconOpacity(from)).toBe(1);
      fade.frames.forEach((f) => {
        const at = from + (to - from) * (f.offset as number);
        expect((f.opacity as number) + iconOpacity(at)).toBeCloseTo(1, 2);
      });
    }
  });

  it('keeps every frame of the open cheap', () => {
    const { parts, shell, shadow, clip, content, proxy } = fakeParts();
    playExpand(parts, g, true);
    const d = shell.calls[0]!.options.duration as number;
    // The blurred shadow never moves (the shell repaints): it fades in as
    // the shell settles, ending with the morph.
    expect(shadow.calls).toHaveLength(1);
    const fade = shadow.calls[0]!;
    expect([...animated(fade.frames)].filter((k) => k !== 'outlineOffset')).toEqual(['opacity']);
    expect(fade.frames.map((f) => f.opacity)).toEqual([0, 1]);
    expect(span(fade.options).to).toBeCloseTo(d, 6);
    expect(fade.options.delay as number).toBeGreaterThan(d / 2);
    // The content is clipped by a clip laid out on the shell (no clip-path,
    // which painted a mask and the content at every frame), only from when
    // it starts to show; it fades by a custom property (an animated
    // `opacity` would keep it drawn apart for the whole animation).
    const [move, opacity] = content.calls;
    expect(animated(clip.calls[0]!.frames)).toEqual(new Set(['transform', 'width', 'height', 'borderRadius']));
    expect(animated(move!.frames)).toEqual(new Set(['transform', 'outlineOffset']));
    expect(animated(opacity!.frames)).toEqual(new Set([CONTENT_OPACITY]));
    expect(clip.calls[0]!.options.delay).toBe(opacity!.options.delay);
    expect(span(clip.calls[0]!.options).to).toBeCloseTo(d, 6);
    expect(opacity!.frames.map((f) => f[CONTENT_OPACITY])).toEqual(['0', '1']);
    // The proxy moves only while it shows.
    expect(span(proxy.calls[0]!.options).to).toBeLessThan(d / 2);
    expect(proxy.calls[0]!.frames.at(-1)!.opacity).toBe(0);
    expect(proxy.calls[0]!.frames.at(-2)!.opacity).toBeGreaterThan(0);
  });

  it('crossfades without moving under reduced motion', () => {
    state.reduced = true;
    const { parts, shell, shadow, clip, content, proxy } = fakeParts();
    playExpand(parts, g, true);
    for (const c of [shell, shadow, clip, proxy]) {
      expect(c.calls).toHaveLength(1);
      expect(c.calls[0]!.frames.every((f) => !('transform' in f))).toBe(true);
      expect(c.calls[0]!.options.duration).toBeLessThanOrEqual(150);
    }
    expect(content.calls).toHaveLength(0);
  });

  it('collapses back onto the proxy', () => {
    const { parts, shell, content, proxy } = fakeParts();
    playCollapse(parts, g, true);
    const last = shell.calls[0]!.frames.at(-1)!;
    const at = applyFlip(g.panel, parseTransform(last.transform as string));
    expect(at.x).toBeCloseTo(g.box.x, 1);
    expect(last.opacity).toBe(0);
    expect(proxy.calls[0]!.frames.at(-1)!.opacity).toBe(1);
    expect(proxy.calls[0]!.frames.at(-1)!.transform).toBe('translate(0px, 0px) scale(1)');
    // The proxy shows only as the shell melts into it: until then it holds still.
    expect(proxy.calls[0]!.options.delay as number).toBeGreaterThan(0);
    expect(proxy.calls[0]!.frames[0]!.opacity).toBe(0);
    const fade = content.calls.find((c) => animated(c.frames).has('opacity'))!;
    expect(fade.frames.at(-1)!.opacity).toBe(0);
  });

  it('stops painting the content and the shadow as soon as they are gone', () => {
    const { parts, shell, shadow, clip, content } = fakeParts({ proxy: false });
    playCollapse(parts, g, true);
    const d = shell.calls[0]!.options.duration as number;
    const fade = content.calls.find((c) => animated(c.frames).has('opacity'))!;
    const gone = fade.options.duration as number;
    expect(gone).toBeLessThan(d / 3);
    // The clip follows the shrinking shell only while the content shows…
    expect(animated(clip.calls[0]!.frames)).toEqual(new Set(['transform', 'width', 'height', 'borderRadius']));
    expect(clip.calls[0]!.options.duration).toBeCloseTo(gone, 6);
    expect(clip.calls[0]!.frames[0]).toMatchObject(clipFrame(g, 1));
    // …and the shadow fades with it, never moving.
    expect(shadow.calls).toHaveLength(1);
    expect(shadow.calls[0]!.options.duration).toBe(gone);
    expect([...animated(shadow.calls[0]!.frames)].filter((k) => k !== 'outlineOffset')).toEqual(['opacity']);
    expect(shadow.calls[0]!.frames.map((f) => f.opacity)).toEqual([1, 0]);
    // It leaves the panel at once: its corners follow the shrinking shell
    // from the first frame of motion on.
    const radii = shell.calls[0]!.frames.map((f) => f.borderRadius);
    expect(radii[0]).toBe('16px / 16px');
    expect(radii.slice(1).every((r) => r !== '16px / 16px')).toBe(true);
  });
});
