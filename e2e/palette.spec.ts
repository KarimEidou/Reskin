// Command palette (Ctrl+K), global shortcuts and the shortcuts overlay (?).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, SAMPLE_PATHS, simulateOpen, test, waitForCall } from './support/fixtures';

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
    // No Selection menu with the brush: the keyboard continues on the canvas.
    await expect(page.getByTestId('canvas')).toBeFocused();
  });

  test('Ctrl+K right after a command ran opens the palette for good, its search focused', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('layer pixels');
    await expect(palette(page).getByRole('option').first()).toContainText('Select layer pixels');
    // Enter runs the command and closes the palette; the dialog's close
    // event is only queued then. Ctrl+K comes before it is dispatched (input
    // runs first on a busy page): the late event must not close the new one.
    await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>('[data-testid="command-palette"]')!;
      const field = dialog.querySelector('input')!;
      const reopen = new MutationObserver(() => {
        if (dialog.open) return;
        reopen.disconnect();
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }),
        );
      });
      reopen.observe(dialog, { attributes: true, attributeFilter: ['open'] });
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await page.waitForTimeout(300);
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue('');
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

test.describe('every adjustment, style and setting', () => {
  test('a filter found by name opens in the Adjust panel', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('sepia');
    await expect(palette(page).getByRole('option').first()).toContainText('Sepia…');
    await page.keyboard.press('Enter');
    const editor = page.getByTestId('adjust-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading', { name: 'Sepia' })).toBeVisible();
    expect(await sidebarTab(page)).toBe('adjust');
  });

  test('a style found by name is applied from the Styles panel', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('clay');
    await expect(palette(page).getByRole('option').first()).toContainText('Clay style');
    await page.keyboard.press('Enter');
    expect(await sidebarTab(page)).toBe('styles');
    // Built in the panels worker behind the thumbnails: give it time.
    await expect(page.locator('[data-preset="clay"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    const labels = await page.evaluate(() =>
      ((window as unknown as { __reskinSession: { engine: { historyEntries: Array<{ label: string }> } } }).__reskinSession.engine.historyEntries).map(
        (e) => e.label,
      ),
    );
    expect(labels).toEqual(['Style: Clay']);
  });

  test('the switches of Settings are commands too', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('low-memory');
    await expect(palette(page).getByRole('option').first()).toContainText('Turn on low-memory mode');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__e2e!.settings.lowMemory)).toBe(true);
    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('low-memory');
    await expect(palette(page).getByRole('option').first()).toContainText('Turn off low-memory mode');
  });

  test('Open project… reopens a saved .reskin design', async ({ openEditor, page }) => {
    await openEditor();
    await openWithDesign(page);
    // A project with a layer the opened icon does not have.
    await page.evaluate(async (path) => {
      type Engine = { addLayer(o: { name: string }): string | null; serialize(): Promise<string>; undo(): boolean };
      const engine = (window as unknown as { __reskinSession: { engine: Engine } }).__reskinSession.engine;
      engine.addLayer({ name: 'From the project' });
      window.__e2e!.setProject(path, await engine.serialize());
      window.__e2e!.setPickFiles([path]);
      engine.undo();
    }, SAMPLE_PATHS.project);
    const names = () =>
      page.evaluate(() =>
        ((window as unknown as { __reskinSession: { engine: { doc: { layers: Array<{ name: string }> } } } }).__reskinSession.engine.doc.layers).map((l) => l.name),
      );
    expect(await names()).not.toContain('From the project');

    await page.keyboard.press('Control+k');
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('open project');
    await expect(palette(page).getByRole('option').first()).toContainText('Open project (.reskin)…');
    await page.keyboard.press('Enter');
    await waitForCall(page, 'pick_files', { purpose: 'project' });
    await expect.poll(names).toContain('From the project');
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
    await expect(overlay.getByRole('region', { name: 'Canvas' })).toContainText('Clear the selection (the layer without one)');
    await shot(page, 'editor-shell-shortcuts.png');
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    // Escape went to the overlay, not to closing the editor.
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__e2e!.callsOf('editor_close').length)).toBe(0);
  });
});
