/**
 * Filter parameter descriptors. Each filter declares its parameters once
 * (key, label, UI kind, range, default); the same list drives the editor UI
 * (via the registry), default values, and validation of incoming params, so
 * ranges can never drift between the UI and the implementation.
 */
import { isColor } from './colormath';
import { normalizeStops, type GradientStop } from './gradient';

export type ParamKind = 'slider' | 'color' | 'toggle' | 'select' | 'gradient';

interface ParamBase {
  /** Property name in the params object. */
  key: string;
  /** Human label for the control. */
  label: string;
}

/** A numeric slider. Values are clamped to [min, max]; when `step` is a whole number ≥ 1 they are also rounded. */
export interface SliderParamSpec extends ParamBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  default: number;
  /** Display unit suffix, e.g. '%', '°', 'px'. */
  unit?: string;
}

/** A colour well (any `parseColor` string; the UI should emit `#rrggbb` / `#rrggbbaa`). */
export interface ColorParamSpec extends ParamBase {
  kind: 'color';
  default: string;
  /** Whether the UI should offer an alpha control. */
  alpha: boolean;
}

export interface ToggleParamSpec extends ParamBase {
  kind: 'toggle';
  default: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectParamSpec extends ParamBase {
  kind: 'select';
  default: string;
  options: readonly SelectOption[];
}

/** A gradient editor producing an ordered list of stops. */
export interface GradientParamSpec extends ParamBase {
  kind: 'gradient';
  default: readonly GradientStop[];
  minStops: number;
  maxStops: number;
}

export type ParamSpec = SliderParamSpec | ColorParamSpec | ToggleParamSpec | SelectParamSpec | GradientParamSpec;

/** Any value a filter parameter can hold. */
export type ParamValue = number | string | boolean | GradientStop[];

/** Loosely typed params, e.g. straight from UI state or a worker message. */
export type ParamRecord = Readonly<Record<string, unknown>>;

export function slider(key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): SliderParamSpec {
  return unit === undefined ? { kind: 'slider', key, label, min, max, step, default: def } : { kind: 'slider', key, label, min, max, step, default: def, unit };
}

export function color(key: string, label: string, def: string, alpha = false): ColorParamSpec {
  return { kind: 'color', key, label, default: def, alpha };
}

export function toggle(key: string, label: string, def: boolean): ToggleParamSpec {
  return { kind: 'toggle', key, label, default: def };
}

export function select(key: string, label: string, options: readonly SelectOption[], def: string): SelectParamSpec {
  return { kind: 'select', key, label, options, default: def };
}

export function gradient(key: string, label: string, def: readonly GradientStop[], minStops = 2, maxStops = 16): GradientParamSpec {
  return { kind: 'gradient', key, label, default: def, minStops, maxStops };
}

function cloneDefault(spec: ParamSpec): ParamValue {
  return spec.kind === 'gradient' ? spec.default.map((s) => ({ ...s })) : spec.default;
}

/** Normalises one value against its descriptor (clamp / validate / fall back to the default). */
export function normalizeParam(spec: ParamSpec, value: unknown): ParamValue {
  switch (spec.kind) {
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
      let v = value < spec.min ? spec.min : value > spec.max ? spec.max : value;
      if (spec.step >= 1 && Number.isInteger(spec.step)) v = Math.round(v);
      return v;
    }
    case 'color':
      return isColor(value) ? value : spec.default;
    case 'toggle':
      return typeof value === 'boolean' ? value : spec.default;
    case 'select':
      return typeof value === 'string' && spec.options.some((o) => o.value === value) ? value : spec.default;
    case 'gradient': {
      const stops = normalizeStops(value, spec.default);
      if (stops.length < spec.minStops) return cloneDefault(spec);
      return stops.length > spec.maxStops ? stops.slice(0, spec.maxStops) : stops;
    }
  }
}

/** A fresh params object holding every default. */
export function defaultsOf<P extends object>(specs: readonly ParamSpec[]): P {
  const out: Record<string, ParamValue> = {};
  for (const s of specs) out[s.key] = cloneDefault(s);
  return out as P;
}

/**
 * Full, validated params: every declared key present and in range; unknown
 * keys are dropped. Accepts partial / untyped input.
 */
export function resolveParams<P extends object>(specs: readonly ParamSpec[], input?: Partial<P> | ParamRecord | null): P {
  // Anything but a plain object (e.g. a stray string from a message) counts as "no params".
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, ParamValue> = {};
  for (const s of specs) out[s.key] = s.key in src ? normalizeParam(s, src[s.key]) : cloneDefault(s);
  return out as P;
}
