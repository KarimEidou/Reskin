// The floating box: pointer, keyboard, OS drag-and-drop and Rust events,
// against the fake backend. Also renders every skin for visual review.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { BoxSkin } from '../src/lib/ipc/types';
import { iconRect, metricsFor, visualRect } from '../src/lib/ui/box-geometry';
import {
  calls,
  editorState,
  emit,
  expect,
  inspectReturns,
  makeItems,
  openPage,
  pushEditorCmd,
  SAMPLE_PATHS,
  setInspectDelay,
  setSettings,
  simulateBoxReturn,
  simulateClose,
  simulateOpen,
  test,
  waitForAck,
  waitForCall,
} from './support/fixtures';

const TWO = [SAMPLE_PATHS.steam, SAMPLE_PATHS.site];

test.describe('drag and drop', () => {
  test('drag enter arms the box, shows the count and inspects immediately', async ({ openBox, page }) => {
    const box = await openBox();
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await expect(box.visual).toHaveAttribute('data-state', 'armed');
    await expect(box.badge).toHaveText('2');
    // Early inspect: inspect_paths runs at enter, before any drop.
    const inspect = await waitForCall(page, 'inspect_paths');
    expect(inspect.args).toEqual({ paths: TWO });
    expect(await calls(page, 'open_editor')).toHaveLength(0);

    await box.dragOver({ x: 60, y: 80 });
    await box.expectState('armed');
  });

  test('a single item shows no badge', async ({ openBox }) => {
    const box = await openBox();
    await box.dragEnter([SAMPLE_PATHS.steam]);
    await box.expectState('armed');
    await expect(box.badge).toHaveCount(0);
  });

  test('drag leave returns to idle', async ({ openBox, page }) => {
    const box = await openBox();
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await box.dragLeave();
    await box.expectState('idle');
    await expect(box.badge).toHaveCount(0);
    expect(await calls(page, 'open_editor')).toHaveLength(0);
  });

  test('drop absorbs the icon, then opens the editor on the inspected items', async ({ openBox, page }) => {
    const box = await openBox();
    const items = await makeItems(page, TWO);
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await waitForCall(page, 'inspect_paths');

    await box.drop(TWO, { x: 30, y: 120 });
    await box.expectState('absorbing');
    expect(await calls(page, 'open_editor')).toHaveLength(0);

    const open = await waitForCall(page, 'open_editor');
    expect(open.args).toEqual({ items: items.map((i) => i.id), view: 'edit' });
    // The inspection started at enter was reused for the drop.
    expect(await calls(page, 'inspect_paths')).toHaveLength(1);
    // Hand-off picture: settled box holding the first icon and the count.
    await box.expectState('idle');
    await expect(box.icon).toHaveAttribute('src', items[0]!.icon!);
    await expect(box.badge).toHaveText('2');
    // The icon sits exactly on box-geometry's iconRect (what the editor FLIPs from).
    await box.expectStatic();
    const expected = iconRect(metricsFor('medium'));
    const bb = (await box.icon.boundingBox())!;
    expect(bb.x).toBeCloseTo(expected.x, 1);
    expect(bb.y).toBeCloseTo(expected.y, 1);
    expect(bb.width).toBeCloseTo(expected.w, 1);
    expect(bb.height).toBeCloseTo(expected.h, 1);
  });

  test('a drop waits for a slow inspection before absorbing', async ({ openBox, page }) => {
    const box = await openBox();
    await setInspectDelay(page, 900);
    await box.dragEnter([SAMPLE_PATHS.folder]);
    await box.drop([SAMPLE_PATHS.folder]);
    await box.expectState('absorbing');
    // Still holding (armed look) while the inspection runs.
    await expect(box.visual).toHaveAttribute('data-state', 'armed');
    await box.waitForVisualState('absorbing', 3000);
    const open = await waitForCall(page, 'open_editor');
    expect((open.args.items as string[]).length).toBe(1);
    expect(open.args.view).toBe('edit');
  });

  test('a drop without a preceding enter still works', async ({ openBox, page }) => {
    const box = await openBox();
    await box.drop([SAMPLE_PATHS.exe]);
    await box.expectState('absorbing');
    await waitForCall(page, 'open_editor', { view: 'edit' });
  });

  test('nothing inspectable shakes the box and never opens the editor', async ({ openBox, page }) => {
    const box = await openBox();
    await inspectReturns(page, []);
    await box.dragEnter([SAMPLE_PATHS.notes]);
    await box.expectState('armed');
    await box.drop([SAMPLE_PATHS.notes]);
    await box.expectState('error');
    await expect(box.root.getByRole('status')).toHaveText(/can be reskinned/);
    // The shake settles back to idle.
    await box.expectState('idle', 4000);
    expect(await calls(page, 'open_editor')).toHaveLength(0);
  });

  test('unreadable items are skipped; all unreadable is an error', async ({ openBox, page }) => {
    const box = await openBox();
    await box.drop([SAMPLE_PATHS.unreadable]);
    await box.expectState('error');
    await box.expectState('idle', 4000);

    await box.drop([SAMPLE_PATHS.unreadable, SAMPLE_PATHS.image]);
    const open = await waitForCall(page, 'open_editor');
    expect((open.args.items as string[]).length).toBe(1);
  });

  test('an absorb cancelled mid-flight does not leak into the next drop', async ({ openBox, page }) => {
    // Half speed: the icon's flight into the box lasts ~600 ms.
    const box = await openBox({ settings: { animationSpeed: 0.5 } });
    await box.drop([SAMPLE_PATHS.steam]);
    // The inspected icon is flying in and the box gulps…
    await box.waitForVisualState('absorbing');
    // …when something else takes over the box.
    await box.flight('error', null, 'Could not update the shortcut');
    await box.expectState('error');
    await box.expectState('idle', 4000);
    expect(await calls(page, 'open_editor')).toHaveLength(0);

    await setInspectDelay(page, 1200);
    const [notes] = await makeItems(page, [SAMPLE_PATHS.notes]);
    await box.drop([SAMPLE_PATHS.notes]);
    await box.expectState('absorbing');
    // Holding (armed look) while the slow inspection runs — not gulping.
    await expect(box.visual).toHaveAttribute('data-state', 'armed');
    await page.waitForTimeout(300);
    await expect(box.visual).toHaveAttribute('data-state', 'armed');
    const open = await waitForCall(page, 'open_editor');
    expect(open.args).toEqual({ items: [notes!.id], view: 'edit' });
    expect(await calls(page, 'open_editor')).toHaveLength(1);
  });

  test('a failing inspection is an error too', async ({ openBox, page }) => {
    const box = await openBox();
    await page.evaluate(() => window.__e2e!.failNext('inspect_paths', 'access denied'));
    await box.dragEnter([SAMPLE_PATHS.steam]);
    await box.drop([SAMPLE_PATHS.steam]);
    await box.expectState('error');
    await expect(box.root.getByRole('status')).toHaveText('access denied');
  });
});

test.describe('pointer and keyboard', () => {
  test('click runs the native drag loop, then opens the start view', async ({ openBox, page }) => {
    const box = await openBox();
    await box.hit.click();
    const drag = await waitForCall(page, 'box_drag');
    const open = await waitForCall(page, 'open_editor');
    expect(open.args).toEqual({ items: [], view: 'start' });
    expect(open.t).toBeGreaterThan(drag.t);
  });

  test('a click snaps to the handoff picture the editor proxy reproduces', async ({ openBox, page }) => {
    const box = await openBox();
    await box.hit.hover();
    await box.expectState('hover');
    await box.expectStatic();
    await box.hit.click();
    await waitForCall(page, 'open_editor', { view: 'start' });
    // No hover → idle transition left running under the editor's proxy.
    expect(await box.runningAnimations()).toBe(0);
    await expect(box.visual).toHaveAttribute('data-state', 'idle');
    await expect(box.visual.locator('.body')).toHaveCSS('transform', 'none');
    await expect(box.visual.locator('.body')).toHaveCSS('opacity', '0.92');
  });

  test('a drag that moved the box does not open the editor', async ({ openBox, page }) => {
    const box = await openBox({ boxDragResult: 'moved' });
    await box.hit.click();
    await waitForCall(page, 'box_drag');
    await page.waitForTimeout(250);
    expect(await calls(page, 'open_editor')).toHaveLength(0);
    await box.expectState('hover');
  });

  test('right-click opens the native menu at the pointer', async ({ openBox, page }) => {
    const box = await openBox();
    await box.hit.click({ button: 'right', position: { x: 40, y: 52 } });
    const menu = await waitForCall(page, 'box_menu');
    expect(menu.args).toEqual({ x: 40, y: 52 });
    expect(await calls(page, 'box_drag')).toHaveLength(0);
  });

  test('Enter and Space open the start view from the keyboard', async ({ openBox, page }) => {
    const box = await openBox();
    await expect(box.hit).toHaveAttribute('role', 'button');
    await box.hit.focus();
    await page.keyboard.press('Enter');
    await waitForCall(page, 'open_editor', { view: 'start' });
    expect(await calls(page, 'box_drag')).toHaveLength(0);

    await emit(page, 'box:shown', null);
    await box.expectState('idle');
    await page.evaluate(() => window.__e2e!.clearCalls());
    await box.hit.focus();
    await page.keyboard.press('Space');
    await waitForCall(page, 'open_editor', { items: [], view: 'start' });
  });

  test('the first-run hint stays until a few seconds after the welcome closes', async ({ openBox, page }) => {
    // Animation speed 2 halves the hint's 6 s lifetime.
    const box = await openBox({ firstRun: true, settings: { animationSpeed: 2 } });
    const hint = box.visual.locator('.hint');
    await expect(hint).toHaveText('Drag a shortcut onto me');
    // The welcome is still open over the (hidden) box: the hint waits.
    await page.waitForTimeout(3500);
    await expect(hint).toHaveCount(1);
    // The welcome collapsed into the box: now the clock runs.
    await emit(page, 'box:shown', null);
    await page.waitForTimeout(1500);
    await expect(hint).toHaveCount(1);
    await expect(hint).toHaveCount(0, { timeout: 4000 });
  });

  test('dragging something onto the box ends the first-run hint', async ({ openBox, page }) => {
    const box = await openBox({ firstRun: true });
    await expect(box.visual.locator('.hint')).toHaveCount(1);
    await box.drop([SAMPLE_PATHS.steam]);
    await waitForCall(page, 'open_editor');
    await emit(page, 'box:shown', null);
    await box.expectState('idle');
    await expect(box.visual.locator('.hint')).toHaveCount(0);
  });

  test('hover lifts the box and leaving settles it', async ({ openBox }) => {
    const box = await openBox();
    await box.hit.hover();
    await box.expectState('hover');
    await box.pointerAway();
    await box.expectState('idle');
  });
});

test.describe('events from Rust', () => {
  test('box:flight legs drive the state', async ({ openBox, page }) => {
    const box = await openBox();
    const [item] = await makeItems(page, [SAMPLE_PATHS.steam]);
    await box.flight('depart', item!.icon);
    await box.expectState('flying');
    await expect(box.icon).toHaveAttribute('src', item!.icon!);
    await box.flight('land');
    await box.expectState('celebrate');
    await expect(box.visual.locator('.burst')).toHaveCount(1);
    await box.flight('return');
    await box.expectState('flying');
    await box.flight('home');
    await box.expectState('idle');
    await expect(box.icon).toHaveCount(0);
  });

  test('celebrate in place and flight errors', async ({ openBox }) => {
    const box = await openBox();
    await box.flight('celebrate');
    await box.expectState('celebrate');
    await box.expectState('idle', 4000);
    await box.flight('error', null, 'Could not update the shortcut');
    await box.expectState('error');
    await expect(box.root.getByRole('status')).toHaveText('Could not update the shortcut');
  });

  test('box:progress shows the busy ring until done', async ({ openBox }) => {
    const box = await openBox();
    await box.progress(1, 3);
    await box.expectState('busy');
    await expect(box.ring).toHaveCount(1);
    await expect(box.ring.locator('.bar')).toHaveCSS('stroke-dasharray', /33\.3/);
    await box.progress(2, 3);
    await expect(box.ring.locator('.bar')).toHaveCSS('stroke-dasharray', /66\.7/);
    await box.progress(3, 3);
    await box.expectState('idle');
    await expect(box.ring).toHaveCount(0);
  });

  test('box:shown ends the hand-off', async ({ openBox, page }) => {
    const box = await openBox();
    await box.drop([SAMPLE_PATHS.steam]);
    await waitForCall(page, 'open_editor');
    await expect(box.icon).toHaveCount(1);
    // Frozen during the hand-off: hovering does not lift it.
    await box.hit.hover();
    await box.expectState('idle');
    await emit(page, 'box:shown', null);
    await expect(box.icon).toHaveCount(0);
    await box.pointerAway();
    await box.hit.hover();
    await box.expectState('hover');
  });

  test('the close handoff: the hidden box takes over the proxy picture, then confirms it', async ({ openBox, page }) => {
    const box = await openBox();
    // Handed over to the editor: frozen on the dropped icon.
    const [dropped] = await makeItems(page, [SAMPLE_PATHS.steam]);
    await box.drop([SAMPLE_PATHS.steam]);
    await waitForCall(page, 'open_editor');
    await expect(box.icon).toHaveAttribute('src', dropped!.icon!);

    // Rust, with the box still hidden: the proxy collapsed carrying the new icon.
    const [applied] = await makeItems(page, [SAMPLE_PATHS.notes]);
    await emit(page, 'box:collapse', { session: 7, then: 'fly', icon: applied!.icon });
    await expect(box.icon).toHaveAttribute('src', applied!.icon!);
    await box.expectState('idle');
    await expect(box.badge).toHaveCount(0);
    // Not shown yet: nothing painted, nothing confirmed.
    await page.waitForTimeout(100);
    expect(await calls(page, 'box_painted')).toHaveLength(0);

    // Shown under the editor: it keeps the picture and confirms it.
    await emit(page, 'box:shown', null);
    await waitForCall(page, 'box_painted', { session: 7 });
    await expect(box.icon).toHaveAttribute('src', applied!.icon!);
    // Still frozen until the flight carries the icon on.
    await box.hit.hover();
    await box.expectState('idle');
    await box.flight('depart', applied!.icon);
    await box.expectState('flying');
    await expect(box.icon).toHaveAttribute('src', applied!.icon!);
  });

  test('the collapse picture is confirmed only once its icon is decoded', async ({ openBox, page }) => {
    const box = await openBox();
    const [applied] = await makeItems(page, [SAMPLE_PATHS.notes]);
    // Decoding takes a while (a big icon on a busy machine); an image that
    // is not decoded yet paints as nothing.
    type Decoded = { __decodedAt?: number };
    await page.evaluate(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function (this: HTMLImageElement) {
        await new Promise((r) => setTimeout(r, 120));
        await decode.call(this);
        (window as Decoded).__decodedAt = performance.now();
      };
    });
    const { session } = await simulateBoxReturn(page, 'fly', applied!.icon);
    const painted = await waitForCall(page, 'box_painted', { session });
    await expect(box.icon).toHaveAttribute('src', applied!.icon!);
    const decodedAt = await page.evaluate(() => (window as Decoded).__decodedAt ?? null);
    expect(decodedAt).not.toBeNull();
    expect(painted.t).toBeGreaterThan(decodedAt!);
  });

  test('a quick plain close brings the box back empty, not with the dropped icon', async ({ openBox, page }) => {
    const box = await openBox();
    await box.drop([SAMPLE_PATHS.steam]);
    await waitForCall(page, 'open_editor');
    await expect(box.icon).toHaveCount(1);
    const back = await simulateBoxReturn(page, 'hide');
    expect(back.painted).toBe(true);
    await expect(box.icon).toHaveCount(0);
    await box.expectState('idle');
    // At rest again: hovering lifts it.
    await box.hit.hover();
    await box.expectState('hover');
  });

  test("the box shows exactly the picture the editor's proxy collapsed onto", async ({ openBox, page, context }) => {
    const box = await openBox();
    const [applied] = await makeItems(page, [SAMPLE_PATHS.notes]);
    const m = metricsFor('medium');
    const region = { x: 0, y: 0, width: m.window, height: m.window };

    // The editor (its own page) collapses onto its proxy at the box's place.
    const editor = await context.newPage();
    await openPage(editor, 'editor');
    await simulateOpen(editor, [SAMPLE_PATHS.steam], 'edit');
    const { session } = await editorState(editor);
    await pushEditorCmd(editor, {
      type: 'collapse',
      session,
      boxRect: { x: 0, y: 0, w: m.window, h: m.window },
      then: 'celebrate',
      icon: applied!.icon,
      morph: true,
    });
    expect(await waitForAck(editor, session, 'collapsed')).toBe(true);
    const proxy = PNG.sync.read(await editor.screenshot({ clip: region, omitBackground: true }));

    const back = await simulateBoxReturn(page, 'celebrate', applied!.icon);
    expect(back.painted).toBe(true);
    await box.expectStatic();
    const shown = PNG.sync.read(await page.screenshot({ clip: region, omitBackground: true }));

    let differing = 0;
    let painted = 0;
    for (let i = 0; i < proxy.data.length; i += 4) {
      const d = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(proxy.data[i + c]! - shown.data[i + c]!)));
      if (d > 8) differing++;
      if (shown.data[i + 3]! > 0) painted++;
    }
    expect(painted).toBeGreaterThan(m.visual * m.visual * 0.5);
    expect(differing).toBe(0);
    await editor.close();
  });

  test('box:undo offers Undo, which restores the entry', async ({ openBox, page }) => {
    const box = await openBox();
    await emit(page, 'box:undo', 'h-42');
    await expect(box.undo).toBeVisible();
    await box.undo.click();
    const restore = await waitForCall(page, 'restore');
    expect(restore.args).toEqual({ target: { type: 'entry', id: 'h-42' } });
    await expect(box.undo).toHaveCount(0);
  });

  test('settings:changed restyles the box', async ({ openBox, page }) => {
    const box = await openBox();
    await expect(box.root).toHaveAttribute('data-skin', 'glass');
    await setSettings(page, { boxSkin: 'neon', idleOpacity: 0.5 });
    await expect(box.root).toHaveAttribute('data-skin', 'neon');
    await expect(box.visual).toHaveClass(/skin-neon/);
    await expect(box.visual.locator('.body')).toHaveCSS('opacity', '0.5');
    await setSettings(page, { boxSize: 'large' });
    await expect(box.root).toHaveCSS('width', '176px');
  });

  test('the box paints only its configured look (no flash of defaults at startup)', async ({ openBox, page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { skinsSeen: string[] }).skinsSeen = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.bv')) {
          const look = `${el.getAttribute('data-skin')}:${document.documentElement.dataset.theme ?? 'unset'}`;
          if (!seen.includes(look)) seen.push(look);
        }
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    const box = await openBox({ settings: { boxSkin: 'neon', theme: 'light' } });
    await expect(box.visual).toHaveAttribute('data-skin', 'neon');
    expect(await page.evaluate(() => (window as unknown as { skinsSeen: string[] }).skinsSeen)).toEqual([
      'neon:light',
    ]);
  });

  test('smoke mode reports readiness after the first paint', async ({ openBox, page }) => {
    await openBox({ smoke: true });
    const ready = await waitForCall(page, 'smoke_ready');
    expect(ready.args.report).toMatchObject({ window: 'box' });
  });
});

test.describe('compatibility mode', () => {
  // Rust clips the opaque box window to the visual box (a rounded window
  // region), so everything must stay inside it.
  test('keeps the box, the badge and the busy ring inside the visual box', async ({ openBox }) => {
    const box = await openBox({ settings: { compatibilityMode: true } });
    await expect(box.visual).toHaveClass(/compat/);
    const v = visualRect(metricsFor('medium'));
    const expectInside = (r: { x: number; y: number; width: number; height: number } | null) => {
      expect(r).not.toBeNull();
      expect(r!.x).toBeGreaterThanOrEqual(v.x);
      expect(r!.y).toBeGreaterThanOrEqual(v.y);
      expect(r!.x + r!.width).toBeLessThanOrEqual(v.x + v.w);
      expect(r!.y + r!.height).toBeLessThanOrEqual(v.y + v.h);
    };

    await box.dragEnter(TWO);
    await box.expectState('armed');
    await expect(box.visual.locator('.body')).toHaveCSS('transform', 'none');
    expectInside(await box.badge.boundingBox());
    await box.dragLeave();

    await box.progress(1, 3);
    await box.expectState('busy');
    // The stroke's geometry (its soft glow may bleed into the clip).
    expectInside(
      await box.ring.locator('.bar').evaluate((el) => {
        const path = el as SVGPathElement;
        const b = path.getBBox();
        const half = parseFloat(getComputedStyle(path).strokeWidth) / 2;
        return { x: b.x - half, y: b.y - half, width: b.width + 2 * half, height: b.height + 2 * half };
      }),
    );
    await box.progress(3, 3);

    await box.hit.hover();
    await box.expectState('hover');
    await expect(box.visual.locator('.body')).toHaveCSS('transform', 'none');
  });
});

test.describe('motion', () => {
  test('idle is static: no animation runs at rest', async ({ openBox }) => {
    const box = await openBox();
    await box.expectStatic();
    // Arming starts the particle loop; leaving stops everything again.
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await expect.poll(() => box.runningAnimations()).toBeGreaterThan(0);
    await box.dragLeave();
    await box.expectState('idle');
    await box.expectStatic();
  });

  test('reduced motion removes movement', async ({ openBox }) => {
    const box = await openBox({ settings: { motion: 'reduced' } });
    await expect(box.visual).toHaveClass(/reduced/);
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await expect(box.visual.locator('.particles')).toHaveCount(0);
    await box.expectStatic();
  });
});

// ---------------------------------------------------------------------------
// The fake backend itself (later specs build on it). A minimal stand-in
// editor runs in the page: it long-polls editor_next and acks each handoff
// stage, optionally late.
// ---------------------------------------------------------------------------

interface FakeEditorOptions {
  /** Delay before acking `prepared` (ms). */
  prepareDelayMs?: number;
}

interface FakeEditorLog {
  /** Command types, in order. */
  seen: string[];
  /** Command types per `editor_next` response. */
  batches: string[][];
  /** The `expand` commands received. */
  expands: Array<{ session: number; morph: boolean }>;
}

async function startFakeEditor(page: Page, opts: FakeEditorOptions = {}): Promise<void> {
  await page.evaluate(({ prepareDelayMs = 0 }) => {
    type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    type Env = { seq: number; cmd: { type: string; session?: number; morph?: boolean } };
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
    const log: FakeEditorLog = { seen: [], batches: [], expands: [] };
    (window as unknown as { fakeEditor: FakeEditorLog }).fakeEditor = log;
    const stages: Record<string, string> = {
      prepare: 'prepared',
      reveal: 'revealed',
      expand: 'expanded',
      collapse: 'collapsed',
      clear: 'cleared',
    };
    void (async () => {
      let after = 0;
      for (;;) {
        const batch = (await invoke('editor_next', { after })) as Env[];
        log.batches.push(batch.map((env) => env.cmd.type));
        for (const env of batch) {
          after = env.seq;
          log.seen.push(env.cmd.type);
          if (env.cmd.type === 'expand') log.expands.push({ session: env.cmd.session!, morph: env.cmd.morph! });
          const stage = stages[env.cmd.type];
          if (!stage) continue;
          if (stage === 'prepared' && prepareDelayMs) await new Promise((r) => setTimeout(r, prepareDelayMs));
          await invoke('editor_ack', { session: env.cmd.session, stage });
        }
      }
    })();
  }, opts);
}

const fakeEditorLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { fakeEditor: FakeEditorLog }).fakeEditor);
const seenByEditor = async (page: Page) => (await fakeEditorLog(page)).seen;

test.describe('fake backend', () => {
  test('simulateOpen / simulateClose run the handoff protocol', async ({ openBox, page }) => {
    await openBox();
    await startFakeEditor(page);
    const open = await simulateOpen(page, [SAMPLE_PATHS.steam], 'edit');
    expect(open).toEqual({ session: 1, morph: true, preparedInTime: true, timedOut: [] });
    expect(await editorState(page)).toEqual({ session: 1, phase: 'open', visible: true, morph: true });
    const close = await simulateClose(page, 'fly', { icon: 'data:image/png;base64,AAAA' });
    expect(close).toEqual({ session: 1, timedOut: [] });
    expect(await seenByEditor(page)).toEqual(['prepare', 'reveal', 'expand', 'collapse', 'clear']);
    expect(await editorState(page)).toMatchObject({ phase: 'closed', visible: false });
    const acks = await page.evaluate(() => window.__e2e!.acks.map((a) => `${a.session}:${a.stage}`));
    expect(acks).toEqual(['1:prepared', '1:revealed', '1:expanded', '1:collapsed', '1:cleared']);
  });

  test('a late prepared ack falls back to a crossfade, like Rust', async ({ openBox, page }) => {
    await openBox();
    await startFakeEditor(page, { prepareDelayMs: 650 });
    const open = await simulateOpen(page, [SAMPLE_PATHS.folder], 'edit');
    expect(open).toMatchObject({ session: 1, morph: false, preparedInTime: false, timedOut: ['prepared'] });
    expect((await editorState(page)).morph).toBe(false);
    const log = await fakeEditorLog(page);
    // Rust's fallback does not wait for `revealed`: Reveal and a crossfade
    // Expand are queued back to back, so the editor gets them together.
    expect(log.batches).toContainEqual(['reveal', 'expand']);
    expect(log.expands).toEqual([{ session: 1, morph: false }]);
  });

  test('editor_close from the page runs the close handoff', async ({ openBox, page }) => {
    await openBox();
    await startFakeEditor(page);
    await simulateOpen(page, [SAMPLE_PATHS.steam], 'start');
    await page.evaluate(() =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
        'editor_close',
        { reason: 'user' },
      ),
    );
    await expect.poll(async () => (await editorState(page)).phase).toBe('closed');
    expect(await seenByEditor(page)).toContain('clear');
  });

  test('the mailbox heartbeats after silence and keeps unacknowledged commands', async ({ openBox, page }) => {
    await openBox({ heartbeatMs: 120 });
    const result = await page.evaluate(async () => {
      const api = window.__e2e!;
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__.invoke;
      const hb = (await invoke('editor_next', { after: 0 })) as Array<{ seq: number; cmd: { type: string } }>;
      const seq = api.pushEditorCmd({ type: 'navigate', view: 'library' });
      const first = (await invoke('editor_next', { after: hb[0]!.seq })) as Array<{ seq: number }>;
      // Not acknowledged yet (a reload would poll from the same position).
      const again = (await invoke('editor_next', { after: hb[0]!.seq })) as Array<{ seq: number }>;
      return { hb: hb.map((e) => e.cmd.type), seq, first: first.map((e) => e.seq), again: again.map((e) => e.seq) };
    });
    expect(result.hb).toEqual(['heartbeat']);
    expect(result.first).toEqual([result.seq]);
    expect(result.again).toEqual([result.seq]);
  });

  test('stateful commands: apply, history, restore, library, export, frames, wallpaper', async ({ openBox, page }) => {
    await openBox();
    const out = await page.evaluate(async (paths) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__.invoke;
      const [item] = (await invoke('inspect_paths', { paths })) as Array<{ id: string; kind: string; modes: string[] }>;
      const frames = (await invoke('item_frames', { item: item!.id })) as Array<{ width: number; png: string }>;
      const req = {
        item: item!.id,
        images: frames.map((f) => ({ size: f.width, png: f.png })),
        designName: 'Neon',
        mode: 'inPlace',
        flourish: false,
        updatePins: false,
      };
      const applied = (await invoke('apply_icon', { req })) as { type: string; entries: Array<{ id: string; state: string }> };
      const history = (await invoke('history_list')) as Array<{ id: string; state: string }>;
      const report = await invoke('restore', { target: { type: 'entry', id: applied.entries[0]!.id } });
      const after = (await invoke('history_list')) as Array<{ state: string }>;
      const saved = (await invoke('library_save', { entry: { id: null, name: 'Mine', thumb: '', data: '{"v":1}' } })) as { id: string; bytes: number };
      const loaded = await invoke('library_load', { id: saved.id });
      await invoke('library_delete', { id: saved.id });
      const list = (await invoke('library_list')) as unknown[];
      const exported = await invoke('export_file', { req: { kind: 'ico', suggestedName: 'steam', images: [], data: null } });
      const wallpaper = new Uint8Array((await invoke('wallpaper')) as ArrayBuffer);
      const unknown = await invoke('open_editor', { items: ['nope'], view: 'edit' }).catch((e: unknown) => String(e));
      return {
        kind: item!.kind,
        modes: item!.modes,
        sizes: frames.map((f) => f.width),
        applied: applied.type,
        historyState: history[0]!.state,
        report,
        afterState: after[0]!.state,
        bytes: saved.bytes,
        loaded,
        list: list.length,
        exported,
        jpeg: [wallpaper[0], wallpaper[1]],
        unknown,
      };
    }, [SAMPLE_PATHS.steam]);
    expect(out).toEqual({
      kind: 'shortcut',
      modes: ['inPlace'],
      sizes: [16, 24, 32, 48, 64, 256],
      applied: 'applied',
      historyState: 'applied',
      report: { restored: 1, failed: [], needsElevation: 0 },
      afterState: 'restored',
      bytes: 7,
      loaded: '{"v":1}',
      list: 0,
      exported: 'C:\\Users\\e2e\\Pictures\\steam.ico',
      jpeg: [0xff, 0xd8],
      unknown: 'unknown item nope',
    });
  });

  test('item kinds, locations and the elevation outcome', async ({ openBox, page }) => {
    await openBox();
    const items = await makeItems(page, Object.values(SAMPLE_PATHS));
    const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
    expect(byPath[SAMPLE_PATHS.site]).toMatchObject({ kind: 'internetShortcut', location: 'userDesktop' });
    expect(byPath[SAMPLE_PATHS.folder]).toMatchObject({ kind: 'folder', name: 'Projects' });
    expect(byPath[SAMPLE_PATHS.exe]).toMatchObject({ kind: 'executable', modes: ['newShortcut'] });
    expect(byPath[SAMPLE_PATHS.image]).toMatchObject({ kind: 'image', modes: [], iconSource: 'image' });
    expect(byPath[SAMPLE_PATHS.project]).toMatchObject({ kind: 'project', icon: null });
    expect(byPath[SAMPLE_PATHS.publicShortcut]).toMatchObject({
      location: 'publicDesktop',
      access: 'needsElevation',
      modes: ['inPlace', 'personalCopy'],
    });
    expect(byPath[SAMPLE_PATHS.unreadable]).toBeUndefined();
    for (const item of items) {
      if (item.kind !== 'project') expect(item.icon).toMatch(/^data:image\/png;base64,/);
    }

    await page.evaluate(() =>
      window.__e2e!.setApplyOutcome({ type: 'needsElevation', ticket: 't-1', reason: 'Public desktop' }),
    );
    const outcome = await page.evaluate(async (id) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__.invoke;
      const frames = (await invoke('item_frames', { item: id })) as Array<{ width: number; png: string }>;
      const req = {
        item: id,
        images: frames.map((f) => ({ size: f.width, png: f.png })),
        designName: null,
        mode: 'inPlace',
        flourish: false,
        updatePins: false,
      };
      const first = (await invoke('apply_icon', { req })) as { type: string };
      const elevated = (await invoke('apply_icon_elevated', { ticket: 't-1' })) as {
        type: string;
        entries: Array<{ elevated: boolean; kind: string; thumb: string | null }>;
      };
      const reused = await invoke('apply_icon_elevated', { ticket: 't-1' }).catch((e: unknown) => String(e));
      return {
        first: first.type,
        elevated: elevated.type,
        entry: { elevated: elevated.entries[0]!.elevated, kind: elevated.entries[0]!.kind, thumb: !!elevated.entries[0]!.thumb },
        reused,
      };
    }, byPath[SAMPLE_PATHS.publicShortcut]!.id);
    expect(outcome).toEqual({
      first: 'needsElevation',
      elevated: 'applied',
      entry: { elevated: true, kind: 'shortcut', thumb: true },
      reused: 'unknown or expired ticket',
    });
  });
});

// ---------------------------------------------------------------------------
// Visual review: every skin idle + armed (not assertions). Set
// RESKIN_SCREENSHOTS=1 to refresh the reference PNGs in e2e/__screenshots__.
// ---------------------------------------------------------------------------

const SKINS: BoxSkin[] = ['glass', 'neon', 'minimal', 'aurora'];
const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

/**
 * Paints a desktop-like wallpaper (a Windows 11 "bloom" around the box)
 * behind the transparent box window, so translucency shows.
 */
async function wallpaper(page: Page, tone: 'dark' | 'light'): Promise<void> {
  const bg =
    tone === 'dark'
      ? [
          'radial-gradient(90px 80px at 26px 22px, rgb(124 92 255 / 0.55), transparent 100%)',
          'radial-gradient(170px 170px at 118px 124px, #4f94ff 0%, #2458d0 34%, #10286a 70%, #070d1f 100%)',
        ].join(', ')
      : [
          'radial-gradient(110px 90px at 130px 140px, rgb(124 170 255 / 0.7), transparent 100%)',
          'radial-gradient(190px 190px at 34px 26px, #ffffff 0%, #e2ecff 40%, #b3cbf5 80%, #9dbbef 100%)',
        ].join(', ');
  await page.addStyleTag({ content: `html, body { background: ${bg} !important; }` });
}

/** Screenshot of the box window, attached to the report (and saved when refreshing). */
async function shoot(page: Page, name: string): Promise<void> {
  const png = await page.locator('main.box-page').screenshot({ animations: 'allow' });
  await test.info().attach(name, { body: png, contentType: 'image/png' });
  if (process.env.RESKIN_SCREENSHOTS === '1') {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, name), png);
  }
}

test.describe('skin gallery', () => {
  test.use({ deviceScaleFactor: 2 });

  test('glass states', async ({ openBox, page }) => {
    const box = await openBox({ firstRun: true, accent: '#0078d4' });
    await wallpaper(page, 'dark');
    await box.expectStatic();
    await shoot(page, 'box-glass-hint.png');

    await box.hit.hover();
    await box.expectState('hover');
    await page.waitForTimeout(450);
    await shoot(page, 'box-glass-hover.png');
    await box.pointerAway();

    await box.drop(TWO, { x: 20, y: 130 });
    await waitForCall(page, 'open_editor');
    await box.expectStatic();
    await shoot(page, 'box-glass-handoff.png');
    await emit(page, 'box:shown', null);

    await box.progress(2, 3);
    await page.waitForTimeout(300);
    await shoot(page, 'box-glass-busy.png');
    await box.progress(3, 3);

    const [item] = await makeItems(page, [SAMPLE_PATHS.site]);
    await box.flight('depart', item!.icon);
    await page.waitForTimeout(450);
    await shoot(page, 'box-glass-flying.png');
    await box.flight('land');
    await page.waitForTimeout(260);
    await shoot(page, 'box-glass-celebrate.png');
    await box.flight('home');

    await box.flight('error', null, 'Access denied');
    await page.waitForTimeout(90);
    await shoot(page, 'box-glass-error.png');
    await box.expectState('idle', 4000);

    await setSettings(page, { compatibilityMode: true });
    await box.expectStatic();
    await shoot(page, 'box-glass-compat.png');
  });

  test('glass compatibility mode (clipped like the Rust window region)', async ({ openBox, page }) => {
    const box = await openBox({ settings: { compatibilityMode: true }, accent: '#0078d4' });
    await wallpaper(page, 'dark');
    const m = metricsFor('medium');
    await page.addStyleTag({
      content: `main.box-page { clip-path: inset(${m.margin}px round ${m.radius}px); }`,
    });
    await box.dragEnter(TWO);
    await box.expectState('armed');
    await page.waitForTimeout(700);
    await shoot(page, 'box-glass-compat-armed.png');
    await box.dragLeave();
    await box.progress(2, 3);
    await page.waitForTimeout(300);
    await shoot(page, 'box-glass-compat-busy.png');
  });

  for (const skin of SKINS) {
    for (const tone of ['dark', 'light'] as const) {
      test(`${skin} (${tone})`, async ({ openBox, page }) => {
        const box = await openBox({
          settings: { boxSkin: skin, theme: tone },
          accent: '#0078d4',
        });
        await expect(box.visual).toHaveAttribute('data-skin', skin);
        await wallpaper(page, tone);
        const suffix = tone === 'light' ? '-light' : '';

        await box.expectStatic();
        await shoot(page, `box-${skin}-idle${suffix}.png`);

        await box.dragEnter(TWO);
        await box.expectState('armed');
        await page.waitForTimeout(700);
        await shoot(page, `box-${skin}-armed${suffix}.png`);
      });
    }
  }
});
