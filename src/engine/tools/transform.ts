// Move / free transform of the active layer (or of the selected pixels).
//
// The first drag lifts the content (the whole layer, or base × selection)
// and starts a transform session; further drags on the handles scale (from
// the opposite handle, or from the centre with Alt; Shift keeps the aspect
// ratio on corners), rotate (outside a corner or the top handle; Shift
// snaps to 15°) or move (inside; Shift locks an axis). Arrow keys nudge by 1
// px (10 with Shift). The session commits as ONE history entry on Enter or
// when another tool/command runs; Esc and undo cancel it (Esc during a drag
// reverts just that drag). Previews and the commit resample bilinearly
// (nearest in pixel-art documents), and pure translations stay pixel-exact.

import type { CursorHint, Tool, ToolContext } from './types';
import type { Modifiers, PointerInput } from '../input/pointer';
import type { Affine, Point } from '../geometry/affine';
import { apply, compose, invert, isIdentity, rotation, scaling, translation } from '../geometry/affine';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { FloatImage } from '../raster/float-image';
import { createFloatImage } from '../raster/float-image';
import type { Pixels } from '../raster/surface';
import { sampleBilinear, sampleNearest } from '../raster/sample';
import type { SelectionMask } from '../selection/mask';
import { transformMask } from '../selection/mask';
import { SelectionCommand } from '../history/commands';
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
  const near = (p: Point, r: number) => Math.hypot(p.x - x, p.y - y) <= r;
  if (near(h.rotate, tolerance)) return 'rotate';
  for (const k of ['nw', 'ne', 'se', 'sw'] as const) if (near(h[k], tolerance)) return k;
  for (const k of ['n', 'e', 's', 'w'] as const) if (near(h[k], tolerance)) return k;
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

export class TransformTool implements Tool<TransformOptions> {
  readonly id = 'move' as const;
  readonly label = 'Move / Transform';
  readonly shortcut = 'V';
  readonly usesSymmetry = false;
  private session: Session | null = null;
  private gesture: Gesture | null = null;
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
    const h = this.gesture?.handle ?? this.hoverHandle ?? 'move';
    return { css: this.gesture && h === 'rotate' ? 'grabbing' : CURSORS[h], radius: 0 };
  }

  hover(ctx: ToolContext, p: PointerInput | null, o: TransformOptions): void {
    const prev = this.hoverHandle;
    this.hoverHandle = p && this.session ? this.hit(ctx, this.session.params, p, o) : null;
    if (prev !== this.hoverHandle) ctx.overlayChanged();
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: TransformOptions): void {
    const fresh = !this.session;
    if (fresh && !this.begin(ctx)) return;
    const s = this.session as Session;
    // Handles only exist once the box is shown: the first press always moves.
    const handle = fresh ? 'move' : (this.hit(ctx, s.params, p, o) ?? 'move');
    this.gesture = { handle, from: { x: p.x, y: p.y }, start: s.params };
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    const g = this.gesture;
    const s = this.session;
    if (!g || !s) return;
    s.params = dragTransform(g.start, g.handle, g.from, { x: p.x, y: p.y }, p.modifiers);
    this.render(ctx, s);
  }

  pointerUp(ctx: ToolContext, p: PointerInput): void {
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
    if (!this.session && !this.begin(ctx)) return true;
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
   * discarded (Esc, undo).
   */
  cancel(ctx: ToolContext): void {
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

  drawOverlay(painter: OverlayPainter): void {
    const s = this.session;
    if (!s) return;
    const t = s.params;
    const q = transformCorners(t);
    painter.polyline(q.flatMap((p) => [p.x, p.y]), true);
    const h = handlePositions(t, ROTATE_HANDLE_PX / painter.scale);
    painter.line(h.n.x, h.n.y, h.rotate.x, h.rotate.y);
    for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) painter.handle(h[k].x, h[k].y, 'square');
    painter.handle(h.rotate.x, h.rotate.y, 'circle');
  }

  private hit(ctx: ToolContext, t: TransformParams, p: PointerInput, o: TransformOptions): TransformHandle | null {
    const scale = Math.max(ctx.viewScale, 1e-6);
    return hitTestTransform(t, p.x, p.y, o.handleTolerance / scale, ROTATE_HANDLE_PX / scale);
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
