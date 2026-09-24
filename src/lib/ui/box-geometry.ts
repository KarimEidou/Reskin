// Geometry of the floating box, shared by BoxVisual (which renders from it)
// and the editor's morph proxy (which FLIPs from it).
//
// The box *window* is `metrics.window` CSS px square. The visual box is
// `metrics.visual` square, centred, leaving `metrics.margin` on every side
// for glow, scale and the progress ring. Rects are in CSS px relative to
// `origin` (the window's top-left; pass the proxy's boxRect origin in the
// editor).

import type { BoxMetrics, CollapseThen, ItemInfo, Rect, Settings, SizeClass } from '$lib/ipc/types';

export type BoxVisualState =
  | 'idle'
  | 'hover'
  | 'armed'
  | 'absorbing'
  | 'busy'
  | 'flying'
  | 'celebrate'
  | 'error';

export const BOX_STATES: readonly BoxVisualState[] = [
  'idle',
  'hover',
  'armed',
  'absorbing',
  'busy',
  'flying',
  'celebrate',
  'error',
];

/** The icon occupies this fraction of the visual box. */
export const ICON_FRACTION = 0.62;

/**
 * The hint the box shows after the first-run welcome collapses into it
 * (pass it to `handoffProps` for that collapse so the pictures match).
 */
export const FIRST_RUN_HINT = 'Drag a shortcut onto me';

/**
 * The absorb ("gulp") animation BoxVisual plays in the `absorbing` state,
 * at animation speed 1. The box inhales, then squashes on impact at
 * `ABSORB_IMPACT_AT` of the way through — time an incoming icon to land
 * then: `dur(ABSORB_MS * ABSORB_IMPACT_AT)`.
 */
export const ABSORB_MS = 720;
export const ABSORB_IMPACT_AT = 0.42;
/** Celebrate burst and error shake lengths at speed 1. */
export const CELEBRATE_MS = 900;
export const ERROR_MS = 480;
/** Space between the visual box and the progress ring stroke centre. */
export const RING_GAP = 5;
export const RING_STROKE = 3;

/** Mirror of Rust `BoxMetrics::for_size`. */
export function metricsFor(size: SizeClass): BoxMetrics {
  const [visual, radius] = size === 'small' ? [96, 24] : size === 'large' ? [148, 36] : [120, 30];
  const margin = 14;
  return { window: visual + 2 * margin, visual, margin, radius };
}

/**
 * The resting transform BoxVisual gives the visual box in each state (the
 * value its transitions settle on; keyframed states rest at identity).
 * Scale is around the box centre. Compatibility mode keeps the box at
 * identity (the window region is the visual box; nothing may grow past it).
 */
export interface BoxTransform {
  scaleX: number;
  scaleY: number;
  /** Vertical offset in CSS px (negative = up). */
  translateY: number;
  /** Rotation in degrees (ignored by the axis-aligned rect helpers). */
  rotate: number;
}

const IDENTITY: BoxTransform = { scaleX: 1, scaleY: 1, translateY: 0, rotate: 0 };

export const STATE_TRANSFORM: Readonly<Record<BoxVisualState, BoxTransform>> = {
  idle: IDENTITY,
  hover: { scaleX: 1.02, scaleY: 1.02, translateY: -2, rotate: 0 },
  armed: { scaleX: 1.08, scaleY: 1.08, translateY: 0, rotate: 0 },
  absorbing: IDENTITY,
  busy: IDENTITY,
  flying: { scaleX: 1.05, scaleY: 0.96, translateY: 0, rotate: -5 },
  celebrate: IDENTITY,
  error: IDENTITY,
};

export function transformCss(t: BoxTransform): string {
  if (t.scaleX === 1 && t.scaleY === 1 && t.translateY === 0 && t.rotate === 0) return 'none';
  const parts: string[] = [];
  if (t.translateY !== 0) parts.push(`translateY(${t.translateY}px)`);
  if (t.rotate !== 0) parts.push(`rotate(${t.rotate}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  return parts.join(' ');
}

type Point = { x: number; y: number };
const ZERO: Point = { x: 0, y: 0 };

/** The whole box window. */
export function windowRect(m: BoxMetrics, origin: Point = ZERO): Rect {
  return { x: origin.x, y: origin.y, w: m.window, h: m.window };
}

/** Scales `r` around its centre and shifts it vertically (rotation ignored). */
function transformRect(r: Rect, t: BoxTransform): Rect {
  const w = r.w * t.scaleX;
  const h = r.h * t.scaleY;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2 + t.translateY, w, h };
}

/** The visual box, optionally with the resting transform of `state`. */
export function visualRect(m: BoxMetrics, origin: Point = ZERO, state: BoxVisualState = 'idle'): Rect {
  const base = { x: origin.x + m.margin, y: origin.y + m.margin, w: m.visual, h: m.visual };
  return transformRect(base, STATE_TRANSFORM[state]);
}

/** The centred icon inside the visual box. */
export function iconRect(m: BoxMetrics, origin: Point = ZERO, state: BoxVisualState = 'idle'): Rect {
  const v = visualRect(m, origin, state);
  const w = v.w * ICON_FRACTION;
  const h = v.h * ICON_FRACTION;
  return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
}

/** Corner radius of the visual box at a given scale. */
export function visualRadius(m: BoxMetrics, state: BoxVisualState = 'idle'): number {
  const t = STATE_TRANSFORM[state];
  return m.radius * Math.min(t.scaleX, t.scaleY);
}

/**
 * Bounds of the progress ring's stroke centre line (window-relative): in
 * the margin around the visual box, or — in compatibility mode, where Rust
 * clips the opaque window to the visual box — just inside it.
 */
export function ringRect(m: BoxMetrics, origin: Point = ZERO, compat = false): Rect {
  const d = compat ? RING_GAP : -RING_GAP;
  return {
    x: origin.x + m.margin + d,
    y: origin.y + m.margin + d,
    w: m.visual - 2 * d,
    h: m.visual - 2 * d,
  };
}

/** Corner radius of the ring's stroke centre line (see `ringRect`). */
export function ringRadius(m: BoxMetrics, compat = false): number {
  return Math.max(0, m.radius + (compat ? -RING_GAP : RING_GAP));
}

/**
 * SVG path of a rounded rectangle that starts at the top centre and runs
 * clockwise, so `stroke-dasharray` progress grows like a clock hand.
 */
export function roundedRectPath(r: Rect, radius: number): string {
  const rr = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  const { x, y, w, h } = r;
  const cx = x + w / 2;
  const f = (n: number) => Math.round(n * 1000) / 1000;
  return [
    `M${f(cx)} ${f(y)}`,
    `H${f(x + w - rr)}`,
    `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}`,
    `V${f(y + h - rr)}`,
    `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}`,
    `H${f(x + rr)}`,
    `A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}`,
    `V${f(y + rr)}`,
    `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}`,
    'Z',
  ].join(' ');
}

/** Everything BoxVisual renders from (its props). */
export interface BoxVisualProps {
  metrics: BoxMetrics;
  skin: Settings['boxSkin'];
  state: BoxVisualState;
  icon: string | null;
  count: number;
  progress: number | null;
  opacity: number;
  compat: boolean;
  reducedMotion: boolean;
  hint: string | null;
}

/**
 * The picture the box shows while it hands over to the editor (after a
 * click or an absorbed drop, until `box:shown`). The editor's morph proxy
 * renders BoxVisual with exactly these props so the two windows show an
 * identical picture at the swap. `hint`: `FIRST_RUN_HINT` when collapsing
 * the first-run welcome (the box shows it once it is back), else null.
 */
export function handoffProps(
  settings: Pick<Settings, 'boxSize' | 'boxSkin' | 'idleOpacity' | 'compatibilityMode'>,
  items: ReadonlyArray<Pick<ItemInfo, 'icon'>>,
  reducedMotion: boolean,
  metrics: BoxMetrics = metricsFor(settings.boxSize),
  hint: string | null = null,
): BoxVisualProps {
  return {
    metrics,
    skin: settings.boxSkin,
    state: 'idle',
    icon: items[0]?.icon ?? null,
    count: items.length,
    progress: null,
    opacity: settings.idleOpacity,
    compat: settings.compatibilityMode,
    reducedMotion,
    hint: items.length === 0 ? hint : null,
  };
}

/**
 * What the box holds at the end of a close handoff (pass it to
 * `handoffProps`): nothing after a plain close, the new icon after an
 * apply (`fly` / `celebrate`). The editor's proxy collapses onto this
 * picture and the box takes it over (`box:collapse`) before it is shown.
 */
export function collapseItems(then: CollapseThen, icon: string | null): Array<Pick<ItemInfo, 'icon'>> {
  return then === 'hide' ? [] : [{ icon }];
}

/**
 * Converts a drag-and-drop position (PHYSICAL px relative to the webview,
 * as Tauri reports it) to CSS px.
 */
export function physicalToCss(p: Point, devicePixelRatio: number): Point {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: p.x / dpr, y: p.y / dpr };
}
