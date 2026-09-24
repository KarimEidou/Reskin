// The Styles panel in the real editor: twelve presets rendered live from
// the item's icon, applied as one undoable step and recorded for "Apply
// style to all". Also captures the grid and several applied presets for
// visual review.

import { canvas, compositeHash, history, layers, openEditor, openTab, shoot, sidebar } from './panels-driver';
import { expect, test } from './support/fixtures';

const tiles = (page: import('@playwright/test').Page) => page.getByTestId('preset-tile');

/**
 * A look is built in the panels worker after the request that is running
 * there (right after the tab opens: the thumbnails); on a busy machine that
 * takes longer than the default expect timeout.
 */
const BUILT = { timeout: 15_000 };

test('the grid shows twelve live thumbnails of the icon', async ({ page }) => {
  await openEditor(page);
  await openTab(page, 'styles');
  await expect(tiles(page)).toHaveCount(12);
  await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 20_000 });
  const labels = await tiles(page).locator('.label').allTextContents();
  expect(labels).toEqual(['Glass', 'Neon', 'Mono Light', 'Mono Dark', 'Pastel', 'Retro Pixel', 'Sticker', 'Clay', 'Gradient', 'Fluent', 'Duotone', 'Sketch']);
  // Every thumbnail has content, and they differ from each other.
  const sums = await tiles(page).locator('canvas').evaluateAll((list) =>
    (list as HTMLCanvasElement[]).map((c) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 7) s = (s + d[i]! * (i % 13)) % 1_000_003;
      return s;
    }),
  );
  expect(sums).toHaveLength(12);
  expect(new Set(sums).size).toBe(12);
});

test('applying a preset is one undo step and becomes the batch recipe', async ({ page }) => {
  await openEditor(page);
  await openTab(page, 'styles');
  const before = await compositeHash(page);
  const names = (await layers(page)).map((l) => l.name);
  await page.locator('[data-preset="neon"]').click();
  await expect(page.locator('[data-preset="neon"]')).toHaveAttribute('aria-pressed', 'true', BUILT);
  await expect.poll(() => compositeHash(page)).not.toBe(before);
  expect((await history(page)).labels).toEqual(['Style: Neon']);
  expect((await layers(page)).map((l) => l.name)).toEqual(['Backdrop', 'Neon fill', 'Neon']);
  expect(await page.evaluate(() => (globalThis as any).__reskinSession.recipe?.label)).toBe('Neon');

  // Tuning re-styles the applied look in place (still one step).
  await page.getByRole('switch', { name: 'Match the icon’s colour' }).click();
  const hue = page.getByTestId('preset-hue');
  await hue.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('PageUp');
  const neon = await compositeHash(page);
  await expect.poll(() => compositeHash(page), { timeout: 10_000 }).not.toBe(neon);
  expect((await history(page)).labels).toEqual(['Style: Neon']);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => compositeHash(page)).toBe(before);
  expect((await layers(page)).map((l) => l.name)).toEqual(names);
  await expect(page.locator('[data-preset="neon"]')).toHaveAttribute('aria-pressed', 'false');
});

test('after a tab switch the applied look is still marked and re-styles in place', async ({ page }) => {
  await openEditor(page);
  await openTab(page, 'styles');
  await page.locator('[data-preset="clay"]').click();
  await expect(page.locator('[data-preset="clay"]')).toHaveAttribute('aria-pressed', 'true', BUILT);
  await openTab(page, 'layers');
  await openTab(page, 'styles');
  await expect(page.locator('[data-preset="clay"]')).toHaveAttribute('aria-pressed', 'true');
  const clay = await compositeHash(page);
  const intensity = page.getByTestId('styles-panel').getByRole('slider', { name: 'Depth' });
  await intensity.focus();
  await page.keyboard.press('PageUp');
  await expect.poll(() => compositeHash(page), { timeout: 10_000 }).not.toBe(clay);
  expect((await history(page)).labels).toEqual(['Style: Clay']);
  await expect(page.locator('[data-preset="clay"]')).toHaveAttribute('aria-pressed', 'true');
});

test('the recipe replays on another icon ("Apply style to all")', async ({ page }) => {
  await openEditor(page);
  await openTab(page, 'styles');
  await page.locator('[data-preset="sticker"]').click();
  await expect.poll(() => history(page).then((h) => h.labels.length), BUILT).toBe(1);
  const replayed = await page.evaluate(async () => {
    const s = (globalThis as any).__reskinSession;
    const Engine = s.engine.constructor;
    const scratch = new Engine();
    const icon = s.engine.getLayer(s.engine.doc.layers.find((l: any) => l.name === 'Icon').id);
    const id = scratch.importImage(icon.surface, 'Other', { padding: 0 });
    scratch.deleteLayer(scratch.doc.layers[0].id);
    await s.recipe.apply(scratch, id);
    return scratch.doc.layers.map((l: any) => l.name);
  });
  expect(replayed).toEqual(['Backdrop', 'Icon', 'Sheen']);
});

test.describe('preset gallery', () => {
  test.use({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });

  for (const theme of ['dark', 'light'] as const) {
    test(`grid and applied looks (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await openEditor(page, { settings: { theme } });
      await openTab(page, 'styles');
      await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 20_000 });
      await shoot(sidebar(page), info, `panels-styles-grid-${theme}.png`);
      if (theme === 'light') return;
      for (const id of ['glass', 'neon', 'clay', 'sticker', 'pastel', 'retroPixel', 'duotone', 'sketch']) {
        const before = await compositeHash(page);
        await page.locator(`[data-preset="${id}"]`).click();
        await expect.poll(() => compositeHash(page), { timeout: 15_000 }).not.toBe(before);
        await expect(page.locator(`[data-preset="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
        await page.waitForTimeout(300);
        await shoot(canvas(page), info, `panels-preset-${id}.png`);
      }
    });
  }

  test('presets on other kinds of icon', async ({ page }, info) => {
    test.setTimeout(120_000);
    for (const [item, name] of [
      ['C:\\Users\\e2e\\Desktop\\Projects\\', 'folder'],
      ['C:\\Users\\e2e\\Desktop\\Docs Portal.url', 'site'],
    ] as const) {
      await openEditor(page, {}, item);
      await openTab(page, 'styles');
      await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 20_000 });
      await shoot(page.getByTestId('styles-panel').locator('[role="list"]'), info, `panels-styles-${name}.png`);
    }
  });
});
