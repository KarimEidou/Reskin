// Move / free transform of the active layer (or of the selected pixels),
// and moving, resizing and rotating text layers.
//
// Raster layers: as soon as the tool is active on a layer with content,
// the bounding box of that content (the layer's pixels, or base ×
// selection) is shown with its handles, so the very first drag can already
// move (inside), scale (from the opposite handle, or from the centre with
// Alt; Shift keeps the aspect ratio on corners) or rotate (outside a corner
// or the top handle; Shift snaps to 15°); a press anywhere else moves, and
// so does a press inside a box too small for its handles (they are then
// grabbed from just outside; the nearest handle always wins). The
// first press lifts the content and starts a transform session; further
// drags adjust it and arrow keys nudge by 1 px (10 with Shift). The session
// commits as ONE history entry on Enter or when another tool/command runs;
// Esc and undo cancel it (Esc during a drag reverts just that drag).
// Previews and the commit resample bilinearly (nearest in pixel-art
// documents), and pure translations stay pixel-exact.
//
// Text layers stay text (they are never rasterized): a drag inside the
// block moves it (x/y), a corner handle resizes it uniformly through the
// font size (text cannot be stretched, so there are no edge handles and the
// aspect ratio is always kept; Alt resizes about the centre), and the
// rotate handle / outside the corners rotates it about its centre (Shift
// snaps to 15°). Each drag is ONE history entry ("Move text", "Resize
// text", "Rotate text"); arrow-key nudges merge into one "Move text" entry
// per burst. Esc during a drag puts the text back.

import type { CursorHint, Tool, ToolContext } from './types';
import type { Modifiers, PointerInput } from '../input/pointer';
import type { Affine, Point } from '../geometry/affine';
import { apply, compose, invert, isIdentity, rotation, scaling, translation } from '../geometry/affine';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage } from '../raster/float-image';
import type { Pixels, Surface } from '../raster/surface';
import { sampleBilinear, sampleNearest } from '../raster/sample';
import type { SelectionMask } from '../selection/mask';
import { transformMask } from '../selection/mask';
import type { PropPatch } from '../history/commands';
import { PropsCommand, SelectionCommand } from '../history/commands';
import type { TextLayer, TextProps } from '../doc/types';
import { MAX_PARAM_PX } from '../doc/types';
import type { TextLayout } from '../text/text';
import { lineStartX } from '../text/text';
import type { Rect } from '../util/rect';
import { clipRect, coverRect, unionRect } from '../util/rect';
import type { OverlayPainter } from '../render/overlay';

// ---------------------------------------------------------------------------
// Pure transform math (exported for tests and for UI numeric fields)
// ---------------------------------------------------------------------------

export type TransformHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'rotate';

export interface TransformBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TransformParams {
  /** Content bounds before the transform, document px. */
  box: TransformBox;
  /** Current centre, document px. */
  cx: number;
  cy: number;
  /** Signed scale (negative = flipped). */
  sx: number;
  sy: number;
  /** Clockwise rotation, radians. */
  angle: number;
}

const HANDLE_DIRS: Record<Exclude<TransformHandle, 'move' | 'rotate'>, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export function initialTransform(box: TransformBox): TransformParams {
  return { box: { ...box }, cx: box.x + box.w / 2, cy: box.y + box.h / 2, sx: 1, sy: 1, angle: 0 };
}

/** Maps original document points to transformed ones. */
export function transformMatrix(t: TransformParams): Affine {
  const bx = t.box.x + t.box.w / 2;
  const by = t.box.y + t.box.h / 2;
  return compose(translation(-bx, -by), scaling(t.sx, t.sy), rotation(t.angle), translation(t.cx, t.cy));
}

/** Box-local (centred, unscaled) point → document point. */
function localToDoc(t: TransformParams, u: number, v: number): Point {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  const x = u * t.sx;
  const y = v * t.sy;
  return { x: t.cx + x * c - y * s, y: t.cy + x * s + y * c };
}

/** Document point → rotation-only local frame around the current centre. */
function docToFrame(t: TransformParams, p: Point): Point {
  const c = Math.cos(-t.angle);
  const s = Math.sin(-t.angle);
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Transformed corners: TL, TR, BR, BL (of the original box). */
export function transformCorners(t: TransformParams): Point[] {
  const hw = t.box.w / 2;
  const hh = t.box.h / 2;
  return [localToDoc(t, -hw, -hh), localToDoc(t, hw, -hh), localToDoc(t, hw, hh), localToDoc(t, -hw, hh)];
}

/** Handle positions; the rotate handle sits `rotateOffset` px beyond the top edge. */
export function handlePositions(t: TransformParams, rotateOffset: number): Record<Exclude<TransformHandle, 'move'>, Point> {
  const hw = t.box.w / 2;
  const hh = t.box.h / 2;
  const out = {} as Record<Exclude<TransformHandle, 'move'>, Point>;
  for (const [k, [hx, hy]] of Object.entries(HANDLE_DIRS) as [keyof typeof HANDLE_DIRS, [number, number]][]) {
    out[k] = localToDoc(t, hx * hw, hy * hh);
  }
  const top = out.n;
  // "Up" in the box frame (flips follow the content).
  const ux = Math.sin(t.angle) * Math.sign(t.sy || 1);
  const uy = -Math.cos(t.angle) * Math.sign(t.sy || 1);
  out.rotate = { x: top.x + ux * rotateOffset, y: top.y + uy * rotateOffset };
  return out;
}

function pointInQuad(q: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i];
    const b = q[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * What a press at (x, y) grabs. `tolerance` and `rotateOffset` are in
 * document px (convert from screen px with the view scale). Outside the
 * box but within 3× tolerance of a corner rotates; farther away → null.
 */
export function hitTestTransform(
  t: TransformParams,
  x: number,
  y: number,
  tolerance: number,
  rotateOffset: number,
): TransformHandle | null {
  const h = handlePositions(t, rotateOffset);
  const dist = (p: Point) => Math.hypot(p.x - x, p.y - y);
  const near = (p: Point, r: number) => dist(p) <= r;
  if (near(h.rotate, tolerance)) return 'rotate';
  // The nearest corner, then the nearest edge handle (on a small box
  // several are within reach).
  for (const group of [['nw', 'ne', 'se', 'sw'], ['n', 'e', 's', 'w']] as const) {
    let best: TransformHandle | null = null;
    let bestD = tolerance;
    for (const k of group) {
      const d = dist(h[k]);
      if (d <= bestD) {
        best = k;
        bestD = d;
      }
    }
    if (best) return best;
  }
  const corners = transformCorners(t);
  if (pointInQuad(corners, x, y)) return 'move';
  for (const c of corners) if (near(c, tolerance * 3)) return 'rotate';
  return null;
}

const MIN_EXTENT = 1e-3;

function clampExtent(v: number): number {
  return Math.abs(v) < MIN_EXTENT ? (v < 0 ? -MIN_EXTENT : MIN_EXTENT) : v;
}

/** New params for dragging `handle` from `from` to `to`, starting at `start`. */
export function dragTransform(
  start: TransformParams,
  handle: TransformHandle,
  from: Point,
  to: Point,
  mods: Pick<Modifiers, 'shift' | 'alt'>,
): TransformParams {
  if (handle === 'move') {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if (mods.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    // Keep untransformed moves on whole pixels.
    if (start.angle === 0 && Math.abs(start.sx) === 1 && Math.abs(start.sy) === 1) {
      dx = Math.round(dx);
      dy = Math.round(dy);
    }
    return { ...start, box: { ...start.box }, cx: start.cx + dx, cy: start.cy + dy };
  }
  if (handle === 'rotate') {
    const a0 = Math.atan2(from.y - start.cy, from.x - start.cx);
    const a1 = Math.atan2(to.y - start.cy, to.x - start.cx);
    let angle = start.angle + (a1 - a0);
    if (mods.shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    return { ...start, box: { ...start.box }, angle };
  }
  const [hx, hy] = HANDLE_DIRS[handle];
  const W0 = start.box.w * start.sx;
  const H0 = start.box.h * start.sy;
  const lf = docToFrame(start, from);
  const lt = docToFrame(start, to);
  const hxPos = (hx * W0) / 2 + (lt.x - lf.x);
  const hyPos = (hy * H0) / 2 + (lt.y - lf.y);
  let W1 = W0;
  let H1 = H0;
  if (hx !== 0) W1 = mods.alt ? 2 * hxPos * hx : (hxPos + (hx * W0) / 2) * hx;
  if (hy !== 0) H1 = mods.alt ? 2 * hyPos * hy : (hyPos + (hy * H0) / 2) * hy;
  if (mods.shift && hx !== 0 && hy !== 0) {
    const kx = W1 / W0;
    const ky = H1 / H0;
    const k = Math.abs(kx) >= Math.abs(ky) ? kx : ky;
    W1 = W0 * k;
    H1 = H0 * k;
  }
  W1 = clampExtent(W1);
  H1 = clampExtent(H1);
  // New centre in the rotated frame: the anchor stays put.
  const cu = mods.alt || hx === 0 ? 0 : -(hx * W0) / 2 + (hx * W1) / 2;
  const cv = mods.alt || hy === 0 ? 0 : -(hy * H0) / 2 + (hy * H1) / 2;
  const c = Math.cos(start.angle);
  const s = Math.sin(start.angle);
  return {
    box: { ...start.box },
    cx: start.cx + cu * c - cv * s,
    cy: start.cy + cu * s + cv * c,
    sx: W1 / start.box.w,
    sy: H1 / start.box.h,
    angle: start.angle,
  };
}

export function isIdentityTransform(t: TransformParams): boolean {
  return isIdentity(transformMatrix(t));
}

/** Integer bounds of the transformed box (+1 px for filtering), or null. */
export function transformedBounds(t: TransformParams, width: number, height: number): Rect | null {
  const c = transformCorners(t);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const r = coverRect(Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1);
  return r ? clipRect(r, width, height) : null;
}

/**
 * Bounds of what the move tool lifts from `surface`: pixels with alpha > 0
 * that are inside `selection` (any coverage), or null when there are none.
 */
export function liftableBounds(surface: Surface, selection: SelectionMask | null): Rect | null {
  if (!selection || selection.width !== surface.width || selection.height !== surface.height) {
    return surface.alphaBounds();
  }
  const { width: w, height: h, data } = surface;
  const m = selection.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w; x < w; x++, i++) {
      if (m[i] === 0 || data[i * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------
// Text layers as transform boxes
// ---------------------------------------------------------------------------

/** The text props the move tool changes. */
export type TextPlacement = Pick<TextProps, 'x' | 'y' | 'fontSize' | 'rotation'>;

/**
 * Transform params describing a text block: `box` is the unrotated block
 * centred on the block's real centre, `angle` its rotation (radians).
 * Empty blocks get a 1 px box.
 */
export function textTransformParams(props: TextProps, layout: TextLayout): TransformParams {
  const w = Math.max(1, layout.width);
  const h = Math.max(1, layout.height);
  const angle = (props.rotation * Math.PI) / 180;
  const lx = lineStartX(props.align, layout.width) + layout.width / 2;
  const ly = layout.height / 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const cx = props.x + lx * c - ly * s;
  const cy = props.y + lx * s + ly * c;
  return { box: { x: cx - w / 2, y: cy - h / 2, w, h }, cx, cy, sx: 1, sy: 1, angle };
}

/** Degrees normalised to (−180, 180] and rounded to 1e-9 (snapped angles stay exact). */
function normalizeDegrees(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return Math.round(d * 1e9) / 1e9;
}

/**
 * Where a text layer goes when `handle` is dragged from `from` to `to`
 * (see the file comment). `start` holds the props before the drag and
 * `layout` their layout. Edge handles act like 'move': text only scales
 * uniformly, through its font size.
 */
export function dragText(
  start: TextProps,
  layout: TextLayout,
  handle: TransformHandle,
  from: Point,
  to: Point,
  mods: Pick<Modifiers, 'shift' | 'alt'>,
): TextPlacement {
  const t0 = textTransformParams(start, layout);
  const same: TextPlacement = { x: start.x, y: start.y, fontSize: start.fontSize, rotation: start.rotation };
  if (handle === 'move' || handle === 'n' || handle === 's' || handle === 'e' || handle === 'w') {
    const m = dragTransform(t0, 'move', from, to, mods);
    return { ...same, x: start.x + (m.cx - t0.cx), y: start.y + (m.cy - t0.cy) };
  }
  const dx = start.x - t0.cx;
  const dy = start.y - t0.cy;
  if (handle === 'rotate') {
    const r = dragTransform(t0, 'rotate', from, to, mods);
    const delta = r.angle - t0.angle;
    // The block turns about its centre; the anchor turns with it.
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    return {
      ...same,
      x: t0.cx + dx * c - dy * s,
      y: t0.cy + dx * s + dy * c,
      rotation: normalizeDegrees(mods.shift ? (r.angle * 180) / Math.PI : start.rotation + (delta * 180) / Math.PI),
    };
  }
  // Corner: uniform scale about the opposite corner (Alt: about the centre).
  const scaled = dragTransform(t0, handle, from, to, { shift: true, alt: mods.alt });
  const size = Math.max(1, start.fontSize);
  const k = scaled.sx > 0 ? Math.min(MAX_PARAM_PX / size, Math.max(1 / size, scaled.sx)) : 1 / size;
  const [hx, hy] = HANDLE_DIRS[handle];
  const ax = mods.alt ? 0 : (-hx * t0.box.w) / 2;
  const ay = mods.alt ? 0 : (-hy * t0.box.h) / 2;
  const c = Math.cos(t0.angle);
  const s = Math.sin(t0.angle);
  // The anchor A = C0 + R·a stays put, so C1 = A − k·R·a; offsets from the
  // centre scale by k because the layout scales with the font size.
  const cx = t0.cx + (ax * c - ay * s) * (1 - k);
  const cy = t0.cy + (ax * s + ay * c) * (1 - k);
  return { ...same, x: cx + dx * k, y: cy + dy * k, fontSize: start.fontSize * k };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface TransformOptions {
  /** Screen px of handle hit radius. */
  handleTolerance: number;
}

export function defaultTransformOptions(): TransformOptions {
  return { handleTolerance: 7 };
}

/** Screen px between the top edge and the rotate handle. */
const ROTATE_HANDLE_PX = 24;

interface Session {
  tx: PixelTransaction;
  /** Premultiplied content being transformed (document-sized). */
  lifted: FloatImage;
  /** What stays behind (straight RGBA8, document-sized). */
  rest: Pixels;
  params: TransformParams;
  selection: SelectionMask | null;
  lastArea: Rect | null;
  nearest: boolean;
}

interface Gesture {
  handle: TransformHandle;
  from: Point;
  start: TransformParams;
}

interface TextDrag {
  layer: TextLayer;
  /** Props and layout when the drag started. */
  start: TextProps;
  layout: TextLayout;
  handle: TransformHandle;
  from: Point;
}

/** What the box is drawn around: a raster session/preview or a text block. */
interface Target {
  params: TransformParams;
  text: boolean;
}

const CURSORS: Record<TransformHandle, string> = {
  move: 'move',
  rotate: 'grab',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const EDGE_HANDLES = ['n', 'e', 's', 'w'] as const;
const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'] as const;

function textSnapshot(l: TextLayer): TextProps {
  return {
    text: l.text,
    fontFamily: l.fontFamily,
    fontSize: l.fontSize,
    weight: l.weight,
    italic: l.italic,
    align: l.align,
    color: { ...l.color },
    x: l.x,
    y: l.y,
    rotation: l.rotation,
    lineHeight: l.lineHeight,
  };
}

export class TransformTool implements Tool<TransformOptions> {
  readonly id = 'move' as const;
  readonly label = 'Move / Transform';
  readonly shortcut = 'V';
  readonly icon = 'move';
  readonly usesSymmetry = false;
  private session: Session | null = null;
  private gesture: Gesture | null = null;
  private textDrag: TextDrag | null = null;
  private hoverHandle: TransformHandle | null = null;

  defaultOptions(): TransformOptions {
    return defaultTransformOptions();
  }

  /** The pending transform (for numeric UI), or null. */
  get params(): TransformParams | null {
    return this.session ? { ...this.session.params, box: { ...this.session.params.box } } : null;
  }

  hasPending(): boolean {
    return this.session !== null;
  }

  cursor(): CursorHint {
    const dragging = this.gesture?.handle ?? this.textDrag?.handle ?? null;
    const h = dragging ?? this.hoverHandle ?? 'move';
    return { css: dragging && h === 'rotate' ? 'grabbing' : CURSORS[h], radius: 0 };
  }

  /**
   * The box the tool shows right now: the pending session, else the active
   * layer's content bounds or text block (null when there is nothing the
   * tool could move: no content, a hidden or a locked layer).
   */
  previewParams(ctx: ToolContext): TransformParams | null {
    const t = this.target(ctx);
    return t ? { ...t.params, box: { ...t.params.box } } : null;
  }

  hover(ctx: ToolContext, p: PointerInput | null, o: TransformOptions): void {
    const prev = this.hoverHandle;
    const t = p ? this.target(ctx) : null;
    this.hoverHandle = p && t ? this.hit(ctx, t, p, o) : null;
    if (prev !== this.hoverHandle) ctx.overlayChanged();
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: TransformOptions): void {
    this.gesture = null;
    this.textDrag = null;
    if (!this.session) {
      const layer = ctx.activeLayer();
      if (layer?.kind === 'text') {
        this.beginTextDrag(ctx, layer, p, o);
        return;
      }
      if (!this.begin(ctx)) return;
    }
    const s = this.session as Session;
    const handle = this.hit(ctx, { params: s.params, text: false }, p, o) ?? 'move';
    this.gesture = { handle, from: { x: p.x, y: p.y }, start: s.params };
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    const td = this.textDrag;
    if (td) {
      this.placeText(ctx, td.layer, dragText(td.start, td.layout, td.handle, td.from, { x: p.x, y: p.y }, p.modifiers));
      return;
    }
    const g = this.gesture;
    const s = this.session;
    if (!g || !s) return;
    s.params = dragTransform(g.start, g.handle, g.from, { x: p.x, y: p.y }, p.modifiers);
    this.render(ctx, s);
  }

  pointerUp(ctx: ToolContext, p: PointerInput): void {
    const td = this.textDrag;
    if (td) {
      this.pointerMove(ctx, p);
      this.textDrag = null;
      this.recordText(ctx, td);
      ctx.overlayChanged();
      return;
    }
    this.pointerMove(ctx, p);
    this.gesture = null;
    ctx.overlayChanged();
  }

  key(ctx: ToolContext, key: string, mods: Modifiers): boolean {
    if (key === 'Enter') {
      if (!this.session) return false;
      this.commit(ctx);
      return true;
    }
    if (key === 'Escape') {
      if (!this.session) return false;
      this.cancel(ctx);
      return true;
    }
    const step = mods.shift ? 10 : 1;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = d[key];
    if (!delta) return false;
    if (!this.session) {
      const layer = ctx.activeLayer();
      if (layer?.kind === 'text') {
        if (this.canMoveText(ctx, layer)) {
          ctx.execute(
            new PropsCommand('Move text', layer, { x: layer.x, y: layer.y }, { x: layer.x + delta[0], y: layer.y + delta[1] }),
            { mergeKey: `move-text-nudge:${layer.id}` },
          );
          ctx.overlayChanged();
        }
        return true;
      }
      if (!this.begin(ctx)) return true;
    }
    const s = this.session as Session;
    s.params = { ...s.params, cx: s.params.cx + delta[0], cy: s.params.cy + delta[1] };
    this.render(ctx, s);
    return true;
  }

  commit(ctx: ToolContext): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.gesture = null;
    this.hoverHandle = null;
    if (isIdentityTransform(s.params)) {
      ctx.cancelPixels(s.tx);
      ctx.overlayChanged();
      return;
    }
    const extra =
      s.selection
        ? [new SelectionCommand('Transform selection', s.selection, transformMask(s.selection, transformMatrix(s.params)))]
        : [];
    const pure = s.params.angle === 0 && s.params.sx === 1 && s.params.sy === 1;
    ctx.commitPixels(s.tx, pure ? 'Move' : 'Transform', extra);
    ctx.overlayChanged();
  }

  /**
   * During a drag (pointercancel, Esc while dragging, a command that has to
   * settle first) only that drag is reverted, so earlier drags of the session
   * survive and can still be committed. Without a drag the whole session is
   * discarded (Esc, undo). A text drag puts the text back.
   */
  cancel(ctx: ToolContext): void {
    const td = this.textDrag;
    if (td) {
      this.textDrag = null;
      const { x, y, fontSize, rotation: r } = td.start;
      this.placeText(ctx, td.layer, { x, y, fontSize, rotation: r });
      ctx.overlayChanged();
      return;
    }
    const s = this.session;
    const g = this.gesture;
    this.gesture = null;
    if (!s) return;
    if (g) {
      s.params = g.start;
      this.render(ctx, s);
      return;
    }
    this.session = null;
    this.hoverHandle = null;
    ctx.cancelPixels(s.tx);
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter, ctx: ToolContext): void {
    const t = this.target(ctx);
    if (!t) return;
    const q = transformCorners(t.params);
    painter.polyline(q.flatMap((p) => [p.x, p.y]), true);
    const h = handlePositions(t.params, ROTATE_HANDLE_PX / painter.scale);
    painter.line(h.n.x, h.n.y, h.rotate.x, h.rotate.y);
    for (const k of CORNER_HANDLES) painter.handle(h[k].x, h[k].y, 'square');
    if (!t.text) for (const k of EDGE_HANDLES) painter.handle(h[k].x, h[k].y, 'square');
    painter.handle(h.rotate.x, h.rotate.y, 'circle');
  }

  private target(ctx: ToolContext): Target | null {
    if (this.session) return { params: this.session.params, text: false };
    const layer = ctx.activeLayer();
    if (!layer || !layer.visible || layer.locked) return null;
    if (layer.kind === 'text') {
      if (layer.text.trim() === '') return null;
      return { params: textTransformParams(layer, ctx.textLayout(layer)), text: true };
    }
    const bounds = ctx.contentBounds ? ctx.contentBounds(layer) : liftableBounds(layer.surface, ctx.doc.selection);
    return bounds ? { params: initialTransform(bounds), text: false } : null;
  }

  private hit(ctx: ToolContext, t: Target, p: PointerInput, o: TransformOptions): TransformHandle | null {
    const scale = Math.max(ctx.viewScale, 1e-6);
    const tolerance = o.handleTolerance / scale;
    const h = hitTestTransform(t.params, p.x, p.y, tolerance, ROTATE_HANDLE_PX / scale);
    if (h === null || h === 'move' || h === 'rotate') return h;
    // On a box too small for its handles (they would cover all of it), a
    // press inside moves; its handles are still reachable from outside.
    const { box, sx, sy } = t.params;
    if (
      Math.min(Math.abs(box.w * sx), Math.abs(box.h * sy)) < 4 * tolerance &&
      pointInQuad(transformCorners(t.params), p.x, p.y)
    ) {
      return 'move';
    }
    // Text has no edge handles (it only scales uniformly).
    if (t.text && (h === 'n' || h === 's' || h === 'e' || h === 'w')) return 'move';
    return h;
  }

  private canMoveText(ctx: ToolContext, layer: TextLayer): boolean {
    if (layer.locked) {
      ctx.message(`${layer.name} is locked`, 'warning');
      return false;
    }
    if (!layer.visible) {
      ctx.message(`${layer.name} is hidden`, 'warning');
      return false;
    }
    return true;
  }

  private beginTextDrag(ctx: ToolContext, layer: TextLayer, p: PointerInput, o: TransformOptions): void {
    if (!this.canMoveText(ctx, layer)) return;
    const layout = ctx.textLayout(layer);
    const start = textSnapshot(layer);
    const handle = this.hit(ctx, { params: textTransformParams(start, layout), text: true }, p, o) ?? 'move';
    this.textDrag = { layer, start, layout, handle, from: { x: p.x, y: p.y } };
    ctx.overlayChanged();
  }

  /** Applies a placement live (not recorded). */
  private placeText(ctx: ToolContext, layer: TextLayer, to: TextPlacement): void {
    if (layer.x === to.x && layer.y === to.y && layer.fontSize === to.fontSize && layer.rotation === to.rotation) return;
    layer.x = to.x;
    layer.y = to.y;
    layer.fontSize = to.fontSize;
    layer.rotation = to.rotation;
    ctx.emitChanges([{ kind: 'layers' }]);
  }

  /** Records a finished text drag as one entry. */
  private recordText(ctx: ToolContext, td: TextDrag): void {
    const l = td.layer;
    const s = td.start;
    if (l.x === s.x && l.y === s.y && l.fontSize === s.fontSize && l.rotation === s.rotation) return;
    const move = l.fontSize === s.fontSize && l.rotation === s.rotation;
    const before: PropPatch = move ? { x: s.x, y: s.y } : { x: s.x, y: s.y, fontSize: s.fontSize, rotation: s.rotation };
    const after: PropPatch = move ? { x: l.x, y: l.y } : { x: l.x, y: l.y, fontSize: l.fontSize, rotation: l.rotation };
    const label = move ? 'Move text' : td.handle === 'rotate' ? 'Rotate text' : 'Resize text';
    ctx.execute(new PropsCommand(label, l, before, after));
  }

  /** Lifts the content of the active layer; false when there is nothing to move. */
  private begin(ctx: ToolContext): boolean {
    const layer = ctx.paintableLayer();
    if (!layer) return false;
    const { doc } = ctx;
    const { width: w, height: h } = doc;
    const sel = doc.selection?.data ?? null;
    const tx = ctx.beginPixels(layer);
    const base = tx.base;
    const lifted = createFloatImage(w, h);
    const rest = new Uint8ClampedArray(w * h * 4);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const a = base[p + 3];
      if (a === 0) continue;
      const m = sel ? sel[i] / 255 : 1;
      const la = (a / 255) * m;
      if (la > 0) {
        const k = la / 255;
        lifted.data[p] = base[p] * k;
        lifted.data[p + 1] = base[p + 1] * k;
        lifted.data[p + 2] = base[p + 2] * k;
        lifted.data[p + 3] = la;
        const x = i % w;
        const y = (i - x) / w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (m < 1) {
        rest[p] = base[p];
        rest[p + 1] = base[p + 1];
        rest[p + 2] = base[p + 2];
        rest[p + 3] = a * (1 - m);
      }
    }
    if (maxX < 0) {
      ctx.cancelPixels(tx);
      ctx.message(sel ? 'The selection is empty on this layer' : 'This layer is empty');
      return false;
    }
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.session = {
      tx,
      lifted,
      rest,
      params: initialTransform(box),
      selection: doc.selection,
      lastArea: box,
      nearest: doc.pixelArt !== null,
    };
    return true;
  }

  private render(ctx: ToolContext, s: Session): void {
    const { tx } = s;
    const w = tx.width;
    const h = tx.height;
    const area = transformedBounds(s.params, w, h);
    const dirty = unionRect(s.lastArea, area);
    s.lastArea = area;
    if (!dirty) return;
    tx.touch(dirty);
    const out = tx.surface.data;
    const rest = s.rest;
    // Everything in the dirty area starts as what stays behind…
    for (let y = dirty.y; y < dirty.y + dirty.h; y++) {
      const i = (y * w + dirty.x) * 4;
      out.set(rest.subarray(i, i + dirty.w * 4), i);
    }
    // …then the transformed content is composited over it.
    const inv = invert(transformMatrix(s.params));
    if (!area || !inv) {
      ctx.pixelsChanged(tx);
      ctx.overlayChanged();
      return;
    }
    const sample = s.nearest ? sampleNearest : sampleBilinear;
    const px = new Float32Array(4);
    for (let y = area.y; y < area.y + area.h; y++) {
      // Walk the row incrementally in source space.
      const q = apply(inv, area.x + 0.5, y + 0.5);
      let qx = q.x - inv[0];
      let qy = q.y - inv[1];
      for (let x = area.x; x < area.x + area.w; x++) {
        qx += inv[0];
        qy += inv[1];
        sample(s.lifted, qx, qy, px, 0, 'transparent');
        const ta = px[3];
        if (ta <= 0) continue;
        const p = (y * w + x) * 4;
        const ra = rest[p + 3] / 255;
        const oa = ta + ra * (1 - ta);
        const kr = (ra * (1 - ta)) / oa;
        out[p] = (px[0] / oa) * 255 + rest[p] * kr;
        out[p + 1] = (px[1] / oa) * 255 + rest[p + 1] * kr;
        out[p + 2] = (px[2] / oa) * 255 + rest[p + 2] * kr;
        out[p + 3] = oa * 255;
      }
    }
    ctx.pixelsChanged(tx);
    ctx.overlayChanged();
  }
}

export function createTransformTool(): TransformTool {
  return new TransformTool();
}
