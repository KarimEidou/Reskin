// Drawing on the canvas stage: brush strokes with real pointer input, undo
// and redo restoring exact pixels, fill and shapes — read back from the
// engine's composite through the e2e session handle.

import type { Page } from '@playwright/test';
import type { EditorSession } from '../src/editor/state/session.svelte';
import { expect, SAMPLE_PATHS, simulateOpen, test, type E2EConfig } from './support/fixtures';

type Point = { x: number; y: number };

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
  await page.waitForFunction(() => (globalThis as unknown as { __reskinSession?: EditorSession }).__reskinSession?.hasDesign === true);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** FNV-1a of the composite's RGBA bytes (plus its size). */
function compositeHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession;
    const c = s.engine.composite();
    let h = 0x811c9dc5;
    const d = c.data;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 0x01000193);
    return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`;
  });
}

/** Straight RGBA of the composite at a document pixel. */
function pixelAt(page: Page, p: Point): Promise<[number, number, number, number]> {
  return page.evaluate(({ x, y }) => {
    const s = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession;
    const c = s.engine.composite();
    const i = (Math.floor(y) * c.width + Math.floor(x)) * 4;
    return [c.data[i]!, c.data[i + 1]!, c.data[i + 2]!, c.data[i + 3]!] as [number, number, number, number];
  }, p);
}

/** Client (page) coordinates of a document point. */
async function toClient(page: Page, p: Point): Promise<Point> {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const vp = await page.evaluate(() => {
    const v = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!;
    return { panX: v.panX, panY: v.panY, scale: v.scale };
  });
  return { x: box.x + vp.panX + p.x * vp.scale, y: box.y + vp.panY + p.y * vp.scale };
}

async function drag(page: Page, from: Point, to: Point, steps = 12): Promise<void> {
  const a = await toClient(page, from);
  const b = await toClient(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

function historyIndex(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.historyIndex);
}

function selectedTool(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.selectedToolId);
}

test.describe('drawing on the canvas', () => {
  test('a brush stroke changes pixels; Ctrl+Z restores the exact bytes and Ctrl+Y re-applies them', async ({ page }) => {
    await openWorkspace(page);
    const before = await compositeHash(page);

    await page.getByTestId('tool-brush').click();
    await expect(page.getByTestId('tool-brush')).toHaveAttribute('aria-pressed', 'true');
    expect(await selectedTool(page)).toBe('brush');

    await drag(page, { x: 90, y: 250 }, { x: 420, y: 270 });
    await expect.poll(() => historyIndex(page)).toBe(1);
    const painted = await compositeHash(page);
    expect(painted).not.toBe(before);
    // The default primary colour is black: the middle of the stroke is opaque black.
    expect(await pixelAt(page, { x: 255, y: 260 })).toEqual([0, 0, 0, 255]);

    await page.keyboard.press('Control+z');
    await expect.poll(() => compositeHash(page)).toBe(before);
    await page.keyboard.press('Control+y');
    await expect.poll(() => compositeHash(page)).toBe(painted);
  });

  test('the right button paints with the secondary colour', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    const a = await toClient(page, { x: 100, y: 300 });
    const b = await toClient(page, { x: 400, y: 300 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await expect.poll(() => historyIndex(page)).toBe(1);
    expect(await pixelAt(page, { x: 250, y: 300 })).toEqual([255, 255, 255, 255]);
  });

  test('fill floods the transparent corner with the primary colour', async ({ page }) => {
    await openWorkspace(page);
    const corner = { x: 3, y: 3 };
    expect((await pixelAt(page, corner))[3]).toBe(0);
    const before = await compositeHash(page);

    await page.getByTestId('tool-fill').click();
    expect(await selectedTool(page)).toBe('fill');
    const at = await toClient(page, corner);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => pixelAt(page, corner)).toEqual([0, 0, 0, 255]);
    // Contiguous: the opposite corner is part of the same transparent region.
    expect(await pixelAt(page, { x: 508, y: 508 })).toEqual([0, 0, 0, 255]);

    await page.keyboard.press('Control+z');
    await expect.poll(() => compositeHash(page)).toBe(before);
  });

  test('a shape drag rasterizes a filled rounded rectangle', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-shape').click();
    expect(await selectedTool(page)).toBe('shape');
    await expect(page.getByTestId('tool-options')).toHaveAttribute('data-tool', 'shape');

    // Pick a solid colour first so the shape is easy to recognise.
    await page.evaluate(() =>
      (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.setColor('primary', {
        r: 250,
        g: 30,
        b: 60,
        a: 1,
      }),
    );
    await drag(page, { x: 120, y: 120 }, { x: 392, y: 392 });
    await expect.poll(() => historyIndex(page)).toBe(1);
    expect(await pixelAt(page, { x: 256, y: 256 })).toEqual([250, 30, 60, 255]);
    // Rounded corners: the very corner of the box stays as it was.
    const corner = await pixelAt(page, { x: 121, y: 121 });
    expect(corner).not.toEqual([250, 30, 60, 255]);
  });

  test('Escape during a drag cancels the stroke', async ({ page }) => {
    await openWorkspace(page);
    const before = await compositeHash(page);
    await page.getByTestId('tool-brush').click();
    const a = await toClient(page, { x: 100, y: 200 });
    const b = await toClient(page, { x: 400, y: 220 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await historyIndex(page)).toBe(0);
    await expect.poll(() => compositeHash(page)).toBe(before);
  });

  test('text: click places a text layer, typing edits it, Enter finishes', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-text').click();
    const at = await toClient(page, { x: 256, y: 400 });
    await page.mouse.click(at.x, at.y);
    const editor = page.getByTestId('text-editor');
    await expect(editor).toBeFocused();
    await page.keyboard.type('Play');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const e = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine;
          const l = e.activeLayer;
          return l?.kind === 'text' ? l.text : null;
        }),
      )
      .toBe('Play');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.textEditLayerId,
      ),
    ).toBeNull();
  });

  test('middle-button drag pans without painting', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    await page.evaluate(() =>
      (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!.setZoom(3),
    );
    const panY = () =>
      page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!.panY);
    const before = await panY();
    const a = await toClient(page, { x: 256, y: 256 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(a.x, a.y - 80, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    expect((await panY()) - before).toBeCloseTo(-80, 0);
    expect(await historyIndex(page)).toBe(0);
    expect(
      await page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.toolId),
    ).toBe('brush');
  });

  test('Space held over the canvas pans with the hand tool, then gives the brush back', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('tool-brush').click();
    await page.evaluate(() =>
      (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!.setZoom(3),
    );
    const panBefore = await page.evaluate(
      () => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!.panX,
    );
    const a = await toClient(page, { x: 256, y: 256 });
    await page.mouse.move(a.x, a.y);
    await page.keyboard.down('Space');
    expect(
      await page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.toolId),
    ).toBe('hand');
    await page.mouse.down();
    await page.mouse.move(a.x + 120, a.y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    const panAfter = await page.evaluate(
      () => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!.panX,
    );
    expect(panAfter - panBefore).toBeCloseTo(120, 0);
    expect(await historyIndex(page)).toBe(0);
    expect(
      await page.evaluate(() => (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.toolId),
    ).toBe('brush');
  });
});
