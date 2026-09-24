// The editor sidebar panels, driven through their UI in the panels harness
// (src/editor/panels/dev: the real session, engine and Sidebar against the
// fake backend, served by the Vite dev server in e2e mode). Also renders
// every panel in both themes for visual review.

import type { Page } from '@playwright/test';
import { acquireHarness, releaseHarness } from '../src/editor/panels/dev/server';
import { compositeHash, history, layerHash, layers, openHarness, openTab, shoot, sidebar } from '../src/editor/panels/dev/driver';
import type { SidebarTab } from '../src/editor/state/session.svelte';
import { expect, test } from './support/fixtures';

let url = '';

test.beforeAll(async () => {
  url = await acquireHarness();
});

test.afterAll(async () => {
  await releaseHarness();
});

function row(page: Page, name: string) {
  return page.getByTestId('layer-row').filter({ hasText: name });
}

test.describe('layers', () => {
  test('add, rename, reorder by drag, visibility and opacity', async ({ page }) => {
    await openHarness(page, url);
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
    await openHarness(page, url);
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
    await openHarness(page, url);
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
});

test.describe('color', () => {
  test('the picker, hex entry and swatches set the engine colours; commits are remembered', async ({ page }) => {
    await openHarness(page, url);
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
    await openHarness(page, url);
    await openTab(page, 'adjust');
    const before = await layerHash(page);
    await page.locator('[data-filter="invert"]').click();
    await expect(page.getByTestId('adjust-editor')).toBeVisible();
    await expect.poll(() => layerHash(page)).not.toBe(before);
    return before;
  }

  test('a live preview, Apply keeps it as one step, Ctrl+Z restores exactly', async ({ page }) => {
    const before = await startInvert(page);
    expect((await history(page)).labels).toEqual(['Invert']);
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

  test('Cancel restores the layer byte for byte and leaves no history', async ({ page }) => {
    await openHarness(page, url);
    await openTab(page, 'adjust');
    const before = await layerHash(page);
    await page.locator('[data-filter="hueSaturation"]').click();
    const hue = page.getByTestId('adjust-editor').getByRole('slider', { name: 'Hue' });
    await hue.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageUp');
    await expect.poll(() => layerHash(page)).not.toBe(before);
    expect((await history(page)).labels).toEqual(['Hue / Saturation']);
    await page.getByTestId('adjust-cancel').click();
    await expect.poll(() => layerHash(page)).toBe(before);
    expect(await history(page)).toEqual({ labels: [], index: 0, canRedo: false });
  });

  test('Reset returns to the defaults; icon helpers preview too', async ({ page }) => {
    await openHarness(page, url);
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

test.describe('effects', () => {
  test('add, toggle and remove layer effects', async ({ page }) => {
    await openHarness(page, url);
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

    // Disable the shadow, then remove both.
    await page.getByTestId('effect-card').first().getByRole('switch').click();
    expect(await page.evaluate(() => (globalThis as any).__reskinSession.engine.activeLayer.effects[0].enabled)).toBe(false);
    await page.getByTestId('remove-effect').first().click();
    await page.getByTestId('remove-effect').first().click();
    await expect(page.getByTestId('effect-card')).toHaveCount(0);
    await expect.poll(() => compositeHash(page)).toBe(plain);
  });
});

test.describe('backdrop', () => {
  test('adds a bottom layer, then updates it', async ({ page }) => {
    await openHarness(page, url);
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
});

test.describe('stickers', () => {
  test('adds a sticker as a new centred layer and selects the move tool', async ({ page }) => {
    await openHarness(page, url);
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
});

test.describe('history', () => {
  test('lists every step and jumps back and forth', async ({ page }) => {
    await openHarness(page, url);
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
    await openHarness(page, url);
    const sizes = await page.evaluate(() => window.__e2e!.settings.icoSizes);
    const previews = page.getByTestId('previews');
    await expect(previews.locator('li.size.ready')).toHaveCount(sizes.length);
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
    await openHarness(page, url);
    await page.evaluate(() => window.__e2e!.failNext('wallpaper', 'no wallpaper'));
    await page.reload();
    await expect(page.locator('main[data-ready="true"]')).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId('desktop-preview')).toBeVisible();
  });
});

test.describe('sidebar', () => {
  test('tabs are keyboard operable and bound to the session', async ({ page }) => {
    await openHarness(page, url);
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
});

// ---------------------------------------------------------------------------
// Visual review (not assertions). RESKIN_SCREENSHOTS=1 refreshes
// e2e/__screenshots__/panels-*.png.
// ---------------------------------------------------------------------------

const TABS: SidebarTab[] = ['layers', 'color', 'adjust', 'effects', 'styles', 'backdrop', 'stickers', 'history'];

test.describe('panel gallery', () => {
  test.use({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });

  for (const theme of ['dark', 'light'] as const) {
    test(`every panel (${theme})`, async ({ page }, info) => {
      test.setTimeout(90_000);
      await openHarness(page, url, { settings: { theme } });
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
