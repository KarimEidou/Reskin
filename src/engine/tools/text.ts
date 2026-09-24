// Text tool: click an existing text layer to edit it (drag to move it: one
// "Move text" entry on release, Esc reverts), or click elsewhere to create a
// new text layer anchored at the click. The Engine then asks the UI to open
// its inline editor (`textEdit` event); the UI writes the text with
// `engine.updateText`, and `engine.endTextEdit()` removes a layer that was
// left empty.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { TextAlign, TextLayer } from '../doc/types';
import { createTextLayer } from '../doc/document';
import { addLayerOp } from '../doc/ops';
import { PropsCommand } from '../history/commands';
import { hitTestText, textQuad } from '../text/text';
import type { OverlayPainter } from '../render/overlay';

export interface TextToolOptions {
  fontFamily: string;
  /** Document px. */
  fontSize: number;
  weight: number;
  italic: boolean;
  align: TextAlign;
}

export function defaultTextToolOptions(): TextToolOptions {
  return { fontFamily: 'Segoe UI', fontSize: 64, weight: 600, italic: false, align: 'center' };
}

interface MoveDrag {
  layer: TextLayer;
  startX: number;
  startY: number;
  px: number;
  py: number;
  moved: boolean;
}

/** Top-most visible text layer under (x, y). */
export function textLayerAt(ctx: ToolContext, x: number, y: number): TextLayer | null {
  const layers = ctx.doc.layers;
  const pad = 4 / Math.max(ctx.viewScale, 1e-6);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.kind !== 'text' || !l.visible) continue;
    if (hitTestText(l, ctx.textLayout(l), x, y, pad)) return l;
  }
  return null;
}

export class TextTool implements Tool<TextToolOptions> {
  readonly id = 'text' as const;
  readonly label = 'Text';
  readonly shortcut = 'T';
  readonly usesSymmetry = false;
  private drag: MoveDrag | null = null;

  defaultOptions(): TextToolOptions {
    return defaultTextToolOptions();
  }

  cursor(): CursorHint {
    return { css: 'text', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: TextToolOptions): void {
    this.drag = null;
    const hit = textLayerAt(ctx, p.x, p.y);
    if (hit) {
      ctx.setActiveLayer(hit.id);
      if (!hit.locked) {
        this.drag = { layer: hit, startX: hit.x, startY: hit.y, px: p.x, py: p.y, moved: false };
      }
      return;
    }
    // Close the current edit first: a text it created and left empty is then
    // rolled back without history entries, and the new layer's own session
    // starts right after its "Add text" entry.
    ctx.requestTextEdit(null);
    const layer = createTextLayer(ctx.doc, {
      text: '',
      name: 'Text',
      fontFamily: o.fontFamily,
      fontSize: Math.max(1, o.fontSize),
      weight: o.weight,
      italic: o.italic,
      align: o.align,
      color: { ...ctx.primary },
      x: p.x,
      y: p.y,
    });
    ctx.execute(addLayerOp(ctx.doc, layer, undefined, 'Add text'));
    ctx.requestTextEdit(layer.id);
  }

  /** Moves the layer live (not recorded); the release records one entry. */
  pointerMove(ctx: ToolContext, p: PointerInput): void {
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.px;
    const dy = p.y - d.py;
    if (!d.moved && Math.hypot(dx, dy) * ctx.viewScale < 3) return;
    d.moved = true;
    this.place(ctx, d, d.startX + dx, d.startY + dy);
  }

  pointerUp(ctx: ToolContext, p: PointerInput): void {
    const d = this.drag;
    if (!d) return;
    this.pointerMove(ctx, p);
    this.drag = null;
    if (!d.moved) {
      ctx.requestTextEdit(d.layer.id);
      return;
    }
    const { x, y } = d.layer;
    if (x === d.startX && y === d.startY) return;
    ctx.execute(new PropsCommand('Move text', d.layer, { x: d.startX, y: d.startY }, { x, y }));
  }

  cancel(ctx: ToolContext): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.moved) this.place(ctx, d, d.startX, d.startY);
  }

  private place(ctx: ToolContext, d: MoveDrag, x: number, y: number): void {
    if (d.layer.x === x && d.layer.y === y) return;
    d.layer.x = x;
    d.layer.y = y;
    ctx.emitChanges([{ kind: 'layers' }]);
  }

  drawOverlay(painter: OverlayPainter, ctx: ToolContext): void {
    const active = ctx.activeLayer();
    if (!active || active.kind !== 'text') return;
    const q = textQuad(active, ctx.textLayout(active));
    painter.polyline(
      q.flatMap((pt) => [pt.x, pt.y]),
      true,
      { dash: [3, 3] },
    );
  }
}

export function createTextTool(): TextTool {
  return new TextTool();
}
