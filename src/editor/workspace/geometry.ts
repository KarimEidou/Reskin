// Pure coordinate / layout maths for the canvas stage (unit tested).
//
// Units: "client" = CSS px relative to the page viewport (PointerEvent
// clientX/Y); "stage" = CSS px inside the canvas element (the Viewport's
// "screen" space); "doc" = document px.

import type { TextLayout, TextProps } from '$engine/index';

/** A view transform: stage = doc · scale + pan. */
export interface ViewTransform {
  scale: number;
  panX: number;
  panY: number;
}

/**
 * Backing-store size of a canvas shown at `cssW`×`cssH` CSS px on a
 * `dpr` display. `device` (from `devicePixelContentBoxSize`) wins when the
 * browser reports it: it is exact, rounding may be off by one.
 */
export function backingSize(
  cssW: number,
  cssH: number,
  dpr: number,
  device?: { inlineSize: number; blockSize: number } | null,
): { width: number; height: number } {
  if (device && device.inlineSize > 0 && device.blockSize > 0) {
    return { width: Math.round(device.inlineSize), height: Math.round(device.blockSize) };
  }
  const k = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.max(1, Math.round(cssW * k)), height: Math.max(1, Math.round(cssH * k)) };
}

/** Split position (0..1 of the document width) under a stage x coordinate. */
export function splitFromStageX(stageX: number, t: ViewTransform, docW: number): number {
  const w = docW * t.scale;
  if (!(w > 0)) return 0.5;
  return clamp01((stageX - t.panX) / w);
}

/**
 * Screen placement of the inline text editor over a text layer: its box
 * (stage px, unrotated, top-left corner), font metrics scaled to the view
 * and the rotation about the text anchor.
 */
export interface TextEditorBox {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  /** Degrees, clockwise, about (originX, 0) of the box. */
  rotation: number;
  originX: number;
}

/** Minimum editor width in ems, so an empty text still shows a caret box. */
const MIN_EDITOR_EM = 0.75;
/** Extra px on the right so the caret never clips at the end of a line. */
const CARET_ROOM = 4;

export function textEditorBox(
  props: Pick<TextProps, 'x' | 'y' | 'align' | 'rotation' | 'fontSize' | 'lineHeight'>,
  layout: Pick<TextLayout, 'width' | 'height' | 'lineHeight'>,
  t: ViewTransform,
): TextEditorBox {
  const s = t.scale;
  const fontSize = props.fontSize * s;
  const lineHeight = layout.lineHeight * s;
  const width = Math.max(layout.width * s, fontSize * MIN_EDITOR_EM) + CARET_ROOM;
  const height = Math.max(layout.height * s, lineHeight);
  // The anchor sits at the left edge, centre or right edge of the block.
  const originX = props.align === 'left' ? 0 : props.align === 'center' ? width / 2 : width;
  const ax = t.panX + props.x * s;
  const ay = t.panY + props.y * s;
  return {
    left: ax - originX,
    top: ay,
    width,
    height,
    fontSize,
    lineHeight,
    rotation: props.rotation,
    originX,
  };
}

/** The viewport shape `isFitted` needs (a Viewport satisfies it). */
export interface FitProbe {
  zoom: number;
  panX: number;
  panY: number;
  scale: number;
  viewWidth: number;
  viewHeight: number;
  docWidth: number;
  docHeight: number;
  fitZoom(): number;
}

/** True when the view shows the whole document, centred, at the fit zoom. */
export function isFitted(v: FitProbe): boolean {
  const fit = v.fitZoom();
  if (Math.abs(v.zoom - fit) > fit * 1e-6) return false;
  const cx = (v.viewWidth - v.docWidth * v.scale) / 2;
  const cy = (v.viewHeight - v.docHeight * v.scale) / 2;
  return Math.abs(v.panX - cx) < 0.5 && Math.abs(v.panY - cy) < 0.5;
}

/** "100%", "33%", "1600%" — rounded, never "0%". */
export function formatZoom(zoom: number): string {
  if (!Number.isFinite(zoom) || zoom <= 0) return '—';
  const pct = zoom * 100;
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, '') : Math.round(pct)}%`;
}

/** Wheel notches (mouse) vs. fine-grained deltas (touchpads, pinch). */
export type WheelZoom = { kind: 'step'; direction: 1 | -1 } | { kind: 'smooth'; factor: number } | null;

/** px per notch reported by Chromium on Windows for a classic mouse wheel. */
const NOTCH_THRESHOLD = 50;
/** Zoom sensitivity for pixel deltas (exp(-dy · k)). */
const SMOOTH_ZOOM_K = 0.0075;

/**
 * How a wheel event zooms. Classic wheels (line mode, or big pixel deltas)
 * step through the zoom presets; touchpads / pinch (small pixel deltas,
 * Ctrl held for pinch) zoom smoothly.
 */
export function wheelZoom(deltaY: number, deltaMode: number): WheelZoom {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  if (deltaMode === 1 || deltaMode === 2 || Math.abs(deltaY) >= NOTCH_THRESHOLD) {
    return { kind: 'step', direction: deltaY < 0 ? 1 : -1 };
  }
  return { kind: 'smooth', factor: Math.exp(-deltaY * SMOOTH_ZOOM_K) };
}

/** Interpolates two view states for animated fit / 100 %: zoom in log space. */
export function mixView(
  a: { zoom: number; panX: number; panY: number },
  b: { zoom: number; panX: number; panY: number },
  p: number,
): { zoom: number; panX: number; panY: number } {
  const q = clamp01(p);
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * q);
  return { zoom, panX: a.panX + (b.panX - a.panX) * q, panY: a.panY + (b.panY - a.panY) * q };
}

/** Is a physical-px point (Tauri drag position) inside an element's client rect? */
export function physicalPointIn(
  pos: { x: number; y: number },
  dpr: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  const k = dpr > 0 ? dpr : 1;
  const x = pos.x / k;
  const y = pos.y / k;
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
