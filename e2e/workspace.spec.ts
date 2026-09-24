// The Edit view around the canvas: tool rail and flyouts, tool options,
// symmetry, zoom, the batch queue, pixel-art mode, before/after, colour
// chips, image paste — and reference screenshots of the whole editor.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { EditorSession } from '../src/editor/state/session.svelte';
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

  test('selection commands work on the current selection', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-selectRect').click();
    const group = page.getByRole('group', { name: 'Selection' });
    await expect(group.getByRole('button', { name: 'Deselect' })).toBeDisabled();
    await group.getByRole('button', { name: 'Select all' }).click();
    expect(await withSession(page, (s) => s.engine.doc.selection !== null)).toBe(true);
    await group.getByRole('button', { name: 'Deselect' }).click();
    expect(await withSession(page, (s) => s.engine.doc.selection)).toBeNull();

    // Marquee a square, invert it, feather it.
    await stroke(page, { x: 128, y: 128 }, { x: 384, y: 384 });
    await expect(group.getByRole('button', { name: 'Invert' })).toBeEnabled();
    await group.getByRole('button', { name: 'Invert' }).click();
    await group.getByRole('button', { name: 'Feather…' }).click();
    const feather = page.getByRole('dialog', { name: 'Feather selection' });
    await feather.getByRole('button', { name: 'Feather' }).click();
    await expect(feather).toHaveCount(0);
    expect(await withSession(page, (s) => s.engine.historyEntries.map((e) => e.label))).toEqual([
      'Select all',
      'Deselect',
      'Rectangle select',
      'Invert selection',
      'Feather',
    ]);
    // Inverted: the middle is outside the selection, the corner inside.
    expect(
      await withSession(page, (s) => {
        const m = s.engine.doc.selection!;
        return [m.data[256 * m.width + 256], m.data[4 * m.width + 4]];
      }),
    ).toEqual([0, 255]);
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

  test('pasting an image adds it as a layer', async ({ page }) => {
    await openWorkspace(page);
    const layersBefore = await withSession(page, (s) => s.engine.doc.layers.length);
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(64, 48);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff3366';
      ctx.fillRect(8, 8, 48, 32);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => withSession(page, (s) => s.engine.doc.layers.length)).toBe(layersBefore + 1);
    expect(await withSession(page, (s) => s.engine.activeLayer?.name)).toBe('Pasted image');
    const [r, g, b, a] = await withSession(page, (s) => {
      const c = s.engine.composite();
      const i = (256 * c.width + 256) * 4;
      return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
    });
    expect([r, g, b, a]).toEqual([255, 51, 102, 255]);
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
