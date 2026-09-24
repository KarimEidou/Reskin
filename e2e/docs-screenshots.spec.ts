// The README's screenshots (docs/screenshots/*.png), made from the real
// pages of the e2e build against the fake backend. They only run with
// RESKIN_DOCS_SCREENSHOTS=1 — `pnpm docs:screenshots` — and are skipped by
// the normal e2e run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { EditorSession } from '../src/editor/state/session.svelte';
import type { BoxSkin } from '../src/lib/ipc/types';
import { canvas, compositeHash, openTab, sidebar } from './panels-driver';
import { BoxDriver, expect, openPage, SAMPLE_PATHS, simulateOpen, test } from './support/fixtures';

test.skip(process.env.RESKIN_DOCS_SCREENSHOTS !== '1', 'refresh the README screenshots with `pnpm docs:screenshots`');

type Win = { __reskinSession: EditorSession };

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');

/** A Windows-11-like desktop: deep blue with soft violet, blue and cyan blooms. */
const WALLPAPER = [
  'radial-gradient(60% 90% at 12% 18%, rgb(124 92 255 / 0.55), transparent 70%)',
  'radial-gradient(55% 80% at 88% 90%, rgb(31 200 227 / 0.4), transparent 70%)',
  'radial-gradient(70% 110% at 55% 60%, rgb(79 125 255 / 0.55), transparent 75%)',
  'linear-gradient(160deg, #0d1640 0%, #0a1030 55%, #070b1f 100%)',
].join(', ');

/**
 * CSS painting the wallpaper behind the page as a fixed `selector::before`
 * layer, softened: a blurred gradient compresses far better than
 * Chromium's dithered one and looks the same.
 */
function desktop(selector: string): string {
  return `${selector}::before { content: ''; position: fixed; inset: -48px; z-index: -1; background: ${WALLPAPER}; filter: blur(24px); }`;
}

/** PNG row filters (-1: the best per row) and deflate strategies (0 default, 1 filtered) worth trying. */
const ENCODINGS = [-1, 1, 4].flatMap((filterType) => [0, 1].map((deflateStrategy) => ({ filterType, deflateStrategy })));

/**
 * Writes an opaque screenshot as a compact PNG: RGB (no alpha channel),
 * maximum deflate, with whichever filter and strategy compress it best.
 */
function save(name: string, png: Buffer): void {
  const image = PNG.sync.read(png);
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) throw new Error(`${name} has transparent pixels; paint a background behind it`);
  }
  const smallest = ENCODINGS.map((e) => PNG.sync.write(image, { colorType: 2, deflateLevel: 9, ...e })).reduce((a, b) =>
    b.length < a.length ? b : a,
  );
  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(join(DOCS_DIR, name), smallest);
}

/** Waits until nothing animates (entrances, previews and transitions settled). */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), {
      timeout: 10_000,
    })
    .toBe(0);
  await page.waitForTimeout(300);
}

test.describe('box skins', () => {
  test.use({ deviceScaleFactor: 2 });

  const SKINS: ReadonlyArray<{ skin: BoxSkin; label: string }> = [
    { skin: 'glass', label: 'Glass' },
    { skin: 'neon', label: 'Neon' },
    { skin: 'minimal', label: 'Minimal' },
    { skin: 'aurora', label: 'Aurora' },
  ];

  test('box-skins.png', async ({ context, page }) => {
    // Each skin in its own box page, captured without a background (the
    // box window is transparent), then laid out on one wallpaper.
    const boxes: string[] = [];
    for (const { skin } of SKINS) {
      const boxPage = await context.newPage();
      // Like the `pageErrors` fixture does for `page`.
      const errors: string[] = [];
      boxPage.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
      const box = await BoxDriver.open(boxPage, { settings: { boxSkin: skin, theme: 'dark' } });
      await expect(box.visual).toHaveAttribute('data-skin', skin);
      await box.expectStatic();
      const png = await box.root.screenshot({ omitBackground: true });
      boxes.push(`data:image/png;base64,${png.toString('base64')}`);
      await boxPage.close();
      expect(errors, `uncaught errors on the ${skin} box page`).toEqual([]);
    }

    await page.setViewportSize({ width: 720, height: 240 });
    await page.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; height: 100%; }
        html { background: #0a1030; }
        ${desktop('html')}
        body {
          display: flex;
          align-items: center;
          justify-content: space-evenly;
          padding: 0 12px;
          box-sizing: border-box;
          font: 12px/1 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
          letter-spacing: 0.03em;
          color: rgb(255 255 255 / 0.86);
        }
        figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
        img { width: 148px; height: 148px; display: block; }
        figcaption { margin-top: 2px; text-shadow: 0 1px 2px rgb(0 0 0 / 0.35); }
      </style>
      ${SKINS.map((s, i) => `<figure><img alt="" src="${boxes[i]}"><figcaption>${s.label}</figcaption></figure>`).join('')}`);
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    save('box-skins.png', await page.screenshot());
  });
});

test.describe('editor', () => {
  // The medium editor window (1080 × 720), rendered at 1.6× for a crisp,
  // still compact picture.
  test.use({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1.6 });

  test('editor.png', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page, 'editor', { settings: { theme: 'dark' } });
    // Three shortcuts in the queue; Steam open in the Neon style, with a
    // matching brush colour picked.
    await simulateOpen(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    await page.waitForFunction(() => (globalThis as unknown as Partial<Win>).__reskinSession?.hasDesign === true);
    await expect(sidebar(page)).toBeVisible();
    await expect(canvas(page)).toBeVisible();
    await page.evaluate(() => {
      (globalThis as unknown as Win).__reskinSession.engine.setColor('primary', { r: 56, g: 189, b: 248, a: 1 });
    });

    await openTab(page, 'styles');
    await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 30_000 });
    const before = await compositeHash(page);
    const neon = page.locator('[data-preset="neon"]');
    await neon.click();
    await expect.poll(() => compositeHash(page), { timeout: 30_000 }).not.toBe(before);
    await expect(neon).toHaveAttribute('aria-pressed', 'true');
    // The click scrolled the tile into view; show the panel from its top.
    await page.getByTestId('panel-styles').evaluate((panel) => panel.scrollTo(0, 0));

    // The desktop behind the transparent window.
    await page.addStyleTag({ content: desktop('html') });
    await settle(page);
    await expect(page.locator('.toasts').locator('[role="alert"], [role="status"]').locator(':scope > *')).toHaveCount(0);
    save('editor.png', await page.screenshot({ animations: 'disabled' }));
  });
});
