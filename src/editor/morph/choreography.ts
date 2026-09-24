// The open/close choreography between the box proxy and the editor panel.
//
// Everything is driven by one spring timeline (SPRINGS.morph, ~480 ms at
// speed 1) sampled into WAAPI keyframes, so the panel's shell, the fading
// proxy and the icon that settles onto the canvas move in step. Only
// transform, opacity, border-radius and the content's clip-path are
// animated; the shell's radius is counter-scaled per frame so its corners
// stay round while it stretches.
//
// Cost per frame (docs/ARCHITECTURE.md, "Performance"): the shell is
// repainted every frame (its radius changes), so it carries no blurred
// shadow — the panel's drop shadow is a layer of its own that only fades,
// once the shell is in place. The content's clip is animated only while the
// content shows.

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
  /** Everything drawn on the panel (title bar, view). */
  content: HTMLElement;
  /** Content regions that enter one after another. */
  regions: readonly HTMLElement[];
  /** Icon clone that flies from the proxy onto the canvas (expand only). */
  flyer?: { el: HTMLElement; from: Rect; to: Rect } | null;
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
 * The shell animates border-radius and the content clip-path, which run on
 * the main thread. Pure transform/opacity animations would run on the
 * compositor and drift ahead of them whenever the main thread is busy
 * (the item is still loading during the morph). A constant, invisible
 * non-compositable property keeps every part of the morph on one clock.
 */
const MAIN_THREAD: Keyframe = { outlineOffset: '0px' };

/** 0..1 → 0..1 with eased ends. */
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const round = (v: number) => Math.round(v * 1000) / 1000;

interface Timeline {
  duration: number;
  /**
   * Frame builder: spring progress p (0..1, may overshoot slightly) and
   * time fraction t, sampled once per frame over the part of the timeline
   * from `from` to `to` (fractions; offsets relative to that part — play it
   * with `span(from, to)`).
   */
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
  return {
    duration,
    keyframes: (render, from = 0, to = 1) => {
      const count = Math.max(2, Math.ceil(((to - from) * duration) / FRAME_MS) + 1);
      return Array.from({ length: count }, (_, i) => {
        const offset = i / (count - 1);
        const t = i === count - 1 ? to : from + (to - from) * offset;
        return { ...render(progress(t), t), offset };
      });
    },
    span: (from, to) => ({ duration: (to - from) * duration, delay: from * duration }),
  };
}

/** Shell frame at spring progress p (0 = box, 1 = panel). */
export function shellFrame(g: MorphGeometry, p: number): Keyframe {
  const m = mixFlip(flipTransform(g.box, g.panel), p);
  const r = lerp(g.boxRadius, g.panelRadius, clamp(p, 0, 1));
  return {
    transform: flipCss(m),
    borderRadius: `${round(r / m.scale.x)}px / ${round(r / m.scale.y)}px`,
  };
}

/**
 * Clip of the panel content at spring progress p: the shell's rect and
 * radius, so text is revealed by the growing shell instead of floating
 * outside it (and never distorted by the shell's scale).
 */
export function clipFrame(g: MorphGeometry, p: number): Keyframe {
  const k = clamp(p, 0, 1);
  const x = lerp(g.box.x, g.panel.x, k);
  const y = lerp(g.box.y, g.panel.y, k);
  const w = lerp(g.box.w, g.panel.w, k);
  const h = lerp(g.box.h, g.panel.h, k);
  const top = round(Math.max(0, y - g.panel.y));
  const left = round(Math.max(0, x - g.panel.x));
  const right = round(Math.max(0, g.panel.x + g.panel.w - (x + w)));
  const bottom = round(Math.max(0, g.panel.y + g.panel.h - (y + h)));
  const r = round(lerp(g.boxRadius, g.panelRadius, k));
  return { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round ${r}px)` };
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

/** Staggered entrance of the panel regions, starting at `delay` ms. */
function enterRegions(regions: readonly HTMLElement[], delay: number): Animation[] {
  return regions.map((el, i) =>
    el.animate(
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: dur(REGION_MS),
        delay: delay + dur(STAGGER_MS) * i,
        easing: EASE.decelerate,
        fill: 'backwards',
      },
    ),
  );
}

/**
 * Proxy → panel. The parts must already be laid out in their final place
 * (panel visible, proxy at the box). Returns every animation started.
 */
export function playExpand(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) {
    const d = dur(CROSSFADE_MS, 'fade');
    const out = [
      animate(parts.shadow, [{ opacity: 0 }, { opacity: 1 }], { duration: d }),
      animate(parts.shell, [{ opacity: 0 }, { opacity: 1 }], { duration: d }),
      animate(parts.content, [{ opacity: 0 }, { opacity: 1 }], { duration: d }),
    ];
    if (parts.proxy) out.push(animate(parts.proxy, [{ opacity: 1 }, { opacity: 0 }], { duration: d }));
    return out;
  }
  const tl = morphTimeline();
  const shadowIn = Math.min(1, dur(SHADOW_FADE_MS, 'fade') / tl.duration);
  const out: Animation[] = [
    animate(
      parts.shell,
      tl.keyframes((p) => ({ ...shellFrame(g, p), opacity: round(smooth(p / 0.3)) })),
      { duration: tl.duration },
    ),
    // The shadow comes as the shell settles in place.
    animate(parts.shadow, [{ opacity: 0, ...MAIN_THREAD }, { opacity: 1, ...MAIN_THREAD }], tl.span(1 - shadowIn, 1)),
    // Content is revealed by the growing shell and fades in once it is
    // about two-thirds open (invisible before: nothing to clip).
    animate(parts.content, tl.keyframes((p) => clipFrame(g, p), CONTENT_IN, 1), tl.span(CONTENT_IN, 1)),
    animate(parts.content, [{ opacity: 0 }, { opacity: 1 }], {
      duration: dur(160, 'fade'),
      delay: tl.duration * CONTENT_IN,
      easing: EASE.standard,
    }),
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
    out.push(
      animate(
        flyer.el,
        tl.keyframes((p, t) => ({ ...flyerFrame(flyer.from, flyer.to, p), opacity: round(1 - smooth((t - 0.5) / 0.5)) })),
        { duration: tl.duration },
      ),
    );
  }
  return out;
}

/**
 * Panel → proxy (morph) or a plain fade out. The panel must be laid out in
 * its open place and the proxy (if any) at the box.
 */
export function playCollapse(parts: MorphParts, g: MorphGeometry, morph: boolean): Animation[] {
  if (!morph || motion.reduced) {
    const d = dur(CROSSFADE_MS, 'fade');
    const out = [
      animate(parts.shadow, [{ opacity: 1 }, { opacity: 0 }], { duration: d }),
      animate(parts.shell, [{ opacity: 1 }, { opacity: 0 }], { duration: d }),
      animate(parts.content, [{ opacity: 1 }, { opacity: 0 }], { duration: d }),
    ];
    if (parts.proxy) out.push(animate(parts.proxy, [{ opacity: 0 }, { opacity: 1 }], { duration: d }));
    return out;
  }
  const tl = morphTimeline();
  const fadeOut = dur(CONTENT_OUT_MS, 'fade');
  // The content is gone after `fadeOut`: its clip follows the shell until then.
  const contentOut = Math.min(1, fadeOut / tl.duration);
  const out: Animation[] = [
    animate(parts.shadow, [{ opacity: 1, ...MAIN_THREAD }, { opacity: 0, ...MAIN_THREAD }], { duration: fadeOut }),
    animate(parts.content, [{ opacity: 1 }, { opacity: 0 }], { duration: fadeOut, easing: EASE.accelerate }),
    animate(parts.content, tl.keyframes((q) => clipFrame(g, 1 - q), 0, contentOut), tl.span(0, contentOut)),
    // q = travel towards the box; the shell melts into the proxy at the end.
    animate(
      parts.shell,
      tl.keyframes((q) => ({ ...shellFrame(g, 1 - q), opacity: round(1 - smooth((q - 0.72) / 0.28)) })),
      { duration: tl.duration },
    ),
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
