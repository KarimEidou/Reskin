// Icon helpers (remove background, auto-trim & center, fit to shape, round
// corners, add badge): their controls, described like filter params so the
// same editor renders both, and the pure function that runs them (in the
// panels worker, or synchronously for "Apply style to all" and tests).

import { BACKDROP_SHAPES, type BackdropShape } from '$engine/backdrop/shapes';
import type { ParamSpec } from '$engine/filters/params';
import { createPixels, type Mask, type Pixels } from '$engine/filters/types';
import { addBadge, fitAndCenter, fitToShape, removeBackground, roundCorners, type BadgePosition, type TextRasterizer } from '$engine/helpers';

export type HelperId = 'removeBackground' | 'autoTrim' | 'fitShape' | 'roundCorners' | 'badge';

/** A short text input (badge label). */
export interface TextParamSpec {
  kind: 'text';
  key: string;
  label: string;
  default: string;
  maxLength: number;
}

export type ControlSpec = ParamSpec | TextParamSpec;

export interface HelperDef {
  id: HelperId;
  label: string;
  description: string;
  params: readonly ControlSpec[];
  /** Whether a selection limits the effect (auto-trim works on the whole layer). */
  usesSelection: boolean;
}

const slider = (key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): ParamSpec =>
  unit === undefined ? { kind: 'slider', key, label, min, max, step, default: def } : { kind: 'slider', key, label, min, max, step, default: def, unit };

export const HELPERS: readonly HelperDef[] = [
  {
    id: 'removeBackground',
    label: 'Remove background',
    description: 'Clears the solid background around the icon, from its edges inwards.',
    usesSelection: true,
    params: [slider('tolerance', 'Tolerance', 0, 100, 1, 12, '%'), slider('feather', 'Feather', 0, 20, 0.5, 1, 'px')],
  },
  {
    id: 'autoTrim',
    label: 'Auto-trim & center',
    description: 'Crops empty space, then scales the content to fit centred.',
    usesSelection: false,
    params: [slider('padding', 'Padding', 0, 40, 1, 8, '%')],
  },
  {
    id: 'fitShape',
    label: 'Fit to shape',
    description: 'Clips the layer to a backdrop shape.',
    usesSelection: true,
    params: [
      { kind: 'select', key: 'shape', label: 'Shape', options: BACKDROP_SHAPES.map((s) => ({ value: s.id, label: s.label })), default: 'squircle' },
      slider('inset', 'Inset', 0, 30, 1, 4, '%'),
    ],
  },
  {
    id: 'roundCorners',
    label: 'Round corners',
    description: 'Rounds the corners of the whole layer.',
    usesSelection: true,
    params: [
      slider('radius', 'Radius', 0, 50, 1, 18, '%'),
      {
        kind: 'select',
        key: 'style',
        label: 'Corners',
        options: [
          { value: 'circular', label: 'Circular' },
          { value: 'squircle', label: 'Squircle' },
        ],
        default: 'squircle',
      },
    ],
  },
  {
    id: 'badge',
    label: 'Add badge',
    description: 'A notification-style badge in a corner.',
    usesSelection: true,
    params: [
      { kind: 'text', key: 'text', label: 'Text', default: '1', maxLength: 3 },
      { kind: 'color', key: 'color', label: 'Colour', default: '#e81123', alpha: false },
      {
        kind: 'select',
        key: 'position',
        label: 'Position',
        options: [
          { value: 'tr', label: 'Top right' },
          { value: 'tl', label: 'Top left' },
          { value: 'br', label: 'Bottom right' },
          { value: 'bl', label: 'Bottom left' },
        ],
        default: 'tr',
      },
      slider('size', 'Size', 15, 60, 1, 34, '%'),
    ],
  },
];

export function getHelper(id: HelperId): HelperDef {
  const h = HELPERS.find((x) => x.id === id);
  if (!h) throw new RangeError(`unknown helper "${String(id)}"`);
  return h;
}

export function isHelperId(v: unknown): v is HelperId {
  return typeof v === 'string' && HELPERS.some((h) => h.id === v);
}

export type ControlValue = number | string | boolean | { offset: number; color: string }[];
export type ControlValues = Record<string, ControlValue>;

/** Every control's default value. */
export function defaultValues(params: readonly ControlSpec[]): ControlValues {
  const out: ControlValues = {};
  for (const p of params) out[p.key] = p.kind === 'gradient' ? p.default.map((s) => ({ ...s })) : p.default;
  return out;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

/**
 * Runs a helper on a layer image. `rasterizer` renders badge text (the
 * canvas rasterizer in the browser; the bitmap font otherwise).
 */
export function runHelper(
  id: HelperId,
  src: Pixels,
  values: Readonly<Record<string, unknown>>,
  mask: Mask | null,
  rasterizer?: TextRasterizer | null,
): Pixels {
  switch (id) {
    case 'removeBackground':
      return removeBackground(src, { tolerance: num(values.tolerance, 12), feather: num(values.feather, 1) }, mask);
    case 'autoTrim': {
      const size = Math.min(src.width, src.height);
      const fitted = fitAndCenter(src, size, { paddingRatio: num(values.padding, 8) / 100 });
      if (src.width === size && src.height === size) return fitted;
      const out = createPixels(src.width, src.height);
      const ox = Math.floor((src.width - size) / 2);
      const oy = Math.floor((src.height - size) / 2);
      for (let y = 0; y < size; y++) out.data.set(fitted.data.subarray(y * size * 4, (y + 1) * size * 4), ((y + oy) * src.width + ox) * 4);
      return out;
    }
    case 'fitShape': {
      const shape = str(values.shape, 'squircle') as BackdropShape;
      return fitToShape(src, { shape, inset: num(values.inset, 4) / 100, cornerRadius: 0.24 }, mask);
    }
    case 'roundCorners':
      return roundCorners(src, num(values.radius, 18) / 100, { style: values.style === 'circular' ? 'circular' : 'squircle' }, mask);
    case 'badge':
      return addBadge(
        src,
        {
          text: str(values.text, '').slice(0, 3),
          color: str(values.color, '#e81123'),
          position: (['tl', 'tr', 'bl', 'br'].includes(str(values.position, 'tr')) ? values.position : 'tr') as BadgePosition,
          size: num(values.size, 34) / 100,
          rasterizer: rasterizer ?? undefined,
        },
        mask,
      );
  }
}
