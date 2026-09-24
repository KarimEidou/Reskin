/**
 * The twelve style presets. Each builds a layer stack from the icon's own
 * glyph / colours (see icon.ts): a backdrop plate (the backdrop generator),
 * the styled icon with non-destructive layer effects, and sometimes a
 * decor or gloss layer. All lengths are fractions of the output size;
 * effect distances are converted to px at the end, so thumbnails and
 * full-size renders match.
 */
import { renderBackdrop, backdropCoverage } from '../backdrop/render';
import type { BackdropShape } from '../backdrop/shapes';
import type { BackdropSpecInput } from '../backdrop/spec';
import { createEffect } from '../doc/effects';
import type { BlendMode, LayerEffect } from '../doc/types';
import { applyFilter } from '../filters/registry';
import { mulberry32 } from '../filters/prng';
import { createPixels, type Pixels } from '../filters/types';
import { fitAndCenter } from '../helpers/trim';
import { resizePixels } from '../helpers/resample';
import { placeGlyph, placeIcon, type IconAnalysis } from './icon';
import {
  alphaPlane,
  blurPlane,
  clamp01,
  dilatePlane,
  effectColor,
  fillPlane,
  hex,
  hsl,
  linear,
  lumaPlane,
  maskPixels,
  mix,
  multiplyPlanes,
  over,
  planeBounds,
  radial,
  ringPlane,
  smoothShape,
  solid,
  toHexString,
  withAlpha,
  type Plane,
  type Rgba,
  type Stop,
} from './paint';
import type { PresetId, PresetInfo, PresetLayer, PresetLayerRole, PresetOptions, PresetResult } from './types';

interface Ctx {
  a: IconAnalysis;
  size: number;
  /** Accent hue (option or the icon's). */
  hue: number;
  /** Intensity 0..1 (0.5 = as designed). */
  k: number;
  shape: BackdropShape;
  seed: number;
}

/** lo at k = 0, mid at k = 0.5, hi at k = 1. */
function amt(ctx: Ctx, lo: number, mid: number, hi: number): number {
  return ctx.k < 0.5 ? lo + (mid - lo) * (ctx.k * 2) : mid + (hi - mid) * ((ctx.k - 0.5) * 2);
}

function layer(
  name: string,
  role: PresetLayerRole,
  pixels: Pixels,
  extra: { opacity?: number; blend?: BlendMode; effects?: LayerEffect[] } = {},
): PresetLayer {
  return { name, role, pixels, opacity: extra.opacity ?? 1, blend: extra.blend ?? 'normal', effects: extra.effects ?? [] };
}

function plate(ctx: Ctx, spec: BackdropSpecInput): Pixels {
  return renderBackdrop({ inset: 0.07, cornerRadius: 0.24, ...spec, shape: ctx.shape, blob: { seed: ctx.seed, points: 6, variance: 0.42 } }, ctx.size);
}

function plateCoverage(ctx: Ctx, spec: BackdropSpecInput = {}): Plane {
  return backdropCoverage({ inset: 0.07, cornerRadius: 0.24, ...spec, shape: ctx.shape, blob: { seed: ctx.seed, points: 6, variance: 0.42 } }, ctx.size);
}

/** px from a fraction of the output size. */
function px(ctx: Ctx, f: number): number {
  return f * ctx.size;
}

function glyphPlane(ctx: Ctx, padding: number): { plane: Plane; pixels: Pixels } {
  const pixels = placeGlyph(ctx.a, ctx.size, padding);
  return { plane: alphaPlane(pixels), pixels };
}

function box(ctx: Ctx, plane: Plane) {
  return planeBounds(plane, ctx.size) ?? { x: 0, y: 0, w: ctx.size, h: ctx.size };
}

function hexOf(c: Rgba): string {
  return toHexString(c);
}

function stops(...list: [number, Rgba][]): Stop[] {
  return list;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

type Builder = (ctx: Ctx) => PresetLayer[];

/** Frosted-glass glyph over a vivid gradient plate with soft colour orbs. */
const glass: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const base = plate(ctx, {
    fill: { type: 'linear', angle: 155, stops: [{ offset: 0, color: hexOf(hsl(h - 18, 0.92, 0.66)) }, { offset: 1, color: hexOf(hsl(h + 28, 0.82, 0.46)) }] },
    border: { width: 0.01, color: '#ffffff40', position: 'inside' },
    shadow: { offsetY: 0.018, blur: 0.03, color: hexOf(hsl(h + 20, 0.7, 0.18)), opacity: 0.38 },
    gloss: null,
  });
  // Colour orbs: blurred discs clipped to the plate, what the glass "refracts".
  const cov = plateCoverage(ctx);
  const orbs = createPixels(size, size);
  const orb = (cx: number, cy: number, r: number, c: Rgba, o: number) => {
    const disc = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) disc[y * size + x] = clamp01(r * size - Math.hypot(x + 0.5 - cx * size, y + 0.5 - cy * size) + 0.5);
    }
    over(orbs, fillPlane(multiplyPlanes(blurPlane(disc, size, size * 0.07), cov), size, solid(c)), o);
  };
  orb(0.76, 0.24, 0.24, hsl(h + 45, 0.95, 0.74), 0.8);
  orb(0.22, 0.8, 0.28, hsl(h - 35, 0.95, 0.6), 0.7);
  over(base, orbs);

  // The glass: a heavily blurred, brightened copy of what lies behind.
  const { plane } = glyphPlane(ctx, 0.235);
  const frosted = createPixels(size, size);
  frosted.data.set(base.data);
  const blurred = applyFilter('blur', frosted, { radius: size * 0.05 });
  const b = box(ctx, plane);
  const sheen = linear(b, 160, stops([0, [255, 255, 255, Math.round(255 * amt(ctx, 0.6, 0.8, 0.92))]], [1, [255, 255, 255, Math.round(255 * amt(ctx, 0.3, 0.5, 0.64))]]));
  const white = fillPlane(new Float32Array(size * size).fill(1), size, sheen);
  over(blurred, white);
  const glassPx = maskPixels(blurred, plane);
  const glassColor = hsl(h + 10, 0.6, 0.22);
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Glass', 'icon', glassPx, {
      effects: [
        createEffect('dropShadow', { color: effectColor(glassColor), opacity: 0.42, angle: 90, distance: px(ctx, 0.02), blur: px(ctx, 0.035), spread: 0 }),
        createEffect('innerShadow', { color: effectColor(glassColor), opacity: 0.3, angle: 300, distance: px(ctx, 0.012), blur: px(ctx, 0.018), choke: 0 }),
        createEffect('innerShadow', { color: effectColor([255, 255, 255, 255]), opacity: 1, angle: 120, distance: px(ctx, 0.01), blur: px(ctx, 0.012), choke: 0 }),
        createEffect('outline', { color: effectColor([255, 255, 255, 255]), opacity: 0.7, width: Math.max(1, px(ctx, 0.005)), position: 'inside' }),
      ],
    }),
  ];
};

/** A neon tube tracing the glyph's outline on a dark plate. */
const neon: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const glowC = hsl(h, 1, 0.6);
  const base = plate(ctx, {
    fill: { type: 'radial', cx: 0.5, cy: 0.32, radius: 0.95, stops: [{ offset: 0, color: '#23263a' }, { offset: 1, color: '#0b0c14' }] },
    border: { width: 0.012, color: hexOf(withAlpha(glowC, 0.28)), position: 'inside' },
    shadow: { offsetY: 0.02, blur: 0.03, color: '#000000', opacity: 0.45 },
    gloss: { opacity: 0.05, size: 0.5, color: '#ffffff' },
  });
  const { plane } = glyphPlane(ctx, 0.25);
  const tubeW = px(ctx, 0.019);
  const tube = ringPlane(smoothShape(plane, size, px(ctx, 0.006)), size, tubeW);
  const inner = fillPlane(plane, size, solid(hsl(h, 0.9, 0.55)));
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Neon fill', 'decor', inner, { opacity: amt(ctx, 0.06, 0.13, 0.22) }),
    layer('Neon', 'icon', fillPlane(tube, size, solid(hsl(h, 1, 0.9))), {
      effects: [
        createEffect('dropShadow', { color: effectColor(glowC), opacity: amt(ctx, 0.35, 0.6, 0.85), angle: 90, distance: 0, blur: px(ctx, amt(ctx, 0.06, 0.1, 0.14)), spread: px(ctx, 0.004) }),
        createEffect('outerGlow', { color: effectColor(glowC), opacity: amt(ctx, 0.6, 0.9, 1), size: px(ctx, amt(ctx, 0.02, 0.035, 0.05)), spread: px(ctx, 0.004) }),
        createEffect('outline', { color: effectColor(hsl(h, 1, 0.62)), opacity: 1, width: Math.max(1, px(ctx, 0.007)), position: 'outside' }),
      ],
    }),
  ];
};

function mono(ctx: Ctx, dark: boolean): PresetLayer[] {
  const { size } = ctx;
  const base = plate(ctx, dark
    ? {
        fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#2e323b' }, { offset: 1, color: '#17191e' }] },
        border: { width: 0.007, color: '#ffffff1f', position: 'inside' },
        gloss: { opacity: 0.07, size: 0.5, color: '#ffffff' },
        shadow: { offsetY: 0.018, blur: 0.028, color: '#000000', opacity: 0.4 },
      }
    : {
        fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#eceef2' }] },
        border: { width: 0.006, color: '#0000001c', position: 'inside' },
        gloss: null,
        shadow: { offsetY: 0.016, blur: 0.026, color: '#1b1f2a', opacity: 0.24 },
      });
  const { plane } = glyphPlane(ctx, 0.25);
  const ink: Rgba = dark ? mix(hex('#8f95a1'), hex('#ffffff'), amt(ctx, 0, 0.88, 1)) : mix(hex('#8a909c'), hex('#0e1014'), amt(ctx, 0, 0.9, 1));
  const shade = dark ? hex('#000000') : hex('#1b1f2a');
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Glyph', 'icon', fillPlane(plane, size, solid(ink)), {
      effects: [
        createEffect('dropShadow', { color: effectColor(shade), opacity: dark ? amt(ctx, 0.25, 0.45, 0.6) : amt(ctx, 0.08, 0.16, 0.26), angle: 90, distance: px(ctx, 0.008), blur: px(ctx, 0.014), spread: 0 }),
      ],
    }),
  ];
}

/** Soft pastel disc, the icon lightened with a white rim, a few confetti dots. */
const pastel: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const base = plate(ctx, {
    inset: 0.06,
    fill: { type: 'linear', angle: 160, stops: [{ offset: 0, color: hexOf(hsl(h - 10, amt(ctx, 1, 0.9, 0.7), 0.9)) }, { offset: 1, color: hexOf(hsl(h + 35, amt(ctx, 0.92, 0.8, 0.62), 0.8)) }] },
    shadow: { offsetY: 0.02, blur: 0.035, color: hexOf(hsl(h + 20, 0.45, 0.45)), opacity: 0.28 },
    border: { width: 0.012, color: '#ffffff99', position: 'inside' },
    gloss: null,
  });
  // Confetti: a few seeded dots near the rim.
  const rnd = mulberry32(ctx.seed * 7919 + 17);
  const cov = plateCoverage(ctx, { inset: 0.06 });
  const confetti = createPixels(size, size);
  const dots = 5;
  for (let i = 0; i < dots; i++) {
    const ang = (i / dots) * Math.PI * 2 + rnd() * 0.6 + 0.4;
    const rr = 0.36 + rnd() * 0.04;
    const cx = (0.5 + Math.cos(ang) * rr) * size;
    const cy = (0.5 + Math.sin(ang) * rr) * size;
    const r = (0.012 + rnd() * 0.012) * size;
    const disc = new Float32Array(size * size);
    for (let y = Math.max(0, Math.floor(cy - r - 2)); y < Math.min(size, Math.ceil(cy + r + 2)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 2)); x < Math.min(size, Math.ceil(cx + r + 2)); x++) {
        disc[y * size + x] = clamp01(r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5);
      }
    }
    over(confetti, fillPlane(multiplyPlanes(disc, cov), size, solid(i % 2 ? [255, 255, 255, 255] : hsl(h + 60 + i * 40, 0.85, 0.82))), 0.9);
  }
  // The icon, pastelised; a glyph cut from a plate gets a soft deeper tone.
  let icon: Pixels;
  if (ctx.a.mode === 'plate' || ctx.a.mode === 'stencil') {
    const { plane } = glyphPlane(ctx, 0.24);
    const l = amt(ctx, 0.5, 0.56, 0.66);
    const sat = amt(ctx, 0.72, 0.6, 0.48);
    icon = fillPlane(plane, size, linear(box(ctx, plane), 180, stops([0, hsl(h + 10, sat, l + 0.06)], [1, hsl(h + 30, sat - 0.07, l - 0.06)])));
  } else {
    icon = placeIcon(ctx.a, size, 0.23);
    icon = applyFilter('hueSaturation', icon, { saturation: -amt(ctx, 10, 28, 45), lightness: amt(ctx, 8, 18, 30) });
  }
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Confetti', 'decor', confetti),
    layer('Icon', 'icon', icon, {
      effects: [
        createEffect('outline', { color: effectColor([255, 255, 255, 255]), opacity: 1, width: px(ctx, 0.016), position: 'outside' }),
        createEffect('dropShadow', { color: effectColor(hsl(h + 20, 0.5, 0.4)), opacity: 0.28, angle: 90, distance: px(ctx, 0.014), blur: px(ctx, 0.024), spread: 0 }),
      ],
    }),
  ];
};

/** Typical stroke width of the glyph in analysis px (2 × area / outline length). */
function strokeWidth(a: IconAnalysis): number {
  const g = a.glyph;
  const n = a.size;
  let area = 0;
  let edge = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (g[i]! < 0.5) continue;
      area++;
      if (g[i - 1]! < 0.5 || g[i + 1]! < 0.5 || g[i - n]! < 0.5 || g[i + n]! < 0.5) edge++;
    }
  }
  return edge ? (2 * area) / edge : 0;
}

/** The glyph image with its coverage dilated by `radius` analysis px (colours kept). */
function boldGlyph(a: IconAnalysis, radius: number): Pixels {
  const cov = dilatePlane(alphaPlane(a.glyphPixels), a.size, radius);
  const out = createPixels(a.size, a.size);
  const ink = glyphInk(a.glyphPixels);
  for (let i = 0; i < cov.length; i++) out.data.set([ink[0], ink[1], ink[2], Math.round(cov[i]! * 255)], i * 4);
  return out;
}

/** The dominant colour of a glyph image (coverage-weighted mean of its solid pixels). */
function glyphInk(p: Pixels): Rgba {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const a = p.data[i + 3]!;
    if (a < 230) continue;
    r += p.data[i]!;
    g += p.data[i + 1]!;
    b += p.data[i + 2]!;
    n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), 255] : [255, 255, 255, 255];
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Nearest-neighbour upscale of a G × G image to size × size. */
function upscaleNearest(src: Pixels, size: number): Pixels {
  return resizePixels(src, size, size, 'nearest');
}

/** 8-bit look: a dithered pixel plate and the icon at a coarse grid with a hard outline. */
const retroPixel: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const G = Math.round(amt(ctx, 40, 32, 20));
  // Plate: the backdrop shape at grid resolution, hard-edged.
  const cov = backdropCoverage({ inset: 0.06, cornerRadius: 0.22, shape: ctx.shape, blob: { seed: ctx.seed, points: 6, variance: 0.42 } }, G);
  const plateG = createPixels(G, G);
  const top = hsl(h, 0.72, 0.6);
  const bottom = hsl(h + 12, 0.7, 0.4);
  const dark = hex('#1a1c2c');
  const light = hsl(h - 5, 0.9, 0.78);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < G && y < G && cov[y * G + x]! >= 0.5;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const topEdge = !edge && !inside(x, y - 2);
      const t = y / G;
      const c = edge ? dark : topEdge ? light : t + (BAYER4[(y % 4) * 4 + (x % 4)]! / 16 - 0.5) * 0.35 < 0.55 ? top : bottom;
      plateG.data.set(c, (y * G + x) * 4);
    }
  }
  // Icon at grid resolution: hard alpha, posterised colours, 1-px dark outline.
  // A bold mark cut from a plate becomes one flat colour (its own, e.g. a
  // white letter); line art and cut-out icons keep their colours, posterised.
  const flat = ctx.a.mode === 'plate' && strokeWidth(ctx.a) >= ctx.a.size * 0.045;
  // Thin strokes would vanish at this grid: embolden the mark by half a cell first.
  const source = flat ? boldGlyph(ctx.a, (0.5 * ctx.a.size) / (G * 0.6)) : ctx.a.fitted;
  const smallRaw = fitAndCenter(source, G, { paddingRatio: 0.2, trim: true, threshold: 8 });
  const small = applyFilter('posterize', applyFilter('hueSaturation', smallRaw, { saturation: 25 }), { levels: 5 });
  if (flat) {
    const ink = glyphInk(ctx.a.glyphPixels);
    for (let i = 0; i < small.data.length; i += 4) small.data.set([ink[0], ink[1], ink[2], small.data[i + 3]!], i);
  }
  const iconG = createPixels(G, G);
  const solidAt = (x: number, y: number) => x >= 0 && y >= 0 && x < G && y < G && small.data[(y * G + x) * 4 + 3]! >= 128;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const i = (y * G + x) * 4;
      if (solidAt(x, y)) {
        iconG.data.set([small.data[i]!, small.data[i + 1]!, small.data[i + 2]!, 255], i);
      } else if (solidAt(x - 1, y) || solidAt(x + 1, y) || solidAt(x, y - 1) || solidAt(x, y + 1)) {
        iconG.data.set(dark, i);
      }
    }
  }
  const unit = size / G;
  return [
    layer('Backdrop', 'backdrop', upscaleNearest(plateG, size)),
    layer('Pixel icon', 'icon', upscaleNearest(iconG, size), {
      effects: [createEffect('dropShadow', { color: effectColor(dark), opacity: 0.55, angle: 135, distance: unit * Math.SQRT2, blur: 0, spread: 0 })],
    }),
  ];
};

/** A die-cut vinyl sticker: thick white border, soft shadow, laminate sheen. */
const sticker: Builder = (ctx) => {
  const { size } = ctx;
  const icon = placeIcon(ctx.a, size, 0.19);
  const border = px(ctx, amt(ctx, 0.028, 0.045, 0.065));
  const cut = smoothShape(dilatePlane(alphaPlane(icon), size, border), size, px(ctx, 0.012));
  const b = box(ctx, cut);
  const paper = fillPlane(cut, size, linear(b, 180, stops([0, hex('#ffffff')], [1, hex('#eef0f4')])));
  // Laminate sheen: a soft diagonal band across the top-left of the sticker.
  const sheen = createPixels(size, size);
  const band = linear(b, 135, stops([0, [255, 255, 255, 150]], [0.32, [255, 255, 255, 40]], [0.42, [255, 255, 255, 0]]));
  const sheenPx = fillPlane(cut, size, band);
  over(sheen, sheenPx);
  return [
    layer('Backdrop', 'backdrop', paper, {
      effects: [
        createEffect('dropShadow', { color: effectColor(hex('#1b1f2a')), opacity: 0.3, angle: 100, distance: px(ctx, 0.014), blur: px(ctx, 0.026), spread: 0 }),
        createEffect('outline', { color: effectColor(hex('#1b1f2a')), opacity: 0.08, width: Math.max(1, px(ctx, 0.003)), position: 'inside' }),
      ],
    }),
    layer('Icon', 'icon', icon),
    layer('Sheen', 'gloss', sheen, { blend: 'screen', opacity: 0.8 }),
  ];
};

/** Puffy clay: soft rounded shapes with inner light and shade. */
const clay: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const depth = amt(ctx, 0.55, 1, 1.45);
  const cov = plateCoverage(ctx);
  const base = fillPlane(cov, size, radial(size * 0.36, size * 0.28, size * 0.95, stops([0, hsl(h - 4, 0.7, 0.72)], [1, hsl(h + 6, 0.58, 0.58)])));
  const { plane } = glyphPlane(ctx, 0.25);
  // Round the glyph like soft clay — gently where its structure is carried by thin cuts.
  const soft = ctx.a.mode === 'segments' ? smoothShape(plane, size, px(ctx, 0.005)) : smoothShape(dilatePlane(plane, size, px(ctx, 0.006)), size, px(ctx, 0.014));
  const glyph = fillPlane(soft, size, radial(size * 0.4, size * 0.32, size * 0.55, stops([0, hsl(h + 6, 0.9, 0.97)], [1, hsl(h + 6, 0.6, 0.88)])));
  const shade = hsl(h + 12, 0.55, 0.28);
  const light = [255, 255, 255, 255] as Rgba;
  return [
    layer('Backdrop', 'backdrop', base, {
      effects: [
        createEffect('dropShadow', { color: effectColor(shade), opacity: 0.4, angle: 90, distance: px(ctx, 0.024), blur: px(ctx, 0.045), spread: 0 }),
        createEffect('innerShadow', { color: effectColor(light), opacity: Math.min(1, 0.6 * depth), angle: 120, distance: px(ctx, 0.022), blur: px(ctx, 0.035), choke: 0 }),
        createEffect('innerShadow', { color: effectColor(shade), opacity: Math.min(1, 0.5 * depth), angle: 300, distance: px(ctx, 0.026), blur: px(ctx, 0.045), choke: 0 }),
      ],
    }),
    layer('Clay glyph', 'icon', glyph, {
      effects: [
        createEffect('dropShadow', { color: effectColor(shade), opacity: 0.5, angle: 90, distance: px(ctx, 0.02), blur: px(ctx, 0.03), spread: 0 }),
        createEffect('innerShadow', { color: effectColor(hsl(h + 6, 0.5, 0.45)), opacity: Math.min(1, 0.45 * depth), angle: 300, distance: px(ctx, 0.014), blur: px(ctx, 0.022), choke: 0 }),
        createEffect('innerShadow', { color: effectColor(light), opacity: 1, angle: 120, distance: px(ctx, 0.01), blur: px(ctx, 0.012), choke: 0 }),
      ],
    }),
  ];
};

/** The silhouette filled with a vivid three-stop gradient on a clean white plate. */
const gradientSilhouette: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const base = plate(ctx, {
    fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#f1f2f6' }] },
    border: { width: 0.006, color: '#00000014', position: 'inside' },
    shadow: { offsetY: 0.016, blur: 0.028, color: '#1b1f2a', opacity: 0.22 },
    gloss: null,
  });
  const { plane } = glyphPlane(ctx, 0.24);
  const b = box(ctx, plane);
  const spread = amt(ctx, 30, 55, 85);
  const fill = fillPlane(plane, size, linear(b, 135, stops([0, hsl(h - spread / 2, 0.95, 0.6)], [0.55, hsl(h + spread / 4, 0.92, 0.56)], [1, hsl(h + spread, 0.95, 0.55)])));
  const gloss = fillPlane(plane, size, linear(b, 180, stops([0, [255, 255, 255, 110]], [0.5, [255, 255, 255, 0]])));
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Silhouette', 'icon', fill, {
      effects: [createEffect('dropShadow', { color: effectColor(hsl(h + spread / 3, 0.9, 0.5)), opacity: 0.4, angle: 90, distance: px(ctx, 0.022), blur: px(ctx, 0.04), spread: 0 })],
    }),
    layer('Highlight', 'gloss', gloss, { blend: 'soft-light' }),
  ];
};

/** Windows 11 Fluent: soft acrylic plate, the icon lit from the top with layered depth. */
const fluent: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  const base = plate(ctx, {
    cornerRadius: 0.2,
    fill: { type: 'linear', angle: 165, stops: [{ offset: 0, color: hexOf(hsl(h - 6, 0.6, 0.965)) }, { offset: 1, color: hexOf(hsl(h + 12, 0.55, 0.85)) }] },
    border: { width: 0.008, color: '#ffffffb3', position: 'inside' },
    gloss: null,
    shadow: { offsetY: 0.018, blur: 0.03, color: '#1b1f2a', opacity: 0.2 },
  });
  let icon: Pixels;
  const plateLuma = 0.95;
  if ((ctx.a.mode !== 'silhouette' && Math.abs(ctx.a.glyphLuma - plateLuma) < 0.35) || ctx.a.mode === 'stencil') {
    // A light mark cut from a plate would vanish: paint it with the accent.
    const { plane } = glyphPlane(ctx, 0.24);
    icon = fillPlane(plane, size, linear(box(ctx, plane), 160, stops([0, hsl(h - 8, 0.9, 0.62)], [1, hsl(h + 18, 0.85, 0.42)])));
  } else if (ctx.a.mode === 'plate') {
    icon = placeGlyph(ctx.a, size, 0.24);
  } else {
    icon = placeIcon(ctx.a, size, 0.22);
  }
  const plane = alphaPlane(icon);
  const light = fillPlane(plane, size, linear(box(ctx, plane), 180, stops([0, [255, 255, 255, 130]], [0.55, [255, 255, 255, 0]])));
  const edge = mix(ctx.a.accent, hex('#000000'), 0.55);
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Icon', 'icon', icon, {
      effects: [
        createEffect('dropShadow', { color: effectColor(hex('#10131a')), opacity: amt(ctx, 0.12, 0.2, 0.3), angle: 90, distance: px(ctx, 0.004), blur: px(ctx, 0.008), spread: 0 }),
        createEffect('dropShadow', { color: effectColor(hex('#10131a')), opacity: amt(ctx, 0.08, 0.16, 0.26), angle: 90, distance: px(ctx, 0.018), blur: px(ctx, 0.036), spread: 0 }),
        createEffect('outline', { color: effectColor(edge), opacity: 0.22, width: Math.max(1, px(ctx, 0.003)), position: 'inside' }),
      ],
    }),
    layer('Top light', 'gloss', light, { blend: 'soft-light', opacity: 0.9 }),
  ];
};

/**
 * Classic duotone ink pairs, keyed by the deep ink's hue: navy + yellow,
 * purple + orange, teal + coral, forest + lime, maroon + pink… Between
 * keys the highlight is interpolated along the shorter hue arc.
 */
const DUOTONE_PAIRS: readonly [deepHue: number, hiHue: number, hiSat: number, hiLight: number][] = [
  [0, 28, 1, 0.72],
  [30, 42, 1, 0.68],
  [60, 52, 1, 0.7],
  [120, 78, 0.85, 0.66],
  [160, 88, 0.85, 0.68],
  [190, 8, 1, 0.72],
  [220, 46, 1, 0.62],
  [250, 38, 1, 0.64],
  [280, 22, 1, 0.66],
  [310, 160, 0.8, 0.68],
  [340, 345, 1, 0.82],
  [360, 28, 1, 0.72],
];

function duotoneHighlight(h: number): Rgba {
  const hue = ((h % 360) + 360) % 360;
  let k = 0;
  while (k + 1 < DUOTONE_PAIRS.length - 1 && DUOTONE_PAIRS[k + 1]![0] <= hue) k++;
  const a = DUOTONE_PAIRS[k]!;
  const b = DUOTONE_PAIRS[k + 1]!;
  const t = (hue - a[0]) / (b[0] - a[0] || 1);
  let dh = b[1] - a[1];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return hsl(a[1] + dh * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
}

/** Two-tone print: deep plate, the icon mapped from shadow to highlight colour. */
const duotone: Builder = (ctx) => {
  const { size, hue: h } = ctx;
  // Yellows and oranges are light inks: they become the highlight over a deep indigo.
  const warm = h >= 30 && h <= 100;
  const deepHue = warm ? 252 + (h - 60) * 0.25 : h;
  const deep = hsl(deepHue, 0.72, 0.2);
  const hi = warm ? hsl(h, 1, 0.64) : duotoneHighlight(h);
  const base = plate(ctx, {
    fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: hexOf(hsl(deepHue, 0.62, 0.32)) }, { offset: 1, color: hexOf(hsl(deepHue + 8, 0.7, 0.17)) }] },
    shadow: { offsetY: 0.02, blur: 0.03, color: '#000000', opacity: 0.35 },
    border: { width: 0.012, color: hexOf(withAlpha(hsl(deepHue, 0.55, 0.62), 0.45)), position: 'inside' },
    gloss: null,
  });
  const src = ctx.a.mode === 'plate' ? placeGlyph(ctx.a, size, 0.24) : placeIcon(ctx.a, size, 0.22);
  // Lift dark glyphs so they land on the highlight side of the ramp.
  const lifted = ctx.a.glyphLuma < 0.45 && ctx.a.mode !== 'silhouette' ? applyFilter('invert', src, {}) : src;
  const toned = applyFilter('duotone', lifted, { shadows: hexOf(hsl(deepHue, 0.7, 0.14)), highlights: hexOf(hi), amount: 100 });
  const contrasty = applyFilter('brightnessContrast', toned, { contrast: amt(ctx, 0, 20, 45) });
  return [
    layer('Backdrop', 'backdrop', base),
    layer('Duotone', 'icon', contrasty, {
      effects: [
        createEffect('outline', { color: effectColor(hi), opacity: 0.9, width: px(ctx, 0.008), position: 'outside' }),
        createEffect('dropShadow', { color: effectColor(deep), opacity: 0.6, angle: 90, distance: px(ctx, 0.016), blur: px(ctx, 0.02), spread: 0 }),
      ],
    }),
  ];
};

/** Pencil on paper: graphite edges and hatching over a warm paper card. */
const sketch: Builder = (ctx) => {
  const { size } = ctx;
  const paper = plate(ctx, {
    cornerRadius: 0.14,
    fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#fbf8f0' }, { offset: 1, color: '#efe8d8' }] },
    border: { width: 0.006, color: '#6b5b3a26', position: 'inside' },
    shadow: { offsetY: 0.016, blur: 0.024, color: '#3b2f1a', opacity: 0.26 },
    gloss: null,
  });
  const grain = applyFilter('noise', paper, { amount: 5, monochrome: true, seed: ctx.seed });
  // Keep the grain inside the card (noise must not touch transparent pixels' alpha).
  const cardAlpha = alphaPlane(paper);
  const card = maskPixels(grain, cardAlpha);

  // Draw what a designer would: the mark itself (in graphite) when it was cut
  // from a plate or is a stencil, the icon with its own shading otherwise.
  const markOnly = ctx.a.mode !== 'silhouette';
  const icon = markOnly ? fillPlane(glyphPlane(ctx, 0.24).plane, size, solid(hex('#6d7078'))) : placeIcon(ctx.a, size, 0.22);
  const onWhite = createPixels(size, size);
  onWhite.data.fill(255);
  over(onWhite, icon);
  const lines = applyFilter('sketch', onWhite, { strength: amt(ctx, 70, 130, 220), invert: true, colored: false });
  const lum = lumaPlane(lines);
  const tone = lumaPlane(onWhite);
  const region = blurPlane(dilatePlane(alphaPlane(icon), size, px(ctx, 0.01)), size, px(ctx, 0.004));
  const graphite = hex('#2d2f36');
  const strokes = new Float32Array(size * size);
  const period = Math.max(3, size * 0.022);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const line = clamp01((1 - lum[i]!) * 1.7);
      // Hatching where the drawing is dark: diagonal strokes, cross-hatched in the darkest tones.
      const dark = 1 - tone[i]!;
      const d1 = Math.abs(((x + y) % period) / period - 0.5) * 2;
      const d2 = Math.abs(((x - y + size * 4) % period) / period - 0.5) * 2;
      const hatch = clamp01((dark - 0.2) * 1.4) * clamp01((0.35 - d1) * 4) + clamp01((dark - 0.6) * 2) * clamp01((0.3 - d2) * 4);
      strokes[i] = clamp01(line + hatch * 0.55) * region[i]!;
    }
  }
  return [
    layer('Paper', 'backdrop', card),
    layer('Pencil', 'icon', fillPlane(strokes, size, solid(graphite)), { blend: 'multiply', opacity: 0.92 }),
  ];
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface PresetDef extends PresetInfo {
  build: Builder;
}

const DEFS: readonly PresetDef[] = [
  { id: 'glass', label: 'Glass', description: 'Frosted glass over a vivid gradient.', shape: 'squircle', intensityLabel: 'Frost', usesHue: true, build: glass },
  { id: 'neon', label: 'Neon', description: 'A glowing neon tube on a dark plate.', shape: 'squircle', intensityLabel: 'Glow', usesHue: true, build: neon },
  { id: 'monoLight', label: 'Mono Light', description: 'Crisp black glyph on a white plate.', shape: 'squircle', intensityLabel: 'Contrast', usesHue: false, build: (c) => mono(c, false) },
  { id: 'monoDark', label: 'Mono Dark', description: 'Soft white glyph on a graphite plate.', shape: 'squircle', intensityLabel: 'Contrast', usesHue: false, build: (c) => mono(c, true) },
  { id: 'pastel', label: 'Pastel', description: 'Candy colours with a white rim and confetti.', shape: 'circle', intensityLabel: 'Softness', usesHue: true, build: pastel },
  { id: 'retroPixel', label: 'Retro Pixel', description: '8-bit pixels on a dithered plate.', shape: 'rounded', intensityLabel: 'Chunkiness', usesHue: true, build: retroPixel },
  { id: 'sticker', label: 'Sticker', description: 'Die-cut vinyl sticker with a white border.', shape: 'squircle', intensityLabel: 'Border', usesHue: false, build: sticker },
  { id: 'clay', label: 'Clay', description: 'Puffy, soft 3D clay.', shape: 'squircle', intensityLabel: 'Depth', usesHue: true, build: clay },
  { id: 'gradientSilhouette', label: 'Gradient', description: 'The silhouette in a vivid gradient.', shape: 'squircle', intensityLabel: 'Spread', usesHue: true, build: gradientSilhouette },
  { id: 'fluent', label: 'Fluent', description: 'Windows 11 style: soft light and depth.', shape: 'rounded', intensityLabel: 'Depth', usesHue: true, build: fluent },
  { id: 'duotone', label: 'Duotone', description: 'Two-tone print in deep and bright inks.', shape: 'circle', intensityLabel: 'Punch', usesHue: true, build: duotone },
  { id: 'sketch', label: 'Sketch', description: 'Pencil drawing on warm paper.', shape: 'rounded', intensityLabel: 'Pencil', usesHue: false, build: sketch },
];

export const PRESET_IDS: readonly PresetId[] = DEFS.map((d) => d.id);

/** Public description of every preset, in display order. */
export const PRESETS: readonly PresetInfo[] = DEFS.map(({ build: _build, ...info }) => Object.freeze(info));

export function isPresetId(id: unknown): id is PresetId {
  return typeof id === 'string' && DEFS.some((d) => d.id === id);
}

export function getPreset(id: PresetId): PresetInfo {
  const d = DEFS.find((p) => p.id === id);
  if (!d) throw new RangeError(`unknown preset "${String(id)}"`);
  const { build: _build, ...info } = d;
  return info;
}

/** Builds a preset's layer stack at `size` from an analysed icon. */
export function buildFromAnalysis(id: PresetId, analysis: IconAnalysis, size: number, options: Partial<PresetOptions> = {}): PresetResult {
  const def = DEFS.find((p) => p.id === id);
  if (!def) throw new RangeError(`unknown preset "${String(id)}"`);
  if (!Number.isInteger(size) || size < 16 || size > 2048) throw new RangeError(`invalid preset size ${size}`);
  const hue = options.hue ?? analysis.hue;
  const ctx: Ctx = {
    a: analysis,
    size,
    hue: ((hue % 360) + 360) % 360,
    k: clamp01(options.intensity ?? 0.5),
    shape: options.shape ?? def.shape,
    seed: Math.max(0, Math.floor(options.seed ?? 1)),
  };
  const layers = def.build(ctx);
  const iconIndex = Math.max(0, layers.findIndex((l) => l.role === 'icon'));
  return { id, size, layers, iconIndex };
}
