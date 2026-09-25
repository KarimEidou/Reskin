// The Edit view around the canvas: tool rail and flyouts, tool options,
// symmetry, zoom, the batch queue, pixel-art mode, before/after, colour
// chips, image paste — and reference screenshots of the whole editor.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { EditorSession } from '../src/editor/state/session.svelte';
import { contrast } from '../src/lib/theme/color';
import { expect, SAMPLE_PATHS, simulateOpen, test, type E2EConfig } from './support/fixtures';

type Point = { x: number; y: number };
type Handle = { __reskinSession: EditorSession };

/** Opens editor.html and runs the open handoff with `paths`; waits for the design. */
async function openWorkspace(page: Page, paths: string[] = [SAMPLE_PATHS.steam], config: E2EConfig = {}): Promise<void> {
  await page.addInitScript((c) => {
    window.__E2E_CONFIG__ = c;
  }, config);
  await page.goto('/editor.html');
  const wired = await page
    .waitForFunction(() => !!window.__e2e?.calls.some((c) => c.cmd === 'editor_next'), null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  test.skip(!wired, 'the editor shell does not run the mailbox in this checkout');
  await simulateOpen(page, paths);
  await page.waitForFunction(() => (globalThis as unknown as Partial<Handle>).__reskinSession?.hasDesign === true);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Evaluates `fn` against the e2e session handle. */
function withSession<T>(page: Page, fn: (s: EditorSession) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(globalThis.__reskinSession)`) as Promise<T>;
}

/** Selects a tool through the engine (like the rail, without clicking). */
function setTool(page: Page, id: string): Promise<void> {
  return page.evaluate((t) => (globalThis as unknown as Handle).__reskinSession.engine.setTool(t as never), id);
}

function compositeHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = (globalThis as unknown as Handle).__reskinSession.engine.composite();
    let h = 0x811c9dc5;
    for (let i = 0; i < c.data.length; i++) h = Math.imul(h ^ c.data[i]!, 0x01000193);
    return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`;
  });
}

async function toClient(page: Page, p: Point): Promise<Point> {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const vp = await withSession(page, (s) => ({ panX: s.engine.viewport!.panX, panY: s.engine.viewport!.panY, scale: s.engine.viewport!.scale }));
  return { x: box.x + vp.panX + p.x * vp.scale, y: box.y + vp.panY + p.y * vp.scale };
}

async function stroke(page: Page, from: Point, to: Point): Promise<void> {
  const a = await toClient(page, from);
  const b = await toClient(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

/** RGBA of the on-screen canvas at a document point (what the user sees). */
async function screenPixel(page: Page, p: Point): Promise<number[]> {
  const c = await toClient(page, p);
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="canvas"]')!;
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    const d = canvas.getContext('2d')!.getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]!];
  }, c);
}

test.describe('tool rail', () => {
  test('selects tools, groups open a flyout, the rail is one tab stop', async ({ page }) => {
    await openWorkspace(page);
    const rail = page.getByRole('toolbar', { name: 'Tools' });
    await expect(rail.getByRole('button', { pressed: true })).toHaveCount(1);

    await rail.getByRole('button', { name: 'Pencil' }).click();
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('pencil');
    await expect(rail.getByRole('button', { name: 'Pencil' })).toHaveAttribute('aria-pressed', 'true');

    // Right-click opens the selection group's flyout.
    await page.getByTestId('tool-selectRect').click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: /Ellipse select/ }).click();
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('selectEllipse');
    // The slot now shows the ellipse tool.
    await expect(page.getByTestId('tool-selectEllipse')).toHaveAttribute('aria-pressed', 'true');

    // Keyboard: arrows move along the rail, → opens a flyout.
    await page.getByTestId('tool-selectEllipse').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('tool-brush')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    const tabStops = await rail.locator('button[data-rail-tool][tabindex="0"]').count();
    expect(tabStops).toBe(1);
  });

  test('a flyout closed from the keyboard gives focus back to its slot; arrows on the colour chips stay there', async ({ page }) => {
    await openWorkspace(page);
    const menu = page.getByRole('menu');
    // → opens the flyout on its first tool; ↓ Enter chooses the next one.
    await page.getByTestId('tool-selectRect').focus();
    await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('menuitemcheckbox', { name: /Rectangle select/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('selectEllipse');
    // Focus is on the slot's tool, where ↓ moves along the rail (the
    // corner trigger would open the flyout again).
    await expect(page.getByTestId('tool-selectEllipse')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('tool-brush')).toBeFocused();
    await expect(menu).toHaveCount(0);

    // Escape closes it the same way.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('tool-selectEllipse')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('tool-move')).toBeFocused();
    await expect(menu).toHaveCount(0);

    // The colour chips are not rail slots: the arrows leave their focus alone.
    await page.getByTestId('color-primary').focus();
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      await page.keyboard.press(key);
      await expect(page.getByTestId('color-primary'), key).toBeFocused();
    }
  });

  test('colour chips: picker, swap (X) and reset (D)', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('color-primary').click();
    const picker = page.getByRole('dialog', { name: 'Primary colour' });
    await expect(picker).toBeVisible();
    const hex = picker.getByRole('textbox', { name: 'Primary colour: hex' });
    await hex.fill('#7c5cff');
    await hex.press('Enter');
    expect(await withSession(page, (s) => s.engine.primary)).toEqual({ r: 124, g: 92, b: 255, a: 1 });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    // The picked colour joins the recent colours.
    await expect.poll(() => page.evaluate(() => window.__e2e!.settings.recentColors[0])).toBe('#7c5cff');

    await page.getByTestId('canvas').focus();
    await page.keyboard.press('x');
    expect(await withSession(page, (s) => s.engine.secondary)).toEqual({ r: 124, g: 92, b: 255, a: 1 });
    await page.keyboard.press('d');
    expect(await withSession(page, (s) => [s.engine.primary, s.engine.secondary])).toEqual([
      { r: 0, g: 0, b: 0, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    ]);
  });

  test('Tab past either end of the colour picker closes it: back to its chip, or on to what follows the chip', async ({ page }) => {
    await openWorkspace(page);
    const chip = page.getByTestId('color-primary');
    const picker = page.getByRole('dialog', { name: 'Primary colour' });
    /** Focuses the picker's first or last focusable control. */
    const focusEnd = (end: 'first' | 'last') =>
      picker.evaluate((el, which) => {
        const all = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
        const shown = all.filter((c) => !c.matches(':disabled') && c.tabIndex >= 0 && c.getClientRects().length > 0);
        (which === 'first' ? shown[0] : shown.at(-1))!.focus();
      }, end);

    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(picker.getByRole('textbox', { name: 'Primary colour: hex' })).toBeVisible();
    await focusEnd('first');
    await page.keyboard.press('Shift+Tab');
    await expect(picker).toHaveCount(0);
    await expect(chip).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(picker.getByRole('textbox', { name: 'Primary colour: hex' })).toBeVisible();
    await focusEnd('last');
    await page.keyboard.press('Tab');
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Swap colours' })).toBeFocused();

    // Inside the picker, Tab still moves between its controls.
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(picker.getByRole('textbox', { name: 'Primary colour: hex' })).toBeVisible();
    await focusEnd('first');
    await page.keyboard.press('Tab');
    await expect(picker).toBeVisible();
    expect(await picker.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== el)).toBe(true);
  });
});

test.describe('tool options', () => {
  test('options bar controls change the engine options', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    const options = page.getByTestId('tool-options');
    await expect(options).toHaveAttribute('data-tool', 'brush');

    // Pill slider: typed value (double-click) and dragging the range.
    await options.getByRole('slider', { name: 'Size' }).dblclick();
    const entry = options.getByRole('textbox', { name: 'Size (px)' });
    await entry.fill('40');
    await entry.press('Enter');
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').size)).toBe(40);
    // Keys step the value itself (the size slider is logarithmic).
    await options.getByRole('slider', { name: 'Size' }).press('ArrowRight');
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').size)).toBe(41);
    await options.getByRole('slider', { name: 'Size' }).press('Shift+ArrowLeft');
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').size)).toBe(31);
    await options.getByRole('slider', { name: 'Hardness' }).fill('25');
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').hardness)).toBe(0.25);

    // More options: every option with exact number entry.
    await options.getByRole('button', { name: 'More brush options' }).click();
    const more = page.getByRole('dialog', { name: 'Brush options' });
    // Whole numbers keep their zeros (100 %, not "1").
    await expect(more.getByRole('spinbutton', { name: 'Opacity' })).toHaveValue('100');
    await expect(more.getByRole('spinbutton', { name: 'Hardness' })).toHaveValue('25');
    const flow = more.getByRole('spinbutton', { name: 'Flow' });
    await flow.fill('50');
    await flow.press('Enter');
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').flow)).toBe(0.5);
    await more.getByRole('switch', { name: 'Pressure controls size' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('brush').pressureSize)).toBe(false);
    await page.keyboard.press('Escape');

    // Toggle chips and choices on other tools.
    await page.getByTestId('tool-fill').click();
    await expect(options).toHaveAttribute('data-tool', 'fill');
    await options.getByRole('button', { name: 'Contiguous' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('fill').contiguous)).toBe(false);
    await options.getByRole('slider', { name: 'Tolerance' }).fill('100');
    expect(await withSession(page, (s) => s.engine.getToolOptions('fill').tolerance)).toBe(100);

    await withSession(page, (s) => s.engine.setTool('eyedropper'));
    await options.getByRole('radio', { name: '5 × 5' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('eyedropper').size)).toBe(5);

    await page.getByTestId('tool-shape').click();
    await options.getByRole('button', { name: /Shape:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Star' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('shape').kind)).toBe('star');
    await expect(options.getByRole('slider', { name: 'Points' })).toBeVisible();
  });

  test('text options: searchable system fonts, weight and italic follow the text being edited', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-text').click();
    const at = await toClient(page, { x: 256, y: 256 });
    await page.mouse.click(at.x, at.y);
    await page.keyboard.type('Hi');
    const options = page.getByTestId('tool-options');

    const font = options.getByRole('combobox', { name: 'Font' });
    await font.click();
    await font.fill('cons');
    const list = page.getByRole('listbox', { name: 'Fonts' });
    // Prefix matches first, then word starts, then anywhere in the name.
    await expect(list.getByRole('option')).toHaveText(['Consolas', 'Constantia', 'Lucida Console', 'Segoe Fluent Icons']);
    await font.press('ArrowDown');
    await font.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(font).toHaveValue('Constantia');
    const textProps = () =>
      withSession(page, (s) => {
        const l = s.engine.activeLayer;
        const o = s.engine.getToolOptions('text');
        return l?.kind === 'text' ? [l.text, l.fontFamily, l.weight, l.italic, o.fontFamily] : null;
      });
    expect(await textProps()).toEqual(['Hi', 'Constantia', 600, false, 'Constantia']);

    await options.getByRole('combobox', { name: 'Weight' }).selectOption('700');
    await options.getByRole('button', { name: 'Italic' }).click();
    expect(await textProps()).toEqual(['Hi', 'Constantia', 700, true, 'Constantia']);
    // The inline editor is still open on the same text.
    await expect(page.getByTestId('text-editor')).toHaveCount(1);
  });

  test('gradient stops: add, recolour and remove', async ({ page }) => {
    await openWorkspace(page);
    await withSession(page, (s) => s.engine.setTool('gradient'));
    const options = page.getByTestId('tool-options');
    await options.getByRole('radio', { name: 'Custom' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('gradient').source)).toBe('custom');
    const stops = page.getByTestId('gradient-stops');
    await expect(stops.getByRole('slider')).toHaveCount(3);

    const bar = (await stops.locator('.bar').boundingBox())!;
    await page.mouse.click(bar.x + bar.width * 0.25, bar.y + 2);
    await expect(stops.getByRole('slider')).toHaveCount(4);
    expect(await withSession(page, (s) => s.engine.getToolOptions('gradient').stops.length)).toBe(4);

    const added = stops.getByRole('slider').nth(3);
    await added.press('ArrowRight');
    expect(await withSession(page, (s) => s.engine.getToolOptions('gradient').stops[3]!.offset)).toBeCloseTo(0.26, 2);
    await added.press('Enter');
    const popover = page.getByRole('dialog', { name: 'Stop 4 colour' });
    await popover.getByRole('textbox', { name: 'Stop 4: hex' }).fill('#ff0000');
    await popover.getByRole('textbox', { name: 'Stop 4: hex' }).press('Enter');
    expect(await withSession(page, (s) => s.engine.getToolOptions('gradient').stops[3]!.color)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 1,
    });
    await popover.getByRole('button', { name: 'Remove stop' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('gradient').stops.length)).toBe(3);

    // Keyboard: every stop is a tab stop, and Insert adds one halfway to the next.
    const handles = stops.getByRole('slider');
    for (let i = 0; i < 3; i++) await expect(handles.nth(i)).toHaveAttribute('tabindex', '0');
    const before = await withSession(page, (s) => s.engine.getToolOptions('gradient').stops.map((st) => st.offset));
    await handles.nth(0).press('Insert');
    const after = await withSession(page, (s) => s.engine.getToolOptions('gradient').stops.map((st) => st.offset));
    expect(after).toHaveLength(4);
    const next = Math.min(...before.filter((o) => o > before[0]!));
    expect(after[3]).toBeCloseTo((before[0]! + next) / 2, 3);
    await expect(handles.nth(3)).toBeFocused();
  });

  test('symmetry modes and radial rays', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    const group = page.getByRole('radiogroup', { name: 'Symmetry' });
    await expect(group.getByRole('radio', { name: 'Symmetry off' })).toHaveAttribute('aria-checked', 'true');

    await group.getByRole('radio', { name: 'Mirror left and right' }).click();
    expect(await withSession(page, (s) => s.engine.symmetry.mode)).toBe('x');
    await group.getByRole('radio', { name: 'Mirror both ways' }).click();
    expect(await withSession(page, (s) => s.engine.symmetry.mode)).toBe('xy');
    await group.getByRole('radio', { name: 'Radial' }).click();
    expect(await withSession(page, (s) => s.engine.symmetry.mode)).toBe('radial');
    const rays = page.getByTestId('tool-options').getByRole('slider', { name: 'Rays' });
    await rays.fill('8');
    expect(await withSession(page, (s) => s.engine.symmetry.rays)).toBe(8);

    // A mirrored stroke in the transparent top margin paints both halves.
    const alphas = () =>
      withSession(page, (s) => {
        const c = s.engine.composite();
        const at = (x: number, y: number) => c.data[(y * c.width + x) * 4 + 3];
        return [at(90, 10), at(512 - 91, 10)];
      });
    expect(await alphas()).toEqual([0, 0]);
    await group.getByRole('radio', { name: 'Mirror left and right' }).click();
    await stroke(page, { x: 60, y: 10 }, { x: 120, y: 10 });
    await expect.poll(alphas).toEqual([255, 255]);

    await group.getByRole('radio', { name: 'Symmetry off' }).click();
    expect(await withSession(page, (s) => s.engine.symmetry.mode)).toBe('off');
    // Symmetry is only offered for painting tools.
    await page.getByTestId('tool-fill').click();
    await expect(page.getByRole('radiogroup', { name: 'Symmetry' })).toHaveCount(0);
  });

  /** The Selection menu of the options bar, and reading the selection mask back. */
  function selectionMenu(page: Page) {
    const menu = page.getByRole('menu', { name: 'Selection' });
    return {
      menu,
      open: () => page.getByTestId('selection-menu').click(),
      choose: async (item: RegExp) => {
        await page.getByTestId('selection-menu').click();
        await menu.getByRole('menuitem', { name: item }).click();
        await expect(menu).toHaveCount(0);
      },
      /** Selection coverage at document points (null: nothing selected). */
      at: (points: Point[]) =>
        withSession(page, (s) => s.engine.doc.selection).then((m) =>
          points.map((p) => (m ? m.data[p.y * m.width + p.x]! : null)),
        ),
    };
  }

  test('the Selection menu: select all, deselect, invert and layer pixels', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-selectRect').click();
    const { menu, open, choose, at } = selectionMenu(page);

    // Nothing selected yet: the commands that need a selection are off.
    await open();
    await expect(menu.getByRole('menuitem', { name: /Deselect/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Grow…/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Select all/ })).toContainText('Ctrl');
    await page.keyboard.press('Escape');

    await choose(/Select all/);
    expect(await at([{ x: 5, y: 5 }])).toEqual([255]);
    await choose(/Deselect/);
    expect(await at([{ x: 5, y: 5 }])).toEqual([null]);

    // Marquee a square and invert it.
    await stroke(page, { x: 128, y: 128 }, { x: 384, y: 384 });
    await choose(/Invert/);
    expect(await at([{ x: 256, y: 256 }, { x: 4, y: 4 }])).toEqual([0, 255]);

    // The icon's pixels: the tile is in, the transparent corner out.
    await choose(/Select layer pixels/);
    expect(await at([{ x: 256, y: 256 }, { x: 5, y: 5 }])).toEqual([255, 0]);
    expect(await withSession(page, (s) => s.engine.historyEntries.map((e) => e.label))).toEqual([
      'Select all',
      'Deselect',
      'Rectangle select',
      'Invert selection',
      'Select layer pixels',
    ]);
  });

  test('Feather… / Grow… / Shrink… / Border… ask for an amount and refine the selection in one step', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-selectRect').click();
    const { choose, at } = selectionMenu(page);
    await stroke(page, { x: 128, y: 128 }, { x: 384, y: 384 });

    await choose(/Grow…/);
    const grow = page.getByRole('dialog', { name: 'Grow selection' });
    await expect(grow.getByRole('slider', { name: 'Grow by' })).toHaveValue('2');
    await grow.getByRole('slider', { name: 'Grow by' }).fill('10');
    await grow.getByRole('button', { name: 'Grow' }).click();
    await expect(grow).toHaveCount(0);
    expect(await at([{ x: 120, y: 256 }, { x: 110, y: 256 }])).toEqual([255, 0]);

    await choose(/Shrink…/);
    const shrink = page.getByRole('dialog', { name: 'Shrink selection' });
    await shrink.getByRole('slider', { name: 'Shrink by' }).fill('20');
    await shrink.getByRole('button', { name: 'Shrink' }).click();
    expect(await at([{ x: 130, y: 256 }, { x: 140, y: 256 }])).toEqual([0, 255]);

    await choose(/Border…/);
    await page.getByRole('dialog', { name: 'Border selection' }).getByRole('button', { name: 'Border' }).click();
    // A band along the edge (x = 138): the middle is out.
    expect(await at([{ x: 138, y: 256 }, { x: 256, y: 256 }])).toEqual([255, 0]);

    await choose(/Feather…/);
    const feather = page.getByRole('dialog', { name: 'Feather selection' });
    await expect(feather.getByRole('slider', { name: 'Radius' })).toHaveValue('4');
    await feather.getByRole('button', { name: 'Feather' }).click();
    await expect(feather).toHaveCount(0);
    expect(await withSession(page, (s) => s.engine.historyEntries.map((e) => e.label))).toEqual([
      'Rectangle select',
      'Grow selection',
      'Shrink selection',
      'Border selection',
      'Feather',
    ]);

    // The prompt closes by itself when the selection goes away, or the Edit view.
    await choose(/Grow…/);
    await expect(page.getByRole('dialog', { name: 'Grow selection' })).toBeVisible();
    await withSession(page, (s) => s.engine.deselect());
    await expect(page.getByRole('dialog', { name: 'Grow selection' })).toHaveCount(0);
    await withSession(page, (s) => s.engine.selectAll());
    await choose(/Grow…/);
    await withSession(page, (s) => s.navigate('library'));
    await expect(page.getByRole('dialog', { name: 'Grow selection' })).toHaveCount(0);
    await withSession(page, (s) => s.navigate('edit'));
    await expect(page.getByTestId('selection-menu')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Grow selection' })).toHaveCount(0);
  });

  test('every selection tool has the Selection menu; painting tools have symmetry', async ({ page }) => {
    await openWorkspace(page);
    const options = page.getByTestId('tool-options');
    for (const id of ['selectRect', 'selectEllipse', 'lasso', 'magicWand'] as const) {
      await setTool(page, id);
      await expect(options).toHaveAttribute('data-tool', id);
      await expect(options.getByTestId('selection-menu')).toBeVisible();
      await expect(options.getByRole('radiogroup', { name: 'Symmetry' })).toHaveCount(0);
    }
    for (const id of ['spray', 'stamp', 'smudge', 'blurSharpen', 'dodgeBurn'] as const) {
      await setTool(page, id);
      await expect(options).toHaveAttribute('data-tool', id);
      await expect(options.getByRole('radiogroup', { name: 'Symmetry' })).toBeVisible();
      await expect(options.getByTestId('selection-menu')).toHaveCount(0);
    }
  });
});

test.describe('new tools', () => {
  // The sample icon: a tile from (40, 32) to (472, 464) whose soft shadow
  // reaches up to y = 14; the rows above are transparent.

  /** Pixels with alpha > 0 and their summed alpha in the composite's rows [y0, y1). */
  const painted = (page: Page, y0: number, y1: number) =>
    page.evaluate(
      ([a, b]) => {
        const c = (globalThis as unknown as Handle).__reskinSession.engine.composite();
        let count = 0;
        let sum = 0;
        for (let y = a!; y < b!; y++) {
          for (let x = 0; x < c.width; x++) {
            const alpha = c.data[(y * c.width + x) * 4 + 3]!;
            if (alpha > 0) count++;
            sum += alpha;
          }
        }
        return { count, sum };
      },
      [y0, y1] as const,
    );
  /** Rec. 709 luma of the composite at a point, 0..255. */
  const luma = (page: Page, p: Point) =>
    page.evaluate(({ x, y }) => {
      const c = (globalThis as unknown as Handle).__reskinSession.engine.composite();
      const i = (y * c.width + x) * 4;
      return 0.2126 * c.data[i]! + 0.7152 * c.data[i + 1]! + 0.0722 * c.data[i + 2]!;
    }, p);

  test('lasso: a freehand loop selects its inside; a polygon closes on Enter or a double-click; Escape cancels it', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('l');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('lasso');
    const mask = (p: Point) =>
      withSession(page, (s) => s.engine.doc.selection).then((m) => (m ? m.data[Math.floor(p.y) * m.width + Math.floor(p.x)] : null));

    // Freehand: drag around a square.
    const loop = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 300 },
      { x: 100, y: 300 },
      { x: 100, y: 100 },
    ];
    const start = await toClient(page, loop[0]!);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const p of loop.slice(1)) {
      const c = await toClient(page, p);
      await page.mouse.move(c.x, c.y, { steps: 6 });
    }
    await page.mouse.up();
    expect([await mask({ x: 200, y: 200 }), await mask({ x: 50, y: 50 }), await mask({ x: 350, y: 200 })]).toEqual([255, 0, 0]);

    // Polygonal, chosen in the options bar: the rail icon and a hint follow.
    const options = page.getByTestId('tool-options');
    await options.getByRole('radio', { name: 'Polygonal lasso' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('lasso').kind)).toBe('polygon');
    await expect(page.getByTestId('tool-lasso')).toHaveAttribute('data-icon', 'lasso-select');
    await expect(options).toContainText('double-click or Enter closes');

    const click = async (p: Point) => {
      const c = await toClient(page, p);
      await page.mouse.click(c.x, c.y);
    };
    const corners = () => withSession(page, (s) => s.engine.tools.lasso.polygon?.length ?? 0);
    // Escape discards the polygon being built — and does not close the editor.
    await click({ x: 60, y: 380 });
    await click({ x: 160, y: 380 });
    await click({ x: 110, y: 470 });
    expect(await corners()).toBe(6);
    await page.keyboard.press('Escape');
    expect(await corners()).toBe(0);
    expect(await mask({ x: 200, y: 200 })).toBe(255);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__e2e!.callsOf('editor_close').length)).toBe(0);

    // Enter closes it (replacing the selection).
    await click({ x: 400, y: 60 });
    await click({ x: 480, y: 60 });
    await click({ x: 440, y: 140 });
    await page.keyboard.press('Enter');
    expect(await corners()).toBe(0);
    expect([await mask({ x: 440, y: 90 }), await mask({ x: 200, y: 200 })]).toEqual([255, 0]);

    // So does a double-click on the last corner.
    await click({ x: 40, y: 200 });
    await click({ x: 90, y: 200 });
    const last = await toClient(page, { x: 65, y: 260 });
    await page.mouse.dblclick(last.x, last.y);
    expect(await corners()).toBe(0);
    expect([await mask({ x: 65, y: 220 }), await mask({ x: 440, y: 90 })]).toEqual([255, 0]);
    expect((await withSession(page, (s) => s.engine.historyEntries.map((e) => e.label))).slice(-3)).toEqual([
      'Lasso select',
      'Lasso select',
      'Lasso select',
    ]);

    // Its other options.
    await options.getByRole('slider', { name: 'Feather' }).fill('6');
    expect(await withSession(page, (s) => s.engine.getToolOptions('lasso').feather)).toBe(6);
    await options.getByRole('radio', { name: /Add to selection/ }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('lasso').mode)).toBe('add');
    await options.getByRole('button', { name: 'More lasso select options' }).click();
    await page.getByRole('dialog', { name: 'Lasso select options' }).getByRole('switch', { name: 'Smooth edges' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('lasso').antialias)).toBe(false);
  });

  test('Delete clears the selection, Backspace the layer without one; a lasso corner comes first', async ({ page }) => {
    await openWorkspace(page);
    const alpha = (p: Point) =>
      page.evaluate(({ x, y }) => {
        const c = (globalThis as unknown as Handle).__reskinSession.engine.composite();
        return c.data[(y * c.width + x) * 4 + 3];
      }, p);
    const labels = () => withSession(page, (s) => s.engine.historyEntries.map((e) => e.label));
    // The icon's tile is opaque around the middle.
    expect([await alpha({ x: 250, y: 250 }), await alpha({ x: 150, y: 150 })]).toEqual([255, 255]);

    await page.keyboard.press('m');
    await stroke(page, { x: 200, y: 200 }, { x: 300, y: 300 });
    await expect(page.getByTestId('canvas')).toBeFocused();
    await page.keyboard.press('Delete');
    expect([await alpha({ x: 250, y: 250 }), await alpha({ x: 150, y: 150 })]).toEqual([0, 255]);
    expect((await labels()).at(-1)).toBe('Clear');

    // Building a polygon, Backspace takes back its last corner: nothing is cleared.
    await page.keyboard.press('l');
    await withSession(page, (s) => s.engine.setToolOptions('lasso', { kind: 'polygon' }));
    for (const p of [
      { x: 60, y: 380 },
      { x: 160, y: 380 },
      { x: 110, y: 470 },
    ]) {
      const c = await toClient(page, p);
      await page.mouse.click(c.x, c.y);
    }
    const corners = () => withSession(page, (s) => s.engine.tools.lasso.polygon?.length ?? 0);
    expect(await corners()).toBe(6);
    const before = await labels();
    await page.keyboard.press('Backspace');
    expect(await corners()).toBe(4);
    expect(await labels()).toEqual(before);
    await page.keyboard.press('Escape');
    expect(await corners()).toBe(0);

    // Without a selection, the whole layer.
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Backspace');
    expect([await alpha({ x: 150, y: 150 }), await alpha({ x: 400, y: 400 })]).toEqual([0, 0]);
    await page.keyboard.press('Control+z');
    expect(await alpha({ x: 150, y: 150 })).toBe(255);
  });

  test('Delete during an unfinished lasso polygon takes back its last corner, not the selected pixels', async ({ page }) => {
    await openWorkspace(page);
    const alpha = (p: Point) =>
      page.evaluate(({ x, y }) => {
        const c = (globalThis as unknown as Handle).__reskinSession.engine.composite();
        return c.data[(y * c.width + x) * 4 + 3];
      }, p);
    const labels = () => withSession(page, (s) => s.engine.historyEntries.map((e) => e.label));
    await page.keyboard.press('m');
    await stroke(page, { x: 200, y: 200 }, { x: 300, y: 300 });

    await page.keyboard.press('l');
    await withSession(page, (s) => s.engine.setToolOptions('lasso', { kind: 'polygon' }));
    for (const p of [
      { x: 60, y: 380 },
      { x: 160, y: 380 },
      { x: 110, y: 470 },
    ]) {
      const c = await toClient(page, p);
      await page.mouse.click(c.x, c.y);
    }
    const corners = () => withSession(page, (s) => s.engine.tools.lasso.polygon?.length ?? 0);
    expect(await corners()).toBe(6);
    const before = await labels();
    await page.keyboard.press('Delete');
    expect(await corners()).toBe(4);
    expect(await alpha({ x: 250, y: 250 })).toBe(255);
    expect(await labels()).toEqual(before);

    // Once the polygon is gone, Delete clears the selection again.
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    expect(await corners()).toBe(0);
    expect(await alpha({ x: 250, y: 250 })).toBe(255);
    await page.keyboard.press('Delete');
    expect(await alpha({ x: 250, y: 250 })).toBe(0);
    expect((await labels()).at(-1)).toBe('Clear');
  });

  test('magic wand selects similar colour; its options come from the bar', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('w');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('magicWand');
    const options = page.getByTestId('tool-options');
    await options.getByRole('slider', { name: 'Tolerance' }).fill('8');
    expect(await withSession(page, (s) => s.engine.getToolOptions('magicWand').tolerance)).toBe(8);

    // A click in the transparent corner selects the margin around the tile.
    const corner = await toClient(page, { x: 6, y: 6 });
    await page.mouse.click(corner.x, corner.y);
    const at = (x: number, y: number) =>
      withSession(page, (s) => s.engine.doc.selection).then((m) => (m ? m.data[y * m.width + x] : null));
    expect([await at(6, 6), await at(505, 6), await at(256, 256)]).toEqual([255, 255, 0]);
    expect((await withSession(page, (s) => s.engine.historyEntries.at(-1)?.label))).toBe('Magic wand');

    await options.getByRole('button', { name: 'Contiguous' }).click();
    await options.getByRole('button', { name: 'All layers' }).click();
    expect(await withSession(page, (s) => [s.engine.getToolOptions('magicWand').contiguous, s.engine.getToolOptions('magicWand').sampleMerged])).toEqual([
      false,
      true,
    ]);
    await options.getByRole('button', { name: 'More magic wand options' }).click();
    const more = page.getByRole('dialog', { name: 'Magic wand options' });
    await more.getByRole('spinbutton', { name: 'Feather' }).fill('3');
    await more.getByRole('spinbutton', { name: 'Feather' }).press('Enter');
    await more.getByRole('switch', { name: 'Smooth edges' }).click();
    expect(await withSession(page, (s) => [s.engine.getToolOptions('magicWand').feather, s.engine.getToolOptions('magicWand').antialias])).toEqual([
      3,
      false,
    ]);
  });

  test('spray scatters dots along the stroke; Reshuffle picks a new pattern', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('a');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('spray');
    const options = page.getByTestId('tool-options');
    await options.getByRole('slider', { name: 'Density' }).fill('80');
    await options.getByRole('slider', { name: 'Dot size' }).fill('3');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('spray').density, s.engine.getToolOptions('spray').dotSize])).toEqual([0.8, 3]);
    await options.getByRole('button', { name: 'More spray options' }).click();
    const more = page.getByRole('dialog', { name: 'Spray options' });
    await more.getByRole('switch', { name: 'Pressure controls density' }).click();
    await more.getByRole('spinbutton', { name: 'Flow' }).fill('60');
    await more.getByRole('spinbutton', { name: 'Flow' }).press('Enter');
    await page.keyboard.press('Escape');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('spray').pressureDensity, s.engine.getToolOptions('spray').flow])).toEqual([
      false,
      0.6,
    ]);

    await options.getByRole('button', { name: 'Reshuffle' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('spray').seed)).toBe(2);

    // The transparent top rows get sparse dots, not a solid band.
    expect((await painted(page, 0, 13)).count).toBe(0);
    await stroke(page, { x: 60, y: 8 }, { x: 450, y: 8 });
    const dots = (await painted(page, 0, 13)).count;
    expect(dots).toBeGreaterThan(50);
    expect(dots).toBeLessThan((390 * 13) / 2);
  });

  test('smudge drags colour into the transparent margin', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('r');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('smudge');
    const options = page.getByTestId('tool-options');
    await options.getByRole('slider', { name: 'Strength' }).fill('90');
    await options.getByRole('slider', { name: 'Hardness' }).fill('80');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('smudge').strength, s.engine.getToolOptions('smudge').hardness])).toEqual([
      0.9,
      0.8,
    ]);
    expect((await painted(page, 0, 13)).count).toBe(0);
    await stroke(page, { x: 256, y: 90 }, { x: 256, y: 4 });
    expect((await painted(page, 0, 13)).count).toBeGreaterThan(100);
  });

  test('blur softens an edge; the mode switches to sharpen and the rail icon follows', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('Shift+R');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('blurSharpen');
    const rail = page.getByTestId('tool-blurSharpen');
    await expect(rail).toHaveAttribute('data-icon', 'droplets');
    const options = page.getByTestId('tool-options');
    await options.getByRole('radio', { name: 'Sharpen' }).click();
    expect(await withSession(page, (s) => s.engine.getToolOptions('blurSharpen').mode)).toBe('sharpen');
    await expect(rail).toHaveAttribute('data-icon', 'triangle');
    await options.getByRole('radio', { name: 'Blur' }).click();
    await expect(rail).toHaveAttribute('data-icon', 'droplets');
    await options.getByRole('slider', { name: 'Strength' }).fill('100');
    await options.getByRole('button', { name: 'More blur / sharpen options' }).click();
    const more = page.getByRole('dialog', { name: 'Blur / Sharpen options' });
    await more.getByRole('spinbutton', { name: 'Blur radius' }).fill('4');
    await more.getByRole('spinbutton', { name: 'Blur radius' }).press('Enter');
    await page.keyboard.press('Escape');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('blurSharpen').strength, s.engine.getToolOptions('blurSharpen').blurRadius])).toEqual([
      1,
      4,
    ]);

    // Scrub along the top edge of the tile: its opacity spreads into the margin.
    const margin = async () => (await painted(page, 18, 32)).sum;
    const before = await margin();
    for (let i = 0; i < 3; i++) await stroke(page, { x: 150, y: 30 }, { x: 360, y: 30 });
    expect(await margin()).toBeGreaterThan(before * 1.5);
  });

  test('dodge lightens and burn darkens; range and exposure come from the bar', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('o');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('dodgeBurn');
    const rail = page.getByTestId('tool-dodgeBurn');
    await expect(rail).toHaveAttribute('data-icon', 'sun');
    const options = page.getByTestId('tool-options');
    await options.getByRole('combobox', { name: 'Range' }).selectOption('highlights');
    await options.getByRole('slider', { name: 'Exposure' }).fill('100');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('dodgeBurn').range, s.engine.getToolOptions('dodgeBurn').exposure])).toEqual([
      'highlights',
      1,
    ]);
    await options.getByRole('combobox', { name: 'Range' }).selectOption('midtones');

    // On the tile, left of its letter.
    const lit = { x: 100, y: 200 };
    const before = await luma(page, lit);
    await stroke(page, { x: 60, y: 200 }, { x: 140, y: 200 });
    expect(await luma(page, lit)).toBeGreaterThan(before + 5);

    await options.getByRole('radio', { name: 'Burn' }).click();
    await expect(rail).toHaveAttribute('data-icon', 'moon');
    const dark = { x: 100, y: 330 };
    const was = await luma(page, dark);
    await stroke(page, { x: 60, y: 330 }, { x: 140, y: 330 });
    expect(await luma(page, dark)).toBeLessThan(was - 5);
  });

  test('stamp: "No sticker" until one is chosen; then a click stamps it; "Choose sticker…" opens the Stickers panel', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('s');
    expect(await withSession(page, (s) => s.engine.selectedToolId)).toBe('stamp');
    const source = page.getByTestId('stamp-source');
    await expect(source).toContainText('No sticker');
    const at = await toClient(page, { x: 100, y: 12 });
    await page.mouse.click(at.x, at.y);
    expect(await withSession(page, (s) => s.engine.historyIndex)).toBe(0);

    // A 24 px red square as the sticker.
    await page.evaluate(() => {
      const s = (globalThis as unknown as Handle).__reskinSession;
      const SurfaceClass = s.engine.composite().constructor as new (w: number, h: number) => { data: Uint8ClampedArray };
      const sticker = new SurfaceClass(24, 24);
      for (let i = 0; i < sticker.data.length; i += 4) sticker.data.set([255, 0, 0, 255], i);
      s.engine.setToolOptions('stamp', { stamp: sticker as never });
    });
    await expect(source.getByRole('img', { name: 'Current sticker' })).toBeVisible();
    await expect(source).not.toContainText('No sticker');
    // The thumbnail is drawn once per sticker, not again with every option change:
    // a mark put on it survives the rotation below.
    const thumb = source.locator('canvas');
    const mark = () =>
      thumb.evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      });
    await thumb.evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, 1, 1);
    });
    const options = page.getByTestId('tool-options');
    await options.getByRole('slider', { name: 'Rotation' }).fill('45');
    expect(await withSession(page, (s) => s.engine.getToolOptions('stamp').rotation)).toBe(45);
    expect(await mark()).toEqual([0, 255, 0, 255]);
    await options.getByRole('slider', { name: 'Rotation' }).fill('0');
    await options.getByRole('button', { name: 'More sticker stamp options' }).click();
    const more = page.getByRole('dialog', { name: 'Sticker stamp options' });
    await more.getByRole('spinbutton', { name: 'Scale' }).fill('200');
    await more.getByRole('spinbutton', { name: 'Scale' }).press('Enter');
    await more.getByRole('spinbutton', { name: 'Opacity' }).fill('50');
    await more.getByRole('spinbutton', { name: 'Opacity' }).press('Enter');
    expect(await withSession(page, (s) => [s.engine.getToolOptions('stamp').scale, s.engine.getToolOptions('stamp').opacity])).toEqual([2, 0.5]);
    await more.getByRole('spinbutton', { name: 'Scale' }).fill('100');
    await more.getByRole('spinbutton', { name: 'Scale' }).press('Enter');
    await more.getByRole('spinbutton', { name: 'Opacity' }).fill('100');
    await more.getByRole('spinbutton', { name: 'Opacity' }).press('Enter');
    await page.keyboard.press('Escape');

    await page.mouse.click(at.x, at.y);
    await expect.poll(() => withSession(page, (s) => s.engine.historyIndex)).toBe(1);
    expect(await withSession(page, (s) => s.engine.historyEntries.at(-1)?.label)).toBe('Stamp');
    await expect.poll(() => screenPixel(page, { x: 100, y: 12 })).toEqual([255, 0, 0, 255]);

    await source.getByRole('button', { name: 'Choose sticker…' }).click();
    expect(await withSession(page, (s) => s.sidebarTab)).toBe('stickers');
    await expect(page.getByTestId('stickers-panel')).toBeVisible();
  });

  test('the dab tools draw their footprint under a crosshair; the stamp says whether it can stamp', async ({ page }) => {
    await openWorkspace(page);
    const canvas = page.getByTestId('canvas');
    const at = { x: 256, y: 120 };
    const ring = { x: at.x + 40, y: at.y };
    const tools = [
      ['spray', { radius: 40 }],
      ['smudge', { size: 80 }],
      ['blurSharpen', { size: 80 }],
      ['dodgeBurn', { size: 80 }],
    ] as const;
    for (const [id, patch] of tools) {
      await page.evaluate(
        ([t, o]) => {
          const e = (globalThis as unknown as Handle).__reskinSession.engine;
          e.setTool(t as never);
          e.setToolOptions(t as never, o as never);
        },
        [id, patch] as const,
      );
      await page.mouse.move(2, 2);
      const plain = await screenPixel(page, ring);
      const c = await toClient(page, at);
      await page.mouse.move(c.x, c.y);
      await expect(canvas, id).toHaveCSS('cursor', 'crosshair');
      await expect.poll(() => screenPixel(page, ring), id).not.toEqual(plain);
    }

    await setTool(page, 'stamp');
    await expect(canvas).toHaveCSS('cursor', 'not-allowed');
    await page.evaluate(() => {
      const s = (globalThis as unknown as Handle).__reskinSession;
      const SurfaceClass = s.engine.composite().constructor as new (w: number, h: number) => unknown;
      s.engine.setToolOptions('stamp', { stamp: new SurfaceClass(24, 24) as never });
    });
    await expect(canvas).toHaveCSS('cursor', 'copy');
  });

  test('tool keys cycle through their group when pressed again', async ({ page }) => {
    await openWorkspace(page);
    const tool = () => withSession(page, (s) => s.engine.selectedToolId);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('r');
      seen.push(await tool());
    }
    expect(seen).toEqual(['smudge', 'blurSharpen', 'dodgeBurn', 'smudge']);
    // The retouch slot shows the tool it switched to.
    await page.keyboard.press('r');
    await expect(page.getByTestId('tool-blurSharpen')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('o');
    expect(await tool()).toBe('dodgeBurn');
    await page.keyboard.press('b');
    await page.keyboard.press('b');
    expect(await tool()).toBe('spray');
    await page.keyboard.press('m');
    await page.keyboard.press('m');
    expect(await tool()).toBe('selectEllipse');
  });
});

test.describe('view', () => {
  test('zoom controls, keyboard zoom, wheel zoom at the cursor and keylines', async ({ page }) => {
    await openWorkspace(page);
    const zoom = page.getByTestId('zoom-level');
    const fitZoom = await withSession(page, (s) => s.engine.viewport!.zoom);
    await expect(zoom).toHaveText(`${Math.round(fitZoom * 100)}%`);

    const bottom = page.getByTestId('bottom-bar');
    await bottom.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBeGreaterThan(fitZoom);

    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Control+1');
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBe(1);
    await expect(zoom).toHaveText('100%');
    await page.keyboard.press('Control+=');
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBe(1.5);
    await page.keyboard.press('Control+-');
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBe(1);
    await page.keyboard.press('Control+0');
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBeCloseTo(fitZoom, 5);

    // Wheel: the document point under the cursor stays put.
    const target = await toClient(page, { x: 128, y: 128 });
    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel(0, -100);
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBeGreaterThan(fitZoom);
    const after = await toClient(page, { x: 128, y: 128 });
    expect(after.x).toBeCloseTo(target.x, 0);
    expect(after.y).toBeCloseTo(target.y, 0);

    await zoom.click();
    await expect.poll(() => withSession(page, (s) => s.engine.viewport!.zoom)).toBeCloseTo(fitZoom, 5);

    const keylines = bottom.getByRole('button', { name: 'Keyline guides' });
    await expect(keylines).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('k');
    await expect(keylines).toHaveAttribute('aria-pressed', 'true');
    await keylines.click();
    await expect(keylines).toHaveAttribute('aria-pressed', 'false');
  });

  test('pixel-art mode resamples to the chosen grid and back', async ({ page }) => {
    await openWorkspace(page);
    const toggle = page.getByTestId('pixel-art-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await withSession(page, (s) => [s.engine.doc.width, s.engine.doc.pixelArt?.grid])).toEqual([32, 32]);

    await page.getByRole('combobox', { name: 'Pixel grid' }).selectOption('16');
    await expect.poll(() => withSession(page, (s) => s.engine.doc.width)).toBe(16);
    await expect.poll(() => page.evaluate(() => window.__e2e!.settings.pixelGrid)).toBe(16);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await withSession(page, (s) => [s.engine.doc.width, s.engine.doc.pixelArt])).toEqual([512, null]);
  });

  test('before/after: split view renders the original left of the divider; \\ peeks', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    await withSession(page, (s) => s.engine.setToolOptions('brush', { size: 60, hardness: 1 }));
    await stroke(page, { x: 40, y: 256 }, { x: 472, y: 256 });
    await expect.poll(() => withSession(page, (s) => s.engine.historyIndex)).toBe(1);
    expect(await screenPixel(page, { x: 128, y: 256 })).toEqual([0, 0, 0, 255]);

    await page.getByTestId('compare-toggle').click();
    expect(await withSession(page, (s) => s.compare)).toBe('split');
    const divider = page.getByTestId('compare-split');
    await expect(divider).toBeVisible();
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    // Left of the split: the original icon (no black stroke); right: the design.
    await expect.poll(() => screenPixel(page, { x: 128, y: 256 })).not.toEqual([0, 0, 0, 255]);
    expect(await screenPixel(page, { x: 384, y: 256 })).toEqual([0, 0, 0, 255]);

    // Drag the divider right: more of the original shows.
    const handle = (await divider.boundingBox())!;
    const dest = await toClient(page, { x: 448, y: 256 });
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(dest.x, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(80);
    await expect.poll(() => screenPixel(page, { x: 384, y: 256 })).not.toEqual([0, 0, 0, 255]);
    await divider.press('Home');
    await expect(divider).toHaveAttribute('aria-valuenow', '0');

    // Hold \ to see the whole original; release returns to the split view.
    await page.getByTestId('canvas').focus();
    await page.keyboard.down('Backslash');
    expect(await withSession(page, (s) => s.compare)).toBe('hold');
    await expect.poll(() => screenPixel(page, { x: 384, y: 256 })).not.toEqual([0, 0, 0, 255]);
    await page.keyboard.up('Backslash');
    expect(await withSession(page, (s) => s.compare)).toBe('split');

    await page.getByTestId('compare-toggle').click();
    expect(await withSession(page, (s) => s.compare)).toBe('off');
    await expect(divider).toHaveCount(0);
  });

  /** Pastes a `w`×`h` PNG with a coral block, as a screenshot tool puts it on the clipboard. */
  async function paste(page: Page, w = 64, h = 48): Promise<void> {
    await page.evaluate(
      async ([width, height]) => {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ff3366';
        ctx.fillRect(width / 8, height / 6, (width * 3) / 4, (height * 2) / 3);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const data = new DataTransfer();
        data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      },
      [w, h] as const,
    );
  }

  test('a pasted image asks what it becomes, where the pointer is: added as a layer', async ({ page }) => {
    await openWorkspace(page);
    const layersBefore = await withSession(page, (s) => s.engine.doc.layers.length);
    const at = await toClient(page, { x: 120, y: 100 });
    await page.mouse.move(at.x, at.y);
    await paste(page);
    const pop = page.getByTestId('import-popover');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Use “Pasted image” how?');
    // Nothing went in without asking.
    expect(await withSession(page, (s) => s.engine.doc.layers.length)).toBe(layersBefore);
    // It opens where the paste happened (the canvas's pointer), not in the middle.
    const box = (await pop.boundingBox())!;
    expect(Math.abs(box.x - at.x)).toBeLessThan(24);
    expect(box.y - at.y).toBeGreaterThanOrEqual(-4);
    expect(box.y - at.y).toBeLessThan(40);
    await expect(pop.getByRole('button', { name: /Add as layer/ })).toBeFocused();
    await pop.getByRole('button', { name: /Add as layer/ }).click();
    await expect(pop).toBeHidden();
    await expect.poll(() => withSession(page, (s) => s.engine.doc.layers.length)).toBe(layersBefore + 1);
    expect(await withSession(page, (s) => s.engine.activeLayer?.name)).toBe('Pasted image');
    const [r, g, b, a] = await withSession(page, (s) => {
      const c = s.engine.composite();
      const i = (256 * c.width + 256) * 4;
      return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
    });
    expect([r, g, b, a]).toEqual([255, 51, 102, 255]);
  });

  test('Undo takes back just the pasted layer, never work that was pending when it came', async ({ page }) => {
    await openWorkspace(page);
    const names = () => withSession(page, (s) => s.engine.doc.layers.map((l) => l.name));
    const labels = () => withSession(page, (s) => s.engine.historyEntries.map((h) => h.label));
    const before = await names();
    // A move not committed yet.
    await page.getByTestId('tool-move').click();
    await stroke(page, { x: 256, y: 256 }, { x: 300, y: 256 });
    expect(await withSession(page, (s) => s.engine.hasPending)).toBe(true);
    await paste(page, 32, 32);
    const pop = page.getByTestId('import-popover');
    await pop.getByRole('button', { name: /Add as layer/ }).click();
    await expect.poll(names).toEqual([...before, 'Pasted image']);
    // The move went in as its own step first.
    expect(await labels()).toEqual(['Move', 'Import Pasted image']);
    expect(await withSession(page, (s) => s.engine.hasPending)).toBe(false);
    await page.keyboard.press('Control+z');
    await expect.poll(names).toEqual(before);
    expect(await withSession(page, (s) => s.engine.historyIndex)).toBe(1);
  });

  test('a pasted image can join the queue as a design of its own instead', async ({ page }) => {
    await openWorkspace(page);
    const before = await withSession(page, (s) => s.engine.doc.layers.map((l) => l.name));
    await paste(page);
    const pop = page.getByTestId('import-popover');
    await pop.getByRole('button', { name: /Queue as new item/ }).click();
    await expect(pop).toBeHidden();
    await expect.poll(() => withSession(page, (s) => s.queue.map((q) => q.info.name))).toEqual(['Steam', 'Pasted image']);
    expect(await withSession(page, (s) => s.engine.doc.layers.map((l) => l.name))).toEqual(before);
    expect(await withSession(page, (s) => s.currentIndex)).toBe(0);
    await expect(page.getByRole('status').filter({ hasText: 'Added 1 item to the queue.' })).toBeVisible();
  });

  test('every toast is announced once, from the live region of its urgency', async ({ page }) => {
    await openWorkspace(page);
    /** The live regions whose text holds `text`, with what they are and whether one sits in another. */
    const regions = (text: string) =>
      page.evaluate((t) => {
        const live = (el: Element) => el.hasAttribute('aria-live') || ['status', 'alert', 'log'].includes(el.getAttribute('role') ?? '');
        const all = [...document.querySelectorAll('*')].filter(live);
        const saying = all.filter((el) => el.textContent?.includes(t));
        return {
          roles: saying.map((el) => el.getAttribute('role') ?? el.getAttribute('aria-live')),
          // A live region around or inside another is read twice.
          nested: saying.filter((el) => all.some((other) => other !== el && (other.contains(el) || el.contains(other)))).length,
          atomic: saying.map((el) => el.getAttribute('aria-atomic')),
        };
      }, text);

    await page.evaluate(() => void (globalThis as unknown as Handle).__reskinSession.saveToLibrary());
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(await regions('Saved')).toEqual({ roles: ['status'], nested: 0, atomic: ['false'] });

    await page.evaluate(() => window.__e2e!.failNext('export_file', 'the disk is full'));
    await page.evaluate(() => void (globalThis as unknown as Handle).__reskinSession.exportAs('png'));
    await expect(page.getByRole('alert').filter({ hasText: 'the disk is full' })).toBeVisible();
    expect(await regions('the disk is full')).toEqual({ roles: ['alert'], nested: 0, atomic: ['false'] });
    // The earlier toast is not in the alert region (it is not read again).
    expect(await regions('Saved')).toEqual({ roles: ['status'], nested: 0, atomic: ['false'] });
  });

  test('the canvas stage is where the open morph lands the icon', async ({ page }) => {
    await openWorkspace(page);
    const target = page.locator('[data-morph-target]');
    await expect(target).toHaveCount(1);
    await expect(target).toHaveAttribute('data-testid', 'canvas-stage');
    // The document fits it with 24 px of breathing room, as the morph assumes.
    const box = (await target.boundingBox())!;
    const doc = await withSession(page, (s) => s.engine.viewport!.scale * s.engine.doc.width);
    expect(doc).toBeCloseTo(Math.min(box.width, box.height) - 2 - 48, 0);
  });

  test('drag-and-drop over the stage lights it up', async ({ page }) => {
    await openWorkspace(page);
    const stage = page.getByTestId('canvas-stage');
    const box = (await stage.boundingBox())!;
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const position = { x: (box.x + box.width / 2) * dpr, y: (box.y + box.height / 2) * dpr };
    await page.evaluate(
      ([pos]) => window.__e2e!.emit('tauri://drag-enter', { paths: ['C:\\x.png'], position: pos }),
      [position] as const,
    );
    await expect(stage).toHaveClass(/drop/);
    await expect(stage.getByText('Drop to import')).toBeVisible();
    await page.evaluate(() => window.__e2e!.emit('tauri://drag-leave', null));
    await expect(stage).not.toHaveClass(/drop/);
  });
});

test.describe('batch queue', () => {
  test('switching items keeps each design', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    const items = page.getByTestId('queue-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('apply-style-all')).toHaveAttribute('aria-disabled', 'true');

    const original = await compositeHash(page);
    await page.getByTestId('tool-brush').click();
    await stroke(page, { x: 100, y: 100 }, { x: 400, y: 400 });
    await expect.poll(() => withSession(page, (s) => s.engine.historyIndex)).toBe(1);
    const edited = await compositeHash(page);
    expect(edited).not.toBe(original);

    await items.nth(1).click();
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => withSession(page, (s) => s.engine.doc.meta.name)).toBe('Notes');
    const notes = await compositeHash(page);
    expect(notes).not.toBe(edited);

    await items.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => compositeHash(page)).toBe(edited);
    // …and it is Steam's own document again.
    expect(await withSession(page, (s) => s.engine.doc.meta.name)).toBe('Steam');
    await expect(items.nth(0)).toHaveAccessibleName('Steam, editing');

    // Removing an item keeps the current design.
    await items.nth(2).hover();
    await page.getByRole('button', { name: 'Remove Docs Portal from the queue' }).click();
    await expect(items).toHaveCount(2);
    expect(await compositeHash(page)).toBe(edited);
  });

  test('"Apply style to all" is enabled once a style exists', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes], { applyCollapses: false });
    const applyAll = page.getByTestId('apply-style-all');
    await expect(applyAll).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => {
      const s = (globalThis as unknown as Handle).__reskinSession;
      s.recipe = {
        label: 'Invert',
        apply: (engine, layer) => {
          engine.editLayerPixels(layer, 'Invert', (surface) => {
            const d = surface.data;
            for (let i = 0; i < d.length; i += 4) {
              d[i] = 255 - d[i]!;
              d[i + 1] = 255 - d[i + 1]!;
              d[i + 2] = 255 - d[i + 2]!;
            }
          });
        },
      };
    });
    await expect(applyAll).toHaveAttribute('aria-disabled', 'false');
    await applyAll.click();
    await expect.poll(() => page.evaluate(() => window.__e2e!.callsOf('apply_icon').length)).toBe(1);
    await expect(page.getByTestId('queue-item').nth(1)).toHaveAccessibleName('Notes, applied');
  });

  test('"Apply style to all" follows undo and redo: a look the design no longer has is never replayed', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes], { applyCollapses: false });
    const applyAll = page.getByTestId('apply-style-all');
    const recipe = () => withSession(page, (s) => s.recipe?.label ?? null);
    // A look from the Adjust panel: Invert, applied.
    await page.locator('[role="tab"][data-tab="adjust"]').click();
    await page.locator('[data-filter="invert"]').click();
    await page.getByTestId('adjust-apply').click();
    await expect(applyAll).toHaveAttribute('aria-disabled', 'false');
    expect(await recipe()).toBe('Invert');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect(applyAll).toHaveAttribute('aria-disabled', 'true');
    expect(await recipe()).toBeNull();
    await page.keyboard.press('Control+y');
    await expect(applyAll).toHaveAttribute('aria-disabled', 'false');
    expect(await recipe()).toBe('Invert');
    // Undone and replaced by another change, it is gone for good.
    await page.keyboard.press('Control+z');
    await withSession(page, (s) => {
      s.engine.editLayerPixels(s.engine.activeLayer!.id, 'Paint', (surface) => surface.data.fill(255, 0, 4));
    });
    await page.keyboard.press('Control+y');
    await expect(applyAll).toHaveAttribute('aria-disabled', 'true');
    expect(await recipe()).toBeNull();
    expect(await page.evaluate(() => window.__e2e!.callsOf('apply_icon').length)).toBe(0);
  });
});

test.describe('robustness', () => {
  test('nothing loops while the editor is idle', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes]);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    // docs/UI.md: no looping animations unless something is actually happening.
    const looping = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)
        .map((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return target instanceof Element ? `${target.tagName}.${target.getAttribute('class') ?? ''}` : '?';
        }),
    );
    expect(looping).toEqual([]);
  });

  test('drawing focuses the canvas without a focus ring; Tab shows one', async ({ page }) => {
    await openWorkspace(page);
    const canvas = page.getByTestId('canvas');
    const ring = () => canvas.evaluate((el) => getComputedStyle(el).boxShadow);
    // The very first press on a fresh page (the editor opens from a drop on the box).
    await stroke(page, { x: 200, y: 200 }, { x: 300, y: 220 });
    await expect(canvas).toBeFocused();
    expect(await ring()).toBe('none');

    await page.getByTestId('tool-options').getByRole('button', { name: /^More .* options$/ }).focus();
    await page.keyboard.press('Tab');
    await expect(canvas).toBeFocused();
    expect(await ring()).not.toBe('none');
  });

  test('closing a toast from the keyboard moves focus to the next toast, then back to where it came from', async ({ page }) => {
    await openWorkspace(page);
    const origin = page.getByTestId('tool-brush');
    await origin.focus();
    await page.evaluate(() => window.__e2e!.failNext('export_file', 'the disk is full'));
    await withSession(page, (s) => void s.exportAs('png'));
    await withSession(page, (s) => void s.saveToLibrary());
    const alert = page.getByRole('alert').filter({ hasText: 'the disk is full' });
    const saved = page.getByRole('status').filter({ hasText: 'Saved' });
    // Focus in the stack stops the toasts timing out, however slow the machine.
    await alert.getByRole('button', { name: 'Dismiss notification' }).focus();
    await expect(saved).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(alert.getByText('the disk is full')).toHaveCount(0);
    await expect(saved.getByRole('button', { name: 'Dismiss notification' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(saved.getByText('Saved')).toHaveCount(0);
    await expect(origin).toBeFocused();
  });

  test('switching views from the keyboard keeps focus in the view: Delete in the Edit view then clears nothing', async ({ page }) => {
    await openWorkspace(page);
    const host = page.locator('[data-view-host]');
    const labels = () => withSession(page, (s) => s.engine.historyEntries.map((e) => e.label));
    // A control of the Edit view has focus when Ctrl+, opens Settings.
    await page.getByTestId('tool-brush').focus();
    await page.keyboard.press('Control+,');
    await expect(host).toHaveAttribute('data-view', 'settings');
    await expect(host).toBeFocused();
    // A screen reader says where focus landed: the view, by name.
    await expect(page.getByRole('main', { name: 'Settings' })).toBeFocused();

    // From a control of Settings, the palette goes back to the editor.
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').first().focus();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('Go to the editor');
    await page.keyboard.press('Enter');
    await expect(host).toHaveAttribute('data-view', 'edit');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(host).toBeFocused();
    await expect(page.getByRole('main', { name: 'Edit' })).toBeFocused();
    const before = await compositeHash(page);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    expect(await labels()).not.toContain('Clear');
    expect(await compositeHash(page)).toBe(before);
  });

  test('a press on empty space in the bars around the canvas gives the canvas its keys back', async ({ page }) => {
    await openWorkspace(page);
    const canvas = page.getByTestId('canvas');
    const labels = () => withSession(page, (s) => s.engine.historyEntries.map((e) => e.label));
    /** A point of `bar` where a press focuses nothing in it (the view host would take it). */
    const emptySpot = (testid: string) =>
      page.evaluate((id) => {
        const bar = document.querySelector(`[data-testid="${id}"]`)!;
        const host = document.querySelector('[data-view-host]');
        const r = bar.getBoundingClientRect();
        const y = r.top + r.height / 2;
        for (let x = r.right - 2; x > r.left; x -= 4) {
          const el = document.elementFromPoint(x, y);
          const focusable = el?.closest('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]');
          if (el && bar.contains(el) && focusable === host) return { x, y };
        }
        throw new Error(`no empty space in ${id}`);
      }, testid);

    // Focus on the view itself, as a view change from the keyboard leaves it: Delete there clears nothing.
    await page.locator('[data-view-host]').focus();
    await page.keyboard.press('Delete');
    expect(await labels()).not.toContain('Clear');

    // A press beside the controls of the tool options bar: the arrows nudge the layer, Enter commits.
    await page.getByTestId('tool-move').click();
    const options = await emptySpot('tool-options');
    await page.mouse.click(options.x, options.y);
    await expect(canvas).toBeFocused();
    // Focus from a press shows no ring.
    await expect(canvas).toHaveAttribute('data-pointer-focus', '');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect.poll(labels).toContain('Move');

    // …and of the bottom bar: Delete clears the layer.
    await page.locator('[data-view-host]').focus();
    const bottom = await emptySpot('bottom-bar');
    await page.mouse.click(bottom.x, bottom.y);
    await expect(canvas).toBeFocused();
    await page.keyboard.press('Delete');
    await expect.poll(labels).toContain('Clear');
  });

  test('Space activates a keyboard-focused rail button instead of panning', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    const over = await toClient(page, { x: 256, y: 256 });
    await page.mouse.move(over.x, over.y);
    // Keyboard focus moves to the pencil; the pointer rests over the canvas.
    await page.getByTestId('tool-brush').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('tool-pencil')).toBeFocused();
    await page.keyboard.down('Space');
    expect(await withSession(page, (s) => s.engine.toolId)).not.toBe('hand');
    await page.keyboard.up('Space');
    await expect.poll(() => withSession(page, (s) => s.engine.selectedToolId)).toBe('pencil');
    expect(await withSession(page, (s) => s.engine.toolId)).toBe('pencil');
  });

  test('a press elsewhere in the editor finishes the text being edited', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-text').click();
    const at = await toClient(page, { x: 256, y: 300 });
    await page.mouse.click(at.x, at.y);
    await expect(page.getByTestId('text-editor')).toBeFocused();
    await page.keyboard.type('Go');
    // The type options keep the editor open…
    await page.getByTestId('tool-options').getByRole('button', { name: 'Italic' }).click();
    await expect(page.getByTestId('text-editor')).toHaveCount(1);
    // …anything else finishes it.
    await page.getByTestId('zoom-level').click();
    await expect(page.getByTestId('text-editor')).toHaveCount(0);
    expect(await withSession(page, (s) => s.engine.textEditLayerId)).toBeNull();
    expect(
      await withSession(page, (s) => {
        const l = s.engine.activeLayer;
        return l?.kind === 'text' ? [l.text, l.italic] : null;
      }),
    ).toEqual(['Go', true]);
  });

  test('typing near the edge of the stage never scrolls the canvas out of place', async ({ page }) => {
    await openWorkspace(page);
    const canvas = page.getByTestId('canvas');
    const before = (await canvas.boundingBox())!;
    await page.getByTestId('tool-text').click();
    const at = await toClient(page, { x: 256, y: 490 });
    await page.mouse.click(at.x, at.y);
    await expect(page.getByTestId('text-editor')).toBeFocused();
    // Lines run past the bottom of the stage; the caret follows them.
    await page.keyboard.type('One');
    for (const line of ['Two', 'Three', 'Four']) {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(line);
    }
    const scrolled = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="workspace"], [data-testid="workspace"] *')]
        .filter((el) => el.scrollTop !== 0 && !el.closest('[data-panel="sidebar"]'))
        .map((el) => el.className),
    );
    expect(scrolled).toEqual([]);
    expect(await canvas.boundingBox()).toEqual(before);
  });

  test('the before/after toggle can be switched off when the design has no original', async ({ page }) => {
    await openWorkspace(page);
    const toggle = page.getByTestId('compare-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await withSession(page, (s) => s.newBlank());
    await expect(toggle).toBeEnabled();
    await toggle.click();
    expect(await withSession(page, (s) => s.compare)).toBe('off');
    await expect(toggle).toBeDisabled();
  });
});

test.describe('legible chrome', () => {
  /**
   * The least contrast `text`'s colour has on what is drawn behind its
   * glyphs (a screenshot of their box with the text hidden), once nothing
   * animates any more.
   */
  async function worstContrast(page: Page, text: Locator): Promise<number> {
    await expect
      .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length))
      .toBe(0);
    const { clip, color } = await text.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { clip: { x, y, width, height }, color: getComputedStyle(el).color };
    });
    await text.evaluate((el) => (el.style.visibility = 'hidden'));
    const behind = PNG.sync.read(await page.screenshot({ clip }));
    await text.evaluate((el) => (el.style.visibility = ''));
    const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
    let worst = Infinity;
    for (let i = 0; i < behind.data.length; i += 4) {
      worst = Math.min(worst, contrast({ r: r!, g: g!, b: b! }, { r: behind.data[i]!, g: behind.data[i + 1]!, b: behind.data[i + 2]! }));
    }
    return worst;
  }

  /** Windows accents across the palette: light ones take dark text, dark ones light text. */
  const ACCENTS = ['#FFB900', '#0078D4', '#9A0089', '#00B7C3', '#E74856', '#7A7574'];

  for (const theme of ['dark', 'light'] as const) {
    test(`Save & Apply and the command search keep 4.5:1, resting and hovered, whatever the accent (${theme})`, async ({ page }) => {
      await openWorkspace(page, [SAMPLE_PATHS.steam], { settings: { theme } });
      const apply = page.getByTestId('apply-button');
      const label = apply.locator('.face.idle .label');
      await expect(apply).not.toHaveClass(/blocked/);
      const failures: string[] = [];
      for (const accent of ACCENTS) {
        await page.evaluate((a) => {
          window.__e2e!.setAccent(a);
          window.dispatchEvent(new Event('focus'));
        }, accent);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-base')))
          .toBe(accent.toLowerCase());
        await page.mouse.move(1, 1);
        const resting = await worstContrast(page, label);
        await apply.getByRole('button', { name: 'Save & Apply' }).hover();
        const hovered = await worstContrast(page, label);
        if (resting < 4.5) failures.push(`${accent}: Save & Apply ${resting.toFixed(2)}`);
        if (hovered < 4.5) failures.push(`${accent}: Save & Apply hovered ${hovered.toFixed(2)}`);
      }
      expect(failures).toEqual([]);

      // The search is a control on the panel: over the wallpaper that takes the most from it.
      await page.addStyleTag({ content: `html, body { background: ${theme === 'dark' ? '#fff' : '#000'} !important; }` });
      const search = page.locator('header.titlebar .search');
      await page.mouse.move(1, 1);
      expect(await worstContrast(page, search.getByText('Search commands'))).toBeGreaterThanOrEqual(4.5);
      await search.hover();
      expect(await worstContrast(page, search.getByText('Search commands'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe('small window', () => {
  test.use({ viewport: { width: 900, height: 620 } });

  test('the bottom bar keeps every control clear of the others', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    const bar = page.getByTestId('bottom-bar');
    const boxes = await Promise.all(
      [
        page.getByTestId('queue-item').first(),
        page.getByTestId('apply-style-all'),
        bar.getByRole('group', { name: 'View' }),
        page.getByTestId('save-library'),
        page.getByTestId('export-menu'),
        page.getByTestId('apply-button'),
      ].map(async (l) => (await l.boundingBox())!),
    );
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x, `control ${i} starts after control ${i - 1} ends`).toBeGreaterThanOrEqual(
        boxes[i - 1]!.x + boxes[i - 1]!.width - 0.5,
      );
    }
    const barBox = (await bar.boundingBox())!;
    const last = boxes.at(-1)!;
    expect(last.x + last.width).toBeLessThanOrEqual(barBox.x + barBox.width);
    // Collapsed to icons, the buttons keep their names.
    await expect(page.getByTestId('apply-style-all')).toHaveAccessibleName('Apply style to all');
    await expect(page.getByTestId('save-library')).toHaveAccessibleName('Save to Library');
    await expect(page.getByTestId('export-menu')).toHaveAccessibleName('Export');
  });

  test('a Tab from a segmented control at either end of "More options" closes it', async ({ page }) => {
    await openWorkspace(page);
    // The eyedropper's two choices do not fit the bar here: "More options"
    // shows, with "Sample" first and "Sample size" last. A segmented control
    // is one Tab stop (its selected segment), so the Tab that leaves it can
    // start with other segments before or after it.
    await setTool(page, 'eyedropper');
    await withSession(page, (s) => s.engine.setToolOptions('eyedropper', { sample: 'layer', size: 1 }));
    const trigger = page.getByTestId('tool-options').getByRole('button', { name: 'More eyedropper options' });
    const more = page.getByRole('dialog', { name: 'Eyedropper options' });
    const selected = (group: string) => more.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { checked: true });

    await trigger.focus();
    await page.keyboard.press('Enter');
    await selected('Sample').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(more).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await selected('Sample size').focus();
    await page.keyboard.press('Tab');
    await expect(more).toHaveCount(0);
    // On from the trigger, as without the popover.
    await expect(page.getByTestId('canvas')).toBeFocused();
  });

  test('the rail shows every tool and the colour chips without scrolling', async ({ page }) => {
    await openWorkspace(page);
    const rail = page.getByTestId('tool-rail');
    const fits = await rail.evaluate((el) => el.scrollHeight <= el.clientHeight);
    expect(fits).toBe(true);
    const railBox = (await rail.boundingBox())!;
    for (const chip of ['color-primary', 'color-secondary']) {
      const box = (await page.getByTestId(chip).boundingBox())!;
      expect(box.y + box.height, chip).toBeLessThanOrEqual(railBox.y + railBox.height);
    }
  });

  test('every tool\'s options fit the bar; what does not fit is in "More options"', async ({ page }) => {
    await openWorkspace(page);
    const options = page.getByTestId('tool-options');
    const ids = await withSession(page, (s) => Object.keys(s.engine.tools));
    for (const id of ids) {
      await setTool(page, id);
      await expect(options).toHaveAttribute('data-tool', id);
      await page.waitForTimeout(50);
      const layout = await options.evaluate((bar) => {
        const controls = bar.querySelector<HTMLElement>('.controls')!;
        const edge = controls.getBoundingClientRect().right;
        // Flex items of the strip (layout-less wrappers are looked through).
        const items: Element[] = [];
        const collect = (parent: Element) => {
          for (const child of parent.children) {
            if (getComputedStyle(child).display === 'contents') collect(child);
            else items.push(child);
          }
        };
        collect(controls);
        const shown = items.filter((el) => el.getBoundingClientRect().width > 0 && !el.classList.contains('hint'));
        return {
          clipped: shown.filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className),
          folded: controls.querySelectorAll('.slot.folded').length,
          barRight: bar.getBoundingClientRect().right,
          moreRight: bar.querySelector('.more')?.getBoundingClientRect().right ?? 0,
        };
      });
      expect(layout.clipped, id).toEqual([]);
      expect(layout.moreRight, id).toBeLessThanOrEqual(layout.barRight);
      if (layout.folded > 0) await expect(options.getByRole('button', { name: /^More .* options$/ }), id).toBeVisible();
    }
  });
});

test.describe('effects performance', () => {
  test('painting on a layer with effects restyles the view around the stroke', async ({ page }) => {
    await openWorkspace(page);
    await page.evaluate(() => {
      const s = (globalThis as unknown as Handle).__reskinSession;
      // A hard red shadow 12 px straight down.
      s.engine.setLayerProps(s.engine.activeLayer!.id, {
        effects: [{ type: 'dropShadow', enabled: true, color: { r: 255, g: 0, b: 0, a: 1 }, opacity: 1, angle: 90, distance: 12, blur: 0, spread: 0 }],
      });
      s.engine.setTool('brush');
      s.engine.setToolOptions('brush', { size: 6, hardness: 1 });
    });
    // (The icon's own faint shadow reaches this row, so "red" is nearly pure red.)
    const red = ([r, g, b]: number[]) => r! > 220 && g! < 40 && b! < 40;
    const shadowAt = { x: 150, y: 18 };
    expect(red(await screenPixel(page, shadowAt))).toBe(false);
    await stroke(page, { x: 100, y: 6 }, { x: 200, y: 6 });
    await expect.poll(async () => red(await screenPixel(page, shadowAt))).toBe(true);
    expect(await screenPixel(page, { x: 150, y: 6 })).toEqual([0, 0, 0, 255]);
  });

  test('a layer getting its first effects is styled off the page: its plain pixels show until the look lands', async ({ page }) => {
    await openWorkspace(page);
    // Under the tile, where a hard red shadow 12 px straight down lands.
    const below = { x: 256, y: 470 };
    const before = await screenPixel(page, below);
    const at = await toClient(page, below);
    // The frame right after the change (its callback runs after the stage's render).
    const firstFrame = await page.evaluate(
      ({ x, y }) =>
        new Promise<number[]>((resolve) => {
          const s = (globalThis as unknown as Handle).__reskinSession;
          s.engine.setLayerProps(s.engine.activeLayer!.id, {
            effects: [{ type: 'dropShadow', enabled: true, color: { r: 255, g: 0, b: 0, a: 1 }, opacity: 1, angle: 90, distance: 12, blur: 0, spread: 0 }],
          });
          requestAnimationFrame(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="canvas"]')!;
            const r = canvas.getBoundingClientRect();
            const k = canvas.width / r.width;
            const d = canvas.getContext('2d')!.getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data;
            resolve([d[0]!, d[1]!, d[2]!, d[3]!]);
          });
        }),
      at,
    );
    expect(firstFrame).toEqual(before);
    const redness = ([r, g]: number[]) => r! - g!;
    await expect.poll(async () => redness(await screenPixel(page, below))).toBeGreaterThan(redness(before) + 60);
  });

  test('dragging an effect slider never blocks the page for long (512 px layer, three effects)', async ({ page }) => {
    // Up to three drags of 48 steps each.
    test.slow();
    await openWorkspace(page);
    await page.evaluate(() => {
      const s = (globalThis as unknown as Handle).__reskinSession;
      const red = { r: 255, g: 0, b: 0, a: 1 };
      s.engine.setLayerProps(s.engine.activeLayer!.id, {
        effects: [
          { type: 'dropShadow', enabled: true, color: red, opacity: 1, angle: 90, distance: 8, blur: 12, spread: 0 },
          { type: 'outerGlow', enabled: true, color: { r: 255, g: 255, b: 190, a: 1 }, opacity: 0.75, size: 16, spread: 0 },
          { type: 'outline', enabled: true, color: { r: 255, g: 255, b: 255, a: 1 }, opacity: 1, width: 8, position: 'outside' },
        ],
      });
      s.sidebarTab = 'effects';
    });
    const slider = page.getByTestId('effect-card').and(page.locator('[data-effect="dropShadow"]')).getByRole('slider', { name: 'Blur' });
    await expect(slider).toBeVisible();
    // Below the tile the red shadow ends before this point; blurred wide, it reaches it.
    const below = { x: 256, y: 500 };
    const redness = async () => {
      const [r, g] = await screenPixel(page, below);
      return r! - g!;
    };
    await page.waitForTimeout(400);
    const before = await redness();

    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    /** One drag across the slider (left to right, or back); the long tasks seen meanwhile. */
    const drag = async (rightwards: boolean): Promise<number[]> => {
      await page.evaluate(() => {
        const w = window as unknown as { __longTasks: number[]; __longTaskObserver: PerformanceObserver };
        w.__longTasks = [];
        w.__longTaskObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
        });
        w.__longTaskObserver.observe({ type: 'longtask' });
      });
      const x = (t: number) => box.x + 4 + (box.width - 8) * (rightwards ? t : 1 - t);
      await page.mouse.move(x(0), y);
      await page.mouse.down();
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        await page.mouse.move(x(i / steps), y);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      // Let the last restyle land, then stop watching: the checks below read
      // the canvas back (a GPU readback) and the autosave that follows edits
      // is not part of the drag.
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const w = window as unknown as { __longTasks: number[]; __longTaskObserver: PerformanceObserver };
        for (const e of w.__longTaskObserver.takeRecords()) w.__longTasks.push(Math.round(e.duration));
        w.__longTaskObserver.disconnect();
        return w.__longTasks;
      });
    };

    const tasks = await drag(true);
    // The final look is on screen: the wider shadow reaches that point.
    expect(await withSession(page, (s) => (s.engine.activeLayer!.effects[0] as { blur: number }).blur)).toBeGreaterThan(40);
    await expect.poll(redness).toBeGreaterThan(before + 20);

    // A task is "long" in wall time, so a machine too busy to schedule the
    // page stretches any of them: like any timing on a shared runner, the
    // best of a few drags counts (a genuinely slow restyle shows in all).
    const runs = [tasks];
    while (Math.max(0, ...runs.at(-1)!) >= 80 && runs.length < 3) runs.push(await drag(runs.length % 2 === 0));
    const worst = Math.min(...runs.map((r) => Math.max(0, ...r)));
    const report = runs.map((r, i) => `drag ${i + 1}: ${r.length ? r.join(', ') : 'none'}`).join('; ');
    test.info().annotations.push({ type: 'long tasks while dragging (ms)', description: report });
    console.log(`effect slider drag long tasks (ms) — ${report}`);
    expect(worst).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// Visual review of the main screen (not assertions). RESKIN_SCREENSHOTS=1
// refreshes the reference PNGs in e2e/__screenshots__.
// ---------------------------------------------------------------------------

const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

/** A desktop-like wallpaper behind the transparent editor window, so the panel's edges and shadow show. */
async function wallpaper(page: Page, tone: 'dark' | 'light'): Promise<void> {
  const bg =
    tone === 'dark'
      ? 'radial-gradient(900px 600px at 20% 10%, #243a75 0%, #101a3a 45%, #070b18 100%)'
      : 'radial-gradient(900px 600px at 20% 10%, #ffffff 0%, #dde8fb 45%, #b9cdf2 100%)';
  await page.addStyleTag({ content: `html, body { background: ${bg} !important; }` });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(350);
  const png = await page.screenshot({ animations: 'disabled' });
  await test.info().attach(name, { body: png, contentType: 'image/png' });
  if (process.env.RESKIN_SCREENSHOTS === '1') {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, name), png);
  }
}

test.describe('editor gallery', () => {
  test.use({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1 });

  for (const theme of ['dark', 'light'] as const) {
    test(`edit view (${theme})`, async ({ page }) => {
      await openWorkspace(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site], { settings: { theme } });
      await wallpaper(page, theme);
      await page.getByTestId('tool-brush').click();
      await withSession(page, (s) => {
        s.engine.setColor('primary', { r: 255, g: 214, b: 102, a: 1 });
        s.engine.setToolOptions('brush', { size: 18, hardness: 0.9 });
        s.engine.setSymmetry({ mode: 'x' });
      });
      await stroke(page, { x: 150, y: 420 }, { x: 230, y: 455 });
      await shoot(page, `workspace-edit-${theme}.png`);

      await page.getByTestId('compare-toggle').click();
      await page.keyboard.press('k');
      await shoot(page, `workspace-compare-${theme}.png`);
      await page.getByTestId('compare-toggle').click();
      await page.keyboard.press('k');

      await withSession(page, (s) => s.engine.setTool('text'));
      const at = await toClient(page, { x: 256, y: 470 });
      await page.mouse.click(at.x, at.y);
      await page.keyboard.type('Steam');
      await shoot(page, `workspace-text-${theme}.png`);
      await page.keyboard.press('Enter');

      await withSession(page, (s) => s.engine.setTool('gradient'));
      await page.getByTestId('apply-options').click();
      await shoot(page, `workspace-apply-menu-${theme}.png`);
    });
  }

  test('small window (dark)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 620 });
    await openWorkspace(page, [SAMPLE_PATHS.steam], { settings: { theme: 'dark' } });
    await wallpaper(page, 'dark');
    await page.getByTestId('color-primary').click();
    await shoot(page, 'workspace-small-dark.png');
  });
});
