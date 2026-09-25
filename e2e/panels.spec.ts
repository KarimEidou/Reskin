// The editor sidebar panels, driven through their UI in the real editor
// (editor.html of the e2e build, opened on an item through the handoff).
// Also checks that opening and closing the editor again and again leaks
// nothing, and renders every panel in both themes for visual review.

import type { Page } from '@playwright/test';
import type { SidebarTab } from '../src/editor/state/session.svelte';
import { compositeHash, docToPage, freezeClock, history, layerHash, layers, openEditor, openItem, openTab, shoot, sidebar } from './panels-driver';
import { calls, expect, openPage, SAMPLE_PATHS, simulateClose, test } from './support/fixtures';

const TABS: SidebarTab[] = ['layers', 'color', 'adjust', 'effects', 'styles', 'backdrop', 'stickers', 'history'];

function row(page: Page, name: string) {
  return page.getByTestId('layer-row').filter({ hasText: name });
}

test.describe('layers', () => {
  test('add, rename, reorder by drag, visibility and opacity', async ({ page }) => {
    await openEditor(page);
    expect((await layers(page)).map((l) => l.name)).toEqual(['Steam']);

    await page.getByTestId('add-layer').click();
    await expect(page.getByTestId('layer-row')).toHaveCount(2);
    expect((await layers(page)).map((l) => l.name)).toEqual(['Steam', 'Layer 1']);

    // Rename: double-click, type, Enter.
    await row(page, 'Layer 1').locator('button.main').dblclick();
    const input = page.getByRole('textbox', { name: 'Layer name' });
    await input.fill('Sparkles');
    await input.press('Enter');
    await expect(row(page, 'Sparkles')).toHaveCount(1);
    expect((await layers(page)).map((l) => l.name)).toEqual(['Steam', 'Sparkles']);

    // Drag the top row (Sparkles) below Steam with the pointer.
    const box = (await row(page, 'Sparkles').locator('button.main').boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    for (let dy = 8; dy <= 56; dy += 8) await page.mouse.move(box.x + 60, box.y + box.height / 2 + dy);
    await page.mouse.up();
    await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Sparkles', 'Steam']);
    expect((await history(page)).labels.at(-1)).toBe('Move Sparkles');

    // Keyboard alternative: Alt+↑ moves the focused layer back up.
    await row(page, 'Sparkles').locator('button.main').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Steam', 'Sparkles']);

    // Hiding the icon layer changes the composite; showing it restores it.
    const shown = await compositeHash(page);
    await row(page, 'Steam').getByRole('button', { name: 'Hide Steam' }).click();
    await expect.poll(() => compositeHash(page)).not.toBe(shown);
    expect((await layers(page)).find((l) => l.name === 'Steam')!.visible).toBe(false);
    await row(page, 'Steam').getByRole('button', { name: 'Show Steam' }).click();
    await expect.poll(() => compositeHash(page)).toBe(shown);

    // Opacity of the active layer (Steam) through the number field.
    await row(page, 'Steam').locator('button.main').click();
    const field = page.getByTestId('layers-panel').getByRole('spinbutton', { name: 'Opacity' });
    await field.fill('40');
    await field.press('Enter');
    await expect.poll(async () => (await layers(page)).find((l) => l.name === 'Steam')!.opacity).toBeCloseTo(0.4, 5);
    await expect(row(page, 'Steam')).toContainText('40%');
  });

  test('keyboard: select, rename with F2, duplicate, delete, merge', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('duplicate-layer').click();
    await expect(page.getByTestId('layer-row')).toHaveCount(2);
    const copy = row(page, 'Steam copy').locator('button.main');
    await copy.focus();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Layer name' }).fill('Shadow');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Shadow')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.name)).toBe('Steam');
    await page.keyboard.press('ArrowUp');
    await page.getByRole('button', { name: 'More layer actions' }).click();
    await page.getByRole('menuitem', { name: 'Merge down' }).click();
    await expect(page.getByTestId('layer-row')).toHaveCount(1);
    await page.getByTestId('add-layer').click();
    await expect(page.getByTestId('layer-row')).toHaveCount(2);
    await page.getByTestId('delete-layer').click();
    await expect(page.getByTestId('layer-row')).toHaveCount(1);
  });

  test('thumbnails follow the layer pixels', async ({ page }) => {
    await openEditor(page);
    const thumb = row(page, 'Steam').locator('canvas');
    await expect(thumb).toBeVisible();
    const sample = () =>
      thumb.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data));
    const before = await sample();
    await page.evaluate(() => {
      const e = (globalThis as any).__reskinSession.engine;
      e.editLayerPixels(e.activeLayer.id, 'Paint', (s: { data: Uint8ClampedArray }) => {
        for (let i = 0; i < s.data.length; i += 4) {
          s.data[i] = 255;
          s.data[i + 1] = 0;
          s.data[i + 2] = 0;
          s.data[i + 3] = 255;
        }
      });
    });
    await expect.poll(sample).not.toEqual(before);
    expect(await sample()).toEqual([255, 0, 0, 255]);
  });

  test('Ctrl+click a thumbnail selects its pixels; Shift adds, Alt subtracts, both intersect', async ({ page }) => {
    await openEditor(page);
    // Two layers with overlapping opaque bands: Left x 100–300, Right x 200–400.
    await page.evaluate(() => {
      const e = (globalThis as any).__reskinSession.engine;
      for (const [name, x0] of [['Left', 100], ['Right', 200]] as const) {
        const id = e.addLayer({ name });
        e.editLayerPixels(id, 'Paint', (s: { data: Uint8ClampedArray }) => {
          for (let y = 100; y < 400; y++) for (let x = x0; x < x0 + 200; x++) s.data.set([20, 120, 220, 255], (y * 512 + x) * 4);
        });
      }
    });
    const thumb = (name: string) => row(page, name).getByTestId('layer-thumb');
    // The thumbnail explains itself on hover.
    await thumb('Left').hover();
    await expect(page.getByRole('tooltip')).toContainText('Ctrl+click: select this layer’s pixels');
    /** Which of: only Left, both, only Right, neither are selected. */
    const selected = () =>
      page.evaluate(() => {
        const sel = (globalThis as any).__reskinSession.engine.doc.selection;
        return [150, 250, 350, 450].map((x) => (sel ? sel.data[250 * 512 + x] > 0 : true));
      });
    const active = () => page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.name);

    await thumb('Left').click({ modifiers: ['Control'] });
    await expect.poll(selected).toEqual([true, true, false, false]);
    // The active layer does not change.
    expect(await active()).toBe('Right');
    await thumb('Right').click({ modifiers: ['Control', 'Shift'] });
    await expect.poll(selected).toEqual([true, true, true, false]);
    await thumb('Left').click({ modifiers: ['Control', 'Alt'] });
    await expect.poll(selected).toEqual([false, false, true, false]);
    await thumb('Left').click({ modifiers: ['Control'] });
    await thumb('Right').click({ modifiers: ['Control', 'Shift', 'Alt'] });
    await expect.poll(selected).toEqual([false, true, false, false]);
    expect((await history(page)).labels.filter((l) => l === 'Select layer pixels')).toHaveLength(5);

    // A plain click still selects the layer; the menu selects the active layer's pixels.
    await thumb('Left').click();
    await expect.poll(active).toBe('Left');
    await page.getByRole('button', { name: 'More layer actions' }).click();
    await page.getByRole('menuitem', { name: 'Select layer pixels' }).click();
    await expect.poll(selected).toEqual([true, true, false, false]);
  });

  test('keyboard steps on the opacity slider are one undo step; every drag is a step of its own', async ({ page }) => {
    // Every step lands inside the merge window, however slow the machine.
    await freezeClock(page);
    await openEditor(page);
    const slider = page.getByTestId('layers-panel').getByRole('slider', { name: 'Opacity' });
    await slider.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await layers(page))[0]!.opacity).toBeCloseTo(0.96, 5);
    expect((await history(page)).labels).toHaveLength(1);
    // Two drags right after (well inside the merge window): two more steps.
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    for (const [from, to] of [
      [0.9, 0.7],
      [0.7, 0.4],
    ] as const) {
      await page.mouse.move(box.x + box.width * from, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * to, y, { steps: 4 });
      await page.mouse.up();
    }
    await expect.poll(async () => (await layers(page))[0]!.opacity).toBeLessThan(0.5);
    await expect.poll(async () => (await history(page)).labels.length).toBe(3);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await layers(page))[0]!.opacity).toBeGreaterThan(0.6);
  });
});

test.describe('color', () => {
  test('the picker, hex entry and swatches set the engine colours; commits are remembered', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'color');
    const primary = () => page.evaluate(() => (globalThis as any).__reskinSession.engine.primary);

    // Drag in the saturation/brightness square.
    const sq = page.getByTestId('sv-square');
    const b = (await sq.boundingBox())!;
    await page.mouse.click(b.x + b.width * 0.8, b.y + b.height * 0.2);
    const picked = await primary();
    expect(picked.r).toBeGreaterThan(150);
    expect(picked.g).toBeLessThan(80);

    // Keyboard on the square: brightness down.
    await sq.focus();
    await page.keyboard.press('Shift+ArrowDown');
    expect((await primary()).r).toBeLessThan(picked.r);

    // Hex entry.
    const hex = page.getByTestId('color-panel').getByRole('textbox', { name: 'Hex' });
    await hex.fill('#ff8800');
    await hex.press('Enter');
    await expect.poll(primary).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    await expect.poll(() => page.evaluate(() => window.__e2e!.settings.recentColors[0])).toBe('#ff8800');
    await expect(page.getByTestId('recent-colors').getByRole('button').first()).toHaveAttribute('aria-label', 'Use #FF8800');

    // Swap, then a palette swatch goes to the colour being edited.
    await page.getByTestId('swap-colors').click();
    await expect.poll(primary).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    // The wells are a radio group: arrow keys switch between them.
    await page.getByTestId('primary-well').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('secondary-well')).toBeFocused();
    await expect(page.getByTestId('secondary-well')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('primary-well')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('secondary-well').click();
    await page.getByTestId('palette').getByRole('button').first().click();
    const secondary = await page.evaluate(() => (globalThis as any).__reskinSession.engine.secondary);
    expect(secondary).toEqual({ r: 0x75, g: 0x0b, b: 0x1c, a: 1 });

    // Without the EyeDropper API the canvas eyedropper tool is selected.
    const hasApi = await page.evaluate(() => 'EyeDropper' in window);
    if (!hasApi) {
      await page.getByTestId('eyedropper').click();
      await expect.poll(() => page.evaluate(() => (globalThis as any).__reskinSession.engine.toolId)).toBe('eyedropper');
    }
  });
});

test.describe('adjust', () => {
  async function startInvert(page: Page) {
    await openEditor(page);
    await openTab(page, 'adjust');
    const before = await layerHash(page);
    await page.locator('[data-filter="invert"]').click();
    await expect(page.getByTestId('adjust-editor')).toBeVisible();
    await expect.poll(() => layerHash(page)).not.toBe(before);
    return before;
  }

  test('pixel sizes follow the document: a pixel-art icon gets its own range and default', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'adjust');
    const radius = page.getByTestId('adjust-editor').getByRole('slider', { name: 'Radius' });
    // The 512 px master: the blur's own range.
    await page.locator('[data-filter="blur"]').click();
    await expect(radius).toHaveAttribute('max', '64');
    await expect(radius).toHaveValue('4');
    await page.getByTestId('adjust-cancel').click();
    // A 32 px pixel-art grid: 4 px of 512 is a quarter pixel, so the smallest
    // blur there is (half a pixel), within a range scaled the same way.
    await page.evaluate(() => (globalThis as any).__reskinSession.engine.setPixelArt(32));
    await page.locator('[data-filter="blur"]').click();
    await expect(radius).toHaveAttribute('max', '4');
    await expect(radius).toHaveValue('0.5');
    await page.getByTestId('adjust-cancel').click();
    // A block of one pixel would change nothing.
    await page.locator('[data-filter="pixelate"]').click();
    await expect(page.getByTestId('adjust-editor').getByRole('slider', { name: 'Block size' })).toHaveValue('2');
  });

  test('a live preview, Apply keeps it as one step, Ctrl+Z restores exactly', async ({ page }) => {
    const before = await startInvert(page);
    // The preview is on the canvas, not in the history, until it is applied.
    expect((await history(page)).labels).toEqual([]);
    const preview = await layerHash(page);
    await page.getByTestId('adjust-apply').click();
    await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
    expect(await layerHash(page)).toBe(preview);
    expect((await history(page)).labels).toEqual(['Invert']);
    expect(await page.evaluate(() => (globalThis as any).__reskinSession.recipe?.label)).toBe('Invert');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect.poll(() => layerHash(page)).toBe(before);
    await page.keyboard.press('Control+y');
    await expect.poll(() => layerHash(page)).toBe(preview);
  });

  test('leaving the panel keeps the adjustment as one step of the design and of its recipe', async ({ page }) => {
    await startInvert(page);
    const inverted = await layerHash(page);
    await openTab(page, 'styles');
    expect(await layerHash(page)).toBe(inverted);
    expect((await history(page)).labels).toEqual(['Invert']);
    await expect(page.getByTestId('styles-panel')).toContainText('“Apply style to all” will use: Invert');
  });

  test('Cancel restores the layer byte for byte and leaves no history', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'adjust');
    const before = await layerHash(page);
    await page.locator('[data-filter="hueSaturation"]').click();
    const hue = page.getByTestId('adjust-editor').getByRole('slider', { name: 'Hue' });
    await hue.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageUp');
    await expect.poll(() => layerHash(page)).not.toBe(before);
    expect((await history(page)).labels).toEqual([]);
    await page.getByTestId('adjust-cancel').click();
    await expect.poll(() => layerHash(page)).toBe(before);
    expect(await history(page)).toEqual({ labels: [], index: 0, canRedo: false });
  });

  test('Ctrl+Z while previewing ends the adjustment and restores the layer exactly', async ({ page }) => {
    const before = await startInvert(page);
    const inverted = await layerHash(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
    expect(await layerHash(page)).toBe(before);
    expect((await history(page)).index).toBe(0);
    // The undone adjustment is a redo step: Ctrl+Y brings it back.
    expect(await history(page)).toEqual({ labels: ['Invert'], index: 0, canRedo: true });
    await page.keyboard.press('Control+y');
    await expect.poll(() => layerHash(page)).toBe(inverted);
    await page.keyboard.press('Control+z');
    await expect.poll(() => layerHash(page)).toBe(before);
    // Opening an adjustment whose defaults change nothing keeps the redo step.
    await page.locator('[data-filter="brightnessContrast"]').click();
    await expect(page.getByTestId('adjust-editor')).toBeVisible();
    await page.getByTestId('adjust-cancel').click();
    expect((await history(page)).canRedo).toBe(true);
    expect(await layerHash(page)).toBe(before);
  });

  test('Escape outside the panel cancels the preview instead of closing the editor', async ({ page }) => {
    const before = await startInvert(page);
    await page.getByTestId('canvas-stage').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
    expect(await layerHash(page)).toBe(before);
    expect((await history(page)).labels).toEqual([]);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
  });

  test('changing the design elsewhere ends the preview and restores the layer', async ({ page }) => {
    const before = await startInvert(page);
    await page.evaluate(() => {
      const e = (globalThis as any).__reskinSession.engine;
      e.setLayerProps(e.activeLayer.id, { locked: true });
    });
    await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
    expect(await layerHash(page)).toBe(before);
    expect((await history(page)).labels).toEqual(['Lock layer']);
  });

  test('Reset returns to the defaults; icon helpers preview too', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'adjust');
    const before = await layerHash(page);
    await page.locator('[data-filter="brightnessContrast"]').click();
    const slider = page.getByTestId('adjust-editor').getByRole('slider', { name: 'Brightness' });
    await slider.focus();
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await expect.poll(() => layerHash(page)).not.toBe(before);
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(() => layerHash(page)).toBe(before);
    expect((await history(page)).labels).toEqual([]);
    await page.getByTestId('adjust-cancel').click();

    await page.locator('[data-helper="badge"]').click();
    await expect.poll(() => layerHash(page)).not.toBe(before);
    await page.getByTestId('adjust-apply').click();
    expect((await history(page)).labels).toEqual(['Add badge']);
    // The back button cancels.
    await page.locator('[data-helper="removeBackground"]').click();
    await page.getByRole('button', { name: 'Back to adjustments (cancel)' }).click();
    await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
    expect((await history(page)).labels).toEqual(['Add badge']);
  });
});

for (const [size, viewport, filters] of [
  ['S', { width: 900, height: 620 }, ['levels', 'hueSaturation']],
  ['M', { width: 1080, height: 720 }, ['levels']],
] as const) {
  test.describe(`adjust at the ${size} size`, () => {
    test.use({ viewport });

    for (const filter of filters) {
      test(`${filter}: Apply and Cancel stay in view below its settings`, async ({ page }) => {
        await openEditor(page);
        await openTab(page, 'adjust');
        await page.locator(`[data-filter="${filter}"]`).click();
        await expect(page.getByTestId('adjust-editor')).toBeVisible();
        const scroller = page.getByTestId('panel-adjust');
        // The settings are taller than the panel: it scrolls, the buttons stay.
        expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        for (const top of [0, Number.MAX_SAFE_INTEGER]) {
          await scroller.evaluate((el, y) => el.scrollTo(0, y), top);
          const panel = (await scroller.boundingBox())!;
          for (const id of ['adjust-apply', 'adjust-cancel']) {
            const button = page.getByTestId(id);
            const box = (await button.boundingBox())!;
            expect(box.y, `${id} top`).toBeGreaterThanOrEqual(panel.y);
            expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(panel.y + panel.height);
            expect(box.y + box.height, `${id} in the window`).toBeLessThanOrEqual(viewport.height);
            // Nothing covers it: a press at its centre reaches it.
            const hit = await button.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            });
            expect(hit, `${id} is on top`).toBe(true);
          }
        }
        // Tab from the top: every control it reaches comes out clear of the
        // bar that holds the buttons (Reset is its first).
        await scroller.evaluate((el) => el.scrollTo(0, 0));
        const editor = page.getByTestId('adjust-editor');
        await editor.getByRole('button', { name: 'Back to adjustments (cancel)' }).focus();
        const reset = editor.getByRole('button', { name: 'Reset' });
        for (let stops = 1; ; stops++) {
          await page.keyboard.press('Tab');
          if (await reset.evaluate((el) => el === document.activeElement)) break;
          expect(stops, 'Tab reaches the buttons').toBeLessThan(20);
          const control = (await page.locator(':focus').boundingBox())!;
          const barTop = await reset.evaluate((el) => el.parentElement!.getBoundingClientRect().top);
          expect(control.y + control.height, `control ${stops} is clear of the bar`).toBeLessThanOrEqual(barTop);
        }
        await page.getByTestId('adjust-apply').click();
        await expect(page.getByTestId('adjust-editor')).toHaveCount(0);
      });
    }
  });
}

test.describe('effects', () => {
  test('add, toggle and remove layer effects', async ({ page }) => {
    // Every step lands inside the merge window, however slow the machine.
    await freezeClock(page);
    await openEditor(page);
    await openTab(page, 'effects');
    const plain = await compositeHash(page);
    await page.getByRole('button', { name: 'Drop shadow' }).click();
    await expect(page.getByTestId('effect-card')).toHaveCount(1);
    expect((await layers(page))[0]!.effects).toEqual(['dropShadow']);
    await expect.poll(() => compositeHash(page)).not.toBe(plain);

    await page.getByRole('button', { name: 'Add effect' }).click();
    await page.getByRole('menuitem', { name: 'Outline' }).click();
    await expect(page.getByTestId('effect-card')).toHaveCount(2);
    expect((await layers(page))[0]!.effects).toEqual(['dropShadow', 'outline']);

    // Switching an effect off and on again is two undo steps (never merged).
    const steps = (await history(page)).labels.length;
    await page.getByTestId('effect-card').first().getByRole('switch').click();
    await page.getByTestId('effect-card').first().getByRole('switch').click();
    expect((await history(page)).labels.length).toBe(steps + 2);
    // A slider's keyboard steps merge into one.
    const opacity = page.getByTestId('effect-card').first().getByRole('slider', { name: 'Opacity' });
    await opacity.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await history(page)).labels.length).toBe(steps + 3);

    // Disable the shadow, then remove both.
    await page.getByTestId('effect-card').first().getByRole('switch').click();
    expect(await page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.effects[0].enabled)).toBe(false);
    await page.getByTestId('remove-effect').first().click();
    await page.getByTestId('remove-effect').first().click();
    await expect(page.getByTestId('effect-card')).toHaveCount(0);
    await expect.poll(() => compositeHash(page)).toBe(plain);
  });

  test("a layer's effects join the design's recipe, sized for each icon they are replayed on", async ({ page }) => {
    await openEditor(page);
    // A 32 px pixel-art icon: its shadow is a sixteenth of the master's.
    await page.evaluate(() => (globalThis as any).__reskinSession.engine.setPixelArt(32));
    await openTab(page, 'effects');
    await page.getByRole('button', { name: 'Drop shadow' }).click();
    await expect(page.getByTestId('effect-card')).toHaveCount(1);
    const chosen = await page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.effects[0].distance);
    expect(chosen).toBe(0.5);
    await openTab(page, 'styles');
    await expect(page.getByTestId('styles-panel')).toContainText('“Apply style to all” will use: Effects');
    // Replayed on another icon at the 512 px master (as "Apply style to all" does).
    const replayed = await page.evaluate(async () => {
      const s = (globalThis as any).__reskinSession;
      const scratch = new s.engine.constructor();
      const blank = scratch.doc.layers[0].id;
      const id = scratch.addLayer();
      scratch.deleteLayer(blank);
      await s.recipe.apply(scratch, id);
      return scratch.getLayer(id).effects.map((e: { type: string; distance: number }) => [e.type, e.distance]);
    });
    expect(replayed).toEqual([['dropShadow', 8]]);
  });
});

test.describe('backdrop', () => {
  test('adds a bottom layer, then updates it', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'backdrop');
    const plain = await compositeHash(page);
    await page.getByTestId('apply-backdrop').click();
    await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Backdrop', 'Steam']);
    expect((await history(page)).labels).toEqual(['Add backdrop']);
    await expect(page.getByTestId('apply-backdrop')).toHaveText(/Update backdrop/);
    expect(await compositeHash(page)).not.toBe(plain);
    // The active layer is still the icon.
    expect(await page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.name)).toBe('Steam');

    const first = await layerHash(page, (await layers(page))[0]!.id);
    await page.getByTestId('backdrop-style').filter({ hasText: 'Sunset' }).click();
    await expect.poll(async () => layerHash(page, (await layers(page))[0]!.id)).not.toBe(first);
    expect((await layers(page)).map((l) => l.name)).toEqual(['Backdrop', 'Steam']);
    expect((await history(page)).labels).toEqual(['Add backdrop', 'Update backdrop']);
  });

  test("a blob's seed is typed in whole, and a new seed gives a new shape", async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'backdrop');
    await sidebar(page).getByRole('radio', { name: 'Blob' }).click();
    const seed = sidebar(page).getByRole('spinbutton', { name: 'Seed' });
    await seed.fill('100');
    await seed.press('Enter');
    await expect(seed).toHaveValue('100');
    await expect(seed).toHaveAttribute('aria-valuenow', '100');
    await page.getByTestId('apply-backdrop').click();
    await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Backdrop', 'Steam']);
    const first = await layerHash(page, (await layers(page))[0]!.id);

    await seed.press('ArrowUp');
    await expect(seed).toHaveValue('101');
    await page.getByTestId('apply-backdrop').click();
    await expect.poll(async () => layerHash(page, (await layers(page))[0]!.id)).not.toBe(first);
    expect((await history(page)).labels).toEqual(['Add backdrop', 'Update backdrop']);
  });
});

test.describe('stickers', () => {
  test('adds a sticker as a new centred layer and selects the move tool', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'stickers');
    await page.getByTestId('sticker-search').fill('love');
    await expect(page.getByTestId('sticker')).toHaveCount(1);
    await page.locator('[data-sticker="heart"]').click();
    await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Steam', 'Heart']);
    expect(await page.evaluate(() => (globalThis as any).__reskinSession.engine.toolId)).toBe('move');
    // Centred: the sticker's centre of mass sits in the middle of the canvas.
    const centre = await page.evaluate(() => {
      const l = (globalThis as any).__reskinSession.engine.activeLayer;
      const { width: w, data } = l.surface;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (!a) continue;
        const p = (i - 3) / 4;
        sx += (p % w) * a;
        sy += Math.floor(p / w) * a;
        n += a;
      }
      return { x: sx / n / w, y: sy / n / w };
    });
    expect(centre.x).toBeCloseTo(0.5, 1);
    expect(centre.y).toBeCloseTo(0.5, 1);

    // Emoji render with the colour-emoji font.
    await page.getByTestId('sticker-search').fill('rocket');
    await page.getByTestId('emoji').first().click();
    await expect.poll(async () => (await layers(page)).length).toBe(3);
  });

  test('stamps a sticker or an emoji by clicking on the canvas', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('add-layer').click();
    await openTab(page, 'stickers');
    await page.getByTestId('sticker-search').fill('love');
    // The Stamp button shows on hover.
    await page.locator('[data-sticker="heart"]').hover();
    await page.getByRole('button', { name: 'Stamp Heart' }).click();
    /** The stamp tool's image: its size and a checksum of its pixels. */
    const stamp = () =>
      page.evaluate(() => {
        const e = (globalThis as any).__reskinSession.engine;
        const s = e.getToolOptions('stamp').stamp;
        let sum = 0;
        if (s) for (let i = 0; i < s.data.length; i++) sum = (sum * 31 + s.data[i]) % 1_000_000_007;
        return { tool: e.toolId, width: s?.width ?? 0, height: s?.height ?? 0, sum };
      });
    await expect.poll(stamp).toMatchObject({ tool: 'stamp' });
    const heart = await stamp();
    // Cropped to the art at the panel's size (46 % of the canvas, plus the outline).
    expect(heart.width).toBeGreaterThan(200);
    expect(heart.width).toBeLessThan(300);

    const at = await docToPage(page, 160, 180);
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await history(page)).labels.at(-1)).toBe('Stamp');
    expect((await layers(page)).map((l) => l.name)).toEqual(['Steam', 'Layer 1']);
    // Centred where the canvas was clicked, in the sticker's colour.
    const placed = await page.evaluate(() => {
      const s = (globalThis as any).__reskinSession.engine.activeLayer.surface;
      const b = s.alphaBounds();
      const x = b.x + b.w / 2;
      const y = b.y + b.h / 2;
      return { x, y, w: b.w, rgb: s.getPixel(Math.floor(x), Math.floor(y)).slice(0, 3) };
    });
    expect(Math.abs(placed.x - 160)).toBeLessThanOrEqual(1);
    expect(Math.abs(placed.y - 180)).toBeLessThanOrEqual(1);
    expect(placed.w).toBe(heart.width);
    expect(placed.rgb[0]).toBeGreaterThan(200);

    // Alt+click and Alt+Enter stamp too (sticker and emoji).
    await page.getByTestId('sticker-search').fill('star');
    await page.locator('[data-sticker="star"]').click({ modifiers: ['Alt'] });
    await expect.poll(async () => (await stamp()).sum).not.toBe(heart.sum);
    expect((await layers(page)).length).toBe(2);
    await page.getByTestId('sticker-search').fill('rocket');
    const rocket = page.getByTestId('emoji').first();
    await rocket.focus();
    await expect(page.getByRole('button', { name: 'Stamp rocket' })).toBeVisible();
    const star = (await stamp()).sum;
    await page.keyboard.press('Alt+Enter');
    await expect.poll(async () => (await stamp()).sum).not.toBe(star);
    expect(await stamp()).toMatchObject({ tool: 'stamp' });
    expect((await layers(page)).length).toBe(2);
  });
});

test.describe('history', () => {
  test('Undo keeps keyboard focus when nothing is left to undo', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('add-layer').click();
    await openTab(page, 'history');
    const undo = page.getByTestId('history-panel').getByRole('button', { name: 'Undo' });
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    // Unavailable now, and still where the keyboard is.
    await expect(undo).toHaveAttribute('aria-disabled', 'true');
    await expect(undo).toBeFocused();
    // Pressing it again does nothing; Redo is the next stop.
    await page.keyboard.press('Enter');
    expect((await history(page)).canRedo).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('history-panel').getByRole('button', { name: 'Redo' })).toBeFocused();
  });

  test('lists every step and jumps back and forth', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('add-layer').click();
    await page.getByTestId('add-layer').click();
    await openTab(page, 'history');
    const rows = page.getByTestId('history-panel').locator('[data-step]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'step');
    await rows.nth(0).click();
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'step');
    // Arrow keys walk the history.
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await layers(page)).length).toBe(2);
    await rows.nth(2).click();
    await expect.poll(async () => (await layers(page)).length).toBe(3);

    await page.getByRole('button', { name: 'Clear history' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear history' }).click();
    await expect(page.getByText('Nothing to undo yet')).toBeVisible();
    expect((await history(page)).labels).toEqual([]);
  });
});

test.describe('previews', () => {
  test('render every export size 1:1 through the export path, plus desktop and taskbars', async ({ page }) => {
    await openEditor(page);
    const sizes = await page.evaluate(() => window.__e2e!.settings.icoSizes);
    const previews = page.getByTestId('previews');
    await expect(previews.locator('li.size.ready')).toHaveCount(sizes.length);
    // The design (not an empty first render) has landed.
    await expect
      .poll(() =>
        previews.locator('canvas[data-size="16"]').evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i]! > 200) opaque++;
          return opaque;
        }),
      )
      .toBeGreaterThan(16 * 16 * 0.3);
    for (const size of sizes) {
      const canvas = previews.locator(`canvas[data-size="${size}"]`);
      const info = await canvas.evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 200) opaque++;
        const r = c.getBoundingClientRect();
        return { w: c.width, h: c.height, cssW: r.width * devicePixelRatio, opaque };
      });
      expect(info.w).toBe(size);
      expect(info.h).toBe(size);
      expect(Math.round(info.cssW)).toBe(size);
      expect(info.opaque).toBeGreaterThan(size * size * 0.3);
    }
    // Same pixels as the export (engine.exportPngs) at 32 px.
    const diff = await page.evaluate(async () => {
      const s = (globalThis as any).__reskinSession;
      const [png] = await s.engine.exportPngs([32]);
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png.png}`)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(32, 32);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const want = ctx.getImageData(0, 0, 32, 32).data;
      const shown = (document.querySelector('canvas[data-size="32"]') as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 32, 32).data;
      let max = 0;
      for (let i = 0; i < want.length; i += 4) {
        if (want[i + 3]! < 32) continue;
        for (let k = 0; k < 4; k++) max = Math.max(max, Math.abs(want[i + k]! - shown[i + k]!));
      }
      return max;
    });
    expect(diff).toBeLessThanOrEqual(3);

    // A design change re-renders the previews (debounced).
    const small = () =>
      previews.locator('canvas[data-size="16"]').evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(8, 8, 1, 1).data));
    const before = await small();
    await page.evaluate(() => {
      const e = (globalThis as any).__reskinSession.engine;
      e.editLayerPixels(e.activeLayer.id, 'Paint', (s: { data: Uint8ClampedArray }) => s.data.fill(255));
    });
    await expect.poll(small).not.toEqual(before);

    await expect(page.getByTestId('desktop-preview')).toBeVisible();
    await expect(page.getByTestId('taskbar-light')).toBeVisible();
    await expect(page.getByTestId('taskbar-dark')).toBeVisible();

    // Collapsible.
    await previews.getByRole('button', { name: 'Previews' }).click();
    await expect(previews.locator('canvas[data-size="16"]')).toHaveCount(0);
    await previews.getByRole('button', { name: 'Previews' }).click();
    await expect(previews.locator('canvas[data-size="16"]')).toHaveCount(1);
  });

  test('a missing wallpaper falls back to the desktop colour', async ({ page }) => {
    await openPage(page, 'editor');
    await page.evaluate(() => window.__e2e!.failNext('wallpaper', 'no wallpaper'));
    await openItem(page);
    await expect(page.getByTestId('desktop-preview')).toBeVisible();
    await expect(page.getByTestId('previews')).toContainText('Your wallpaper could not be read, so the desktop colour is shown.');
  });
});

test.describe('sidebar', () => {
  test('tabs are keyboard operable and bound to the session', async ({ page }) => {
    await openEditor(page);
    const tabs = sidebar(page).getByRole('tab');
    await expect(tabs).toHaveCount(8);
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => (globalThis as any).__reskinSession.sidebarTab)).toBe('color');
    await page.keyboard.press('End');
    await expect.poll(() => page.evaluate(() => (globalThis as any).__reskinSession.sidebarTab)).toBe('history');
    await page.evaluate(() => ((globalThis as any).__reskinSession.sidebarTab = 'styles'));
    await expect(sidebar(page).getByRole('tab', { name: 'Styles' })).toHaveAttribute('aria-selected', 'true');
    // Every tab keeps an accessible name even when only its icon shows.
    for (const name of ['Layers', 'Color', 'Adjust', 'Effects', 'Styles', 'Backdrop', 'Stickers', 'History']) {
      await expect(sidebar(page).getByRole('tab', { name })).toHaveCount(1);
    }
  });

  test('each tab keeps its scroll position, also when switched from elsewhere', async ({ page }) => {
    await openEditor(page);
    await openTab(page, 'adjust');
    await expect(page.getByTestId('adjust-panel')).toBeVisible();
    const scroller = page.getByTestId('panel-adjust');
    await scroller.evaluate((el) => (el.scrollTop = 240));
    const kept = await scroller.evaluate((el) => el.scrollTop);
    expect(kept).toBeGreaterThan(100);
    await openTab(page, 'layers');
    await expect.poll(() => page.getByTestId('panel-layers').evaluate((el) => el.scrollTop)).toBe(0);
    // Switched by code (command palette, other views) rather than a tab click.
    await page.evaluate(() => ((globalThis as any).__reskinSession.sidebarTab = 'adjust'));
    await expect.poll(() => page.getByTestId('panel-adjust').evaluate((el) => el.scrollTop)).toBe(kept);
  });
});

test.describe('lifecycle', () => {
  test('opening and closing the editor again and again leaks no listeners, timers or workers', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page, 'editor');
    const counts = () => page.evaluate(() => (globalThis as any).__reskinProbe());
    /** One open → work in every panel → close, as a user would. */
    async function cycle(): Promise<void> {
      await openItem(page, SAMPLE_PATHS.steam);
      await expect(page.getByTestId('previews').locator('li.size.ready').first()).toBeVisible();
      for (const tab of TABS) {
        await openTab(page, tab);
        if (tab === 'adjust') {
          await page.locator('[data-filter="invert"]').click();
          await expect(page.getByTestId('adjust-editor')).toBeVisible();
          await page.getByTestId('adjust-cancel').click();
        }
        if (tab === 'styles') await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 20_000 });
      }
      await openTab(page, 'layers');
      await simulateClose(page);
    }
    /** Counts once nothing is pending any more (debounces, autosave, idle work). */
    async function settled(): Promise<Record<string, number>> {
      let last = JSON.stringify(await counts());
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(2500);
        const now = JSON.stringify(await counts());
        if (now === last) return JSON.parse(now);
        last = now;
      }
      throw new Error(`the editor never settled: ${last}`);
    }

    await cycle();
    const baseline = await settled();
    // The session's two workers (panels, filters), started on first use.
    expect(baseline.workers).toBe(2);
    expect(baseline.intervals).toBe(0);
    for (let n = 2; n <= 5; n++) await cycle();
    await expect.poll(counts, { timeout: 20_000, intervals: [500] }).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// Visual review (not assertions). RESKIN_SCREENSHOTS=1 refreshes
// e2e/__screenshots__/panels-*.png.
// ---------------------------------------------------------------------------

test.describe('panel gallery', () => {
  test.use({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });

  for (const theme of ['dark', 'light'] as const) {
    test(`every panel (${theme})`, async ({ page }, info) => {
      test.setTimeout(90_000);
      await openEditor(page, { settings: { theme } });
      // Some content to show: an effect, a second layer, a few history steps.
      await page.evaluate(() => {
        const e = (globalThis as any).__reskinSession.engine;
        const icon = e.activeLayer.id;
        e.addLayer({ name: 'Highlights' });
        e.setActiveLayer(icon);
        e.setLayerProps(icon, { effects: [{ type: 'dropShadow', enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.4, angle: 120, distance: 10, blur: 16, spread: 0 }] });
        e.setColor('primary', { r: 124, g: 92, b: 255, a: 1 });
      });
      for (const tab of TABS) {
        await openTab(page, tab);
        if (tab === 'styles') await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 20_000 });
        if (tab === 'adjust' && theme === 'dark') {
          await page.locator('[data-filter="hueSaturation"]').click();
          await expect(page.getByTestId('adjust-editor')).toBeVisible();
        }
        await page.waitForTimeout(400);
        await shoot(sidebar(page), info, `panels-${tab}-${theme}.png`);
        if (tab === 'adjust' && theme === 'dark') await page.getByTestId('adjust-cancel').click();
      }
      await shoot(page, info, `panels-editor-${theme}.png`);
    });
  }
});
