// `--smoke-test` support in the editor: readiness report at boot and the
// open → apply → restore cycle driven by EditorCmd::SmokeCycle.

import type { ApplyRequest, SmokeReport } from '../src/lib/ipc/types';
import {
  calls,
  expect,
  makeItems,
  pushEditorCmd,
  SAMPLE_PATHS,
  setApplyOutcome,
  simulateOpen,
  test,
  waitForCall,
} from './support/fixtures';
import type { Page } from '@playwright/test';

function reports(page: Page): Promise<SmokeReport[]> {
  return page.evaluate(() => [...window.__e2e!.smokeReports]);
}

async function cycleResult(page: Page): Promise<string> {
  const handle = await page.waitForFunction(
    () => window.__e2e!.smokeReports.find((r) => r.detail.startsWith('cycle:'))?.detail ?? null,
    null,
    { timeout: 15_000 },
  );
  return (await handle.jsonValue()) as string;
}

test('smoke mode reports the editor ready right after boot', async ({ openEditor, page }) => {
  await openEditor({ smoke: true });
  const ready = await waitForCall(page, 'smoke_ready');
  expect(ready.args.report).toMatchObject({ window: 'editor' });
  expect((ready.args.report as SmokeReport).detail).toMatch(/^editor ok v1\.0\.0-e2e/);
});

test('no smoke report outside smoke mode', async ({ openEditor, page }) => {
  await openEditor();
  await page.waitForTimeout(300);
  expect(await calls(page, 'smoke_ready')).toHaveLength(0);
});

test('SmokeCycle applies in place, restores the item and reports cycle:ok', async ({ openEditor, page }) => {
  await openEditor({ smoke: true });
  const [item] = await makeItems(page, [SAMPLE_PATHS.steam]);
  await simulateOpen(page, [item!], 'edit');
  // Straight after the open, like Rust: the design may still be loading.
  await pushEditorCmd(page, { type: 'smokeCycle', item: item!.id });
  expect(await cycleResult(page)).toBe('cycle:ok');

  const apply = await waitForCall(page, 'apply_icon');
  const req = apply.args.req as ApplyRequest;
  expect(req).toMatchObject({ item: item!.id, mode: 'inPlace', flourish: false });
  expect(req.images.length).toBeGreaterThan(3);
  const restore = await waitForCall(page, 'restore');
  expect(restore.args).toEqual({ target: { type: 'item', item: item!.id } });
  expect(restore.t).toBeGreaterThan(apply.t);
  const history = await page.evaluate(() => window.__e2e!.history);
  expect(history.map((h) => h.state)).toEqual(['restored']);
  // No flourish: the editor stayed open.
  expect((await page.evaluate(() => window.__e2e!.editor)).phase).toBe('open');
});

test('a slow item load is waited for', async ({ openEditor, page }) => {
  await openEditor({ smoke: true });
  const [item] = await makeItems(page, [SAMPLE_PATHS.folder]);
  // Make item_frames slow: the first call fails over to the preview path later.
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown, o?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = async (cmd, args, options) => {
      if (cmd === 'item_frames') await new Promise((r) => setTimeout(r, 900));
      return inner(cmd, args, options);
    };
  });
  await simulateOpen(page, [item!], 'edit');
  await pushEditorCmd(page, { type: 'smokeCycle', item: item!.id });
  expect(await cycleResult(page)).toBe('cycle:ok');
});

test('a failed apply is reported as cycle:fail with the reason', async ({ openEditor, page }) => {
  await openEditor({ smoke: true });
  const [item] = await makeItems(page, [SAMPLE_PATHS.notes]);
  await simulateOpen(page, [item!], 'edit');
  await setApplyOutcome(page, { type: 'failed', message: 'shortcut is locked', hint: null });
  await pushEditorCmd(page, { type: 'smokeCycle', item: item!.id });
  expect(await cycleResult(page)).toBe('cycle:fail:apply: shortcut is locked');
  expect(await calls(page, 'restore')).toHaveLength(0);
});

test('an item that was never opened fails fast', async ({ openEditor, page }) => {
  await openEditor({ smoke: true });
  await simulateOpen(page, [], 'start');
  await pushEditorCmd(page, { type: 'smokeCycle', item: 'item-404' });
  expect(await cycleResult(page)).toBe('cycle:fail:the item is not open in the editor');
  expect((await reports(page)).map((r) => r.window)).toEqual(['editor', 'editor']);
});
