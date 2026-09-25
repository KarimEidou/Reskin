// The open/close choreography between the box proxy and the editor panel.
//
// Everything is driven by one spring timeline (SPRINGS.morph, ~480 ms at
// speed 1) sampled into WAAPI keyframes, so the panel's shell, the fading
// proxy and the icon that settles onto the canvas move in step. What the
// icon lands on (the document, drawn before the morph starts) shows only as
// the icon settles: the two cross-fade there, never side by side.
//
// Cost per frame (docs/ARCHITECTURE.md, "Performance"): nothing of the
// panel is painted again while it grows. Its glass and its content are
// pictures inside one rounded clip, its hairline border solid pieces inside
// another (MorphFrame): overflow clips moved (a composited translation) and
// sized (laid out) onto the shell's rect every frame, which paint nothing —
// the compositor rounds the pictures inside them — while the pictures only
// move. The glass is the panel's own, painted once and scaled into the clip
// like a FLIP (so its tint stretches as it always did); the content stays
// in place (it moves by the opposite of the clip's offset); the border's
// pieces lie along the edges of their clip. The border and the content fade
// by custom properties: an animated `opacity` would keep a picture of
// several layers drawn apart in a pass of its own even while it is opaque
// (and, before the content shows, drawn at all). Each part is animated only
// while it changes: what holds still costs no frame anything. The panel's
// blurred drop shadow is a layer of its own that only fades, once the shell
// is in place. The regions enter by fading only: a region that moved would
// make every layer painted above it a layer of its own for its whole
// entrance (the compositor assumes they overlap), and each frame would
// commit them all.

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

/** The panel background: the glass and its hairline border, each in a rounded clip. */
export interface ShellParts {
  /**
   * Rounded clip of the glass — and of the content, which MorphFrame lays
   * out inside it too: the shell's rect while it morphs.
   */
  clip: HTMLElement;
  /** The glass (fill, tint, highlight): panel-sized, at the clip's origin, scaled into it. */
  fill: HTMLElement;
  /**
   * Rounded clip of the border: the shell's rect grown by it (its solid
   * pieces lay themselves out along its edges); none in compatibility mode.
   */
  edge: HTMLElement | null;
}

export interface MorphParts {
  /** Wrapper of the BoxVisual proxy (absent for a crossfade close). */
  proxy: HTMLElement | null;
  shell: ShellParts;
  /** The panel's drop shadow (never moved or scaled: it only fades). */
  shadow: HTMLElement;
  /**
   * Everything drawn on the panel (title bar, view): panel-sized, inside
   * the shell's clip at its origin, kept in place while the clip moves.
   */
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

/** The border's opacity while it morphs (a custom property, see the file comment). */
export const SHELL_OPACITY = '--morph-shell-o';
/** The content's opacity while it morphs (a custom property, see the file comment). */
export const CONTENT_OPACITY = '--morph-content-o';

/**
 * The glass, the content, the shadow, the proxy, the flyer and what it
 * lands on move on the main thread with the clips (their sizes are laid
 * out there); pure transform/opacity animations would run on the
 * compositor and drift ahead of them whenever the main thread is busy (a
 * slow machine; an item that took longer than the open waits for it). A
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

/** One frame of the timeline: spring progress p (may overshoot slightly), time fraction t, keyframe offset. */
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
 * The shell at spring progress p (0 = box, 1 = panel), relative to the
 * panel: the panel FLIPped onto it (the numbers the shell's transform
 * always had, flipCss's 3 decimals) — its rect, and its scale, which is
 * also the width of its hairline border (1 px at rest) — and its corner
 * radius on screen (round at every size).
 */
export function shellAt(g: MorphGeometry, p: number) {
  const m = mixFlip(flipTransform(g.box, g.panel), p);
  const [x, y, sx, sy] = [m.translate.x, m.translate.y, m.scale.x, m.scale.y].map(round) as [number, number, number, number];
  return { x, y, w: g.panel.w * sx, h: g.panel.h * sy, sx, sy, r: lerp(g.boxRadius, g.panelRadius, clamp(p, 0, 1)) };
}

/** A rounded clip moved and sized onto a rect (`at`: where it is laid out, panel-relative). */
function clipKeyframe(x: number, y: number, w: number, h: number, r: number, at = { x: 0, y: 0 }): Keyframe {
  return {
    transform: `translate(${round(x - at.x)}px, ${round(y - at.y)}px)`,
    width: `${round(w)}px`,
    height: `${round(h)}px`,
    borderRadius: `${round(r)}px`,
  };
}

/**
 * The panel's frame at spring progress p: the clip on the shell's rect, the
 * glass scaled into it (exactly where the shell's transform always put it)
 * and the content moved by the opposite of its offset (in place, exact to
 * the fraction of a pixel), and the border's clip on that rect grown by the
 * border, round by the radius grown by it (the border's own pieces follow
 * its edges). The clips only move and lay out; the rest only moves.
 */
export function shellFrame(g: MorphGeometry, p: number): { clip: Keyframe; fill: Keyframe; content: Keyframe; edge: Keyframe } {
  const { x, y, w, h, sx, sy, r } = shellAt(g, p);
  return {
    clip: clipKeyframe(x, y, w, h, r),
    fill: { transform: `scale(${sx}, ${sy})`, ...MAIN_THREAD },
    content: { transform: `translate(${-x}px, ${-y}px)`, ...MAIN_THREAD },
    // The border's clip rests at (-1, -1): the panel grown by the border.
    edge: clipKeyframe(x - sx, y - sy, w + 2 * sx, h + 2 * sy, r + (sx + sy) / 2, { x: -1, y: -1 }),
  };
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
 * The shell following spring progress `at(p)` over the whole timeline,
 * fading as `fade(p)`, and the content in its clip kept in place from
 * `content.from` to `content.to` (fractions of the timeline: while it
 * shows).
 */
function moveShell(
  parts: MorphParts,
  g: MorphGeometry,
  tl: Timeline,
  at: (p: number) => number,
  fade: (p: number) => number,
  content: { from: number; to: number },
): Animation[] {
  const timing = { duration: tl.duration };
  const frames = tl.samples().map((s) => ({ offset: s.offset, ...shellFrame(g, at(s.p)), opacity: round(fade(s.p)) }));
  const { clip, fill, edge } = parts.shell;
  const out = [
    animate(clip, frames.map((f) => ({ ...f.clip, offset: f.offset })), timing),
    // The glass is a picture of one layer: its own opacity costs nothing.
    animate(fill, frames.map((f) => ({ ...f.fill, opacity: f.opacity, offset: f.offset })), timing),
    animate(
      parts.content,
      tl.samples(content.from, content.to).map((s) => ({ ...shellFrame(g, at(s.p)).content, offset: s.offset })),
      tl.span(content.from, content.to),
    ),
  ];
  if (edge) {
    out.push(animate(edge, frames.map((f) => ({ ...f.edge, offset: f.offset })), timing));
    const fading = changing(frames.map((f) => f.opacity), SHELL_REST);
    if (fading) {
      const { from, to, fill: holds } = fading;
      out.push(
        animate(
          edge,
          frames.slice(from, to + 1).map((f, i) => ({ [SHELL_OPACITY]: String(f.opacity), offset: i / Math.max(1, to - from) })),
          { ...tl.span(frames[from]!.offset, frames[to]!.offset), fill: holds },
        ),
      );
    }
  }
  return out;
}

/** A custom property's value at rest (its initial value). */
const SHELL_REST = 1;

/**
 * Where a sampled value changes: the samples `from`..`to` (null when it
 * never does), and the fill that holds it outside them — only where it
 * differs from `rest`, its value when not animated.
 */
function changing(values: readonly number[], rest: number): { from: number; to: number; fill: FillMode } | null {
  let from = 0;
  while (from < values.length - 1 && values[from + 1] === values[from]) from++;
  let to = values.length - 1;
  while (to > from && values[to - 1] === values[to]) to--;
  if (from >= to) return values[0] === rest ? null : { from: 0, to: values.length - 1, fill: 'both' };
  const before = values[from] !== rest;
  const after = values[to] !== rest;
  return { from, to, fill: before && after ? 'both' : before ? 'backwards' : after ? 'forwards' : 'none' };
}

/** The content's fade of a morph: its CONTENT_OPACITY from `from` to `to`. */
function fadeContent(content: HTMLElement, from: number, to: number, options: KeyframeAnimationOptions): Animation {
  return animate(content, [{ [CONTENT_OPACITY]: String(from) }, { [CONTENT_OPACITY]: String(to) }], options);
}

/**
 * All but transparent (a fraction of a level of colour): drawn, so the
 * compositor takes its layers in, where transparent it would skip them.
 */
const GLIMPSE = 0.002;

/** The crossfade: the panel's parts fade from `from` to `to` together (and the proxy the other way). */
function crossfade(parts: MorphParts, from: number, to: number): Animation[] {
  const d = dur(CROSSFADE_MS, 'fade');
  const fade = (el: HTMLElement, a: number, b: number) => animate(el, [{ opacity: a }, { opacity: b }], { duration: d });
  const out = [fade(parts.shadow, from, to), fade(parts.shell.fill, from, to), fade(parts.content, from, to)];
  if (parts.shell.edge) out.push(fade(parts.shell.edge, from, to));
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
 * (panel visible, proxy at the box; MorphFrame's `data-morphing` for a
 * morph). Returns every animation started.
 */
export function playExpand(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) return crossfade(parts, 0, 1);
  const tl = morphTimeline();
  const shadowIn = Math.min(1, dur(SHADOW_FADE_MS, 'fade') / tl.duration);
  const out: Animation[] = [
    // The shell fades in as it leaves the box.
    ...moveShell(parts, g, tl, (p) => p, (p) => smooth(p / 0.3), { from: CONTENT_IN, to: 1 }),
    // The shadow comes as the shell settles in place.
    animate(parts.shadow, [{ opacity: 0, ...MAIN_THREAD }, { opacity: 1, ...MAIN_THREAD }], tl.span(1 - shadowIn, 1)),
    // Content is revealed by the growing shell and fades in once it is
    // about two-thirds open (transparent before, so not drawn at all).
    fadeContent(parts.content, 0, 1, { duration: dur(160, 'fade'), delay: tl.duration * CONTENT_IN, easing: EASE.standard, fill: 'backwards' }),
    // The first frame (the proxy on screen, before the morph plays) draws
    // it, unseen under the proxy: the compositor takes in the layers of the
    // whole view there, not in the frame of the morph where it starts to show.
    animate(parts.content, [{ [CONTENT_OPACITY]: String(GLIMPSE) }, { [CONTENT_OPACITY]: String(GLIMPSE) }], { duration: 1, fill: 'none' }),
    ...enterRegions(parts.regions, tl.duration * CONTENT_IN),
  ];
  if (parts.proxy) {
    out.push(
      animate(
        parts.proxy,
        tl.keyframes((p) => ({ ...proxyFrame(g, p), opacity: round(1 - smooth(p / 0.5)) })),
        { duration: tl.duration },
      ),
    );
  }
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
      ...(flyer.landing ?? []).map((el) =>
        animate(el, tl.keyframes((_p, t) => ({ opacity: round(settle(t)), ...MAIN_THREAD })), { duration: tl.duration }),
      ),
    );
  }
  return out;
}

/**
 * Panel → proxy (morph) or a plain fade out. The panel must be laid out in
 * its open place (MorphFrame's `data-morphing` for a morph) and the proxy
 * (if any) at the box.
 */
export function playCollapse(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) return crossfade(parts, 1, 0);
  const tl = morphTimeline();
  const fadeOut = dur(CONTENT_OUT_MS, 'fade');
  // q = travel towards the box.
  const back = (q: number) => 1 - q;
  const out: Animation[] = [
    animate(parts.shadow, [{ opacity: 1, ...MAIN_THREAD }, { opacity: 0, ...MAIN_THREAD }], { duration: fadeOut }),
    fadeContent(parts.content, 1, 0, { duration: fadeOut, easing: EASE.accelerate, fill: 'forwards' }),
    // The shell melts into the proxy at the end.
    // The content is gone after `fadeOut`: it stays in place until then.
    ...moveShell(parts, g, tl, back, (q) => 1 - smooth((q - 0.72) / 0.28), { from: 0, to: Math.min(1, fadeOut / tl.duration) }),
  ];
  if (parts.proxy) {
    out.push(
      animate(
        parts.proxy,
        tl.keyframes((q) => ({ ...proxyFrame(g, 1 - q), opacity: round(smooth((q - 0.55) / 0.4)) })),
        { duration: tl.duration },
      ),
    );
  }
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
