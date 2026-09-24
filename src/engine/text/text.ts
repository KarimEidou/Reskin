// Text layers: layout contract, cache management and hit-testing geometry.
//
// Rasterising text needs real fonts, so it is delegated to a
// `TextRasterizer` (the Canvas implementation lives in ./measure-canvas.ts
// and is only imported by the UI). The pure core only needs measurements
// for hit-testing/overlays; without a rasterizer an approximate layout is
// used and text caches stay as they are.

import type { Doc, TextLayer, TextProps } from '../doc/types';
import { TEXT_PROP_KEYS } from '../doc/types';
import type { Surface } from '../raster/surface';
import type { Point } from '../geometry/affine';
import { toCssRgb } from '../color/color';

export interface TextLayout {
  lines: { text: string; width: number }[];
  /** Line box height, px (fontSize · lineHeight). */
  lineHeight: number;
  /** Font ascent/descent, px. */
  ascent: number;
  descent: number;
  /** Width of the widest line and total block height, px. */
  width: number;
  height: number;
}

export interface TextMeasurer {
  measure(props: TextProps): TextLayout;
}

export interface TextRenderOptions {
  /** Threshold alpha to 0/255 (pixel-art documents). */
  crisp: boolean;
}

export interface TextRasterizer extends TextMeasurer {
  /** Renders the text into a new `width`×`height` straight-alpha surface. */
  render(props: TextProps, width: number, height: number, opts: TextRenderOptions): Surface;
}

/** CSS font shorthand for canvas: `italic 700 48px "Family", sans-serif`. */
export function cssFont(p: Pick<TextProps, 'italic' | 'weight' | 'fontSize' | 'fontFamily'>): string {
  const family = p.fontFamily.replace(/["\\]/g, '');
  return `${p.italic ? 'italic ' : ''}${Math.round(p.weight)} ${p.fontSize}px "${family}", sans-serif`;
}

export function cssColor(p: Pick<TextProps, 'color'>): string {
  return toCssRgb(p.color);
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Layout from per-line widths (shared by the approximate and Canvas measurers). */
export function layoutFromWidths(
  props: TextProps,
  lines: string[],
  widths: number[],
  ascent: number,
  descent: number,
): TextLayout {
  const lineHeight = props.fontSize * props.lineHeight;
  return {
    lines: lines.map((text, i) => ({ text, width: widths[i] })),
    lineHeight,
    ascent,
    descent,
    width: widths.reduce((m, w) => Math.max(m, w), 0),
    height: lines.length * lineHeight,
  };
}

/** Font-free estimate (0.55 em per character, 0.6 em when bold). */
export const approximateMeasurer: TextMeasurer = {
  measure(props) {
    const lines = splitLines(props.text);
    const em = props.fontSize * (props.weight >= 600 ? 0.6 : 0.55);
    return layoutFromWidths(
      props,
      lines,
      lines.map((l) => [...l].length * em),
      props.fontSize * 0.8,
      props.fontSize * 0.2,
    );
  },
};

/** Baseline y (block-local) of line `i`. */
export function baselineOf(layout: TextLayout, i: number): number {
  const halfLeading = (layout.lineHeight - (layout.ascent + layout.descent)) / 2;
  return i * layout.lineHeight + halfLeading + layout.ascent;
}

/** Left x (block-local) of a line for the given alignment. */
export function lineStartX(align: TextProps['align'], lineWidth: number): number {
  return align === 'left' ? 0 : align === 'center' ? -lineWidth / 2 : -lineWidth;
}

/** The text block's four corners in document coordinates (TL, TR, BR, BL). */
export function textQuad(props: TextProps, layout: TextLayout): Point[] {
  const left = lineStartX(props.align, layout.width);
  const corners: [number, number][] = [
    [left, 0],
    [left + layout.width, 0],
    [left + layout.width, layout.height],
    [left, layout.height],
  ];
  const a = (props.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return corners.map(([x, y]) => ({ x: props.x + x * c - y * s, y: props.y + x * s + y * c }));
}

/** True when (x, y) lies inside the rotated text block (with `pad` px slack). */
export function hitTestText(props: TextProps, layout: TextLayout, x: number, y: number, pad = 0): boolean {
  const a = (-props.rotation * Math.PI) / 180;
  const dx = x - props.x;
  const dy = y - props.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const left = lineStartX(props.align, layout.width);
  return lx >= left - pad && lx <= left + layout.width + pad && ly >= -pad && ly <= layout.height + pad;
}

export function pickTextProps(layer: TextProps): TextProps {
  const out = {} as Record<string, unknown>;
  for (const k of TEXT_PROP_KEYS) out[k] = k === 'color' ? { ...layer.color } : layer[k];
  return out as unknown as TextProps;
}

export function defaultTextProps(docSize: number): TextProps {
  return {
    text: 'Text',
    fontFamily: 'Segoe UI',
    fontSize: Math.max(4, Math.round(docSize / 8)),
    weight: 600,
    italic: false,
    align: 'center',
    color: { r: 255, g: 255, b: 255, a: 1 },
    x: docSize / 2,
    y: docSize / 2,
    rotation: 0,
    lineHeight: 1.2,
  };
}

/** What a text cache depends on: every text prop plus the document size/mode. */
export function textCacheKey(layer: TextLayer, doc: Pick<Doc, 'width' | 'height' | 'pixelArt'>): string {
  return JSON.stringify([pickTextProps(layer), doc.width, doc.height, doc.pixelArt?.grid ?? 0]);
}

/**
 * Re-renders `layer.cache` if it is stale. Returns true when it changed.
 * Without a rasterizer the (possibly stale) cache is kept.
 */
export function refreshTextCache(
  layer: TextLayer,
  doc: Pick<Doc, 'width' | 'height' | 'pixelArt'>,
  rasterizer: TextRasterizer | null,
): boolean {
  if (!rasterizer) return false;
  const key = textCacheKey(layer, doc);
  if (key === layer.cacheKey && layer.cache) return false;
  layer.cache = rasterizer.render(pickTextProps(layer), doc.width, doc.height, { crisp: doc.pixelArt !== null });
  layer.cacheKey = key;
  return true;
}

export function isTextCacheFresh(layer: TextLayer, doc: Pick<Doc, 'width' | 'height' | 'pixelArt'>): boolean {
  return layer.cache !== null && layer.cacheKey === textCacheKey(layer, doc);
}
