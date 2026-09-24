// What changes while the pages live on: Windows settings (accent colour,
// animation effects, a hotkey another app took) picked up when a window
// gains focus, and Settings › About's open-source licenses.

import type { Page } from '@playwright/test';
import { calls, expect, simulateOpen, test, waitForCall } from './support/fixtures';

type Invoke = (cmd: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
type Win = { __TAURI_INTERNALS__: { invoke: Invoke }; __windowsNow?: Record<string, unknown> };

/**
 * Windows changed something: from now on app_boot reports `now` on top of
 * what the fake backend says (as Rust reads it live).
 */
async function windowsChanges(page: Page, now: Record<string, unknown>): Promise<void> {
  await page.evaluate((patch) => {
    const w = window as unknown as Win;
    if (!w.__windowsNow) {
      const inner = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (cmd, args, opts) => {
        const result = await inner(cmd, args, opts);
        return cmd === 'app_boot' ? { ...(result as object), ...w.__windowsNow } : result;
      };
    }
    w.__windowsNow = { ...w.__windowsNow, ...patch };
  }, now);
}

const focusWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const accentBase = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-base'));

const TAKEN = 'Ctrl+Alt+Shift+R is already in use by another app';

test.describe('Windows changes while a page lives on', () => {
  test('the editor follows a new accent colour and animation effects on focus', async ({ openEditor, page }) => {
    await openEditor({ accent: '#0078d4' });
    await expect.poll(() => accentBase(page)).toBe('#0078d4');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');

    await windowsChanges(page, { accent: '#e81123', systemReducedMotion: true });
    // Nothing happens until the window is focused again.
    await page.waitForTimeout(100);
    expect(await accentBase(page)).toBe('#0078d4');
    await focusWindow(page);
    await expect.poll(() => accentBase(page)).toBe('#e81123');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await expect(view.locator('.accent')).toHaveAttribute('title', 'Windows accent #e81123');

    // Later settings changes keep the new accent.
    await view.getByRole('switch', { name: 'Sounds' }).click();
    await waitForCall(page, 'settings_set');
    await page.waitForTimeout(50);
    expect(await accentBase(page)).toBe('#e81123');
  });

  test('the box follows them too', async ({ openBox, page }) => {
    const box = await openBox({ accent: '#0078d4' });
    await expect(box.visual).not.toHaveClass(/reduced/);
    await windowsChanges(page, { accent: '#107c10', systemReducedMotion: true });
    await focusWindow(page);
    await expect.poll(() => accentBase(page)).toBe('#107c10');
    await expect(box.visual).toHaveClass(/reduced/);
  });

  test('a hotkey another app holds is flagged until it works again', async ({ openEditor, page }) => {
    await openEditor();
    await windowsChanges(page, { hotkeyError: TAKEN });
    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await expect(view.getByTestId('hotkey-problem')).toContainText(`Not working: ${TAKEN}.`);

    // Recording the same shortcut again only retries it: still taken.
    await view.getByRole('button', { name: 'Change', exact: true }).click();
    await page.keyboard.press('Control+Alt+Shift+R');
    await waitForCall(page, 'settings_set');
    await expect(view.getByTestId('hotkey-error')).toHaveText(TAKEN);
    await expect(page.getByRole('alert').filter({ hasText: `Couldn't use that shortcut: ${TAKEN}` })).toBeVisible();
    await expect(view.getByTestId('hotkey-problem')).toBeVisible();

    // The other app let go of it: the next try works.
    await windowsChanges(page, { hotkeyError: null });
    await view.getByRole('button', { name: 'Change', exact: true }).click();
    await page.keyboard.press('Control+Alt+Shift+R');
    await expect(page.getByText('Shortcut set to Ctrl+Alt+Shift+R.')).toBeVisible();
    await expect(view.getByTestId('hotkey-problem')).toHaveCount(0);
    await expect(view.getByTestId('hotkey-error')).toHaveText('');
    expect(await calls(page, 'settings_set')).toHaveLength(2);
  });
});

test.describe('open-source licenses', () => {
  const NOTICES = [
    'Reskin 1.0.0: third-party notices',
    '',
    'svelte 5.57.1 · MIT · https://github.com/sveltejs/svelte  [1]',
    '',
    '[1] svelte 5.57.1',
    '-'.repeat(72),
    'Copyright (c) 2016-2025 Svelte Contributors',
  ].join('\n');

  test('About shows the notices shipped with the app, loaded on demand', async ({ openEditor, page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.route('**/THIRD_PARTY_NOTICES.txt', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: NOTICES }),
    );
    await openEditor();
    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await view.getByRole('button', { name: 'About' }).click();
    expect(requests.filter((u) => /LicensesDialog|THIRD_PARTY_NOTICES/.test(u))).toEqual([]);

    await view.getByRole('button', { name: 'Open-source licenses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open-source licenses' });
    await expect(dialog.getByRole('textbox', { name: 'Third-party notices' })).toHaveValue(NOTICES);
    expect(requests.some((u) => /LicensesDialog/.test(u))).toBe(true);
    await dialog.getByRole('button', { name: 'Releases' }).click();
    await waitForCall(page, 'open_external', { link: 'releases' });

    // Escape closes only the dialog; reopening doesn't fetch again.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    await view.getByRole('button', { name: 'Open-source licenses' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Third-party notices' })).toHaveValue(NOTICES);
    expect(requests.filter((u) => u.endsWith('/THIRD_PARTY_NOTICES.txt'))).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toBeHidden();
  });

  test('a build without the notices says where to find them', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await view.getByRole('button', { name: 'Open-source licenses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open-source licenses' });
    await expect(dialog.getByTestId('licenses-dialog')).toHaveAttribute('data-state', 'missing');
    await expect(dialog).toContainText('only release builds do');
  });
});
