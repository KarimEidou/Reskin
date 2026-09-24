// Command palette (Ctrl+K), global shortcuts and the shortcuts overlay (?).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, SAMPLE_PATHS, simulateOpen, test } from './support/fixtures';

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

type EngineView = {
  selectedToolId: string;
  doc: { layers: unknown[] };
  canUndo: boolean;
};
type SessionView = { hasDesign: boolean; view: string; sidebarTab: string; engine: EngineView };

type Win = { __reskinSession: SessionView };
const toolId = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__reskinSession.engine.selectedToolId);
const layerCount = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__reskinSession.engine.doc.layers.length);
const sidebarTab = (page: Page) => page.evaluate(() => (window as unknown as Win).__reskinSession.sidebarTab);

async function openWithDesign(page: Page): Promise<void> {
  await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
  await page.waitForFunction(() => (window as unknown as { __reskinSession: SessionView }).__reskinSession.hasDesign);
}

const palette = (page: Page) => page.getByTestId('command-palette');
const input = (page: Page) => page.getByRole('combobox', { name: 'Search commands' });

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.RESKIN_SCREENSHOTS !== '1') return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  writeFileSync(join(SHOTS_DIR, name), await page.screenshot());
}

test.describe('command palette', () => {
  test('Ctrl+K opens it with the search focused; Esc closes it', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    // Grouped list when empty.
    await expect(palette(page).getByRole('group', { name: 'Tools' })).toBeVisible();
    await shot(page, 'editor-shell-palette.png');
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    // The title-bar button opens it too.
    await page.getByRole('button', { name: 'Search commands' }).click();
    await expect(palette(page)).toBeVisible();
  });

  test('typing filters, arrows move, Enter runs (switch tool)', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('brush');
    const options = palette(page).getByRole('option');
    await expect(options.first()).toContainText('Brush tool');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    // The highlighted characters are marked.
    await expect(options.first().locator('mark').first()).toHaveText('Brush');
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    expect(await toolId(page)).toBe('brush');

    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('tool');
    const count = await options.count();
    expect(count).toBeGreaterThan(5);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input(page)).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(options.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  });

  test('Enter on a view command navigates', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('librar');
    await expect(palette(page).getByRole('option').first()).toContainText('Go to Library');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('library-view')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Library' }).first()).toHaveAttribute('aria-current', 'page');
  });

  test('clicking an option runs it; no match shows a message', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('zzqqxx');
    await expect(palette(page).getByRole('status')).toHaveText(/No commands match/);
    await input(page).fill('effects panel');
    await palette(page).getByRole('option', { name: /Show Effects panel/ }).click();
    await expect(palette(page)).toBeHidden();
    expect(await sidebarTab(page)).toBe('effects');
  });

  test('selection commands: select layer pixels, then Grow selection… asks for the amount with any tool', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    const selected = (x: number, y: number) =>
      page.evaluate(
        ([px, py]) => {
          const m = (window as unknown as { __reskinSession: { engine: { doc: { selection: { width: number; data: Uint8Array } | null } } } })
            .__reskinSession.engine.doc.selection;
          return m ? m.data[py! * m.width + px!] : null;
        },
        [x, y] as const,
      );
    // Refining needs a selection: not offered yet.
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('grow selection');
    await expect(palette(page).getByRole('option', { name: /Grow selection/ })).toHaveCount(0);
    await input(page).fill('layer pixels');
    await expect(palette(page).getByRole('option').first()).toContainText('Select layer pixels');
    await page.keyboard.press('Enter');
    // The tile of the icon is selected, its transparent margin is not (its soft shadow barely).
    expect([await selected(256, 256), await selected(5, 250)]).toEqual([255, 0]);
    expect(await selected(34, 250)).toBeLessThan(128);

    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('grow');
    await expect(palette(page).getByRole('option').first()).toContainText('Grow selection…');
    await page.keyboard.press('Enter');
    const prompt = page.getByRole('dialog', { name: 'Grow selection' });
    await expect(prompt).toBeVisible();
    expect(await toolId(page)).toBe('brush');
    await prompt.getByRole('slider', { name: 'Grow by' }).fill('10');
    await prompt.getByRole('button', { name: 'Grow' }).click();
    await expect(prompt).toHaveCount(0);
    expect(await selected(34, 250)).toBe(255);
  });

  test('only commands that apply right now are listed', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.keyboard.press('Control+k');
    await expect(palette(page).getByRole('option', { name: /Brush tool/ })).toHaveCount(0);
    await expect(palette(page).getByRole('option', { name: /Open image or shortcut/ })).toHaveCount(1);
    await expect(palette(page).getByRole('option', { name: /Go to Start page/ })).toHaveCount(0);
  });
});

test.describe('global shortcuts', () => {
  test('tool keys, undo and redo', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('e');
    expect(await toolId(page)).toBe('eraser');
    await page.keyboard.press('Shift+G');
    expect(await toolId(page)).toBe('gradient');
    await page.keyboard.press('g');
    expect(await toolId(page)).toBe('fill');

    const before = await layerCount(page);
    await page.keyboard.press('Control+Shift+N');
    expect(await layerCount(page)).toBe(before + 1);
    await page.keyboard.press('Control+z');
    expect(await layerCount(page)).toBe(before);
    await page.keyboard.press('Control+y');
    expect(await layerCount(page)).toBe(before + 1);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+Z');
    expect(await layerCount(page)).toBe(before + 1);
  });

  test('shortcuts stay out of text fields', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('b');
    // Save through the palette shortcut; the Library lists it.
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: 'Library' }).first().click();
    const filter = page.getByPlaceholder('Filter');
    await expect(filter).toBeVisible();
    await filter.click();
    await page.keyboard.type('pe');
    await expect(filter).toHaveValue('pe');
    expect(await toolId(page)).toBe('brush');
  });

  test('tool keys and undo only act in the Edit view', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+Shift+N');
    const layers = await layerCount(page);
    await page.getByRole('button', { name: 'History' }).first().click();
    await expect(page.getByTestId('history-view')).toBeVisible();
    await page.locator('body').click({ position: { x: 600, y: 400 } });
    await page.keyboard.press('e');
    await page.keyboard.press('Control+z');
    // Nothing changed out of sight, and the page stayed put.
    expect(await toolId(page)).not.toBe('eraser');
    expect(await layerCount(page)).toBe(layers);
    await expect(page.getByTestId('history-view')).toBeVisible();
    // Back in Edit they work.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.keyboard.press('e');
    expect(await toolId(page)).toBe('eraser');
  });

  test('Ctrl+N asks before dropping unsaved edits', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+Shift+N');
    const layers = await layerCount(page);
    await page.keyboard.press('Control+n');
    const confirm = page.getByRole('dialog', { name: 'Start a blank icon?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(await layerCount(page)).toBe(layers);
    await page.keyboard.press('Control+n');
    await confirm.getByRole('button', { name: 'Start blank' }).click();
    await expect(confirm).toBeHidden();
    // A fresh blank document (for the queued item) replaced the edited one.
    await expect.poll(() => layerCount(page)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __reskinSession: { engine: { canUndo: boolean } } }).__reskinSession.engine.canUndo)).toBe(false);
  });

  test('Ctrl+, opens Settings', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings-view')).toBeVisible();
  });
});

test.describe('shortcuts overlay', () => {
  test('? opens the keyboard map', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('?');
    const overlay = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('region', { name: 'Tools' })).toContainText('Brush tool');
    await expect(overlay.getByRole('region', { name: 'Tools' })).toContainText('Next tool of the group');
    await expect(overlay.getByRole('region', { name: 'Canvas' })).toContainText('Toggle keyline guides');
    await expect(overlay.getByRole('region', { name: 'Edit' })).toContainText('Swap primary and secondary colours');
    await expect(overlay).toContainText('Pan the canvas');
    await expect(overlay).toContainText('Remove the last lasso corner');
    await shot(page, 'editor-shell-shortcuts.png');
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    // Escape went to the overlay, not to closing the editor.
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__e2e!.callsOf('editor_close').length)).toBe(0);
  });
});
