import { describe, expect, it } from 'vitest';
import { Engine, Surface } from '$engine/index';
import { buildPreset } from '$engine/presets';
import { getSticker, renderSticker } from '$engine/stickers';
import { resolveBackdropSpec } from '$engine/backdrop';
import { BACKDROP_LAYER_NAME, backdropRecipe, chainRecipes, filterRecipe, helperRecipe, placeBackdrop, presetRecipe, type PresetBuilder } from './recipe';

/** A scratch engine like "Apply style to all" makes: one icon layer. */
function scratch(): { engine: Engine; icon: string } {
  const engine = new Engine();
  const px = renderSticker(getSticker('bolt')!, { size: 512 });
  const icon = engine.importImage(Surface.fromRgba(512, 512, px.data), 'App', { padding: 0 })!;
  engine.deleteLayer(engine.doc.layers[0]!.id);
  engine.clearHistory();
  return { engine, icon };
}

const syncBuilder: PresetBuilder = async (id, icon, size, opts) => buildPreset(id, icon, size, opts);

describe('style recipes', () => {
  it('replays a preset from the icon layer', async () => {
    const { engine, icon } = scratch();
    const r = presetRecipe('clay', 'Clay', { intensity: 0.7 }, syncBuilder);
    expect(r.label).toBe('Clay');
    await r.apply(engine, icon);
    expect(engine.doc.layers.map((l) => l.name)).toEqual(['Backdrop', 'Clay glyph']);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Style: Clay']);
  });

  it('chains adjustments and a backdrop after a preset, on the active layer', async () => {
    const { engine, icon } = scratch();
    let recipe = chainRecipes(null, presetRecipe('monoDark', 'Mono Dark', {}, syncBuilder));
    recipe = chainRecipes(recipe, filterRecipe('invert', 'Invert', {}));
    recipe = chainRecipes(recipe, helperRecipe('badge', 'Add badge', { text: '2', color: '#ff0000', position: 'tr', size: 30 }));
    recipe = chainRecipes(recipe, backdropRecipe(resolveBackdropSpec({ shape: 'circle' })));
    expect(recipe.label).toBe('Mono Dark + Invert + 2 more');
    await recipe.apply(engine, icon);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Style: Mono Dark', 'Invert', 'Add badge', 'Update backdrop']);
    // The preset already has a Backdrop layer: it was repainted, not duplicated.
    expect(engine.doc.layers.filter((l) => l.name === BACKDROP_LAYER_NAME)).toHaveLength(1);
  });

  it('keeps one backdrop step when the backdrop is updated again', () => {
    let recipe = chainRecipes(null, presetRecipe('glass', 'Glass', {}, syncBuilder));
    recipe = chainRecipes(recipe, backdropRecipe(resolveBackdropSpec({ shape: 'circle' })));
    recipe = chainRecipes(recipe, backdropRecipe(resolveBackdropSpec({ shape: 'hexagon' })));
    expect(recipe.label).toBe('Glass + Backdrop');
    const only = chainRecipes(backdropRecipe(resolveBackdropSpec({ shape: 'circle' })), backdropRecipe(resolveBackdropSpec({ shape: 'blob' })));
    expect(only.label).toBe('Backdrop');
    expect((only as { steps?: unknown }).steps).toBeUndefined();
  });

  it('adds a backdrop under everything when there is none', () => {
    const { engine } = scratch();
    const id = placeBackdrop(engine, { data: new Uint8ClampedArray(512 * 512 * 4).fill(200) });
    expect(engine.doc.layers[0]!.id).toBe(id);
    expect(engine.doc.layers[0]!.name).toBe('Backdrop');
    expect(engine.activeLayer!.name).toBe('App');
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Add backdrop']);
  });
});
