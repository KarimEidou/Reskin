// The open/close choreography between the box proxy and the editor panel.
//
// Everything is driven by one spring timeline (SPRINGS.morph, ~480 ms at
// speed 1) sampled into WAAPI keyframes, so the panel's shell, the fading
// proxy and the icon that settles onto the canvas move in step. What the
// icon lands on (the document, drawn before the morph starts) shows only as
// the icon settles: the two cross-fade there, never side by side. The
// shell's radius is counter-scaled per frame so its corners stay round
// while it stretches.
//
// Cost per frame (docs/ARCHITECTURE.md, "Performance"): the shell is
// repainted every frame its radius changes, so it carries no blurred shadow
// — the panel's drop shadow is a layer of its own that only fades, once the
// shell is in place — and once its corners are round to a fraction of a
// pixel with their radius at rest, they keep it: as it settles the shell
// only moves. The content is revealed by a rounded clip laid out on the
// shell's rect, and stays in place inside it (moved by the opposite of the
// clip's offset): a clip-path painted a mask, and the content with it, at
// every frame. The clip moves only while the content shows. The content
// fades in by a custom property: an animated `opacity` keeps the whole
// content drawn apart, in a pass of its own, for as long as the animation
// lasts, even while opaque (the collapse's short fade-out is an `opacity`:
// once transparent the content is not drawn at all). The canvas holds
// still meanwhile (MorphFrame, `stage.hold`), and so does what is
// transparent (the proxy once it has faded, what the icon lands on until
// it shows): what does not change costs a frame nothing. The regions enter
// by fading only: a region that moved would make every layer painted above
// it a layer of its own for its whole entrance (the compositor assumes they
// overlap), and each frame would commit them all.

import type { Rect } from '$lib/ipc/types';
import { clamp, EASE, lerp } from '$lib/motion/easing';
import { flipCss, flipTransform, mixFlip } from '$lib/motion/flip';
import { createSpring, SPRINGS } from '$lib/motion/spring';
import { dur, motion } from '$lib/motion/speed.svelte';

export interface MorphGeometry {
  /** The box's visual rect (window CSS px). */
  box: Rect;
  boxRadius: number;
  /** The panel rect (window CSS px). */
  panel: Rect;
  panelRadius: number;
}

export interface MorphParts {
  /** Wrapper of the BoxVisual proxy (absent for a crossfade close). */
  proxy: HTMLElement | null;
  /** The panel background (glass, border). */
  shell: HTMLElement;
  /** The panel's drop shadow (never moved or scaled: it only fades). */
  shadow: HTMLElement;
  /** The rounded clip of everything drawn on the panel: laid out on the shell's rect while it morphs. */
  clip: HTMLElement;
  /** Everything drawn on the panel (title bar, view): panel-sized inside `clip`, kept in place. */
  content: HTMLElement;
  /** Content regions that enter one after another. */
  regions: readonly HTMLElement[];
  /**
   * Icon clone that flies from the proxy onto the canvas (expand only), and
   * what it lands on there (`landing`: the document on the canvas, hidden
   * until the icon settles on it).
   */
  flyer?: { el: HTMLElement; from: Rect; to: Rect; landing?: readonly HTMLElement[] } | null;
}

/** Stagger between panel regions (ms at speed 1). */
export const STAGGER_MS = 30;
const REGION_MS = 280;
const CROSSFADE_MS = 220;
/** The panel shadow's fade (ms at speed 1). */
const SHADOW_FADE_MS = 160;
/** The content fades out this fast as the collapse starts (ms at speed 1). */
const CONTENT_OUT_MS = 110;
/** Fraction of the open timeline after which the content fades in. */
const CONTENT_IN = 0.22;
const FRAME_MS = 1000 / 60;
/**
 * How far (CSS px on screen) the shell's corners may be from round as it
 * settles, where they keep their radius at rest (see shellFrame): a
 * fraction of a pixel on the curve of a corner, as its last frames grow
 * the panel by a few pixels.
 */
const SETTLED_RADIUS_PX = 0.5;

/** The content's opacity while it morphs (a custom property registered in MorphFrame, see the file comment). */
export const CONTENT_OPACITY = '--morph-content-o';

/**
 * The shell animates border-radius and the content's clip its size, which
 * run on the main thread. Pure transform/opacity animations would run on
 * the compositor and drift ahead of them whenever the main thread is busy
 * (a slow machine; an item that took longer than the open waits for it). A
 * constant, invisible non-compositable property keeps every part of the
 * morph on one clock.
 */
const MAIN_THREAD: Keyframe = { outlineOffset: '0px' };

/** 0..1 → 0..1 with eased ends. */
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const round = (v: number) => Math.round(v * 1000) / 1000;

/** One frame of the timeline: spring progress `p` (may overshoot slightly), time fraction `t`, keyframe offset. */
interface Sample {
  p: number;
  t: number;
  offset: number;
}

interface Timeline {
  duration: number;
  /**
   * One sample per frame over the part of the timeline from `from` to `to`
   * (fractions; offsets relative to that part — play it with `span(from, to)`).
   */
  samples(from?: number, to?: number): Sample[];
  /** Keyframes rendered from `samples(from, to)`. */
  keyframes(render: (p: number, t: number) => Keyframe, from?: number, to?: number): Keyframe[];
  /** Duration and delay that play the part of the timeline from `from` to `to`. */
  span(from: number, to: number): { duration: number; delay: number };
}

/** The morph spring as a sampled timeline scaled by the animation speed. */
export function morphTimeline(): Timeline {
  const spring = createSpring(SPRINGS.morph);
  const settle = spring.settleTime();
  const duration = settle * 1000 / motion.speed;
  const progress = (t: number) => (t >= 1 ? 1 : spring.position(t * settle));
  const samples = (from = 0, to = 1): Sample[] => {
    const count = Math.max(2, Math.ceil(((to - from) * duration) / FRAME_MS) + 1);
    return Array.from({ length: count }, (_, i) => {
      const offset = i / (count - 1);
      const t = i === count - 1 ? to : from + (to - from) * offset;
      return { p: progress(t), t, offset };
    });
  };
  return {
    duration,
    samples,
    keyframes: (render, from, to) => samples(from, to).map((s) => ({ ...render(s.p, s.t), offset: s.offset })),
    span: (from, to) => ({ duration: (to - from) * duration, delay: from * duration }),
  };
}

/**
 * Shell frame at spring progress p (0 = box, 1 = panel). Once its corners
 * are within SETTLED_RADIUS_PX of their radius at rest, scaled as they are,
 * they keep it: from there on the shell only moves, and is not painted again.
 */
export function shellFrame(g: MorphGeometry, p: number): Keyframe {
  const m = mixFlip(flipTransform(g.box, g.panel), p);
  const r = lerp(g.boxRadius, g.panelRadius, clamp(p, 0, 1));
  const off = Math.max(Math.abs(r - g.panelRadius * m.scale.x), Math.abs(r - g.panelRadius * m.scale.y));
  const [rx, ry] = off <= SETTLED_RADIUS_PX ? [g.panelRadius, g.panelRadius] : [r / m.scale.x, r / m.scale.y];
  return { transform: flipCss(m), borderRadius: `${round(rx)}px / ${round(ry)}px` };
}

/**
 * The content's clip at spring progress p, relative to the panel: the
 * shell's rect and radius (the panel at most: an overshooting shell never
 * shows more of the content), so text is revealed by the growing shell
 * instead of floating outside it (and never distorted by the shell's scale).
 */
export function clipAt(g: MorphGeometry, p: number) {
  const k = clamp(p, 0, 1);
  return {
    x: round(lerp(g.box.x, g.panel.x, k) - g.panel.x),
    y: round(lerp(g.box.y, g.panel.y, k) - g.panel.y),
    w: round(lerp(g.box.w, g.panel.w, k)),
    h: round(lerp(g.box.h, g.panel.h, k)),
    r: round(lerp(g.boxRadius, g.panelRadius, k)),
  };
}

/** The content's clip at spring progress p (see clipAt): moved to its place and laid out at its size. */
export function clipFrame(g: MorphGeometry, p: number): Keyframe {
  const c = clipAt(g, p);
  return { transform: `translate(${c.x}px, ${c.y}px)`, width: `${c.w}px`, height: `${c.h}px`, borderRadius: `${c.r}px` };
}

/** The content inside its clip at spring progress p: moved by the opposite of the clip's offset, it stays in place. */
export function contentFrame(g: MorphGeometry, p: number): Keyframe {
  const c = clipAt(g, p);
  return { transform: `translate(${-c.x}px, ${-c.y}px)`, ...MAIN_THREAD };
}

/** The proxy drifts toward the panel's centre and grows while it fades. */
function proxyFrame(g: MorphGeometry, p: number): Keyframe {
  const bx = g.box.x + g.box.w / 2;
  const by = g.box.y + g.box.h / 2;
  const px = g.panel.x + g.panel.w / 2;
  const py = g.panel.y + g.panel.h / 2;
  const k = clamp(p, 0, 1);
  return {
    transform: `translate(${round((px - bx) * 0.18 * k)}px, ${round((py - by) * 0.18 * k)}px) scale(${round(1 + 0.22 * k)})`,
    ...MAIN_THREAD,
  };
}

function flyerFrame(from: Rect, to: Rect, p: number): Keyframe {
  return { transform: flipCss(mixFlip(flipTransform(from, to), p)), ...MAIN_THREAD };
}

function animate(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
  return el.animate(keyframes, { easing: 'linear', fill: 'both', ...options });
}

/**
 * Animates `render` (with an `opacity`) over the timeline, but only for as
 * long as the element shows: transparent before and after, it holds still
 * (the fill), and those frames cost it nothing.
 */
function whileShown(el: Element, tl: Timeline, render: (p: number, t: number) => Keyframe): Animation {
  const samples = tl.samples();
  const frames = samples.map((s) => render(s.p, s.t));
  const hidden = (i: number) => frames[i]!.opacity === 0;
  let from = 0;
  while (from < frames.length - 2 && hidden(from) && hidden(from + 1)) from++;
  let to = frames.length - 1;
  while (to > from + 1 && hidden(to) && hidden(to - 1)) to--;
  const part = frames.slice(from, to + 1).map((f, i) => ({ ...f, offset: i / (to - from) }));
  return animate(el, part, tl.span(samples[from]!.t, samples[to]!.t));
}

/**
 * The shell following spring progress `at(p)` over the whole timeline,
 * fading as `fade(p)`, and the content's clip following it from
 * `content.from` to `content.to` (fractions of the timeline: while the
 * content shows).
 */
function moveShell(
  parts: MorphParts,
  g: MorphGeometry,
  tl: Timeline,
  at: (p: number) => number,
  fade: (p: number) => number,
  content: { from: number; to: number },
): Animation[] {
  const shown = tl.samples(content.from, content.to);
  const timing = tl.span(content.from, content.to);
  return [
    animate(parts.shell, tl.keyframes((p) => ({ ...shellFrame(g, at(p)), opacity: round(fade(p)) })), { duration: tl.duration }),
    animate(parts.clip, shown.map((s) => ({ ...clipFrame(g, at(s.p)), offset: s.offset })), timing),
    animate(parts.content, shown.map((s) => ({ ...contentFrame(g, at(s.p)), offset: s.offset })), timing),
  ];
}

/** The content's fade of a morph: its CONTENT_OPACITY from `from` to `to`. */
function fadeContent(content: HTMLElement, from: number, to: number, options: KeyframeAnimationOptions): Animation {
  return animate(content, [{ [CONTENT_OPACITY]: String(from) }, { [CONTENT_OPACITY]: String(to) }], options);
}

/** The crossfade: the panel's parts fade from `from` to `to` together (and the proxy the other way). */
function crossfade(parts: MorphParts, from: number, to: number): Animation[] {
  const d = dur(CROSSFADE_MS, 'fade');
  const fade = (el: HTMLElement, a: number, b: number) => animate(el, [{ opacity: a }, { opacity: b }], { duration: d });
  const out = [fade(parts.shadow, from, to), fade(parts.shell, from, to), fade(parts.clip, from, to)];
  if (parts.proxy) out.push(fade(parts.proxy, to, from));
  return out;
}

/** Staggered entrance of the panel regions (a fade each), starting at `delay` ms. */
function enterRegions(regions: readonly HTMLElement[], delay: number): Animation[] {
  return regions.map((el, i) =>
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: dur(REGION_MS),
      delay: delay + dur(STAGGER_MS) * i,
      easing: EASE.decelerate,
      fill: 'backwards',
    }),
  );
}

/**
 * Proxy → panel. The parts must already be laid out in their final place
 * (panel visible, proxy at the box). Returns every animation started.
 */
export function playExpand(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) return crossfade(parts, 0, 1);
  const tl = morphTimeline();
  const shadowIn = Math.min(1, dur(SHADOW_FADE_MS, 'fade') / tl.duration);
  const out: Animation[] = [
    // The shell fades in as it leaves the box; the content is revealed by
    // it once it shows (transparent before, so not drawn at all).
    ...moveShell(parts, g, tl, (p) => p, (p) => smooth(p / 0.3), { from: CONTENT_IN, to: 1 }),
    // The shadow comes as the shell settles in place.
    animate(parts.shadow, [{ opacity: 0, ...MAIN_THREAD }, { opacity: 1, ...MAIN_THREAD }], tl.span(1 - shadowIn, 1)),
    // The content fades in once the shell is about two-thirds open.
    fadeContent(parts.content, 0, 1, { duration: dur(160, 'fade'), delay: tl.duration * CONTENT_IN, easing: EASE.standard }),
    ...enterRegions(parts.regions, tl.duration * CONTENT_IN),
  ];
  if (parts.proxy) out.push(whileShown(parts.proxy, tl, (p) => ({ ...proxyFrame(g, p), opacity: round(1 - smooth(p / 0.5)) })));
  const flyer = parts.flyer;
  if (flyer) {
    // The icon fades out over the second half as it settles, and what it
    // lands on fades in under it: at no time do both show apart.
    const settle = (t: number) => smooth((t - 0.5) / 0.5);
    out.push(
      animate(
        flyer.el,
        tl.keyframes((p, t) => ({ ...flyerFrame(flyer.from, flyer.to, p), opacity: round(1 - settle(t)) })),
        { duration: tl.duration },
      ),
      ...(flyer.landing ?? []).map((el) => whileShown(el, tl, (_p, t) => ({ opacity: round(settle(t)), ...MAIN_THREAD }))),
    );
  }
  return out;
}

/**
 * Panel → proxy (morph) or a plain fade out. The panel must be laid out in
 * its open place and the proxy (if any) at the box.
 */
export function playCollapse(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) return crossfade(parts, 1, 0);
  const tl = morphTimeline();
  const fadeOut = dur(CONTENT_OUT_MS, 'fade');
  // The content is gone after `fadeOut`: its clip follows the shell until then.
  const contentOut = Math.min(1, fadeOut / tl.duration);
  const out: Animation[] = [
    animate(parts.shadow, [{ opacity: 1, ...MAIN_THREAD }, { opacity: 0, ...MAIN_THREAD }], { duration: fadeOut }),
    // Transparent once faded (so not drawn at all): its own opacity costs a
    // pass only while it shows.
    animate(parts.content, [{ opacity: 1 }, { opacity: 0 }], { duration: fadeOut, easing: EASE.accelerate }),
    // q = travel towards the box; the shell melts into the proxy at the end.
    ...moveShell(parts, g, tl, (q) => 1 - q, (q) => 1 - smooth((q - 0.72) / 0.28), { from: 0, to: contentOut }),
  ];
  if (parts.proxy) out.push(whileShown(parts.proxy, tl, (q) => ({ ...proxyFrame(g, 1 - q), opacity: round(smooth((q - 0.55) / 0.4)) })));
  return out;
}

/** Resolves when every animation finished or was cancelled. */
export async function settled(animations: readonly Animation[]): Promise<void> {
  await Promise.all(animations.map((a) => a.finished.catch(() => undefined)));
}

/** Marks the regions that enter one after another (document order). */
const STAGGER_SELECTOR = '[data-stagger], [data-panel]';

/**
 * The regions that stagger in: `[data-stagger]` elements and the Edit
 * view's `[data-panel]` regions (rail, options, stage, sidebar, bottom), or
 * — for views that mark none — the view's top-level children.
 */
export function staggerTargets(content: HTMLElement, view: HTMLElement | null): HTMLElement[] {
  const visible = (el: HTMLElement) => el.getClientRects().length > 0;
  const marked = [...content.querySelectorAll<HTMLElement>(STAGGER_SELECTOR)].filter(visible);
  const inView = view ? marked.filter((el) => view.contains(el)) : [];
  if (view && inView.length === 0) {
    // Unmarked view: use its children (descending through single wrappers).
    let root: Element = view;
    while (root.children.length === 1 && root.firstElementChild) root = root.firstElementChild;
    const children = [...root.children].filter((c): c is HTMLElement => c instanceof HTMLElement && visible(c));
    return [...marked, ...children].slice(0, 12);
  }
  return marked.slice(0, 12);
}

/**
 * Where the icon lands at the end of the open morph: exactly on the
 * document (`landing`, the canvas stage's document rect), or — when no
 * canvas shows the icon — a square in the middle of the view.
 */
export function iconTarget(landing: Rect | null, view: HTMLElement, iconSize: number): Rect {
  if (landing) return { x: landing.x, y: landing.y, w: landing.w, h: landing.h };
  const r = view.getBoundingClientRect();
  const side = Math.max(iconSize, Math.min(r.width, r.height) * 0.42);
  return { x: r.left + (r.width - side) / 2, y: r.top + (r.height - side) / 2, w: side, h: side };
}
