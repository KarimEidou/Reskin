// Work that finishes after the user switched items (a backdrop render, a
// sticker) — or that was started while the switch was half-way — never
// lands on a design being put away or on the one that opened, and the
// Stickers panel feeds the stamp tool while it is the selected tool.

import type { Page } from '@playwright/test';
import { layers, openTab, sidebar } from './panels-driver';
import { expect, openPage, SAMPLE_PATHS, simulateOpen, test } from './support/fixtures';

/** The session as the specs reach it (globalThis.__reskinSession). */
type Session = {
  currentIndex: number;
  engine: {
    doc: { layers: { name: string }[]; meta: { name: string } };
    setTool(id: string): void;
    selectedToolId: string;
    getToolOptions(id: 'stamp'): { stamp: { data: Uint8ClampedArray } | null };
  };
  filters: { backdrop(...args: unknown[]): Promise<unknown> };
  panels: { request(req: { op: string }): Promise<unknown> };
};
type Invoke = (cmd: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
type Scope = {
  __reskinSession: Session;
  __TAURI_INTERNALS__: { invoke: Invoke };
  /** Lets the held result go. */
  release: () => void;
  /** Lets the held item_frames calls go. */
  releaseFrames: () => void;
  /** The design open before the switch. */
  before: Session['engine']['doc'];
  /** A render of the kind being watched finished (see watchRenders). */
  rendered: boolean;
};

async function openQueue(page: Page): Promise<void> {
  await openPage(page, 'editor');
  await simulateOpen(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes]);
  await page.waitForFunction(() => (globalThis as unknown as { __reskinSession?: { hasDesign: boolean } }).__reskinSession?.hasDesign === true);
  await expect(sidebar(page)).toBeVisible();
}

/**
 * Holds `item_frames` (the next item's icon) until released, and keeps the
 * open design: a switch then stops half-way — Steam's design put away,
 * Notes' not loaded yet.
 */
function holdSwitch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const g = globalThis as unknown as Scope;
    const inner = g.__TAURI_INTERNALS__.invoke;
    const gate = new Promise<void>((r) => (g.releaseFrames = r));
    g.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => (cmd === 'item_frames' ? gate.then(() => inner(cmd, args, opts)) : inner(cmd, args, opts));
    g.before = g.__reskinSession.engine.doc;
  });
}

/** Switches to Notes and waits until Steam is put away (Notes still loading). */
async function switchHalfway(page: Page): Promise<void> {
  await page.getByTestId('queue-item').nth(1).click();
  await page.waitForFunction(() => (globalThis as unknown as Scope).__reskinSession.currentIndex === 1);
  expect(await page.evaluate(() => (globalThis as unknown as Scope).__reskinSession.engine.doc === (globalThis as unknown as Scope).before)).toBe(true);
}

const beforeLayers = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Scope).before.layers.map((l) => l.name));

/** Finishes the switch, then checks both designs: neither got the late result. */
async function finishAndCheck(page: Page): Promise<void> {
  // Not on the design being put away…
  expect(await beforeLayers(page)).toEqual(['Steam']);
  await page.evaluate(() => (globalThis as unknown as Scope).releaseFrames());
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as Scope).__reskinSession.engine.doc.meta.name)).toBe('Notes');
  // …nor on the one that opened; and Steam's own design is as it was.
  expect((await layers(page)).map((l) => l.name)).toEqual(['Notes']);
  await page.getByTestId('queue-item').nth(0).click();
  await expect.poll(async () => (await layers(page)).map((l) => l.name)).toEqual(['Steam']);
}

/** Notes when a backdrop apply or a sticker render has finished (sets `rendered`). */
function watchRenders(page: Page): Promise<void> {
  return page.evaluate(() => {
    const g = globalThis as unknown as Scope;
    g.rendered = false;
    const { filters, panels } = g.__reskinSession;
    const render = filters.backdrop.bind(filters);
    const request = panels.request.bind(panels);
    filters.backdrop = (...args: unknown[]) =>
      render(...args).finally(() => (g.rendered = (args[2] as { channel?: string } | undefined)?.channel === 'backdrop-apply' || g.rendered));
    panels.request = (req) => request(req).finally(() => (g.rendered = req.op === 'sticker' || g.rendered));
  });
}

test.describe('switching items while a panel works', () => {
  test('a backdrop that renders past the switch is dropped', async ({ page }) => {
    await openQueue(page);
    await openTab(page, 'backdrop');
    await page.evaluate(() => {
      const g = globalThis as unknown as Scope;
      const filters = g.__reskinSession.filters;
      const render = filters.backdrop.bind(filters);
      const gate = new Promise<void>((r) => (g.release = r));
      filters.backdrop = (...args: unknown[]) =>
        (args[2] as { channel?: string } | undefined)?.channel === 'backdrop-apply' ? gate.then(() => render(...args)) : render(...args);
    });
    await holdSwitch(page);
    const button = page.getByTestId('apply-backdrop');
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await switchHalfway(page);
    await page.evaluate(() => (globalThis as unknown as Scope).release());
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await finishAndCheck(page);
  });

  test('a sticker that renders past the switch is dropped', async ({ page }) => {
    await openQueue(page);
    await openTab(page, 'stickers');
    await page.getByTestId('sticker-search').fill('love');
    await page.evaluate(() => {
      const g = globalThis as unknown as Scope;
      const panels = g.__reskinSession.panels;
      const request = panels.request.bind(panels);
      const gate = new Promise<void>((r) => (g.release = r));
      panels.request = (req) => (req.op === 'sticker' ? gate.then(() => request(req)) : request(req));
    });
    await holdSwitch(page);
    const heart = page.locator('[data-sticker="heart"]');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-busy', 'true');
    await switchHalfway(page);
    await page.evaluate(() => (globalThis as unknown as Scope).release());
    await expect(heart).toHaveAttribute('aria-busy', 'false');
    await finishAndCheck(page);
  });
});

test.describe('a panel used while the switch is half-way', () => {
  test('a backdrop applied then lands on neither design', async ({ page }) => {
    await openQueue(page);
    await openTab(page, 'backdrop');
    await holdSwitch(page);
    await switchHalfway(page);
    await watchRenders(page);
    const button = page.getByTestId('apply-backdrop');
    await button.click();
    await page.waitForFunction(() => (globalThis as unknown as Scope).rendered);
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await finishAndCheck(page);
  });

  test('a sticker added then lands on neither design', async ({ page }) => {
    await openQueue(page);
    await openTab(page, 'stickers');
    await page.getByTestId('sticker-search').fill('love');
    await holdSwitch(page);
    await switchHalfway(page);
    await watchRenders(page);
    const heart = page.locator('[data-sticker="heart"]');
    await heart.click();
    await page.waitForFunction(() => (globalThis as unknown as Scope).rendered);
    await expect(heart).toHaveAttribute('aria-busy', 'false');
    await finishAndCheck(page);
  });
});

test.describe('stickers panel', () => {
  /** A checksum of the stamp tool's image (0: none). */
  const stamp = (page: Page) =>
    page.evaluate(() => {
      const s = (globalThis as unknown as Scope).__reskinSession.engine.getToolOptions('stamp').stamp;
      let sum = 0;
      if (s) for (let i = 0; i < s.data.length; i++) sum = (sum * 31 + s.data[i]!) % 1_000_000_007;
      return sum;
    });

  test('with the stamp tool selected, a click loads a sticker or an emoji into the stamp', async ({ page }) => {
    await openQueue(page);
    await openTab(page, 'stickers');
    await page.evaluate(() => (globalThis as unknown as Scope).__reskinSession.engine.setTool('stamp'));
    const count = (await layers(page)).length;
    await page.getByTestId('sticker-search').fill('love');
    const heart = page.locator('[data-sticker="heart"]');
    await expect(heart).toHaveAccessibleName('Use Heart as the stamp');
    await expect(heart).toHaveAttribute('title', 'Heart — click to stamp');
    await heart.click();
    await expect.poll(() => stamp(page)).not.toBe(0);
    const hearts = await stamp(page);
    await page.getByTestId('sticker-search').fill('rocket');
    const rocket = page.getByTestId('emoji').first();
    await expect(rocket).toHaveAccessibleName('Use rocket as the stamp');
    await rocket.click();
    await expect.poll(() => stamp(page)).not.toBe(hearts);
    // Nothing was added; the stamp tool stays selected.
    expect((await layers(page)).length).toBe(count);
    expect(await page.evaluate(() => (globalThis as unknown as Scope).__reskinSession.engine.selectedToolId)).toBe('stamp');

    // With another tool, a click adds a layer again.
    await page.evaluate(() => (globalThis as unknown as Scope).__reskinSession.engine.setTool('brush'));
    await page.getByTestId('sticker-search').fill('love');
    await expect(heart).toHaveAccessibleName('Add Heart sticker');
    await heart.click();
    await expect.poll(async () => (await layers(page)).length).toBe(count + 1);
  });
});
