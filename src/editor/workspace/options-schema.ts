// What the tool options bar shows for each tool, as data (unit tested).
// Ranges follow the engine's option contracts (src/engine/README.md and
// the tool modules); the bar renders sliders / toggles / choices from these
// specs, and a few bespoke controls (fonts, gradient stops, colours).

import type { ToolId, ToolOptionsMap } from '$engine/index';

/** 1 = shown in the bar when there is room; 2 = only in "More options". */
export type Priority = 1 | 2;

type Keys<T> = Extract<keyof T, string>;

export interface SliderSpec<K extends string = string> {
  kind: 'slider';
  key: K;
  label: string;
  /** Range in option units (0..1 values use `percent`). */
  min: number;
  max: number;
  /** Step in DISPLAY units (after the percent conversion). */
  step: number;
  /** Values stored 0..1 but shown as 0..100 %. */
  percent?: boolean;
  unit?: string;
  /** Logarithmic slider travel (sizes spanning several orders of magnitude). */
  log?: boolean;
  priority: Priority;
  /** Only shown when this returns true for the current options. */
  when?: (options: Record<string, unknown>) => boolean;
}

export interface ToggleSpec<K extends string = string> {
  kind: 'toggle';
  key: K;
  label: string;
  priority: Priority;
  when?: (options: Record<string, unknown>) => boolean;
}

export interface ChoiceOption {
  value: string;
  label: string;
  /** Icon key, resolved by the component (see tool-icons.ts). */
  icon?: string;
}

export interface ChoiceSpec<K extends string = string> {
  kind: 'choice';
  key: K;
  label: string;
  options: readonly ChoiceOption[];
  /** The option value is a number (the choice values are its string form). */
  numeric?: boolean;
  /** Render as a dropdown instead of a segmented control. */
  dropdown?: boolean;
  /** Segmented control with icons only (labels become names/tooltips). */
  iconOnly?: boolean;
  /** No caption before the control in the bar (the choices say it all). */
  hideCaption?: boolean;
  priority: Priority;
  when?: (options: Record<string, unknown>) => boolean;
}

export type OptionSpec<K extends string = string> = SliderSpec<K> | ToggleSpec<K> | ChoiceSpec<K>;

type SpecsFor<T> = readonly OptionSpec<Keys<T>>[];

const brushSpecs: SpecsFor<ToolOptionsMap['brush']> = [
  { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 512, step: 1, unit: 'px', log: true, priority: 1 },
  { kind: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 1 },
  { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 1 },
  { kind: 'slider', key: 'flow', label: 'Flow', min: 0.01, max: 1, step: 1, percent: true, unit: '%', priority: 2 },
  {
    kind: 'slider',
    key: 'spacing',
    label: 'Spacing',
    min: 0.01,
    max: 2,
    step: 1,
    percent: true,
    unit: '%',
    priority: 2,
  },
  { kind: 'slider', key: 'smoothing', label: 'Smoothing', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 2 },
  { kind: 'toggle', key: 'pressureSize', label: 'Pressure controls size', priority: 2 },
  {
    kind: 'slider',
    key: 'minSize',
    label: 'Minimum size',
    min: 0,
    max: 1,
    step: 1,
    percent: true,
    unit: '%',
    priority: 2,
    when: (o) => o.pressureSize === true,
  },
  { kind: 'toggle', key: 'pressureOpacity', label: 'Pressure controls flow', priority: 2 },
  {
    kind: 'toggle',
    key: 'catchUp',
    label: 'Finish at the pointer',
    priority: 2,
    when: (o) => typeof o.smoothing === 'number' && o.smoothing > 0,
  },
];

const selectSpecs: SpecsFor<ToolOptionsMap['selectRect']> = [
  {
    kind: 'choice',
    key: 'mode',
    label: 'Selection mode',
    iconOnly: true,
    options: [
      { value: 'replace', label: 'New selection', icon: 'selReplace' },
      { value: 'add', label: 'Add to selection (Shift)', icon: 'selAdd' },
      { value: 'subtract', label: 'Subtract from selection (Alt)', icon: 'selSubtract' },
      { value: 'intersect', label: 'Intersect with selection (Shift+Alt)', icon: 'selIntersect' },
    ],
    priority: 1,
  },
  { kind: 'slider', key: 'feather', label: 'Feather', min: 0, max: 64, step: 1, unit: 'px', priority: 1 },
  { kind: 'toggle', key: 'antialias', label: 'Smooth edges', priority: 2 },
];

export const TOOL_OPTION_SPECS: { readonly [K in ToolId]: SpecsFor<ToolOptionsMap[K]> } = {
  move: [],
  // Placeholders until the options bar gets controls for these tools.
  lasso: [],
  magicWand: [],
  spray: [],
  stamp: [],
  smudge: [],
  blurSharpen: [],
  dodgeBurn: [],
  selectRect: selectSpecs,
  selectEllipse: selectSpecs,
  brush: brushSpecs,
  eraser: brushSpecs,
  pencil: [
    { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 64, step: 1, unit: 'px', priority: 1 },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 1 },
    {
      kind: 'toggle',
      key: 'pixelPerfect',
      label: 'Pixel perfect',
      priority: 1,
      when: (o) => o.size === 1,
    },
  ],
  fill: [
    { kind: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1, priority: 1 },
    { kind: 'toggle', key: 'contiguous', label: 'Contiguous', priority: 1 },
    { kind: 'toggle', key: 'sampleMerged', label: 'All layers', priority: 1 },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 2 },
  ],
  gradient: [
    {
      kind: 'choice',
      key: 'kind',
      label: 'Gradient type',
      hideCaption: true,
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
        { value: 'conic', label: 'Conic' },
      ],
      priority: 1,
    },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 1 },
    {
      kind: 'choice',
      key: 'spread',
      label: 'Beyond the ends',
      dropdown: true,
      options: [
        { value: 'pad', label: 'Extend' },
        { value: 'repeat', label: 'Repeat' },
        { value: 'reflect', label: 'Reflect' },
      ],
      priority: 2,
    },
    { kind: 'toggle', key: 'reverse', label: 'Reverse', priority: 2 },
    { kind: 'toggle', key: 'dither', label: 'Dither (no banding)', priority: 2 },
  ],
  shape: [
    { kind: 'toggle', key: 'fill', label: 'Fill', priority: 1 },
    { kind: 'toggle', key: 'stroke', label: 'Stroke', priority: 1 },
    {
      kind: 'slider',
      key: 'strokeWidth',
      label: 'Width',
      min: 1,
      max: 128,
      step: 1,
      unit: 'px',
      log: true,
      priority: 1,
      when: (o) => o.stroke === true || o.kind === 'line' || o.kind === 'arrow',
    },
    {
      kind: 'slider',
      key: 'cornerRadius',
      label: 'Corners',
      min: 0,
      max: 256,
      step: 1,
      unit: 'px',
      priority: 1,
      when: (o) => o.kind === 'roundedRect',
    },
    {
      kind: 'slider',
      key: 'sides',
      label: 'Sides',
      min: 3,
      max: 64,
      step: 1,
      priority: 1,
      when: (o) => o.kind === 'polygon',
    },
    {
      kind: 'slider',
      key: 'sides',
      label: 'Points',
      min: 3,
      max: 64,
      step: 1,
      priority: 1,
      when: (o) => o.kind === 'star',
    },
    {
      kind: 'slider',
      key: 'innerRatio',
      label: 'Inner radius',
      min: 0.05,
      max: 1,
      step: 1,
      percent: true,
      unit: '%',
      priority: 1,
      when: (o) => o.kind === 'star',
    },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 1, percent: true, unit: '%', priority: 2 },
  ],
  text: [
    { kind: 'slider', key: 'fontSize', label: 'Size', min: 4, max: 512, step: 1, unit: 'px', log: true, priority: 1 },
    {
      kind: 'choice',
      key: 'weight',
      label: 'Weight',
      numeric: true,
      dropdown: true,
      options: [
        { value: '100', label: 'Thin' },
        { value: '200', label: 'Extra light' },
        { value: '300', label: 'Light' },
        { value: '400', label: 'Regular' },
        { value: '500', label: 'Medium' },
        { value: '600', label: 'Semibold' },
        { value: '700', label: 'Bold' },
        { value: '800', label: 'Extra bold' },
        { value: '900', label: 'Black' },
      ],
      priority: 1,
    },
    { kind: 'toggle', key: 'italic', label: 'Italic', priority: 1 },
    {
      kind: 'choice',
      key: 'align',
      label: 'Alignment',
      iconOnly: true,
      options: [
        { value: 'left', label: 'Align left', icon: 'alignLeft' },
        { value: 'center', label: 'Align centre', icon: 'alignCenter' },
        { value: 'right', label: 'Align right', icon: 'alignRight' },
      ],
      priority: 1,
    },
  ],
  eyedropper: [
    {
      kind: 'choice',
      key: 'sample',
      label: 'Sample',
      options: [
        { value: 'composite', label: 'All layers' },
        { value: 'layer', label: 'Current layer' },
      ],
      priority: 1,
    },
    {
      kind: 'choice',
      key: 'size',
      label: 'Sample size',
      numeric: true,
      options: [
        { value: '1', label: 'Point' },
        { value: '3', label: '3 × 3' },
        { value: '5', label: '5 × 5' },
      ],
      priority: 1,
    },
  ],
  hand: [],
  zoom: [
    {
      kind: 'choice',
      key: 'zoomOut',
      label: 'Click to',
      options: [
        { value: 'false', label: 'Zoom in', icon: 'zoomIn' },
        { value: 'true', label: 'Zoom out', icon: 'zoomOut' },
      ],
      priority: 1,
    },
  ],
};

/** Shape kinds in menu order, with their labels and icon keys. */
export const SHAPE_CHOICES: readonly ChoiceOption[] = [
  { value: 'rect', label: 'Rectangle', icon: 'shapeRect' },
  { value: 'roundedRect', label: 'Rounded rectangle', icon: 'shapeRounded' },
  { value: 'squircle', label: 'Squircle', icon: 'shapeSquircle' },
  { value: 'ellipse', label: 'Ellipse', icon: 'shapeEllipse' },
  { value: 'polygon', label: 'Polygon', icon: 'shapePolygon' },
  { value: 'star', label: 'Star', icon: 'shapeStar' },
  { value: 'heart', label: 'Heart', icon: 'shapeHeart' },
  { value: 'line', label: 'Line', icon: 'shapeLine' },
  { value: 'arrow', label: 'Arrow', icon: 'shapeArrow' },
];

/** The specs that apply to the current options (their `when` passes). */
export function visibleSpecs<K extends string>(
  specs: readonly OptionSpec<K>[],
  options: Record<string, unknown>,
): OptionSpec<K>[] {
  return specs.filter((s) => !s.when || s.when(options));
}

// ---- slider maths -------------------------------------------------------------

/** Slider travel for log sliders: positions 0..LOG_STEPS. */
export const LOG_STEPS = 1000;

/** Option value → what the user sees (percent values ×100). */
export function toDisplay(spec: SliderSpec, value: number): number {
  return spec.percent ? value * 100 : value;
}

/** What the user typed → option value (clamped and snapped to the step). */
export function fromDisplay(spec: SliderSpec, display: number): number {
  const step = spec.step > 0 ? spec.step : 1;
  const lo = toDisplay(spec, spec.min);
  const hi = toDisplay(spec, spec.max);
  const snapped = Math.round(display / step) * step;
  const clamped = Math.min(hi, Math.max(lo, Number.isFinite(snapped) ? snapped : lo));
  // Floating-point tidy: 0.29999999 → 0.3.
  const v = spec.percent ? clamped / 100 : clamped;
  return Number(v.toFixed(6));
}

/** Range input bounds for a spec, in slider units. */
export function sliderRange(spec: SliderSpec): { min: number; max: number; step: number } {
  if (spec.log) return { min: 0, max: LOG_STEPS, step: 1 };
  return { min: toDisplay(spec, spec.min), max: toDisplay(spec, spec.max), step: spec.step };
}

/** Option value → slider position. */
export function toSliderPos(spec: SliderSpec, value: number): number {
  if (!spec.log) return toDisplay(spec, clampTo(spec, value));
  const lo = Math.max(1e-6, spec.min);
  const v = Math.min(spec.max, Math.max(lo, value));
  return Math.round((Math.log(v / lo) / Math.log(spec.max / lo)) * LOG_STEPS);
}

/** Slider position → option value (snapped to the step). */
export function fromSliderPos(spec: SliderSpec, pos: number): number {
  if (!spec.log) return fromDisplay(spec, pos);
  const lo = Math.max(1e-6, spec.min);
  const t = Math.min(1, Math.max(0, pos / LOG_STEPS));
  return fromDisplay(spec, toDisplay(spec, lo * Math.pow(spec.max / lo, t)));
}

/**
 * The value after a key press on a slider (null for other keys): arrows
 * move one step in display units, Shift+arrow and PageUp/PageDown ten,
 * Home/End jump to the ends.
 */
export function keyStep(spec: SliderSpec, value: number, key: string, shift = false): number | null {
  if (key === 'Home') return spec.min;
  if (key === 'End') return spec.max;
  const up = key === 'ArrowRight' || key === 'ArrowUp' || key === 'PageUp';
  const down = key === 'ArrowLeft' || key === 'ArrowDown' || key === 'PageDown';
  if (!up && !down) return null;
  const steps = shift || key === 'PageUp' || key === 'PageDown' ? 10 : 1;
  return fromDisplay(spec, toDisplay(spec, value) + (up ? 1 : -1) * spec.step * steps);
}

/** "24 px", "80 %", "6". */
export function formatOption(spec: SliderSpec, value: number): string {
  const d = toDisplay(spec, value);
  const decimals = spec.step < 1 ? Math.min(3, (String(spec.step).split('.')[1] ?? '').length) : 0;
  const text = d.toFixed(decimals);
  if (!spec.unit) return text;
  return spec.unit === '%' ? `${text}%` : `${text} ${spec.unit}`;
}

function clampTo(spec: SliderSpec, value: number): number {
  return Math.min(spec.max, Math.max(spec.min, Number.isFinite(value) ? value : spec.min));
}

/** Decimal places of a step (1 → 0, 0.25 → 2). */
export function stepDecimals(step: number): number {
  return (String(step).split('.')[1] ?? '').length;
}

/**
 * A number as typed-in fields show it: rounded to the step's decimals,
 * trailing fractional zeros dropped ("80", "0.5", "12.25"), never "-0".
 */
export function formatNumber(value: number, step = 1): string {
  if (!Number.isFinite(value)) return '';
  const text = value.toFixed(stepDecimals(step));
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  return trimmed === '-0' ? '0' : trimmed;
}

/** Parses a choice value back into the option's type. */
export function choiceValue(spec: ChoiceSpec, raw: string): string | number | boolean {
  if (spec.numeric) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** The option's current value as a choice string. */
export function choiceKey(value: unknown): string {
  return String(value);
}
