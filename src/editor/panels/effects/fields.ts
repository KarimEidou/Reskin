// What the Effects panel shows for each layer effect: its name and the
// editable fields, with pixel ranges scaled to the document size (effects
// are measured in document pixels; the ranges are designed for 512 px).

import { BLEND_MODES, type EffectType } from '$engine/index';

export type EffectField =
  | { kind: 'color'; key: 'color'; label: string }
  | { kind: 'percent'; key: 'opacity'; label: string }
  | { kind: 'angle'; key: 'angle'; label: string }
  | { kind: 'px'; key: 'distance' | 'blur' | 'spread' | 'size' | 'width' | 'choke'; label: string; min: number; max: number }
  | { kind: 'segment'; key: 'position'; label: string; options: readonly { value: string; label: string }[] }
  | { kind: 'select'; key: 'blend'; label: string; options: readonly { value: string; label: string }[] };

export interface EffectInfo {
  type: EffectType;
  label: string;
  description: string;
  fields: readonly EffectField[];
}

const color: EffectField = { kind: 'color', key: 'color', label: 'Colour' };
const opacity: EffectField = { kind: 'percent', key: 'opacity', label: 'Opacity' };
const angle: EffectField = { kind: 'angle', key: 'angle', label: 'Light angle' };

const blendLabel = (m: string) => m.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const EFFECTS: readonly EffectInfo[] = [
  {
    type: 'dropShadow',
    label: 'Drop shadow',
    description: 'A soft shadow behind the layer.',
    fields: [color, opacity, angle, { kind: 'px', key: 'distance', label: 'Distance', min: 0, max: 64 }, { kind: 'px', key: 'blur', label: 'Blur', min: 0, max: 64 }, { kind: 'px', key: 'spread', label: 'Spread', min: 0, max: 32 }],
  },
  {
    type: 'outerGlow',
    label: 'Outer glow',
    description: 'Light spilling around the layer.',
    fields: [color, opacity, { kind: 'px', key: 'size', label: 'Size', min: 0, max: 64 }, { kind: 'px', key: 'spread', label: 'Spread', min: 0, max: 32 }],
  },
  {
    type: 'outline',
    label: 'Outline',
    description: 'A stroke around the layer’s shape.',
    fields: [
      color,
      opacity,
      { kind: 'px', key: 'width', label: 'Width', min: 1, max: 32 },
      {
        kind: 'segment',
        key: 'position',
        label: 'Position',
        options: [
          { value: 'outside', label: 'Outside' },
          { value: 'center', label: 'Centre' },
          { value: 'inside', label: 'Inside' },
        ],
      },
    ],
  },
  {
    type: 'colorOverlay',
    label: 'Colour overlay',
    description: 'Tints the layer with one colour.',
    fields: [color, opacity, { kind: 'select', key: 'blend', label: 'Blend mode', options: BLEND_MODES.map((m) => ({ value: m, label: blendLabel(m) })) }],
  },
  {
    type: 'innerShadow',
    label: 'Inner shadow',
    description: 'A shadow cast inside the layer’s edges.',
    fields: [color, opacity, angle, { kind: 'px', key: 'distance', label: 'Distance', min: 0, max: 64 }, { kind: 'px', key: 'blur', label: 'Blur', min: 0, max: 64 }, { kind: 'px', key: 'choke', label: 'Choke', min: 0, max: 32 }],
  },
];

export function effectInfo(type: EffectType): EffectInfo {
  return EFFECTS.find((e) => e.type === type)!;
}

/** Slider range for a pixel field at a document size (designed for 512 px). */
export function pxRange(field: { min: number; max: number }, docSize: number): { min: number; max: number; step: number } {
  const k = docSize / 512;
  const step = k >= 0.5 ? 1 : k >= 0.125 ? 0.25 : 0.125;
  const snap = (v: number) => Math.round(v / step) * step;
  return { min: snap(field.min * Math.min(1, k)), max: Math.max(step * 4, snap(field.max * k)), step };
}
