// Lasso selection, freehand or polygonal.
//
// Freehand: drag to draw the outline; releasing closes it. Polygonal: every
// click adds a corner (a press can be dragged to place it; Shift snaps the
// new edge to 45°); a double-click, Enter, or a click on the first corner
// closes the polygon, Backspace removes the last corner and Escape cancels.
// A polygon being built is pending work: undo or Escape discards it, and
// switching tools closes it.
//
// Modifiers at the first press pick the operation (Shift add, Alt subtract,
// Shift+Alt intersect; otherwise the `mode` option), like the marquees. The
// outline becomes an anti-aliased polygon mask (whole pixels in pixel-art
// documents or with `antialias` off), optionally feathered. A freehand
// click without a real outline deselects (in replace mode).

import type { CursorHint, Tool, ToolContext } from './types';
import type { Modifiers, PointerInput } from '../input/pointer';
import type { Point } from '../geometry/affine';
import type { SelectionMask, SelectionOp } from '../selection/mask';
import { combineMasks, featherMask, polygonMask } from '../selection/mask';
import type { OverlayPainter } from '../render/overlay';
import { selectionOpFor } from './select';
import { optionIn } from './dab-tool';

export type LassoKind = 'freehand' | 'polygon';

export interface LassoOptions {
  kind: LassoKind;
  mode: SelectionOp;
  /** Anti-aliased edge (always whole pixels in pixel-art documents). */
  antialias: boolean;
  /** Feather radius, document px. */
  feather: number;
}

export function defaultLassoOptions(): LassoOptions {
  return { kind: 'freehand', mode: 'replace', antialias: true, feather: 0 };
}

/** Two presses at most this far apart in time (ms)… */
export const DOUBLE_CLICK_MS = 500;
/** …and this close (screen px) are a double-click. */
export const DOUBLE_CLICK_PX = 5;
/** Screen px around the first corner that close the polygon. */
const CLOSE_PX = 7;
/** Largest feather radius the lasso applies, document px. */
const MAX_FEATHER = 1024;

/** Selected area of a mask in px² (coverage-weighted). */
function maskArea(m: SelectionMask): number {
  let n = 0;
  const d = m.data;
  for (let i = 0; i < d.length; i++) n += d[i];
  return n / 255;
}

interface Freehand {
  op: SelectionOp;
  points: number[];
}

interface PolygonDraft {
  op: SelectionOp;
  /** Corners [x0, y0, x1, y1, …]; while pressing, the last one follows the pointer. */
  points: number[];
  pressing: boolean;
  lastDown: { x: number; y: number; time: number };
  /** Options of the latest press (used when a tool switch closes the polygon). */
  options: LassoOptions;
}

/** `to`, snapped to a multiple of 45° around `from` when `snap`. */
export function snap45(from: Point, to: Point, snap: boolean): Point {
  if (!snap) return { x: to.x, y: to.y };
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

export class LassoTool implements Tool<LassoOptions> {
  readonly id = 'lasso' as const;
  readonly label = 'Lasso select';
  readonly shortcut = 'L';
  readonly icon = 'lasso';
  readonly usesSymmetry = false;
  private free: Freehand | null = null;
  private poly: PolygonDraft | null = null;
  private hoverAt: (Point & { mods: Modifiers }) | null = null;

  defaultOptions(): LassoOptions {
    return defaultLassoOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  hasPending(): boolean {
    return this.poly !== null;
  }

  /** Corners of the polygon being built (document px, flat), or null. */
  get polygon(): number[] | null {
    return this.poly ? this.poly.points.slice() : null;
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: LassoOptions): void {
    this.hoverAt = { x: p.x, y: p.y, mods: p.modifiers };
    const d = this.poly;
    if (!d && o.kind !== 'polygon') {
      this.free = { op: selectionOpFor(p, o.mode), points: [p.x, p.y] };
      ctx.overlayChanged();
      return;
    }
    if (!d) {
      this.poly = {
        op: selectionOpFor(p, o.mode),
        points: [p.x, p.y],
        pressing: true,
        lastDown: { x: p.x, y: p.y, time: p.time },
        options: o,
      };
      ctx.overlayChanged();
      return;
    }
    const scale = Math.max(ctx.viewScale, 1e-6);
    const n = d.points.length / 2;
    const doubleClick =
      p.time - d.lastDown.time <= DOUBLE_CLICK_MS &&
      p.time >= d.lastDown.time &&
      Math.hypot(p.x - d.lastDown.x, p.y - d.lastDown.y) * scale <= DOUBLE_CLICK_PX;
    const onFirst = n >= 3 && Math.hypot(p.x - d.points[0], p.y - d.points[1]) * scale <= CLOSE_PX;
    if (doubleClick || onFirst) {
      this.close(ctx, o);
      return;
    }
    const q = snap45({ x: d.points[d.points.length - 2], y: d.points[d.points.length - 1] }, p, p.modifiers.shift);
    d.points.push(q.x, q.y);
    d.pressing = true;
    d.lastDown = { x: p.x, y: p.y, time: p.time };
    d.options = o;
    ctx.overlayChanged();
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    this.hoverAt = { x: p.x, y: p.y, mods: p.modifiers };
    const f = this.free;
    if (f) {
      const n = f.points.length;
      const step = Math.max(0.1, 1 / Math.max(ctx.viewScale, 1e-6));
      if (Math.hypot(p.x - f.points[n - 2], p.y - f.points[n - 1]) >= step) f.points.push(p.x, p.y);
      ctx.overlayChanged();
      return;
    }
    const d = this.poly;
    if (d?.pressing) {
      const n = d.points.length;
      if (n >= 4) {
        const q = snap45({ x: d.points[n - 4], y: d.points[n - 3] }, p, p.modifiers.shift);
        d.points[n - 2] = q.x;
        d.points[n - 1] = q.y;
      } else {
        d.points[0] = p.x;
        d.points[1] = p.y;
      }
      ctx.overlayChanged();
    }
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: LassoOptions): void {
    const f = this.free;
    if (f) {
      const n = f.points.length;
      if (p.x !== f.points[n - 2] || p.y !== f.points[n - 1]) f.points.push(p.x, p.y);
      this.free = null;
      this.finish(ctx, f.points, f.op, o, true);
      ctx.overlayChanged();
      return;
    }
    const d = this.poly;
    if (d?.pressing) {
      this.pointerMove(ctx, p);
      d.pressing = false;
    }
  }

  hover(ctx: ToolContext, p: PointerInput | null): void {
    this.hoverAt = p ? { x: p.x, y: p.y, mods: p.modifiers } : null;
    if (this.poly) ctx.overlayChanged();
  }

  key(ctx: ToolContext, key: string, _mods: Modifiers, o: LassoOptions): boolean {
    const d = this.poly;
    if (!d) return false;
    if (key === 'Enter') {
      this.close(ctx, o);
      return true;
    }
    if (key === 'Escape') {
      this.cancel(ctx);
      return true;
    }
    if (key === 'Backspace') {
      // During a press this drops the corner being placed; the rest of
      // that press then does nothing (it must not drag an older corner).
      d.pressing = false;
      if (d.points.length <= 2) this.poly = null;
      else d.points.length -= 2;
      ctx.overlayChanged();
      return true;
    }
    return false;
  }

  /** Closes a pending polygon (tool switch, `engine.commitPending()`). */
  commit(ctx: ToolContext, o?: LassoOptions): void {
    const d = this.poly;
    if (d) this.close(ctx, o ?? d.options);
  }

  /**
   * During a press: drops what that press did (the freehand outline, or the
   * polygon corner being placed). Otherwise discards the whole polygon.
   */
  cancel(ctx: ToolContext): void {
    if (this.free) {
      this.free = null;
      ctx.overlayChanged();
      return;
    }
    const d = this.poly;
    if (!d) return;
    if (d.pressing) {
      d.pressing = false;
      d.points.length -= 2;
      if (d.points.length === 0) this.poly = null;
    } else {
      this.poly = null;
    }
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter, _ctx: ToolContext, _o: LassoOptions, hover: Point | null): void {
    const f = this.free;
    if (f) {
      painter.polyline(f.points, false, { dash: [4, 4] });
      const n = f.points.length;
      if (n >= 6) painter.line(f.points[n - 2], f.points[n - 1], f.points[0], f.points[1], { dash: [2, 4], width: 1 });
      return;
    }
    const d = this.poly;
    if (!d) return;
    const pts = d.points.slice();
    const n = pts.length;
    const at = this.hoverAt ?? (hover ? { ...hover, mods: { shift: false, alt: false, ctrl: false, meta: false } } : null);
    if (!d.pressing && at) {
      const q = snap45({ x: pts[n - 2], y: pts[n - 1] }, at, at.mods.shift);
      pts.push(q.x, q.y);
    }
    painter.polyline(pts, false, { dash: [4, 4] });
    if (pts.length >= 6) {
      painter.line(pts[pts.length - 2], pts[pts.length - 1], pts[0], pts[1], { dash: [2, 4] });
    }
    for (let i = 2; i < n; i += 2) painter.handle(d.points[i], d.points[i + 1], 'square', 5);
    painter.handle(d.points[0], d.points[1], 'circle', n >= 6 ? 9 : 6);
  }

  private close(ctx: ToolContext, o: LassoOptions): void {
    const d = this.poly;
    if (!d) return;
    this.poly = null;
    this.finish(ctx, d.points, d.op, o, false);
    ctx.overlayChanged();
  }

  /** Turns an outline into the selection. */
  private finish(ctx: ToolContext, points: number[], op: SelectionOp, o: LassoOptions, freehand: boolean): void {
    const { doc } = ctx;
    // The enclosed area decides, not the signed area: a figure-eight
    // outline encloses two lobes of opposite winding (nonzero rule).
    let shape =
      points.length >= 6 ? polygonMask(doc.width, doc.height, [points], o.antialias && doc.pixelArt === null) : null;
    if (!shape || maskArea(shape) < 1) {
      // A freehand click (or a sliver) acts like a marquee click.
      if (freehand && op === 'replace' && doc.selection) ctx.setSelection(null, 'Deselect');
      return;
    }
    const feather = optionIn(o.feather, 0, MAX_FEATHER, 0);
    if (feather > 0) shape = featherMask(shape, feather) ?? shape;
    ctx.setSelection(combineMasks(doc.selection, shape, op), this.label);
  }
}

export function createLassoTool(): LassoTool {
  return new LassoTool();
}
