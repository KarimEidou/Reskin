// Save & Apply from the shell: a queue applied item by item (Undo while the
// editor stays open; the strip keeps the current item in view), "Apply
// style to all" with administrator approval (one summary once answered),
// Store app shortcuts, elevation (Allow / personal copy / cancel) and
// failures surfaced with their hint.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { ApplyRequest, ItemInfo } from '../src/lib/ipc/types';
import {
  calls,
  editorState,
  emit,
  expect,
  makeItems,
  SAMPLE_PATHS,
  setApplyOutcome,
  simulateOpen,
  test,
  waitForCall,
} from './support/fixtures';

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

type SessionView = {
  hasDesign: boolean;
  busy: unknown;
  elevation: unknown;
  currentIndex: number;
  switching: number;
  current: { status: string } | null;
  queue: Array<{ status: string; problem: string | null; info: { name: string } }>;
  recipe: unknown;
};
type Win = { __reskinSession: SessionView };

const statuses = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__reskinSession.queue.map((q) => q.status));

/** Waits until no job runs and no item is loading. */
const idle = (page: Page) =>
  page.waitForFunction(() => {
    const s = (window as unknown as Win).__reskinSession;
    return s.busy === null && s.switching === 0;
  });

async function openOn(page: Page, what: string | string[] | ItemInfo[]): Promise<void> {
  await simulateOpen(page, typeof what === 'string' ? [what] : what, 'edit');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __reskinSession?: SessionView }).__reskinSession;
    return !!s?.hasDesign && s.current?.status === 'editing' && s.switching === 0;
  });
}

/** The Undo buttons the toasts offer. */
const toastUndos = (page: Page) =>
  page.locator('[role="alert"], [role="status"]').getByRole('button', { name: 'Undo', exact: true });

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
    // Every button fits inside the dialog.
    const box = (await dialog.boundingBox())!;
    for (const name of ['Cancel', 'Make a personal copy', 'Allow (administrator)']) {
      const b = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.x, name).toBeGreaterThanOrEqual(box.x);
      expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width);
    }
    await expect(dialog.getByRole('button', { name: 'Allow (administrator)' })).toBeFocused();
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
    // The palette's own options: the page behind it has native <option>s
    // too (the Layers panel's blend mode), which the modal makes inert.
    await expect(page.getByTestId('command-palette').getByRole('option').first()).toContainText('Save & Apply');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await applyRequests(page)).length).toBe(1);
    const [req] = await applyRequests(page);
    expect(req).toMatchObject({ mode: 'inPlace', flourish: true, updatePins: false });
    expect(req!.images.map((i) => i.size)).toEqual([16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256]);
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
  });
});

type Invoke = (cmd: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
type Internals = { __TAURI_INTERNALS__: { invoke: Invoke } };

test.describe('a queue', () => {
  test('survives Save & Apply: item by item with Undo, and only the last one closes the editor', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    await applyNow(page);
    await expect.poll(() => statuses(page)).toEqual(['applied', 'editing', 'pending']);
    // Still open, on the next item, with the queue as it was.
    expect((await editorState(page)).phase).toBe('open');
    await expect(page.getByTestId('queue-item').nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('queue-item').nth(0)).toHaveAccessibleName('Steam, applied');
    const applied = page.getByRole('status').filter({ hasText: 'Applied to Steam.' });
    await expect(applied).toBeVisible();

    // Its Undo puts the icon back; the item can be applied again.
    const [entry] = await page.evaluate(() => window.__e2e!.history);
    await applied.getByRole('button', { name: 'Undo' }).click();
    await waitForCall(page, 'restore', { target: { type: 'entry', id: entry!.id } });
    await expect.poll(() => statuses(page)).toEqual(['editing', 'editing', 'pending']);
    expect((await page.evaluate(() => window.__e2e!.history))[0]!.state).toBe('restored');

    // Notes, then Docs Portal, then round to Steam again: the last one flourishes.
    for (const next of [2, 0]) {
      await idle(page);
      await applyNow(page);
      await expect.poll(() => page.evaluate(() => (window as unknown as Win).__reskinSession.currentIndex)).toBe(next);
      expect((await editorState(page)).phase).toBe('open');
    }
    await idle(page);
    await applyNow(page);
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    expect((await applyRequests(page)).map((r) => r.flourish)).toEqual([false, false, false, true]);
  });

  test('a design source waiting in the queue does not keep the editor open: the last target closes it', async ({ openEditor, page }) => {
    await openEditor();
    await openOn(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes]);
    // An image queued as a design of its own: nothing to apply it to.
    await emit(page, 'tauri://drag-drop', { paths: [SAMPLE_PATHS.image], position: { x: 600, y: 300 } });
    const pop = page.getByTestId('import-popover');
    await pop.getByRole('button', { name: /Queue as new item/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__reskinSession.queue.map((q) => q.info.name))).toEqual([
      'Steam',
      'Notes',
      'logo.png',
    ]);
    await applyNow(page);
    await expect.poll(() => statuses(page)).toEqual(['applied', 'editing', 'pending']);
    expect((await editorState(page)).phase).toBe('open');
    await idle(page);
    // Notes is the last target: its apply flourishes and closes the editor.
    await applyNow(page);
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    expect((await applyRequests(page)).map((r) => r.flourish)).toEqual([false, true]);
  });

  test('while a batch runs, neither the queue strip nor the title bar menu switches items', async ({ openEditor, page }) => {
    await openEditor({ applyCollapses: false });
    await openOn(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    // Every apply waits until the test lets it go.
    await page.evaluate(() => {
      const w = window as unknown as Internals & Win & { __release: () => void };
      const inner = w.__TAURI_INTERNALS__.invoke;
      const gate = new Promise<void>((r) => (w.__release = r));
      w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) =>
        cmd === 'apply_icon' ? gate.then(() => inner(cmd, args, opts)) : inner(cmd, args, opts);
      w.__reskinSession.recipe = { label: 'Mono', apply: () => {} };
    });
    await page.getByTestId('apply-style-all').click();
    await expect.poll(() => statuses(page)).toEqual(['editing', 'applying', 'pending']);

    const title = page.locator('header.titlebar');
    await title.getByRole('button', { name: /Steam, 1 of 3 queued/ }).click();
    const portal = page.getByRole('menuitemcheckbox', { name: /Docs Portal/ });
    await expect(portal).toBeDisabled();
    await portal.click({ force: true });
    await page.keyboard.press('Escape');
    // The strip's thumbnail is aria-disabled but still takes the click: refused too.
    await page.getByTestId('queue-item').nth(2).click({ force: true });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.currentIndex)).toBe(0);

    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect.poll(() => statuses(page)).toEqual(['editing', 'applied', 'applied']);
    expect(await page.evaluate(() => (window as unknown as Win).__reskinSession.currentIndex)).toBe(0);
    // Idle again: the menu switches.
    await title.getByRole('button', { name: /Steam, 1 of 3 queued/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /Docs Portal/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__reskinSession.currentIndex)).toBe(2);
  });
});

test.describe('"Apply style to all" and administrator approval', () => {
  test('asks once about every icon on the Public Desktop, then applies them in turn', async ({ openEditor, page }) => {
    const zoom = 'C:\\Users\\Public\\Desktop\\Zoom.lnk';
    await openEditor({ applyCollapses: false });
    const [steam, firefox, zoomItem] = await makeItems(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.publicShortcut, zoom]);
    // Rust answers each of them with a ticket of its own (the fake has one
    // outcome for everything, so they are answered here).
    await page.evaluate(
      (publicIds) => {
        const w = window as unknown as Internals & { __elevated: string[] };
        const inner = w.__TAURI_INTERNALS__.invoke;
        const tickets = new Map<string, unknown>();
        w.__elevated = [];
        w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {
          const req = args?.req as { item: string; mode: string } | undefined;
          if (cmd === 'apply_icon' && req && publicIds.includes(req.item) && req.mode === 'inPlace') {
            tickets.set(`t-${req.item}`, req);
            return Promise.resolve({ type: 'needsElevation', ticket: `t-${req.item}`, reason: 'Access is denied. (0x80070005)' });
          }
          if (cmd === 'apply_icon_elevated') {
            w.__elevated.push(String(args?.ticket));
            return inner('apply_icon', { req: tickets.get(String(args?.ticket)) }, opts);
          }
          return inner(cmd, args, opts);
        };
      },
      [firefox!.id, zoomItem!.id],
    );
    await openOn(page, [steam!, firefox!, zoomItem!]);
    await page.evaluate(() => {
      (window as unknown as Win).__reskinSession.recipe = { label: 'Mono', apply: () => {} };
    });
    await page.getByTestId('apply-style-all').click();

    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2 shortcuts are on the Public Desktop');
    await expect(dialog.getByRole('list', { name: 'Waiting for approval' }).getByRole('listitem')).toHaveText(['Firefox', 'Zoom']);
    await expect(dialog.getByRole('button', { name: 'Make personal copies' })).toBeVisible();
    // Until then each one says why it waits.
    await expect(page.getByTestId('queue-item').nth(2)).toHaveAccessibleName('Zoom, failed: Needs administrator approval');

    await dialog.getByRole('button', { name: 'Allow (administrator)' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => statuses(page)).toEqual(['editing', 'applied', 'applied']);
    expect(await page.evaluate(() => (window as unknown as { __elevated: string[] }).__elevated)).toEqual([
      `t-${firefox!.id}`,
      `t-${zoomItem!.id}`,
    ]);
    await expect(page.getByRole('status').filter({ hasText: 'Applied to 2 more icons.' })).toBeVisible();
    // The one summary: nothing was reported before the dialog was answered.
    await expect(toastUndos(page)).toHaveCount(1);
    await expect(page.getByRole('alert').filter({ hasText: 'administrator approval' })).toHaveCount(0);
    expect((await editorState(page)).phase).toBe('open');
  });

  test('Cancel reports once what the batch applied, with its Undo', async ({ openEditor, page }) => {
    await openEditor({ applyCollapses: false });
    const [steam, notes, firefox] = await makeItems(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.publicShortcut]);
    await page.evaluate((publicId) => {
      const w = window as unknown as Internals;
      const inner = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {
        const req = args?.req as { item: string; mode: string } | undefined;
        return cmd === 'apply_icon' && req?.item === publicId && req.mode === 'inPlace'
          ? Promise.resolve({ type: 'needsElevation', ticket: 't-firefox', reason: 'Access is denied. (0x80070005)' })
          : inner(cmd, args, opts);
      };
    }, firefox!.id);
    await openOn(page, [steam!, notes!, firefox!]);
    await page.evaluate(() => {
      (window as unknown as Win).__reskinSession.recipe = { label: 'Mono', apply: () => {} };
    });
    await page.getByTestId('apply-style-all').click();

    const dialog = page.getByRole('dialog', { name: 'Administrator permission needed' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    const summary = page.getByRole('alert').filter({ hasText: 'Applied to 1 of 2 icons.' });
    await expect(summary).toBeVisible();
    await expect(toastUndos(page)).toHaveCount(1);
    expect(await statuses(page)).toEqual(['editing', 'applied', 'failed']);
    expect(await calls(page, 'apply_icon_elevated')).toHaveLength(0);

    // Its Undo takes back what the batch applied.
    const [entry] = await page.evaluate(() => window.__e2e!.history);
    await summary.getByRole('button', { name: 'Undo' }).click();
    await waitForCall(page, 'restore', { target: { type: 'entry', id: entry!.id } });
    await expect.poll(() => statuses(page)).toEqual(['editing', 'editing', 'failed']);
  });
});

test.describe('the queue strip', () => {
  // The medium editor window: only a few thumbnails fit beside the zoom and the buttons.
  test.use({ viewport: { width: 1080, height: 720 } });

  test('scrolls with the mouse wheel and keeps the current item in view', async ({ openEditor, page }) => {
    // Six applies in turn.
    test.slow();
    await openEditor();
    await openOn(page, Array.from({ length: 8 }, (_, n) => `C:\\Users\\e2e\\Desktop\\App ${n + 1}.lnk`));
    const list = page.getByRole('list', { name: 'Queued icons' });
    const scrollLeft = () => list.evaluate((ul) => ul.scrollLeft);
    expect(await list.evaluate((ul) => ul.scrollWidth > ul.clientWidth)).toBe(true);

    // A vertical wheel over it scrolls it sideways.
    const strip = (await list.boundingBox())!;
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2);
    await page.mouse.wheel(0, 100);
    await expect.poll(scrollLeft).toBeGreaterThan(0);
    await page.mouse.move(2, 2);
    await list.evaluate((ul) => (ul.scrollLeft = 0));

    // Item after item, the one that opens comes into view.
    for (let next = 1; next <= 6; next++) {
      await idle(page);
      await applyNow(page);
      await expect.poll(() => page.evaluate(() => (window as unknown as Win).__reskinSession.currentIndex)).toBe(next);
    }
    const current = list.locator('[data-testid="queue-item"][aria-current="true"]');
    await expect(current).toHaveAccessibleName('App 7, editing');
    const inView = async () => {
      const [box, item] = [(await list.boundingBox())!, (await current.boundingBox())!];
      return item.x >= box.x && item.x + item.width <= box.x + box.width;
    };
    await expect.poll(inView).toBe(true);
  });
});

test.describe('Store app shortcuts', () => {
  test('apply as a classic desktop shortcut, and the apply menu says why', async ({ openEditor, page }) => {
    await openEditor({ applyCollapses: false });
    // As Rust reports one: changing it in place works, but Explorer ignores the icon.
    const [spotify] = await makeItems(page, [SAMPLE_PATHS.storeApp]);
    expect(spotify).toMatchObject({ storeApp: true, modes: ['inPlace', 'newShortcut'] });
    await openOn(page, [spotify!]);
    await page.getByTestId('apply-options').click();
    const menu = page.getByRole('dialog', { name: 'Apply options' });
    await expect(menu.locator('.mode.preferred')).toHaveAttribute('data-mode', 'newShortcut');
    await expect(menu.getByTestId('apply-notes')).toContainText('A Store app shortcut');
    await page.keyboard.press('Escape');
    await applyNow(page);
    await expect.poll(async () => (await applyRequests(page)).map((r) => r.mode)).toEqual(['newShortcut']);
  });
});
