// Save & Apply and the Export menu: what reaches the backend is decoded and
// checked (every configured ICO size, square, not empty), plus the apply
// menu (modes, pins setting), the blocked and busy states of the button.

import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { EditorSession } from '../src/editor/state/session.svelte';
import type { ApplyRequest, ExportRequest, SizedPng } from '../src/lib/ipc/types';
import {
  calls,
  expect,
  SAMPLE_PATHS,
  settings,
  simulateOpen,
  test,
  waitForCall,
  type E2EConfig,
} from './support/fixtures';

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256];

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
}

/** Decodes every image and checks size, squareness and that it is not blank. */
function expectIconImages(images: SizedPng[], sizes: number[]): void {
  expect(images.map((i) => i.size)).toEqual(sizes);
  for (const img of images) {
    const png = PNG.sync.read(Buffer.from(img.png, 'base64'));
    expect(png.width, `${img.size} px width`).toBe(img.size);
    expect(png.height, `${img.size} px height`).toBe(img.size);
    let opaque = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i]! > 0) opaque++;
    expect(opaque, `${img.size} px has visible pixels`).toBeGreaterThan(0);
    // A real icon, not a solid block: some pixels stay transparent.
    expect(opaque, `${img.size} px keeps its transparent corners`).toBeLessThan(img.size * img.size);
  }
}

const applyButton = (page: Page) => page.getByRole('button', { name: 'Save & Apply' });

test.describe('Save & Apply', () => {
  test('sends every ICO size, decoded square and non-empty, with the preferred mode', async ({ page }) => {
    await openWorkspace(page);
    expect((await settings(page)).icoSizes).toEqual(ICO_SIZES);
    await applyButton(page).click();

    const call = await waitForCall(page, 'apply_icon', undefined, 10_000);
    const req = call.args.req as ApplyRequest;
    const [item] = await page.evaluate(() => window.__e2e!.makeItems(['C:\\Users\\e2e\\Desktop\\Steam.lnk']));
    expect(req.item).toBe(item!.id);
    expect(req.mode).toBe('inPlace');
    expect(req.flourish).toBe(true);
    expect(req.updatePins).toBe(false);
    expect(req.designName).toBe('Steam');
    expectIconImages(req.images, ICO_SIZES);
    // The fake backend journals it like Rust.
    await expect.poll(() => page.evaluate(() => window.__e2e!.history.length)).toBe(1);
  });

  test('commits a pending move before applying, so the icon is what the canvas shows', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam], { applyCollapses: false });
    await page.getByTestId('tool-move').click();
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const vp = await page.evaluate(() => {
      const v = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine.viewport!;
      return { x: v.panX, y: v.panY, s: v.scale };
    });
    const at = (x: number, y: number) => ({ x: canvas.x + vp.x + x * vp.s, y: canvas.y + vp.y + y * vp.s });
    const from = at(256, 256);
    const to = at(300, 256);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    const engineState = () =>
      page.evaluate(() => {
        const e = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.engine;
        return { pending: e.hasPending, labels: e.historyEntries.map((h) => h.label) };
      });
    expect(await engineState()).toEqual({ pending: true, labels: [] });

    await applyButton(page).click();
    await waitForCall(page, 'apply_icon', undefined, 10_000);
    expect(await engineState()).toEqual({ pending: false, labels: ['Move'] });
  });

  test('shows a progress ring while applying', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.steam], { applyCollapses: false });
    // A long-running job (batch apply / elevation wait) as the session reports it.
    const button = page.getByTestId('apply-button');
    await page.evaluate(() => {
      const s = (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession;
      s.busy = { label: 'Applying', progress: 0.4 };
    });
    await expect(button.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    await expect(button.locator('.main')).toHaveAttribute('aria-busy', 'true');
    await expect(button.locator('.main')).toHaveAccessibleName('Applying 40%');
    await expect(page.getByTestId('apply-options')).toBeDisabled();
    await page.evaluate(() => {
      (globalThis as unknown as { __reskinSession: EditorSession }).__reskinSession.busy = null;
    });
    await expect(applyButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect(applyButton(page)).toHaveAttribute('aria-disabled', 'false');
  });

  test('is blocked with a reason when there is nothing to apply to', async ({ page }) => {
    // An image alone is a design source, not a target.
    await openWorkspace(page, [SAMPLE_PATHS.image]);
    const button = applyButton(page);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Drop a shortcut here to apply');
    // aria-disabled keeps it focusable (for the reason); a click does nothing.
    await button.click({ force: true });
    await page.waitForTimeout(200);
    expect(await calls(page, 'apply_icon')).toHaveLength(0);
  });

  test('the apply menu lists the modes and saves the pins setting', async ({ page }) => {
    await openWorkspace(page, [SAMPLE_PATHS.publicShortcut], { applyCollapses: false });
    await page.getByTestId('apply-options').click();
    const menu = page.getByRole('dialog', { name: 'Apply options' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: /Change in place/ })).toBeEnabled();
    await expect(menu.getByRole('button', { name: /New desktop shortcut/ })).toBeDisabled();
    await expect(menu.getByRole('button', { name: /Personal copy/ })).toBeEnabled();

    await menu.getByRole('switch', { name: 'Also update Start menu and taskbar pins' }).click();
    await waitForCall(page, 'settings_set');
    await expect.poll(async () => (await settings(page)).updatePins).toBe(true);

    await menu.getByRole('button', { name: /Personal copy/ }).click();
    const call = await waitForCall(page, 'apply_icon', undefined, 10_000);
    const req = call.args.req as ApplyRequest;
    expect(req.mode).toBe('personalCopy');
    expect(req.updatePins).toBe(true);
    expect(req.images).toHaveLength(ICO_SIZES.length);
  });
});

test.describe('Export menu', () => {
  async function exportAs(page: Page, item: RegExp): Promise<ExportRequest> {
    await page.getByTestId('export-menu').click();
    await page.getByRole('menuitem', { name: item }).click();
    const call = await waitForCall(page, 'export_file', undefined, 10_000);
    return call.args.req as ExportRequest;
  }

  test('.ico carries all 12 sizes', async ({ page }) => {
    await openWorkspace(page);
    const req = await exportAs(page, /Icon file/);
    expect(req.kind).toBe('ico');
    expect(req.suggestedName).toBe('Steam');
    expect(req.data).toBeNull();
    expectIconImages(req.images, ICO_SIZES);
    await expect(page.getByText(/Exported to .*Steam\.ico/)).toBeVisible();
  });

  test('.png is one 256 px image', async ({ page }) => {
    await openWorkspace(page);
    const req = await exportAs(page, /PNG image/);
    expect(req.kind).toBe('png');
    expectIconImages(req.images, [256]);
  });

  test('.reskin carries the project', async ({ page }) => {
    await openWorkspace(page);
    const req = await exportAs(page, /Reskin project/);
    expect(req.kind).toBe('project');
    expect(req.images).toEqual([]);
    const project = JSON.parse(req.data!) as { format: string; version: number };
    expect(project.format).toBe('reskin');
    expect(project.version).toBeGreaterThanOrEqual(1);
  });

  test('copy puts a 256 px PNG on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openWorkspace(page);
    await page.getByTestId('export-menu').click();
    await page.getByRole('menuitem', { name: 'Copy to clipboard' }).click();
    await expect(page.getByText('Copied to the clipboard.')).toBeVisible();
    const size = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item!.getType('image/png');
      const bmp = await createImageBitmap(blob);
      return [bmp.width, bmp.height];
    });
    expect(size).toEqual([256, 256]);
  });

  test('Save to Library stores the design under the chosen name', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('save-library').click();
    const form = page.getByRole('dialog', { name: 'Save to Library' });
    const name = form.getByRole('textbox');
    await expect(name).toHaveValue('Steam');
    await name.fill('Steam — midnight');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const call = await waitForCall(page, 'library_save');
    expect((call.args.entry as { name: string }).name).toBe('Steam — midnight');
    await expect(form).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__e2e!.library.map((l) => l.name))).toEqual(['Steam — midnight']);
  });

  test('a design saved before says which Library design it updates; "Save as new" adds another', async ({ page }) => {
    await openWorkspace(page);
    const library = () => page.evaluate(() => window.__e2e!.library.map((l) => [l.id, l.name]).sort());
    const lastSave = async () => (await calls(page, 'library_save')).at(-1)!.args.entry as { id: string | null; name: string };
    const form = page.getByRole('dialog', { name: 'Save to Library' });
    await page.getByTestId('save-library').click();
    await form.getByRole('textbox').fill('Mono');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Saved "Mono" to the Library.' })).toBeVisible();
    const [[mono]] = await library();

    // Linked now: the form names the design it updates, and says so when a new name renames it.
    await page.getByTestId('save-library').click();
    const notice = form.getByTestId('library-link');
    const name = form.getByRole('textbox', { name: 'Name' });
    await expect(notice).toHaveText('Updates "Mono" in your Library.');
    await expect(name).toHaveValue('Mono');
    await expect(name).toHaveAccessibleDescription('Updates "Mono" in your Library.');
    await name.fill('Mono v2');
    await expect(notice).toHaveText('Updates "Mono" in your Library and renames it "Mono v2".');
    await form.getByRole('button', { name: 'Save as new' }).click();
    await expect(form).toBeHidden();
    expect(await lastSave()).toMatchObject({ id: null, name: 'Mono v2' });
    await expect.poll(library).toHaveLength(2);
    expect((await library()).find(([id]) => id === mono)).toEqual([mono, 'Mono']);
    const v2 = (await library()).find(([id]) => id !== mono)![0];

    // Save changes updates the design it is linked to now, keeping its name.
    await page.getByTestId('save-library').click();
    await expect(notice).toHaveText('Updates "Mono v2" in your Library.');
    await name.press('Enter');
    await expect(form).toBeHidden();
    expect(await lastSave()).toMatchObject({ id: v2, name: 'Mono v2' });
    await expect(page.getByRole('status').filter({ hasText: 'Updated "Mono v2" in the Library.' })).toBeVisible();
    expect(await library()).toEqual([
      [mono, 'Mono'],
      [v2, 'Mono v2'],
    ].sort());
  });

  test('"Save as new" under the linked design\'s own name adds a copy, not a second design of that name', async ({ page }) => {
    await openWorkspace(page);
    const names = () => page.evaluate(() => window.__e2e!.library.map((l) => l.name).sort());
    const lastSave = async () => (await calls(page, 'library_save')).at(-1)!.args.entry as { id: string | null; name: string };
    const form = page.getByRole('dialog', { name: 'Save to Library' });
    await page.getByTestId('save-library').click();
    await form.getByRole('textbox').fill('Mono');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();

    await page.getByTestId('save-library').click();
    await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Mono');
    await form.getByRole('button', { name: 'Save as new' }).click();
    await expect(form).toBeHidden();
    expect(await lastSave()).toMatchObject({ id: null, name: 'Mono copy' });
    await expect.poll(names).toEqual(['Mono', 'Mono copy']);
    // The design goes by the copy now.
    await page.getByTestId('save-library').click();
    await expect(form.getByTestId('library-link')).toHaveText('Updates "Mono copy" in your Library.');
  });

  test('Ctrl+S and the palette save a new design at once, but open the form over a linked one', async ({ page }) => {
    await openWorkspace(page);
    const saves = () => calls(page, 'library_save');
    const form = page.getByRole('dialog', { name: 'Save to Library' });
    const name = form.getByRole('textbox', { name: 'Name' });
    const notice = form.getByTestId('library-link');
    const workspace = page.getByTestId('workspace');

    // Not linked to a Library design: Ctrl+S adds one, no questions asked.
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await saves()).length).toBe(1);
    expect((await saves())[0]!.args.entry).toMatchObject({ id: null, name: 'Steam' });
    await expect(form).toBeHidden();
    const [steam] = await page.evaluate(() => window.__e2e!.library.map((l) => l.id));

    // Linked now: Ctrl+S never saves over it unseen — the form that names
    // it opens, the name ready to type over.
    await page.keyboard.press('Control+s');
    await expect(form).toBeVisible();
    await expect(notice).toHaveText('Updates "Steam" in your Library.');
    await expect(name).toHaveValue('Steam');
    await expect(name).toBeFocused();
    await expect(page.getByTestId('save-library')).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(150);
    expect(await saves()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(page.getByTestId('save-library')).toHaveAttribute('aria-expanded', 'false');

    // From another view: the form opens in the Edit view, where it lives.
    await page.locator('header.titlebar').getByRole('button', { name: 'Library' }).click();
    await expect(workspace).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect(workspace).toBeVisible();
    await expect(form).toBeVisible();
    await expect(name).toHaveValue('Steam');
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();

    // The palette's "Save to Library" asks the same way, from any view.
    await page.locator('header.titlebar').getByRole('button', { name: 'History' }).click();
    await expect(workspace).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
    await page.keyboard.type('Save to Library');
    await page.keyboard.press('Enter');
    await expect(form).toBeVisible();
    await expect(notice).toHaveText('Updates "Steam" in your Library.');
    expect(await saves()).toHaveLength(1);
    // Saved over only from the form that named it.
    await name.fill('Steam — dusk');
    await name.press('Enter');
    await expect(form).toBeHidden();
    expect((await saves()).at(-1)!.args.entry).toMatchObject({ id: steam, name: 'Steam — dusk' });
  });
});
