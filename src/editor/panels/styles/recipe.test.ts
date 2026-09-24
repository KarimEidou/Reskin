import { describe, expect, it } from 'vitest';
import { createEffect, Engine, Surface, type PixelGrid } from '$engine/index';
import { buildPreset } from '$engine/presets';
import { getSticker, renderSticker } from '$engine/stickers';
import { resolveBackdropSpec } from '$engine/backdrop';
import {
  BACKDROP_LAYER_NAME,
  backdropRecipe,
  chainRecipes,
  effectsRecipe,
  filterRecipe,
  helperRecipe,
  placeBackdrop,
  presetRecipe,
  type PresetBuilder,
} from './recipe';

/**
 * A scratch engine like "Apply style to all" makes: one icon layer, on the
 * 512 px master or on a pixel-art grid.
 */
function scratch(grid: PixelGrid | null = null): { engine: Engine; icon: string } {
  const engine = new Engine();
  const px = renderSticker(getSticker('bolt')!, { size: 512 });
  const icon = engine.importImage(Surface.fromRgba(512, 512, px.data), 'App', { padding: 0 })!;
  engine.deleteLayer(engine.doc.layers[0]!.id);
  if (grid) engine.setPixelArt(grid);
  engine.clearHistory();
  return { engine, icon };
}

/** The design's pixels, for comparing two replays byte for byte. */
const pixels = (engine: Engine) => Buffer.from(engine.composite().data).toString('base64');

/** Share of the document the design covers (alpha-weighted), 0..1. */
function coverage(engine: Engine): number {
  const { data, width, height } = engine.composite();
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i]!;
  return sum / 255 / (width * height);
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
    recipe = chainRecipes(recipe, filterRecipe('invert', 'Invert', {}, 512));
    recipe = chainRecipes(recipe, helperRecipe('badge', 'Add badge', { text: '2', color: '#ff0000', position: 'tr', size: 30 }, 512));
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

describe('style recipes on documents of every size', () => {
  it('an adjustment chosen on a 32 px document replays on 512 px as it would be chosen there', async () => {
    // Blur 0.5 px of 32 is 8 px of 512.
    const replayed = scratch();
    await filterRecipe('blur', 'Blur', { radius: 0.5 }, 32).apply(replayed.engine, replayed.icon);
    const native = scratch();
    await filterRecipe('blur', 'Blur', { radius: 8 }, 512).apply(native.engine, native.icon);
    expect(pixels(replayed.engine)).toBe(pixels(native.engine));
    // And back: pixelate blocks of 32 px on 512 are blocks of 2 px on 32.
    const small = scratch(32);
    await filterRecipe('pixelate', 'Pixelate', { size: 32 }, 512).apply(small.engine, small.icon);
    const smallNative = scratch(32);
    await filterRecipe('pixelate', 'Pixelate', { size: 2 }, 32).apply(smallNative.engine, smallNative.icon);
    expect(pixels(small.engine)).toBe(pixels(smallNative.engine));
    // A setting that was off stays off; one still on never scales to nothing.
    const off = scratch(32);
    const before = pixels(off.engine);
    await filterRecipe('blur', 'Blur', { radius: 0 }, 512).apply(off.engine, off.icon);
    expect(pixels(off.engine)).toBe(before);
    const least = scratch(32);
    await filterRecipe('blur', 'Blur', { radius: 1 }, 512).apply(least.engine, least.icon);
    expect(pixels(least.engine)).not.toBe(before);
  });

  it('an icon helper scales its pixel settings, and keeps its relative ones', async () => {
    const replayed = scratch(32);
    await helperRecipe('removeBackground', 'Remove background', { tolerance: 12, feather: 16 }, 512).apply(replayed.engine, replayed.icon);
    const native = scratch(32);
    await helperRecipe('removeBackground', 'Remove background', { tolerance: 12, feather: 1 }, 32).apply(native.engine, native.icon);
    expect(pixels(replayed.engine)).toBe(pixels(native.engine));
  });

  it('effects keep their size relative to the document, on the layer of the same name', async () => {
    const shadow = createEffect('dropShadow', { distance: 0.5, blur: 0.75, spread: 0.25 });
    const glow = createEffect('outerGlow', { size: 1, spread: 0 });
    const recipe = effectsRecipe('App', [shadow, glow], 32);
    expect(recipe.label).toBe('Effects');
    const big = scratch();
    await recipe.apply(big.engine, big.icon);
    expect(big.engine.getLayer(big.icon)!.effects).toMatchObject([
      { type: 'dropShadow', distance: 8, blur: 12, spread: 4 },
      { type: 'outerGlow', size: 16, spread: 0 },
    ]);
    // Recorded on the master, replayed on a pixel-art icon.
    const small = scratch(32);
    await effectsRecipe('App', [createEffect('outline', { width: 16 })], 512).apply(small.engine, small.icon);
    expect(small.engine.getLayer(small.icon)!.effects).toMatchObject([{ type: 'outline', width: 1 }]);
    // No layer of that name (another item's icon): the adjusted layer gets them.
    const other = scratch();
    await effectsRecipe('Steam', [shadow], 32).apply(other.engine, other.icon);
    expect(other.engine.getLayer(other.icon)!.effects).toMatchObject([{ type: 'dropShadow', distance: 8 }]);
  });

  it('keeps one step per layer when its effects change again', () => {
    let recipe = chainRecipes(null, presetRecipe('neon', 'Neon', {}, syncBuilder));
    recipe = chainRecipes(recipe, effectsRecipe('Neon', [createEffect('outerGlow')], 512));
    recipe = chainRecipes(recipe, effectsRecipe('Neon', [createEffect('outerGlow', { size: 24 })], 512));
    expect(recipe.label).toBe('Neon + Effects');
  });

  it('backdrops and presets are measured in fractions of the document: the same look at 32 and 512 px', async () => {
    const spec = resolveBackdropSpec({ shape: 'circle', inset: 0.1, border: { width: 0.04 }, shadow: { blur: 0.05 } });
    const big = scratch();
    const small = scratch(32);
    await backdropRecipe(spec).apply(big.engine, big.icon);
    await backdropRecipe(spec).apply(small.engine, small.icon);
    expect(coverage(small.engine)).toBeCloseTo(coverage(big.engine), 1);

    const bigStyled = scratch();
    const smallStyled = scratch(32);
    await presetRecipe('glass', 'Glass', {}, syncBuilder).apply(bigStyled.engine, bigStyled.icon);
    await presetRecipe('glass', 'Glass', {}, syncBuilder).apply(smallStyled.engine, smallStyled.icon);
    expect(smallStyled.engine.doc.layers.map((l) => l.name)).toEqual(bigStyled.engine.doc.layers.map((l) => l.name));
    expect(coverage(smallStyled.engine)).toBeCloseTo(coverage(bigStyled.engine), 1);
  });
});
