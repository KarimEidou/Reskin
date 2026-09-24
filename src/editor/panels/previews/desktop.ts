// Desktop preview maths (pure, unit tested): how Windows lays a wallpaper
// on a monitor for each fit mode, which part of the screen the preview
// vignette shows, and which rendered icon size to draw for a target size.

import type { WallpaperFit } from '$lib/ipc/types';

/** Where the wallpaper image lands on the monitor (physical px). */
export type WallpaperLayout =
  | { kind: 'image'; x: number; y: number; w: number; h: number }
  | { kind: 'tile'; w: number; h: number };

export function wallpaperLayout(fit: WallpaperFit, imgW: number, imgH: number, monW: number, monH: number): WallpaperLayout {
  const w = Math.max(1, imgW);
  const h = Math.max(1, imgH);
  switch (fit) {
    case 'stretch':
      return { kind: 'image', x: 0, y: 0, w: monW, h: monH };
    case 'tile':
      return { kind: 'tile', w, h };
    case 'center':
      return { kind: 'image', x: (monW - w) / 2, y: (monH - h) / 2, w, h };
    case 'fit': {
      const k = Math.min(monW / w, monH / h);
      return { kind: 'image', x: (monW - w * k) / 2, y: (monH - h * k) / 2, w: w * k, h: h * k };
    }
    case 'fill':
    case 'span':
    default: {
      const k = Math.max(monW / w, monH / h);
      return { kind: 'image', x: (monW - w * k) / 2, y: (monH - h * k) / 2, w: w * k, h: h * k };
    }
  }
}

/**
 * The part of the monitor a vignette of `viewW × viewH` physical px shows:
 * centred on a spot in the upper-left area (where desktop icons live),
 * clamped to the screen.
 */
export function vignetteOrigin(monW: number, monH: number, viewW: number, viewH: number, at = { x: 0.3, y: 0.34 }): { x: number; y: number } {
  const x = Math.round(monW * at.x - viewW / 2);
  const y = Math.round(monH * at.y - viewH / 2);
  return {
    x: Math.max(0, Math.min(Math.max(0, monW - viewW), x)),
    y: Math.max(0, Math.min(Math.max(0, monH - viewH), y)),
  };
}

/**
 * The rendered size to draw at `target` px: the exact size when available,
 * else the smallest larger one (Windows scales icons down), else the largest.
 */
export function pickSize(available: readonly number[], target: number): number | null {
  if (available.length === 0) return null;
  const sorted = [...available].sort((a, b) => a - b);
  if (sorted.includes(target)) return target;
  return sorted.find((s) => s > target) ?? sorted[sorted.length - 1]!;
}

/** Windows-style desktop label: at most two lines, ellipsised, for a given measure function. */
export function desktopLabel(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  let lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (!line || measure(next) <= maxWidth) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  lines.push(line);
  if (lines.length > 2) lines = [lines[0]!, lines.slice(1).join(' ')];
  const fit = (s: string) => {
    if (measure(s) <= maxWidth) return s;
    let t = s;
    while (t.length > 1 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  };
  return lines.map(fit);
}
