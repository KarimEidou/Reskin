// Re-playable styles for "Apply style to all": what the Styles, Backdrop,
// Adjust and Effects panels did, as steps that rebuild the look on another
// icon. A preset starts a new recipe (it replaces the whole design); a
// backdrop, an adjustment or a layer's effects applied afterwards are
// appended to it.
//
// A look must come out the same on a document of any size (the 512 px
// master, a 16–64 px pixel-art grid): presets and backdrops are measured
// in fractions of the document already, and the steps with pixel settings
// (adjustments, icon helpers, effects) remember the size of the document
// they were chosen on and scale those settings to the one they replay on.

import { cloneEffects, scaleEffect, type Engine, type LayerEffect } from '$engine/index';
import type { BackdropSpec } from '$engine/backdrop';
import { renderBackdrop } from '$engine/backdrop';
import { applyFilter, getFilter, type FilterId } from '$engine/filters';
import { createCanvasTextRasterizer } from '$engine/helpers';
import { applyPresetResult, insertLayer, layerImage, makeRasterLayer, type PresetId, type PresetOptions, type PresetResult } from '$engine/presets';
import type { StyleRecipe } from '../../state/session.svelte';
import { getHelper, runHelper, type HelperId } from '../adjust/helper-defs';
import { scalePxValues } from '../adjust/scale';

/** Recipe steps keep their own label so chains can describe themselves. */
export interface RecipeStep extends StyleRecipe {
  steps?: readonly StyleRecipe[];
  /**
   * Steps that set up the same thing again (a backdrop re-designed and
   * updated) replace the previous one of that kind at the end of a chain
   * instead of piling up.
   */
  replaces?: string;
}

/** Builds a preset at `size` from an icon image (the panels worker in the app). */
export type PresetBuilder = (id: PresetId, icon: { width: number; height: number; data: Uint8ClampedArray }, size: number, options: Partial<PresetOptions>) => Promise<PresetResult>;

export function presetRecipe(id: PresetId, label: string, options: Partial<PresetOptions>, build: PresetBuilder): RecipeStep {
  const opts = { ...options };
  return {
    label,
    async apply(engine: Engine, iconLayerId: string) {
      const icon = layerImage(engine, iconLayerId);
      if (!icon) return;
      applyPresetResult(engine, await build(id, icon, engine.doc.width, opts), { label: `Style: ${label}` });
    },
  };
}

/** The layer an adjustment replays on: the active image layer, else the icon. */
function targetLayer(engine: Engine, iconLayerId: string): string | null {
  const a = engine.activeLayer;
  if (a && a.kind === 'raster') return a.id;
  return engine.getLayer(iconLayerId) ? iconLayerId : null;
}

/** An adjustment with `params` chosen on a `size` px document. */
export function filterRecipe(id: FilterId, label: string, params: Record<string, unknown>, size: number): RecipeStep {
  const chosen = structuredClone(params);
  return {
    label,
    apply(engine: Engine, iconLayerId: string) {
      const target = targetLayer(engine, iconLayerId);
      if (!target) return;
      const p = scalePxValues(getFilter(id).params, chosen, size, engine.doc.width);
      engine.editLayerPixels(target, label, (s) => {
        applyFilter(id, s, p, null, s);
      });
    },
  };
}

/** An icon helper with `values` chosen on a `size` px document. */
export function helperRecipe(id: HelperId, label: string, values: Record<string, unknown>, size: number): RecipeStep {
  const chosen = structuredClone(values);
  return {
    label,
    apply(engine: Engine, iconLayerId: string) {
      const target = targetLayer(engine, iconLayerId);
      if (!target) return;
      const v = scalePxValues(getHelper(id).params, chosen, size, engine.doc.width);
      const rasterizer = createCanvasTextRasterizer();
      engine.editLayerPixels(target, label, (s) => {
        s.data.set(runHelper(id, s, v, null, rasterizer).data);
      });
    },
  };
}

/**
 * The effects the layer `layerName` got on a `size` px document (the
 * Effects panel): given again to the layer of that name — a preset's
 * layers have the same names on every icon — or else to the layer
 * adjustments replay on. Later changes to the same layer's effects
 * replace this step.
 */
export function effectsRecipe(layerName: string, effects: readonly LayerEffect[], size: number): RecipeStep {
  const chosen = cloneEffects(effects);
  return {
    label: 'Effects',
    replaces: `effects:${layerName}`,
    apply(engine: Engine, iconLayerId: string) {
      const target = engine.doc.layers.find((l) => l.name === layerName)?.id ?? targetLayer(engine, iconLayerId);
      if (!target) return;
      const k = engine.doc.width / size;
      engine.setLayerProps(target, { effects: chosen.map((e) => scaleEffect(e, k)) });
    },
  };
}

export const BACKDROP_LAYER_NAME = 'Backdrop';

/** Adds the backdrop under everything, or repaints an existing "Backdrop" layer. */
export function placeBackdrop(engine: Engine, pixels: { data: Uint8ClampedArray }, label?: string): string | null {
  const existing = engine.doc.layers.find((l) => l.kind === 'raster' && l.name === BACKDROP_LAYER_NAME);
  if (existing) {
    const ok = engine.editLayerPixels(existing.id, label ?? 'Update backdrop', (s) => s.data.set(pixels.data));
    return ok ? existing.id : null;
  }
  const layer = makeRasterLayer(engine, BACKDROP_LAYER_NAME, { width: engine.doc.width, height: engine.doc.height, data: pixels.data });
  return insertLayer(engine, label ?? 'Add backdrop', layer, 0, false);
}

export function backdropRecipe(spec: BackdropSpec): RecipeStep {
  const s = structuredClone(spec);
  return {
    label: 'Backdrop',
    replaces: 'backdrop',
    apply(engine: Engine) {
      placeBackdrop(engine, renderBackdrop(s, engine.doc.width));
    },
  };
}

/** `prev` then `next` (a preset always starts afresh). */
export function chainRecipes(prev: StyleRecipe | null, next: RecipeStep): StyleRecipe {
  if (!prev) return next;
  const before = [...((prev as RecipeStep).steps ?? [prev])];
  const last = before[before.length - 1] as RecipeStep | undefined;
  if (next.replaces !== undefined && last?.replaces === next.replaces) before.pop();
  if (before.length === 0) return next;
  const steps = [...before, ...(next.steps ?? [next])];
  const names = steps.map((s) => s.label);
  return {
    label: names.length > 3 ? `${names.slice(0, 2).join(' + ')} + ${names.length - 2} more` : names.join(' + '),
    steps,
    async apply(engine: Engine, iconLayerId: string) {
      for (const step of steps) await step.apply(engine, iconLayerId);
    },
  } as RecipeStep;
}
