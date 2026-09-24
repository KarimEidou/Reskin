// Viewport-only tools. They need `screenX/screenY` on pointer input (view
// CSS px) and a viewport attached to the engine; otherwise they do nothing.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';

export class HandTool implements Tool<object> {
  readonly id = 'hand' as const;
  readonly label = 'Hand';
  readonly shortcut = 'H';
  readonly icon = 'hand';
  readonly usesSymmetry = false;
  private last: { x: number; y: number } | null = null;

  defaultOptions(): object {
    return {};
  }

  cursor(): CursorHint {
    return { css: this.last ? 'grabbing' : 'grab', radius: 0 };
  }

  pointerDown(_ctx: ToolContext, p: PointerInput): void {
    this.last = p.screenX !== undefined && p.screenY !== undefined ? { x: p.screenX, y: p.screenY } : null;
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    if (!this.last || p.screenX === undefined || p.screenY === undefined || !ctx.viewport) return;
    ctx.viewport.panBy(p.screenX - this.last.x, p.screenY - this.last.y);
    this.last = { x: p.screenX, y: p.screenY };
  }

  pointerUp(ctx: ToolContext, p: PointerInput): void {
    this.pointerMove(ctx, p);
    this.last = null;
  }

  cancel(): void {
    this.last = null;
  }
}

export interface ZoomOptions {
  /** Click zooms out instead of in (Alt inverts). */
  zoomOut: boolean;
}

/** Screen px of horizontal drag per doubling of the zoom (scrubby zoom). */
const SCRUB_PX_PER_DOUBLING = 120;

export class ZoomTool implements Tool<ZoomOptions> {
  readonly id = 'zoom' as const;
  readonly label = 'Zoom';
  readonly shortcut = 'Z';
  readonly icon = 'zoom-in';
  readonly usesSymmetry = false;
  private start: { x: number; y: number; zoom: number; scrubbed: boolean } | null = null;

  defaultOptions(): ZoomOptions {
    return { zoomOut: false };
  }

  cursor(o: ZoomOptions): CursorHint {
    return { css: o.zoomOut ? 'zoom-out' : 'zoom-in', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput): void {
    if (!ctx.viewport || p.screenX === undefined || p.screenY === undefined) return;
    this.start = { x: p.screenX, y: p.screenY, zoom: ctx.viewport.zoom, scrubbed: false };
  }

  pointerMove(ctx: ToolContext, p: PointerInput): void {
    const s = this.start;
    if (!s || !ctx.viewport || p.screenX === undefined) return;
    const dx = p.screenX - s.x;
    if (!s.scrubbed && Math.abs(dx) < 4) return;
    s.scrubbed = true;
    ctx.viewport.setZoom(s.zoom * Math.pow(2, dx / SCRUB_PX_PER_DOUBLING), s.x, s.y);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: ZoomOptions): void {
    const s = this.start;
    this.start = null;
    if (!s || !ctx.viewport || s.scrubbed) return;
    const out = o.zoomOut !== p.modifiers.alt;
    ctx.viewport.zoomStep(out ? -1 : 1, s.x, s.y);
  }

  cancel(): void {
    this.start = null;
  }
}

export function createHandTool(): HandTool {
  return new HandTool();
}

export function createZoomTool(): ZoomTool {
  return new ZoomTool();
}
