// The editor side of the box ⇄ editor handoff: the proxy is pixel-placed on
// the box, acks follow the protocol, stale sessions are ignored, and the
// window is fully transparent after Clear.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import type { AckStage, EditorCmd, Rect } from '../src/lib/ipc/types';
import { metricsFor, visualRect } from '../src/lib/ui/box-geometry';
import {
  calls,
  editorState,
  expect,
  makeItems,
  pushEditorCmd,
  SAMPLE_PATHS,
  settings as backendSettings,
  simulateClose,
  simulateOpen,
  test,
  waitForAck,
  waitForCall,
} from './support/fixtures';

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

const frame = (page: Page) => page.locator('.frame');

/** Waits until the opened item's design is loaded (it switches to Edit when done). */
const designLoaded = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __reskinSession: { hasDesign: boolean } }).__reskinSession.hasDesign);
const proxy = (page: Page) => page.getByTestId('box-proxy');

function acks(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__e2e!.acks.map((a) => `${a.session}:${a.stage}`));
}

async function prepare(page: Page, session: number, boxRect: Rect, paths: string[] = [SAMPLE_PATHS.steam]) {
  const items = paths.length ? await makeItems(page, paths) : [];
  const cmd: EditorCmd = {
    type: 'prepare',
    session,
    boxRect,
    items,
    view: items.length ? 'edit' : 'start',
    settings: await backendSettings(page),
    morph: true,
  };
  await pushEditorCmd(page, cmd);
  expect(await waitForAck(page, session, 'prepared')).toBe(true);
  return items;
}

/** Records every value `data-transition` takes on the frame. */
async function recordTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __transitions: string[] }).__transitions = seen;
    const el = document.querySelector('.frame')!;
    new MutationObserver(() => {
      const v = el.getAttribute('data-transition');
      if (v) seen.push(v);
    }).observe(el, { attributes: true, attributeFilter: ['data-transition'] });
  });
}

const transitions = (page: Page) =>
  page.evaluate(() => (window as unknown as { __transitions: string[] }).__transitions);

/** Paints a desktop wallpaper behind the transparent window (screenshots only). */
async function wallpaper(page: Page, tone: 'dark' | 'light'): Promise<void> {
  const bg =
    tone === 'dark'
      ? 'radial-gradient(900px 600px at 20% 10%, rgb(124 92 255 / 0.45), transparent 70%), radial-gradient(1400px 900px at 85% 100%, #3d7bff 0%, #1c3f9e 45%, #0b1636 100%)'
      : 'radial-gradient(900px 600px at 20% 10%, rgb(255 255 255 / 0.9), transparent 70%), radial-gradient(1400px 900px at 85% 100%, #9ec2ff 0%, #c9dcfb 55%, #eef3fc 100%)';
  await page.addStyleTag({ content: `html, body { background: ${bg} !important; }` });
}

async function shoot(page: Page, name: string): Promise<void> {
  const png = await page.screenshot({ animations: 'allow' });
  await test.info().attach(name, { body: png, contentType: 'image/png' });
  if (process.env.RESKIN_SCREENSHOTS === '1') {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, name), png);
  }
}

test.describe('prepare', () => {
  test('the proxy renders exactly on the box before expanding', async ({ openEditor, page }) => {
    await openEditor();
    // Fractional CSS px, as Rust sends them on scaled displays.
    const boxRect = { x: 101.5, y: 377.25, w: 148, h: 148 };
    const [item] = await prepare(page, 1, boxRect);

    await expect(frame(page)).toHaveAttribute('data-mode', 'proxy');
    const bb = (await proxy(page).locator('.bv').boundingBox())!;
    expect(Math.abs(bb.x - boxRect.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bb.y - boxRect.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bb.width - boxRect.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(bb.height - boxRect.h)).toBeLessThanOrEqual(1);

    // The visual box (what the real box shows) matches box-geometry.
    const vr = visualRect(metricsFor('medium'), boxRect);
    const vb = (await proxy(page).locator('.bv .box').boundingBox())!;
    expect(Math.abs(vb.x - vr.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(vb.y - vr.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(vb.width - vr.w)).toBeLessThanOrEqual(1);

    // Same picture as the box's hand-off: the dropped icon, idle, same skin.
    await expect(proxy(page).locator('img.icon')).toHaveAttribute('src', item!.icon!);
    await expect(proxy(page).locator('.bv')).toHaveAttribute('data-state', 'idle');
    await expect(proxy(page).locator('.bv')).toHaveAttribute('data-skin', 'glass');
    // Nothing of the panel is painted yet.
    await expect(page.getByTestId('editor-panel')).toHaveCSS('visibility', 'hidden');
  });

  test('a batch shows the count badge like the box', async ({ openEditor, page }) => {
    await openEditor();
    await prepare(page, 1, { x: 40, y: 40, w: 148, h: 148 }, [SAMPLE_PATHS.steam, SAMPLE_PATHS.site, SAMPLE_PATHS.folder]);
    await expect(proxy(page).locator('.badge')).toHaveText('3');
  });

  test('the proxy follows the box skin and size of the snapshot', async ({ openEditor, page }) => {
    await openEditor({ settings: { boxSkin: 'neon', boxSize: 'large' } });
    const m = metricsFor('large');
    await prepare(page, 1, { x: 60, y: 300, w: m.window, h: m.window }, []);
    await expect(proxy(page).locator('.bv')).toHaveAttribute('data-skin', 'neon');
    const bb = (await proxy(page).locator('.bv').boundingBox())!;
    expect(bb.width).toBeCloseTo(m.window, 0);
    await expect(proxy(page).locator('img.icon')).toHaveCount(0);
  });
});

test.describe('handoff protocol', () => {
  test('acks follow the protocol for one session: open, then close', async ({ openEditor, page }) => {
    await openEditor();
    const open = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    expect(open).toEqual({ session: 1, morph: true, preparedInTime: true, timedOut: [] });
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');
    await expect(page.locator('html')).toHaveAttribute('data-phase', 'open');
    expect(await acks(page)).toEqual(['1:prepared', '1:revealed', '1:expanded']);

    const close = await simulateClose(page, 'hide');
    expect(close).toEqual({ session: 1, timedOut: [] });
    expect(await acks(page)).toEqual(['1:prepared', '1:revealed', '1:expanded', '1:collapsed', '1:cleared']);
    await expect(frame(page)).toHaveAttribute('data-mode', 'hidden');

    // A second open uses the next session and works the same way.
    const again = await simulateOpen(page, [], 'start');
    expect(again.session).toBe(2);
    expect(again.timedOut).toEqual([]);
    await expect(page.getByTestId('start-view')).toBeVisible();
  });

  test('the morph grows the proxy into the panel', async ({ openEditor, page }) => {
    await openEditor();
    await recordTransitions(page);
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    expect(await transitions(page)).toContain('morph');
    // The panel fills the window minus its 12 px shadow margin.
    const panel = (await page.getByTestId('editor-panel').boundingBox())!;
    const vp = page.viewportSize()!;
    expect(panel).toEqual({ x: 12, y: 12, width: vp.width - 24, height: vp.height - 24 });
    await expect(proxy(page)).toHaveCount(0);
  });

  test('collapse ends on the proxy at the box, carrying the new icon', async ({ openEditor, page }) => {
    await openEditor();
    const [item] = await makeItems(page, [SAMPLE_PATHS.notes]);
    const { session } = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    const boxRect = { x: 900, y: 500, w: 148, h: 148 };
    await pushEditorCmd(page, { type: 'collapse', session, boxRect, then: 'fly', icon: item!.icon, morph: true });
    expect(await waitForAck(page, session, 'collapsed')).toBe(true);
    await expect(frame(page)).toHaveAttribute('data-mode', 'proxy');
    await expect(proxy(page).locator('img.icon')).toHaveAttribute('src', item!.icon!);
    const bb = (await proxy(page).locator('.bv').boundingBox())!;
    expect(Math.abs(bb.x - boxRect.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bb.y - boxRect.y)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('editor-panel')).toHaveCSS('visibility', 'hidden');

    await pushEditorCmd(page, { type: 'clear', session });
    expect(await waitForAck(page, session, 'cleared')).toBe(true);
    await expect(frame(page)).toHaveAttribute('data-mode', 'hidden');
  });

  test('a plain close collapses into the empty box', async ({ openEditor, page }) => {
    await openEditor();
    const { session } = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await pushEditorCmd(page, { type: 'collapse', session, boxRect: { x: 32, y: 32, w: 148, h: 148 }, then: 'hide', icon: null, morph: true });
    expect(await waitForAck(page, session, 'collapsed')).toBe(true);
    await expect(proxy(page).locator('img.icon')).toHaveCount(0);
    await expect(proxy(page).locator('.badge')).toHaveCount(0);
  });

  test('after Clear nothing at all is painted', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    // A toast would be painted too: make one and check it goes away.
    await page.evaluate(() => (window as unknown as { __reskinSession: { saveToLibrary(): Promise<unknown> } }).__reskinSession.saveToLibrary());
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await simulateClose(page, 'hide');
    const png = PNG.sync.read(await page.screenshot({ omitBackground: true }));
    let painted = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i]! > 0) painted++;
    expect(painted).toBe(0);
  });

  test('Escape closes the editor (editor_close user)', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.keyboard.press('Escape');
    const close = await waitForCall(page, 'editor_close');
    expect(close.args).toEqual({ reason: 'user' });
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    await expect(frame(page)).toHaveAttribute('data-mode', 'hidden');
  });

  test('the close button runs the same close', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await page.getByRole('button', { name: 'Close editor' }).click();
    const close = await waitForCall(page, 'editor_close');
    expect(close.args).toEqual({ reason: 'user' });
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
  });

  test('Escape is left to an open dialog or text field first', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'library');
    await page.getByRole('button', { name: 'Search commands' }).click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();
    await page.waitForTimeout(150);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    // Then a second Escape closes the editor.
    await page.keyboard.press('Escape');
    await waitForCall(page, 'editor_close', { reason: 'user' });
  });
});

test.describe('crossfade fallback', () => {
  test('a late prepared ack crossfades and still acks every stage', async ({ openEditor, page }) => {
    await openEditor();
    await recordTransitions(page);
    // Rust waits 400 ms; pretend it gave up at once.
    const open = await simulateOpen(page, [SAMPLE_PATHS.folder], 'edit', { prepareTimeoutMs: 0 });
    expect(open).toMatchObject({ morph: false, preparedInTime: false });
    await expect.poll(() => acks(page)).toEqual(['1:prepared', '1:revealed', '1:expanded']);
    expect(await transitions(page)).toEqual(['crossfade']);
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');

    await simulateClose(page, 'hide');
    expect(await acks(page)).toEqual(['1:prepared', '1:revealed', '1:expanded', '1:collapsed', '1:cleared']);
    // morph=false fades out without a proxy.
    expect((await transitions(page)).at(-1)).toBe('crossfade');
  });

  test('reduced motion crossfades', async ({ openEditor, page }) => {
    await openEditor({ settings: { motion: 'reduced' } });
    await recordTransitions(page);
    const open = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    expect(open.morph).toBe(false);
    expect(open.timedOut).toEqual([]);
    expect(await transitions(page)).toEqual(['crossfade']);
  });
});

test.describe('stale sessions', () => {
  test('commands for another session are ignored', async ({ openEditor, page }) => {
    await openEditor();
    const { session } = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await designLoaded(page);
    const rect = { x: 32, y: 32, w: 148, h: 148 };
    const stale: Array<[EditorCmd, AckStage]> = [
      [{ type: 'collapse', session: session + 5, boxRect: rect, then: 'hide', icon: null, morph: true }, 'collapsed'],
      [{ type: 'clear', session: session - 1 }, 'cleared'],
      [{ type: 'reveal', session: session + 1 }, 'revealed'],
      [{ type: 'expand', session: 0, morph: true }, 'expanded'],
    ];
    for (const [cmd] of stale) await pushEditorCmd(page, cmd);
    // A later command for the live session still goes through (proves the stale ones were processed).
    await pushEditorCmd(page, { type: 'navigate', view: 'library' });
    await expect(page.getByTestId('library-view')).toBeVisible();
    for (const [cmd, stage] of stale) {
      expect(await waitForAck(page, (cmd as { session: number }).session, stage, 50)).toBe(false);
    }
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');
    expect(await acks(page)).toEqual([`${session}:prepared`, `${session}:revealed`, `${session}:expanded`]);
  });

  test('an older Prepare cannot reopen a finished session', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await simulateClose(page);
    await simulateOpen(page, [], 'start');
    const items = await makeItems(page, [SAMPLE_PATHS.steam]);
    await pushEditorCmd(page, {
      type: 'prepare',
      session: 1,
      boxRect: { x: 0, y: 0, w: 148, h: 148 },
      items,
      view: 'edit',
      settings: await backendSettings(page),
      morph: true,
    });
    await pushEditorCmd(page, { type: 'navigate', view: 'history' });
    await expect(page.getByTestId('history-view')).toBeVisible();
    expect((await acks(page)).filter((a) => a === '1:prepared')).toHaveLength(1);
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');
  });
});

test.describe('mailbox commands', () => {
  test('navigate, addItems and settings reach the open editor', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await designLoaded(page);
    await pushEditorCmd(page, { type: 'navigate', view: 'settings' });
    await expect(page.getByTestId('settings-view')).toBeVisible();

    const more = await makeItems(page, [SAMPLE_PATHS.site, SAMPLE_PATHS.folder]);
    await pushEditorCmd(page, { type: 'addItems', items: more });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reskinSession: { queue: unknown[] } }).__reskinSession.queue.length))
      .toBe(3);

    await page.evaluate(() => window.__e2e!.setSettings({ theme: 'light' }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('about opens Settings at the About section', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'about');
    await expect(page.getByTestId('about-version')).toBeInViewport();
    await expect(page.getByTestId('about-version')).toContainText('1.0.0-e2e');
  });
});

test.describe('morph gallery', () => {
  for (const tone of ['dark', 'light'] as const) {
    test(`mid-morph frames (${tone})`, async ({ openEditor, page }) => {
      test.slow();
      await openEditor({ settings: { theme: tone, animationSpeed: 0.5 }, accent: '#0078d4' });
      await wallpaper(page, tone);
      const items = await makeItems(page, [SAMPLE_PATHS.steam]);
      const boxRect = { x: 1080, y: 520, w: 148, h: 148 };
      await pushEditorCmd(page, {
        type: 'prepare',
        session: 1,
        boxRect,
        items,
        view: 'edit',
        settings: await backendSettings(page),
        morph: true,
      });
      await waitForAck(page, 1, 'prepared');
      await shoot(page, `editor-shell-morph-0-proxy${tone === 'light' ? '-light' : ''}.png`);
      await pushEditorCmd(page, { type: 'reveal', session: 1 });
      await waitForAck(page, 1, 'revealed');
      await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
      for (const [i, ms] of [70, 140, 320].entries()) {
        await page.waitForTimeout(i === 0 ? ms : ms - [70, 140, 320][i - 1]!);
        await shoot(page, `editor-shell-morph-${i + 1}${tone === 'light' ? '-light' : ''}.png`);
      }
      expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    });
  }
});
