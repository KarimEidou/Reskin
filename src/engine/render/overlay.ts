// Tool overlays are described through this small drawing interface, so tool
// code stays DOM-free. Coordinates are DOCUMENT px; line widths, handle
// sizes and dashes are SCREEN px (overlays keep a constant on-screen size
// at any zoom). The canvas view implements it on a 2D context.

export interface OverlayStyle {
  /** CSS colour; the painter picks a contrasting default when omitted. */
  color?: string;
  /** Screen px (default 1). */
  width?: number;
  /** Screen px dash pattern. */
  dash?: readonly number[];
  /** Fill colour for closed shapes / handles. */
  fill?: string;
  /** Draw a dark/light double stroke so the line reads on any background (default true). */
  contrast?: boolean;
}

export type HandleShape = 'square' | 'circle';

export interface OverlayPainter {
  /** Screen px per document px. */
  readonly scale: number;
  line(x0: number, y0: number, x1: number, y1: number, style?: OverlayStyle): void;
  /** Axis-aligned rectangle in document space. */
  rect(x: number, y: number, w: number, h: number, style?: OverlayStyle): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, style?: OverlayStyle): void;
  /** Flat [x0, y0, x1, y1, …] document points. */
  polyline(points: readonly number[], closed: boolean, style?: OverlayStyle): void;
  /** A fixed-size (screen px) handle centred on a document point. */
  handle(x: number, y: number, shape?: HandleShape, sizePx?: number): void;
}
