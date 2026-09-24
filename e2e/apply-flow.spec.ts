// Save & Apply from the shell: elevation (Allow / personal copy / cancel)
// and failures surfaced with their hint.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { ApplyRequest } from '../src/lib/ipc/types';
import {
  calls,
  editorState,
  expect,
  SAMPLE_PATHS,
  setApplyOutcome,
  simulateOpen,
  test,
  waitForCall,
} from './support/fixtures';

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

type SessionView = { hasDesign: boolean; busy: unknown; elevation: unknown; current: { status: string } | null };
type Win = { __reskinSession: SessionView };

async function openOn(page: Page, path: string): Promise<void> {
  await simulateOpen(page, [path], 'edit');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __reskinSession?: SessionView }).__reskinSession;
    return !!s?.hasDesign && s.current?.status === 'editing';
  });
}

/** Save & Apply through its keyboard shortcut. */
async function applyNow(page: Page): Promise<void> {
  await page.keyboard.press('Control+Enter');
}

function applyRequests(page: Page): Promise<ApplyRequest[]> {
  return page.evaluate(() => window.__e2e!.callsOf('apply_icon').map((c) => c.args.req as ApplyRequest));
}

const NEEDS_ADMIN = { type: 'needsElevation', ticket: 't-42', reason: 'Access is denied. (0x80070005)' } as const;

test.describe('elevation', () => {
  test('Allow runs the elevated helper and the editor flies home', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.publicShortcut);
    await setApplyOutcome(page, NEEDS_ADMIN);
    await applyNow(page);

    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Firefox');
    await expect(dialog).toContainText('Public Desktop');
    await expect(dialog).toContainText('Access is denied.');
    if (process.env.RESKIN_SCREENSHOTS === '1') {
      mkdirSync(SHOTS_DIR, { recursive: true });
      writeFileSync(join(SHOTS_DIR, 'editor-shell-elevation.png'), await page.screenshot());
    }

    await dialog.getByRole('button', { name: 'Allow (administrator)' }).click();
    const elevated = await waitForCall(page, 'apply_icon_elevated');
    expect(elevated.args).toEqual({ ticket: 't-42' });
    await expect(dialog).toBeHidden();
    // Applied with the flourish: Rust collapses the editor (fly).
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    const history = await page.evaluate(() => window.__e2e!.history);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ elevated: true, state: 'applied', name: 'Firefox' });
    const collapse = await page.evaluate(() => window.__e2e!.acks.map((a) => a.stage));
    expect(collapse).toEqual(['prepared', 'revealed', 'expanded', 'collapsed', 'cleared']);
  });

  test('Make a personal copy applies with mode personalCopy', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.publicShortcut);
    await setApplyOutcome(page, NEEDS_ADMIN);
    await applyNow(page);
    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await expect(dialog).toBeVisible();
    await setApplyOutcome(page, null);
    await dialog.getByRole('button', { name: 'Make a personal copy' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await applyRequests(page)).map((r) => r.mode)).toEqual(['inPlace', 'personalCopy']);
    expect((await calls(page, 'apply_icon_elevated')).length).toBe(0);
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    const history = await page.evaluate(() => window.__e2e!.history);
    expect(history[0]).toMatchObject({ kind: 'createdShortcut', elevated: false });
  });

  test('Cancel leaves the icon alone and keeps editing', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.publicShortcut);
    await setApplyOutcome(page, NEEDS_ADMIN);
    await applyNow(page);
    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(150);
    expect(await calls(page, 'apply_icon_elevated')).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.elevation)).toBeNull();
    expect((await editorState(page)).phase).toBe('open');
    // Esc on the dialog cancels too (and does not close the editor).
    await applyNow(page);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(150);
    expect((await editorState(page)).phase).toBe('open');
    expect(await calls(page, 'editor_close')).toHaveLength(0);
  });

  test('a shortcut without a personal-copy mode offers only Allow', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.steam);
    await setApplyOutcome(page, NEEDS_ADMIN);
    await applyNow(page);
    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Make a personal copy' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Allow (administrator)' })).toBeVisible();
  });
});

test.describe('failures', () => {
  test('a failed apply shows the error with its hint and keeps the editor open', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.steam);
    await setApplyOutcome(page, {
      type: 'failed',
      message: 'The shortcut is read-only.',
      hint: 'Clear its Read-only attribute in Properties, then try again.',
    });
    await applyNow(page);
    const alert = page.getByRole('alert').filter({ hasText: 'The shortcut is read-only.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Clear its Read-only attribute');
    expect((await editorState(page)).phase).toBe('open');
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.current?.status)).toBe('failed');
  });

  test('an unsupported item explains why', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.site);
    await setApplyOutcome(page, { type: 'unsupported', reason: 'Windows ignores icons on this kind of link.' });
    await applyNow(page);
    await expect(page.getByRole('alert').filter({ hasText: 'Windows ignores icons' })).toBeVisible();
  });

  test('Save & Apply from the command palette applies in place', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, SAMPLE_PATHS.notes);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
    await page.keyboard.type('save apply');
    await expect(page.getByRole('option').first()).toContainText('Save & Apply');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await applyRequests(page)).length).toBe(1);
    const [req] = await applyRequests(page);
    expect(req).toMatchObject({ mode: 'inPlace', flourish: true, updatePins: false });
    expect(req!.images.map((i) => i.size)).toEqual([16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256]);
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
  });
});
