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

const frame = (page: Page) => page.getByTestId('morph-frame');

/** Waits until the opened item's design is loaded (it switches to Edit when done). */
const designLoaded = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __reskinSession: { hasDesign: boolean } }).__reskinSession.hasDesign);
const proxy = (page: Page) => page.getByTestId('box-proxy');

/**
 * Nothing of the panel shows behind the proxy: it is laid out but fully
 * transparent, and its shield takes the pointer.
 */
async function expectPanelTransparent(page: Page): Promise<void> {
  const panel = page.getByTestId('editor-panel');
  for (const part of ['shadow', 'shell', 'content']) await expect(panel.locator(`:scope > .${part}`)).toHaveCSS('opacity', '0');
  const hit = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.className ?? '';
  });
  expect(hit).toContain('shield');
}

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
    const el = document.querySelector('[data-testid="morph-frame"]')!;
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
    // Nothing of the panel shows yet.
    await expectPanelTransparent(page);
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
    expect(open).toEqual({ session: 1, morph: true, preparedInTime: true, boxPainted: null, timedOut: [] });
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
    await expectPanelTransparent(page);

    await pushEditorCmd(page, { type: 'clear', session });
    expect(await waitForAck(page, session, 'cleared')).toBe(true);
    await expect(frame(page)).toHaveAttribute('data-mode', 'hidden');
  });

  test('floating layers (tooltips, menus, popovers) show only over the open panel', async ({ openEditor, page }) => {
    // Half speed: the collapse runs about a second.
    await openEditor({ settings: { animationSpeed: 0.5 } });
    const { session } = await simulateOpen(page, [], 'start');
    // Portalled out of the panel, a floating layer is marked as one…
    await page.getByRole('button', { name: 'Close editor' }).hover();
    await expect(page.getByRole('tooltip')).toHaveAttribute('data-floating-layer', '');
    // …and the page hides every one while the panel is not open.
    await page.evaluate(() => {
      const layer = document.createElement('div');
      layer.setAttribute('data-floating-layer', '');
      layer.dataset.testid = 'floating-probe';
      layer.textContent = 'Floating';
      layer.style.cssText = 'position: fixed; left: 40px; top: 40px';
      document.body.append(layer);
    });
    const probe = page.getByTestId('floating-probe');
    await expect(probe).toBeVisible();
    await pushEditorCmd(page, { type: 'collapse', session, boxRect: { x: 32, y: 32, w: 148, h: 148 }, then: 'hide', icon: null, morph: true });
    await expect(page.locator('html')).toHaveAttribute('data-stage', 'animating');
    await expect(probe).toBeHidden();
    expect(await waitForAck(page, session, 'collapsed')).toBe(true);
    await expect(probe).toBeHidden();
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

  test('a modal scrim never paints the transparent shadow margin', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    await page.waitForTimeout(400);
    const shot = async () => PNG.sync.read(await page.screenshot({ omitBackground: true }));
    const alphaIn = (png: PNG, x: number, y: number) => png.data[(y * png.width + x) * 4 + 3]!;
    const before = await shot();
    await page.getByRole('button', { name: 'Restore all icons…' }).click();
    await expect(page.getByRole('dialog', { name: 'Restore all icons?' })).toBeVisible();
    await page.waitForTimeout(400);
    const after = await shot();
    const { width: w, height: h } = after;
    // The 12 px margin around the panel (corners, edge midpoints) looks the
    // same as without the dialog: only the panel's own shadow, no scrim…
    for (const [x, y] of [
      [2, 2],
      [w - 3, 2],
      [2, h - 3],
      [w - 3, h - 3],
      [Math.round(w / 2), 3],
      [3, Math.round(h / 2)],
      [w - 4, Math.round(h / 2)],
      [Math.round(w / 2), h - 4],
    ] as const) {
      expect(Math.abs(alphaIn(after, x, y) - alphaIn(before, x, y)), `alpha at ${x},${y}`).toBeLessThanOrEqual(1);
    }
    expect(alphaIn(after, 2, 2)).toBe(0);
    // …while the panel under the scrim is painted.
    expect(alphaIn(after, 40, 200)).toBeGreaterThan(200);
  });

  test('a closing editor ignores the keyboard', async ({ openEditor, page }) => {
    await openEditor({ settings: { animationSpeed: 0.5 } });
    const { session } = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await designLoaded(page);
    const tool = () => page.evaluate(() => (window as unknown as { __reskinSession: { engine: { selectedToolId: string } } }).__reskinSession.engine.selectedToolId);
    const before = await tool();
    await pushEditorCmd(page, { type: 'collapse', session, boxRect: { x: 32, y: 32, w: 148, h: 148 }, then: 'hide', icon: null, morph: true });
    // Caught on the frame it starts: a busy machine can run the whole
    // collapse between two of expect's polls.
    await page.waitForFunction(() => document.documentElement.dataset.stage === 'animating', undefined, { polling: 'raf' });
    await page.keyboard.press('e');
    await page.keyboard.press('Escape');
    expect(await waitForAck(page, session, 'collapsed')).toBe(true);
    expect(await tool()).toBe(before);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
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

  test('Escape used by a window listener added after the App does not close', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [], 'start');
    // Like the canvas stage, whose window listeners come with the Edit view
    // (long after the App's): it uses the key and calls preventDefault.
    await page.evaluate(() =>
      window.addEventListener('keydown', (e) => e.key === 'Escape' && e.preventDefault(), { once: true }),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    // The next Escape nothing uses closes the editor.
    await page.keyboard.press('Escape');
    await waitForCall(page, 'editor_close', { reason: 'user' });
  });

  test('Escape during a brush stroke cancels the stroke, not the editor', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await designLoaded(page);
    const canvas = page.getByTestId('canvas');
    const r = (await canvas.boundingBox())!;
    await page.keyboard.press('b');
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 40, r.y + r.height / 2 + 30, { steps: 4 });
    const interacting = () =>
      page.evaluate(() => (window as unknown as { __reskinSession: { engine: { isInteracting: boolean } } }).__reskinSession.engine.isInteracting);
    expect(await interacting()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await interacting()).toBe(false);
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');
  });

  test('Escape never closes over a pending move, wherever focus is', async ({ openEditor, page }) => {
    await openEditor();
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    await designLoaded(page);
    await page.getByTestId('tool-move').click();
    const r = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 40, r.y + r.height / 2, { steps: 4 });
    await page.mouse.up();
    const pending = () =>
      page.evaluate(() => (window as unknown as { __reskinSession: { engine: { hasPending: boolean } } }).__reskinSession.engine.hasPending);
    expect(await pending()).toBe(true);

    // Focus in a non-modal overlay that has no use for Escape: the canvas
    // leaves the key alone there, and nothing else says it was used.
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Probe');
      overlay.innerHTML = '<button type="button">Probe</button>';
      document.body.append(overlay);
      overlay.querySelector('button')!.focus();
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    expect(await pending()).toBe(true);

    // On the canvas Escape cancels the move; only the next one closes.
    await page.getByRole('dialog', { name: 'Probe' }).evaluate((el) => el.remove());
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Escape');
    await expect.poll(pending).toBe(false);
    await page.waitForTimeout(150);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    await page.keyboard.press('Escape');
    await waitForCall(page, 'editor_close', { reason: 'user' });
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

  test('a hidden box leaves no proxy: only the panel fades in', async ({ openEditor, page }) => {
    await openEditor();
    await recordTransitions(page);
    // Record every proxy that ever appears.
    await page.evaluate(() => {
      const w = window as unknown as { __proxies: number };
      w.__proxies = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="box-proxy"]')) w.__proxies++;
      }).observe(document.body, { subtree: true, childList: true });
    });
    const [item] = await makeItems(page, [SAMPLE_PATHS.steam]);
    await pushEditorCmd(page, {
      type: 'prepare',
      session: 1,
      boxRect: null,
      items: [item!],
      view: 'edit',
      settings: await backendSettings(page),
      morph: false,
    });
    expect(await waitForAck(page, 1, 'prepared')).toBe(true);
    await expect(frame(page)).toHaveAttribute('data-mode', 'hidden');
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    await pushEditorCmd(page, { type: 'expand', session: 1, morph: false });
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    await expect(frame(page)).toHaveAttribute('data-mode', 'open');
    expect(await transitions(page)).toEqual(['crossfade']);
    expect(await page.evaluate(() => (window as unknown as { __proxies: number }).__proxies)).toBe(0);
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

test.describe('landing', () => {
  test('the box icon settles exactly on the document on the canvas', async ({ openEditor, page }) => {
    await openEditor();
    const boxRect = { x: 1080, y: 520, w: 148, h: 148 };
    await prepare(page, 1, boxRect);
    // The workspace is mounted (Expand waits for a slow item, but not forever).
    await designLoaded(page);
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    // Hold the icon's flight: it never starts playing (on a busy machine
    // the whole flight can pass between two polls).
    type Held = { __play?: Animation['play'] };
    await page.evaluate(() => {
      const play = Animation.prototype.play;
      (window as Held).__play = play;
      Animation.prototype.play = function (this: Animation) {
        const target = (this.effect as KeyframeEffect | null)?.target;
        if (!target?.matches('img.flyer')) play.call(this);
      };
    });
    await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
    await page.waitForFunction(() => (document.querySelector('img.flyer')?.getAnimations().length ?? 0) > 0);
    // Hold every animation at its end: where the icon lands.
    await freezeAt(page, 1);
    await page.evaluate(() => (Animation.prototype.play = (window as Held).__play!));
    const landed = (await page.locator('img.flyer').boundingBox())!;
    const doc = (await page.getByTestId('canvas-stage').locator('.doc-overlay').boundingBox())!;
    expect(doc.width).toBeGreaterThan(100);
    expect(Math.abs(landed.x - doc.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(landed.y - doc.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(landed.width - doc.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(landed.height - doc.height)).toBeLessThanOrEqual(1);
    await resume(page);
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
  });

  /** Holds every `item_frames` answer until `release()` (in the page). */
  async function holdItemFrames(page: Page): Promise<void> {
    await page.evaluate(() => {
      type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
      const w = window as unknown as { __release?: () => void; __TAURI_INTERNALS__: { invoke: Invoke } };
      const inner = w.__TAURI_INTERNALS__.invoke;
      const held = new Promise<void>((r) => (w.__release = r));
      w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) =>
        cmd === 'item_frames' ? held.then(() => inner(cmd, args, opts)) : inner(cmd, args, opts);
    });
  }
  const release = (page: Page) => page.evaluate(() => (window as unknown as { __release: () => void }).__release());

  test('the morph waits behind the proxy until the opened item is on the canvas', async ({ openEditor, page }) => {
    await openEditor();
    await recordTransitions(page);
    await holdItemFrames(page);
    await prepare(page, 1, { x: 1080, y: 520, w: 148, h: 148 });
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
    // Still loading: the proxy stays, nothing of the panel shows.
    await page.waitForTimeout(400);
    await expect(frame(page)).toHaveAttribute('data-mode', 'proxy');
    await expectPanelTransparent(page);
    expect(await transitions(page)).toEqual([]);
    // Then it morphs into the Edit view.
    await release(page);
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    expect(await transitions(page)).toEqual(['morph']);
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('an item that takes longer than a second arrives in the open panel', async ({ openEditor, page }) => {
    await openEditor();
    await holdItemFrames(page);
    await prepare(page, 1, { x: 1080, y: 520, w: 148, h: 148 });
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    const expand = await page.evaluate(() => performance.now());
    await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    // Within the protocol's time box (Rust waits 2.5 s for `expanded`).
    const expanded = await page.evaluate(() => window.__e2e!.acks.find((a) => a.stage === 'expanded')!.t);
    expect(expanded - expand).toBeLessThan(2500);
    await expect(page.getByText('Loading the icon…')).toBeVisible();
    await release(page);
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('the workspace regions enter one after another', async ({ openEditor, page }) => {
    await openEditor();
    await prepare(page, 1, { x: 1080, y: 520, w: 148, h: 148 });
    await designLoaded(page);
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    // Record the regions' entrances as they start (polling could miss them).
    type Entered = { __entered?: Array<{ panel: string; delay: number }> };
    await page.evaluate(() => {
      const entered: Array<{ panel: string; delay: number }> = [];
      (window as Entered).__entered = entered;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        const animation = animate.apply(this, args);
        const panel = this instanceof HTMLElement ? this.dataset.panel : undefined;
        if (panel) entered.push({ panel, delay: Number(animation.effect?.getTiming().delay ?? 0) });
        return animation;
      };
    });
    await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    const list = await page.evaluate(() => (window as Entered).__entered!);
    expect(list.map((d) => d.panel)).toEqual(['rail', 'options', 'stage', 'sidebar', 'bottom']);
    for (let i = 1; i < list.length; i++) expect(list[i]!.delay).toBeGreaterThan(list[i - 1]!.delay);
  });
});

test.describe('mailbox commands', () => {
  test('a slow handoff step keeps the mailbox polling without acknowledging it', async ({ openEditor, page }) => {
    // Half speed: the expand runs about a second (Rust takes a mailbox
    // silent for 2 s for a dead page).
    await openEditor({ settings: { animationSpeed: 0.5 } });
    await prepare(page, 1, { x: 1080, y: 520, w: 148, h: 148 });
    await pushEditorCmd(page, { type: 'reveal', session: 1 });
    expect(await waitForAck(page, 1, 'revealed')).toBe(true);
    const start = await page.evaluate(() => performance.now());
    const seq = await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
    expect(await waitForAck(page, 1, 'expanded')).toBe(true);
    const acked = (await page.evaluate(() => window.__e2e!.acks)).find((a) => a.stage === 'expanded')!.t;
    const during = (await calls(page, 'editor_next')).filter((c) => c.t > start && c.t < acked);
    expect(acked - start).toBeGreaterThan(700);
    expect(during.length).toBeGreaterThanOrEqual(1);
    for (const poll of during) expect(poll.args.after).toBeLessThan(seq);
  });

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

/**
 * Pauses every running animation at `fraction` of its own timeline (delay
 * included), so a screenshot shows one exact moment of the morph.
 */
type Frozen = { __frozen?: Set<Animation> };

/**
 * Waits until the morph plays (the frame sets `data-transition`), then
 * freezes every animation of it at one moment: `fraction` of the whole
 * morph, up to the end of its last animation (the shell, the fading shadow,
 * the content and the regions entering after one another, all on one
 * clock); an animation over by then is held at its end. `resume` lets
 * them go on.
 */
async function freezeAt(page: Page, fraction: number): Promise<void> {
  await expect(frame(page)).toHaveAttribute('data-transition', /.+/);
  await page.evaluate((f) => {
    const endOf = (a: Animation) => {
      const t = a.effect?.getComputedTiming();
      return Number(t?.delay ?? 0) + Number(t?.activeDuration ?? 0);
    };
    const w = window as unknown as Frozen;
    // Held at their end, animations no longer show in getAnimations().
    const frozen = (w.__frozen ??= new Set());
    for (const a of document.getAnimations()) if (Number.isFinite(endOf(a))) frozen.add(a);
    const at = Math.max(...[...frozen].map(endOf)) * f;
    for (const a of frozen) {
      a.pause();
      a.currentTime = Math.min(at, endOf(a));
    }
  }, fraction);
}

/** Lets the animations `freezeAt` holds go on; those held at their end finish there. */
async function resume(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Frozen;
    for (const a of w.__frozen ?? []) {
      const t = a.effect?.getComputedTiming();
      if (Number(a.currentTime) >= Number(t?.delay ?? 0) + Number(t?.activeDuration ?? 0)) a.finish();
      else a.play();
    }
    w.__frozen = undefined;
  });
}

test.describe('morph gallery', () => {
  for (const tone of ['dark', 'light'] as const) {
    test(`mid-morph frames (${tone})`, async ({ openEditor, page }) => {
      test.slow();
      await openEditor({ settings: { theme: tone }, accent: '#0078d4' });
      await wallpaper(page, tone);
      const suffix = tone === 'light' ? '-light' : '';
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
      await shoot(page, `editor-shell-morph-0-proxy${suffix}.png`);
      await pushEditorCmd(page, { type: 'reveal', session: 1 });
      await waitForAck(page, 1, 'revealed');
      await pushEditorCmd(page, { type: 'expand', session: 1, morph: true });
      // Three moments of the expand — the last as the panel's shadow (a
      // layer of its own) fades in — then let it finish.
      for (const [i, f] of [0.1, 0.4, 0.85].entries()) {
        await freezeAt(page, f);
        await shoot(page, `editor-shell-morph-${i + 1}${suffix}.png`);
      }
      await resume(page);
      expect(await waitForAck(page, 1, 'expanded')).toBe(true);
      await expect(frame(page)).toHaveAttribute('data-mode', 'open');

      // And one moment of the collapse back into the box.
      await pushEditorCmd(page, { type: 'collapse', session: 1, boxRect, then: 'hide', icon: null, morph: true });
      await freezeAt(page, 0.3);
      await shoot(page, `editor-shell-morph-4-collapse${suffix}.png`);
      await resume(page);
      expect(await waitForAck(page, 1, 'collapsed')).toBe(true);
    });
  }
});
