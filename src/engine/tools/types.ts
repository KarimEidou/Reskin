// The Tool interface and the context the Engine gives tools.
//
// Tools receive pointer input in DOCUMENT coordinates plus an options
// object, and act on the document only through `ToolContext` (pixel
// transactions, recorded commands, colours, messages). They never touch the
// DOM; overlays are drawn through `OverlayPainter`.

import type { Rgba } from '../color/color';
import type { Doc, Layer, RasterLayer, TextLayer } from '../doc/types';
import type { Rect } from '../util/rect';
import type { Point } from '../geometry/affine';
import type { Change, PushOptions } from '../history/history';
import type { DocCommand } from '../history/commands';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { Modifiers, PointerInput } from '../input/pointer';
import type { Surface } from '../raster/surface';
import type { OverlayPainter } from '../render/overlay';
import type { SelectionMask } from '../selection/mask';
import type { SymmetrySettings } from '../symmetry/symmetry';
import type { TextLayout } from '../text/text';
import type { Viewport } from '../viewport/viewport';

export type ToolId =
  | 'move'
  | 'selectRect'
  | 'selectEllipse'
  | 'lasso'
  | 'magicWand'
  | 'brush'
  | 'spray'
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'gradient'
  | 'shape'
  | 'text'
  | 'eyedropper'
  | 'stamp'
  | 'smudge'
  | 'blurSharpen'
  | 'dodgeBurn'
  | 'hand'
  | 'zoom';

/**
 * Tools that can share one rail slot with a flyout (docs/UI.md "Tool
 * rail"): the two marquees, brush + spray, and the retouching tools.
 */
export type ToolGroup = 'marquee' | 'brush' | 'retouch';

export interface CursorHint {
  /** CSS `cursor` value for the canvas element. */
  css: string;
  /** Footprint radius in document px for brush-like tools (0 = none). */
  radius: number;
}

export type MessageLevel = 'info' | 'warning';

/** Reusable zeroed work buffers (one set per engine, sized to the document). */
export class Scratch {
  private floats: Float32Array | null = null;
  private shorts: Uint16Array | null = null;

  /** A zeroed Float32Array of length n (shared: valid until the next call). */
  floatPlane(n: number): Float32Array {
    if (!this.floats || this.floats.length !== n) this.floats = new Float32Array(n);
    else this.floats.fill(0);
    return this.floats;
  }

  /** A zeroed Uint16Array of length n (shared: valid until the next call). */
  counters(n: number): Uint16Array {
    if (!this.shorts || this.shorts.length !== n) this.shorts = new Uint16Array(n);
    else this.shorts.fill(0);
    return this.shorts;
  }
}

export interface ToolContext {
  readonly doc: Doc;
  readonly primary: Rgba;
  readonly secondary: Rgba;
  readonly symmetry: SymmetrySettings;
  /** Present when the UI attached a viewport (hand/zoom need it). */
  readonly viewport: Viewport | null;
  /** Screen px per document px (1 without a viewport), for handle sizes. */
  readonly viewScale: number;
  readonly scratch: Scratch;

  activeLayer(): Layer | null;
  /** Makes a layer active (not recorded in history, like layer selection in most editors). */
  setActiveLayer(id: string): void;
  /** The active layer if it is a visible, unlocked raster layer; otherwise posts why and returns null. */
  paintableLayer(): RasterLayer | null;

  beginPixels(layer: RasterLayer): PixelTransaction;
  /** Publishes live changes of an open transaction (redraw). */
  pixelsChanged(tx: PixelTransaction): void;
  /** Records the transaction (plus optional extra commands) as one history entry. */
  commitPixels(tx: PixelTransaction, label: string, extra?: DocCommand[]): void;
  cancelPixels(tx: PixelTransaction): void;

  /** Applies and records a document command. */
  execute(cmd: DocCommand | null, opts?: PushOptions): void;
  /** Replaces the selection (recorded). */
  setSelection(mask: SelectionMask | null, label: string): void;

  /** Straight-alpha composite of the visible layers (cached). */
  composite(): Surface;
  setColor(which: 'primary' | 'secondary', color: Rgba): void;
  message(text: string, level?: MessageLevel): void;
  /** The tool's overlay changed (redraw without pixel changes). */
  overlayChanged(): void;

  textLayout(layer: TextLayer): TextLayout;
  /** Asks the UI to open (layer id) or close (null) the inline text editor. */
  requestTextEdit(layerId: string | null): void;
  /** Emits changes (used by tools that edit layers directly). */
  emitChanges(changes: Change[]): void;
  /**
   * Bounds of the pixels the move tool would lift from a raster layer
   * (alpha > 0 and inside the selection), cached until the layer's pixels,
   * the layer list or the selection change. Null when there are none.
   * Optional (added later): tools fall back to `liftableBounds`, uncached.
   */
  contentBounds?(layer: RasterLayer): Rect | null;
}

export interface Tool<O extends object = object> {
  readonly id: ToolId;
  readonly label: string;
  /** Keyboard shortcut shown in tooltips. */
  readonly shortcut: string;
  /** Lucide icon name hint (kebab-case, e.g. 'lasso'); see TOOL_META. */
  readonly icon?: string;
  /** Rail group hint (see ToolGroup). */
  readonly group?: ToolGroup;
  /** Painting tools replicate strokes through the symmetry settings. */
  readonly usesSymmetry: boolean;

  defaultOptions(): O;
  cursor(options: O, ctx: ToolContext): CursorHint;

  pointerDown(ctx: ToolContext, p: PointerInput, options: O): void;
  pointerMove(ctx: ToolContext, p: PointerInput, options: O): void;
  pointerUp(ctx: ToolContext, p: PointerInput, options: O): void;
  /** Pointer moved with no button down (null = left the canvas). */
  hover?(ctx: ToolContext, p: PointerInput | null, options: O): void;
  /**
   * Aborts the gesture in progress (Esc, pointercancel). Tools with state
   * across gestures (`hasPending`) revert only the current gesture when one
   * is in progress, and discard the pending state when called without one.
   */
  cancel(ctx: ToolContext): void;
  /** Finishes state kept across gestures (e.g. a pending transform); receives the current options. */
  commit?(ctx: ToolContext, options?: O): void;
  /** True while there is uncommitted state across gestures. */
  hasPending?(): boolean;
  /** Keyboard input while the tool is active; true when handled. */
  key?(ctx: ToolContext, key: string, mods: Modifiers, options: O): boolean;
  /** Tool overlay (brush outline, marquee, handles…). `hover` is the last pointer position. */
  drawOverlay?(painter: OverlayPainter, ctx: ToolContext, options: O, hover: Point | null): void;
}
