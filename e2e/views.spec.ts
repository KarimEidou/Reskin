// The editor's pages against the fake backend: Start, Welcome, System icons,
// Library, History, Settings, crash recovery and files dropped on the window.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { LibrarySave, Settings } from '../src/lib/ipc/types';
import {
  calls,
  editorState,
  emit,
  expect,
  SAMPLE_PATHS,
  simulateClose,
  simulateOpen,
  test,
  waitForCall,
} from './support/fixtures';

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

type SessionView = {
  hasDesign: boolean;
  view: string;
  queue: Array<{ info: { name: string; kind: string } }>;
  engine: { doc: { layers: unknown[]; meta: { name: string } }; serialize(): Promise<string> };
  saveToLibrary(name?: string): Promise<unknown>;
};
type Win = { __reskinSession: SessionView };

const hasDesign = (page: Page) =>
  page.waitForFunction(() => (window as unknown as Win).__reskinSession.hasDesign);
const layerCount = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__reskinSession.engine.doc.layers.length);
const titleBar = (page: Page) => page.locator('header.titlebar');

async function wallpaper(page: Page, tone: 'dark' | 'light'): Promise<void> {
  const bg =
    tone === 'dark'
      ? 'radial-gradient(900px 600px at 20% 10%, rgb(124 92 255 / 0.45), transparent 70%), radial-gradient(1400px 900px at 85% 100%, #3d7bff 0%, #1c3f9e 45%, #0b1636 100%)'
      : 'radial-gradient(900px 600px at 20% 10%, rgb(255 255 255 / 0.9), transparent 70%), radial-gradient(1400px 900px at 85% 100%, #9ec2ff 0%, #c9dcfb 55%, #eef3fc 100%)';
  await page.addStyleTag({ content: `html, body { background: ${bg} !important; }` });
}

/** Screenshot for visual review (saved with RESKIN_SCREENSHOTS=1). */
async function shot(page: Page, name: string): Promise<void> {
  // Toasts from the setup would cover the page.
  // (Outroing toasts are inert; skip those.)
  const dismiss = page.locator('section[aria-label="Notifications"] > :not([inert]) button[aria-label="Dismiss notification"]');
  for (let i = 0; i < 12 && (await dismiss.count()) > 0; i++) await dismiss.first().click();
  await expect(page.locator('section[aria-label="Notifications"] > *')).toHaveCount(0);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  const png = await page.screenshot();
  await test.info().attach(name, { body: png, contentType: 'image/png' });
  if (process.env.RESKIN_SCREENSHOTS === '1') {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, name), png);
  }
}

/**
 * Drops crash-recovery autosaves (the session autosaves shortly after edits),
 * so the first Start view doesn't open the recovery dialog in tests that are
 * about something else.
 */
async function noAutosave(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Invoke = (cmd: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = (cmd, args, opts) =>
      cmd === 'autosave' && args?.data != null ? Promise.resolve(null) : inner(cmd, args, opts);
  });
}

/** Applies a design to `path` through the editor (the fake journals it). */
async function applyTo(page: Page, path: string): Promise<void> {
  await simulateOpen(page, [path], 'edit');
  await hasDesign(page);
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
}

test.describe('start', () => {
  test('drop target and ways in', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    const view = page.getByTestId('start-view');
    await expect(view).toBeVisible();
    await expect(page.getByTestId('drop-zone')).toContainText('Drag a shortcut, folder or image here');
    await expect(view.getByText('No saved designs yet')).toBeVisible();
    await expect(view.getByText('Nothing changed yet')).toBeVisible();
    // No design yet: no Edit tab.
    await expect(titleBar(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

    await page.evaluate((p) => window.__e2e!.setPickFiles(p), [SAMPLE_PATHS.image]);
    await view.getByRole('button', { name: 'Open image…' }).click();
    const pick = await waitForCall(page, 'pick_files');
    expect(pick.args).toEqual({ purpose: 'import' });
    await hasDesign(page);
    await expect(page.locator('[data-view-host]')).toHaveAttribute('data-view', 'edit');
    await expect(titleBar(page)).toContainText('logo.png');
    await expect(titleBar(page).getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('New blank icon starts an empty design', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.getByRole('button', { name: 'New blank icon' }).click();
    await hasDesign(page);
    await expect(titleBar(page)).toContainText('Untitled');
    // The logo goes back to Start.
    await page.getByRole('button', { name: 'Start page' }).click();
    await expect(page.getByTestId('start-view')).toBeVisible();
  });

  test('recent changes offer Undo; Restore all asks first', async ({ openEditor, page }) => {
    await openEditor();
    await noAutosave(page);
    await applyTo(page, SAMPLE_PATHS.steam);
    await simulateOpen(page, [], 'start');
    const view = page.getByTestId('start-view');
    const row = view.locator('li.change').filter({ hasText: 'Steam' });
    await expect(row).toBeVisible();
    const [entry] = await page.evaluate(() => window.__e2e!.history);
    await row.getByRole('button', { name: 'Undo the change to Steam' }).click();
    const restore = await waitForCall(page, 'restore');
    expect(restore.args).toEqual({ target: { type: 'entry', id: entry!.id } });
    await expect(page.getByRole('status').filter({ hasText: 'Original icon restored' })).toBeVisible();
    await expect(row.getByRole('button', { name: /Undo/ })).toHaveCount(0);

    await view.getByRole('button', { name: 'Restore all icons…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Restore all icons?' });
    await expect(confirm).toBeVisible();
    // A destructive question starts on Cancel, so Enter can't restore by accident.
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect((await calls(page, 'restore')).length).toBe(1);
    await view.getByRole('button', { name: 'Restore all icons…' }).click();
    await page.getByTestId('confirm-ok').click();
    await waitForCall(page, 'restore', { target: { type: 'all' } });
  });

  test('screenshots', async ({ openEditor, page }) => {
    test.slow();
    await openEditor({ accent: '#0078d4' });
    await noAutosave(page);
    await applyTo(page, SAMPLE_PATHS.steam);
    await applyTo(page, SAMPLE_PATHS.site);
    await page.evaluate(async () => {
      const s = (window as unknown as Win).__reskinSession;
      await s.saveToLibrary('Steam Glass');
      await s.saveToLibrary('Docs Neon');
    });
    for (const tone of ['dark', 'light'] as const) {
      await page.evaluate((t) => window.__e2e!.setSettings({ theme: t }), tone);
      await simulateOpen(page, [], 'start');
      if (tone === 'dark') await wallpaper(page, 'dark');
      else await wallpaper(page, 'light');
      await shot(page, `editor-shell-start${tone === 'light' ? '-light' : ''}.png`);
      await simulateClose(page);
    }
  });
});

test.describe('compatibility mode', () => {
  test('the opaque window fills the frame', async ({ openEditor, page }) => {
    await openEditor({ settings: { compatibilityMode: true }, accent: '#0078d4' });
    await simulateOpen(page, [], 'start');
    await expect(page.locator('html')).toHaveAttribute('data-compat', 'true');
    const panel = (await page.getByTestId('editor-panel').boundingBox())!;
    expect(panel.x).toBe(0);
    expect(panel.y).toBe(0);
    await shot(page, 'editor-shell-start-compat.png');
    // Cleared: nothing but the window background remains visible to the user.
    await simulateClose(page);
    await expect(page.getByTestId('morph-frame')).toHaveAttribute('data-mode', 'hidden');
  });
});

test.describe('welcome', () => {
  test('Got it finishes onboarding and closes into the box', async ({ openEditor, page }) => {
    await openEditor({ firstRun: true });
    await simulateOpen(page, [], 'welcome');
    const view = page.getByTestId('welcome-view');
    await expect(view.getByRole('heading', { name: 'Welcome to Reskin' })).toBeVisible();
    await expect(view.getByRole('listitem')).toHaveCount(3);
    await page.getByTestId('welcome-done').click();
    const set = await waitForCall(page, 'settings_set');
    expect((set.args.settings as Settings).onboarded).toBe(true);
    await waitForCall(page, 'editor_close', { reason: 'user' });
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
  });

  for (const tone of ['dark', 'light'] as const) {
    test(`screenshot (${tone})`, async ({ openEditor, page }) => {
      await openEditor({ firstRun: true, settings: { theme: tone }, accent: '#0078d4' });
      await wallpaper(page, tone);
      await simulateOpen(page, [], 'welcome');
      await page.waitForTimeout(1600);
      await shot(page, `editor-shell-welcome${tone === 'light' ? '-light' : ''}.png`);
    });
  }
});

test.describe('system icons', () => {
  test('lists the system icons and opens one for editing', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'systemIcons');
    const view = page.getByTestId('system-icons-view');
    await expect(view.getByRole('button', { name: /^Edit / })).toHaveCount(6);
    expect((await calls(page, 'inspect_system_icon')).map((c) => c.args.id)).toEqual([
      'thisPc',
      'recycleBinEmpty',
      'recycleBinFull',
      'userFiles',
      'network',
      'controlPanel',
    ]);
    await wallpaper(page, 'dark');
    await shot(page, 'editor-shell-system-icons.png');
    await view.getByRole('button', { name: 'Edit This PC' }).click();
    await hasDesign(page);
    await expect(titleBar(page)).toContainText('This PC');
    const queue = await page.evaluate(() => (window as unknown as Win).__reskinSession.queue.map((q) => q.info.kind));
    expect(queue).toEqual(['systemIcon']);
  });
});

test.describe('library', () => {
  test('save, open, rename and delete designs', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    const view = page.getByTestId('library-view');
    await expect(view.getByText('Your Library is empty')).toBeVisible();

    await view.getByRole('button', { name: 'Save current design' }).first().click();
    const save = await waitForCall(page, 'library_save');
    expect((save.args.entry as LibrarySave).id).toBeNull();
    const card = view.getByTestId('library-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Steam');

    // Rename keeps the id.
    await card.getByRole('button', { name: 'More actions for Steam' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const nameField = card.getByRole('textbox', { name: 'New name for Steam' });
    await expect(nameField).toBeFocused();
    await nameField.fill('Steam — Neon');
    await page.keyboard.press('Enter');
    await expect(card).toContainText('Steam — Neon');
    // Keyboard focus continues from the card, not from the page.
    await expect(card.getByRole('button', { name: 'More actions for Steam — Neon' })).toBeFocused();
    const saves = await calls(page, 'library_save');
    const renamed = saves.at(-1)!.args.entry as LibrarySave;
    const [stored] = await page.evaluate(() => window.__e2e!.library);
    expect(renamed.id).toBe(stored!.id);
    expect(renamed.name).toBe('Steam — Neon');
    expect(renamed.data.length).toBeGreaterThan(10);

    // Open it.
    await page.getByRole('button', { name: 'Start page' }).click();
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    await view.getByRole('button', { name: 'Open Steam — Neon' }).click();
    await waitForCall(page, 'library_load', { id: stored!.id });
    await expect(page.locator('[data-view-host]')).toHaveAttribute('data-view', 'edit');

    // Delete asks first.
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    await card.getByRole('button', { name: 'More actions for Steam — Neon' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete "Steam — Neon"?' })).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await waitForCall(page, 'library_delete', { id: stored!.id });
    await expect(view.getByText('Your Library is empty')).toBeVisible();
  });

  test('the icon-only menu keeps its focused trigger while it opens and closes', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await page.evaluate(() => (window as unknown as Win).__reskinSession.saveToLibrary('Mono'));
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    type Probed = HTMLElement & { probe?: boolean };
    const trigger = page.getByTestId('library-card').getByRole('button', { name: 'More actions for Mono' });
    await trigger.evaluate((el) => void ((el as Probed).probe = true));
    // Reached with the keyboard, its tooltip shows at once.
    await trigger.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveText('More actions for Mono');
    // Opening the menu turns the tooltip off without re-creating the trigger
    // (the old unwrap re-created it and wrote state while Svelte removed it).
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await trigger.evaluate((el) => (el as Probed).probe)).toBe(true);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
  });

  test('apply a saved design to the queued item', async ({ openEditor, page }) => {
    await openEditor({ applyCollapses: false });
    await simulateOpen(page, [SAMPLE_PATHS.notes], 'edit');
    await hasDesign(page);
    await page.evaluate(() => (window as unknown as Win).__reskinSession.saveToLibrary('Mono'));
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    const card = page.getByTestId('library-card');
    await card.getByRole('button', { name: 'More actions for Mono' }).click();
    await page.getByRole('menuitem', { name: 'Apply to “Notes”' }).click();
    await waitForCall(page, 'library_load');
    const apply = await waitForCall(page, 'apply_icon');
    expect(apply.args.req).toMatchObject({ designName: 'Mono', mode: 'inPlace' });
  });

  test('screenshots', async ({ openEditor, page }) => {
    await openEditor({ accent: '#0078d4' });
    await simulateOpen(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.site, SAMPLE_PATHS.folder, SAMPLE_PATHS.exe], 'edit');
    await hasDesign(page);
    await page.evaluate(async () => {
      const s = (window as unknown as Win).__reskinSession;
      for (const name of ['Steam Glass', 'Portal Neon', 'Projects Clay', 'Paint Retro', 'Mono Dark']) await s.saveToLibrary(name);
    });
    await titleBar(page).getByRole('button', { name: 'Library' }).click();
    await expect(page.getByTestId('library-card')).toHaveCount(5);
    await wallpaper(page, 'dark');
    await shot(page, 'editor-shell-library.png');
    await page.evaluate(() => window.__e2e!.setSettings({ theme: 'light' }));
    await wallpaper(page, 'light');
    await shot(page, 'editor-shell-library-light.png');
  });
});

test.describe('history', () => {
  test('undo one change, restore original and restore all', async ({ openEditor, page }) => {
    await openEditor();
    await applyTo(page, SAMPLE_PATHS.steam);
    await applyTo(page, SAMPLE_PATHS.steam);
    await applyTo(page, SAMPLE_PATHS.site);
    await simulateOpen(page, [], 'history');
    const view = page.getByTestId('history-view');
    const rows = view.getByTestId('history-row');
    await expect(rows).toHaveCount(3);
    await expect(view.getByRole('heading', { name: 'Today' })).toBeVisible();
    await wallpaper(page, 'dark');
    await shot(page, 'editor-shell-history.png');

    const history = await page.evaluate(() => window.__e2e!.history);
    const [firstSteam, secondSteam, site] = history;
    expect(secondSteam!.supersedes).toBe(firstSteam!.id);

    // The newest Steam change has a chain: Restore original walks it back.
    const steamRow = view.locator('[data-testid="history-row"][data-state="applied"]').filter({ hasText: 'Steam' });
    await expect(view.locator(`[data-state="applied"]`)).toHaveCount(2);
    await view.getByRole('button', { name: 'Restore the original icon of Steam' }).click();
    await waitForCall(page, 'restore', { target: { type: 'entry', id: secondSteam!.id } });
    await expect(steamRow).toHaveCount(0);

    // Undo the site change.
    await view.getByRole('button', { name: 'Undo the change to Docs Portal' }).click();
    await waitForCall(page, 'restore', { target: { type: 'entry', id: site!.id } });
    await expect(view.locator('[data-state="applied"]')).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Restore all…' })).toBeDisabled();
  });

  test('Restore all confirms, then restores everything', async ({ openEditor, page }) => {
    await openEditor();
    await applyTo(page, SAMPLE_PATHS.notes);
    await simulateOpen(page, [], 'history');
    await page.getByRole('button', { name: 'Restore all…' }).click();
    await page.getByTestId('confirm-ok').click();
    await waitForCall(page, 'restore', { target: { type: 'all' } });
    await expect(page.getByRole('status').filter({ hasText: 'Restored 1 original icon' })).toBeVisible();
    await expect(page.getByTestId('history-row')).toHaveAttribute('data-state', 'restored');
  });
});

test.describe('settings', () => {
  test('box skin with a live preview, theme, toggles and actions', async ({ openEditor, page }) => {
    await openEditor({ accent: '#0078d4' });
    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await expect(view.getByTestId('box-preview')).toHaveAttribute('data-skin', 'glass');
    await view.getByRole('radio', { name: 'Neon' }).check();
    const set = await waitForCall(page, 'settings_set');
    expect((set.args.settings as Settings).boxSkin).toBe('neon');
    await expect(view.getByTestId('box-preview')).toHaveAttribute('data-skin', 'neon');
    await expect(view.getByTestId('box-preview').locator('.bv')).toHaveClass(/skin-neon/);

    await view.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await view.getByRole('switch', { name: 'Sounds' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__e2e!.settings)).sounds).toBe(true);

    await view.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitForCall(page, 'refresh_icons', { level: 'notify' });
    await view.getByRole('button', { name: 'Rebuild cache' }).click();
    await waitForCall(page, 'refresh_icons', { level: 'rebuild' });

    // Export sizes: the required ones are locked.
    await expect(view.getByRole('checkbox', { name: '256' })).toBeDisabled();
    await view.getByRole('checkbox', { name: '20' }).uncheck();
    await expect.poll(async () => (await page.evaluate(() => window.__e2e!.settings)).icoSizes).not.toContain(20);

    await view.getByRole('button', { name: 'About' }).click();
    await view.getByRole('button', { name: 'Releases' }).click();
    await waitForCall(page, 'open_external', { link: 'releases' });
  });

  test('hotkey recorder validates and saves', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'settings');
    const view = page.getByTestId('settings-view');
    await view.getByRole('button', { name: 'Change', exact: true }).click();
    // Shift alone is not enough for a global hotkey.
    await page.keyboard.press('Shift+R');
    await expect(view.getByTestId('hotkey-error')).toContainText("Shift alone isn't enough");
    expect(await calls(page, 'settings_set')).toHaveLength(0);
    // A bare key is refused too.
    await page.keyboard.press('R');
    await expect(view.getByTestId('hotkey-error')).toContainText('Add at least one of Ctrl, Alt, Shift or Win');
    // A valid one is saved canonically; Ctrl+K is recorded, not the palette.
    await page.keyboard.press('Control+Alt+K');
    const set = await waitForCall(page, 'settings_set');
    expect((set.args.settings as Settings).hotkey).toBe('Ctrl+Alt+K');
    await expect(page.getByTestId('command-palette')).toBeHidden();
    await expect(view.getByTestId('hotkey-error')).toHaveText('');

    // Escape cancels a recording without closing the editor.
    await view.getByRole('button', { name: 'Change', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    // Turn off.
    await view.getByRole('button', { name: 'Turn off' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__e2e!.settings)).hotkey).toBe('');
    await expect(view.getByRole('button', { name: /Global shortcut: off/ })).toBeVisible();
  });

  test('a refused setting rolls back with a toast', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'settings');
    await page.evaluate(() => window.__e2e!.failNext('settings_set', 'the registry is locked'));
    const view = page.getByTestId('settings-view');
    await view.getByRole('switch', { name: 'Start with Windows' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'the registry is locked' })).toBeVisible();
    await expect(view.getByRole('switch', { name: 'Start with Windows' })).toHaveAttribute('aria-checked', 'false');
  });

  for (const tone of ['dark', 'light'] as const) {
    test(`screenshot (${tone})`, async ({ openEditor, page }) => {
      await openEditor({ settings: { theme: tone }, accent: '#0078d4' });
      await wallpaper(page, tone);
      await simulateOpen(page, [], 'settings');
      await shot(page, `editor-shell-settings${tone === 'light' ? '-light' : ''}.png`);
    });
  }
});

test.describe('recovery', () => {
  /** Leaves an autosaved Steam design behind, as a crash would. */
  async function leaveAutosave(page: Page): Promise<void> {
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await page.evaluate(async () => {
      const s = (window as unknown as Win).__reskinSession;
      const json = await s.engine.serialize();
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__.invoke;
      await invoke('autosave', { data: json });
    });
    await simulateClose(page);
  }

  const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Restore your unsaved design?' });
  const bannerOf = (page: Page) => page.getByRole('region', { name: 'Unsaved design' });

  test('Restore opens the design (focused by default)', async ({ openEditor, page }) => {
    await openEditor();
    await leaveAutosave(page);
    // The first Start view of this page offers it.
    await simulateOpen(page, [], 'start');
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Restore' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await hasDesign(page);
    await expect(page.locator('[data-view-host]')).toHaveAttribute('data-view', 'edit');
    await expect(titleBar(page)).toContainText('Steam');
    // While that design is open the Start page doesn't offer it again.
    await page.getByRole('button', { name: 'Start page' }).click();
    await expect(page.getByTestId('start-view')).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
  });

  test('Discard in the dialog deletes it everywhere', async ({ openEditor, page }) => {
    await openEditor();
    await leaveAutosave(page);
    await simulateOpen(page, [], 'start');
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toBeHidden();
    await waitForCall(page, 'autosave', { data: null });
    // The Start page's own offer went with it.
    await expect(bannerOf(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__e2e!.callsOf('restore').length)).toBe(0);
  });

  test('dismissing the dialog keeps it on the Start page until discarded', async ({ openEditor, page }) => {
    await openEditor();
    await leaveAutosave(page);
    await simulateOpen(page, [], 'start');
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Esc went to the dialog, not to closing the editor.
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    const banner = bannerOf(page);
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Discard' }).click();
    await expect(banner).toBeHidden();
    await waitForCall(page, 'autosave', { data: null });
  });
});

test.describe('files dropped on the editor', () => {
  test('an image while editing asks: add as layer', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    const before = await layerCount(page);
    await emit(page, 'tauri://drag-enter', { paths: [SAMPLE_PATHS.image], position: { x: 600, y: 300 } });
    await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.image], position: { x: 600, y: 300 } });
    const pop = page.getByTestId('import-popover');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('“logo.png”');
    await pop.getByRole('button', { name: /Add as layer/ }).click();
    await expect(pop).toBeHidden();
    await expect.poll(() => layerCount(page)).toBe(before + 1);
  });

  test('dragging over the editor highlights the drop', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await emit(page, 'tauri://drag-enter', { paths: [SAMPLE_PATHS.image], position: { x: 600, y: 300 } });
    await expect(page.getByText('Drop to add to your design or queue')).toBeVisible();
    await emit(page, 'tauri://drag-leave', null);
    await expect(page.getByText('Drop to add to your design or queue')).toHaveCount(0);
    // The Start view uses its own drop target.
    await page.getByRole('button', { name: 'Start page' }).click();
    await emit(page, 'tauri://drag-enter', { paths: [SAMPLE_PATHS.image], position: { x: 600, y: 300 } });
    await expect(page.getByTestId('drop-zone')).toContainText('Drop to start editing');
    await expect(page.getByTestId('drop-zone').locator('.bv')).toHaveAttribute('data-state', 'armed');
  });

  test('an image can replace the design instead', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.image], position: { x: 500, y: 300 } });
    await page.getByTestId('import-popover').getByRole('button', { name: /Open as a new design/ }).click();
    await expect(titleBar(page)).toContainText('logo.png');
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.queue.length)).toBe(0);
  });

  test('shortcuts join the queue without asking', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.notes, SAMPLE_PATHS.folder], position: { x: 500, y: 300 } });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__reskinSession.queue.map((q) => q.info.name)))
      .toEqual(['Steam', 'Notes', 'Projects']);
    await expect(page.getByTestId('import-popover')).toHaveCount(0);
    await expect(titleBar(page)).toContainText('1/3');
    await expect(page.getByRole('status').filter({ hasText: 'Added 2 items to the queue' })).toBeVisible();
  });

  test('nothing usable shows an error', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.unreadable], position: { x: 500, y: 300 } });
    await expect(page.getByRole('alert').filter({ hasText: 'None of these items can be reskinned' })).toBeVisible();
  });
});

test.describe('pasted images', () => {
  /** Pastes a 64 px coral PNG (as a file, like a screenshot tool puts it on the clipboard). */
  async function paste(page: Page): Promise<void> {
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff3366';
      ctx.fillRect(0, 0, 64, 64);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
  }

  const layerNames = (page: Page) =>
    page.evaluate(() =>
      ((window as unknown as Win).__reskinSession.engine.doc.layers as Array<{ name: string }>).map((l) => l.name),
    );

  test('an image pasted on the Start page starts a design', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await expect(page.getByTestId('start-view')).toBeVisible();
    await paste(page);
    await hasDesign(page);
    await expect(page.locator('[data-view-host]')).toHaveAttribute('data-view', 'edit');
    expect(await layerNames(page)).toEqual(['Pasted image']);
  });

  test('on the canvas the workspace takes the paste: one layer, not two', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await hasDesign(page);
    await expect(page.getByTestId('canvas-stage')).toBeVisible();
    const before = await layerNames(page);
    await paste(page);
    await expect.poll(() => layerNames(page)).toEqual([...before, 'Pasted image']);
    // The App skips a paste the canvas already handled (preventDefault).
    await page.waitForTimeout(300);
    expect(await layerNames(page)).toEqual([...before, 'Pasted image']);
  });

  test('a paste into a text field stays text', async ({ openEditor, page }) => {
    await openEditor();
    // A saved design, so the Library shows its filter field.
    await page.evaluate(() =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
        'library_save',
        { entry: { id: null, name: 'Mono', thumb: '', data: '{}' } },
      ),
    );
    await simulateOpen(page, [], 'library');
    await page.getByRole('searchbox', { name: 'Filter designs' }).focus();
    await page.evaluate(async () => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.hasDesign)).toBe(false);
    await expect(page.getByTestId('library-view')).toBeVisible();
  });
});

test.describe('overlay gallery', () => {
  for (const tone of ['dark', 'light'] as const) {
    test(`queue menu, import popover and confirm (${tone})`, async ({ openEditor, page }) => {
      const suffix = tone === 'light' ? '-light' : '';
      await openEditor({ settings: { theme: tone }, accent: '#0078d4' });
      await wallpaper(page, tone);
      await simulateOpen(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.site, SAMPLE_PATHS.folder], 'edit');
      await hasDesign(page);

      await titleBar(page).getByRole('button', { name: /Steam, 1 of 3 queued/ }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Steam' })).toHaveAttribute('aria-checked', 'true');
      await shot(page, `editor-shell-queue-menu${suffix}.png`);
      // Switching items from the menu.
      await page.getByRole('menuitemcheckbox', { name: /Docs Portal/ }).click();
      await expect(titleBar(page)).toContainText('Docs Portal');
      await expect(titleBar(page)).toContainText('2/3');

      await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.image], position: { x: 700, y: 360 } });
      await expect(page.getByTestId('import-popover')).toBeVisible();
      await shot(page, `editor-shell-import-popover${suffix}.png`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('import-popover')).toBeHidden();

      await page.keyboard.press('Control+k');
      await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
      await page.keyboard.type('restore all');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Restore all icons?' })).toBeVisible();
      await shot(page, `editor-shell-confirm${suffix}.png`);
    });
  }
});
