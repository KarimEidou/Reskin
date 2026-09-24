// Generic helpers for driving the fake backend (`window.__e2e`, see
// src/testing/tauri-mock.ts) from Playwright specs. Anything not covered
// here is one `page.evaluate(() => window.__e2e!.…)` away; callbacks such
// as `setInspectOverride(fn)` must be written inside that evaluate.

import { expect, type Page } from '@playwright/test';
import type { CommandName } from '../../src/lib/ipc/commands';
import type {
  AckStage,
  ApplyOutcome,
  CollapseThen,
  EditorCmd,
  EditorView,
  ItemInfo,
  Settings,
} from '../../src/lib/ipc/types';
import type {
  E2ECall,
  E2EConfig,
  E2EEditorState,
  SimulateCloseOptions,
  SimulateCloseResult,
  SimulateOpenOptions,
  SimulateOpenResult,
} from '../../src/testing/e2e-api';

export type { E2EApi, E2ECall, E2EConfig } from '../../src/testing/e2e-api';
export type PageKind = 'box' | 'editor';

/** Sample paths covering the item kinds (Windows-style). */
export const SAMPLE_PATHS = {
  steam: 'C:\\Users\\e2e\\Desktop\\Steam.lnk',
  notes: 'C:\\Users\\e2e\\Desktop\\Notes.lnk',
  site: 'C:\\Users\\e2e\\Desktop\\Docs Portal.url',
  folder: 'C:\\Users\\e2e\\Desktop\\Projects\\',
  exe: 'C:\\Tools\\Paint.exe',
  image: 'C:\\Users\\e2e\\Pictures\\logo.png',
  publicShortcut: 'C:\\Users\\Public\\Desktop\\Firefox.lnk',
  project: 'C:\\Users\\e2e\\Documents\\My Icon.reskin',
  unreadable: 'C:\\Users\\e2e\\Desktop\\broken.lnk::unreadable',
} as const;

/**
 * Opens a page of the e2e build with an optional fake-backend config and
 * waits until the page booted (box: `data-ready`; editor: its first
 * mailbox poll).
 */
export async function openPage(page: Page, kind: PageKind, config: E2EConfig = {}): Promise<void> {
  await page.addInitScript((c) => {
    window.__E2E_CONFIG__ = c;
  }, config);
  await page.goto(`/${kind}.html`);
  if (kind === 'box') {
    await expect(page.locator('main.box-page')).toHaveAttribute('data-ready', 'true');
  } else {
    await page.waitForFunction(() => !!window.__e2e?.calls.some((c) => c.cmd === 'editor_next'));
  }
}

export function calls(page: Page, cmd: CommandName): Promise<E2ECall[]> {
  return page.evaluate((c) => window.__e2e!.callsOf(c), cmd);
}

export function clearCalls(page: Page): Promise<void> {
  return page.evaluate(() => window.__e2e!.clearCalls());
}

/** First call to `cmd` (already made or upcoming) whose args include `args`. */
export async function waitForCall(
  page: Page,
  cmd: CommandName,
  args?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<E2ECall> {
  const handle = await page.waitForFunction(
    ([c, a]) => {
      const matches = (call: { args: Record<string, unknown> }) =>
        !a || Object.entries(a).every(([k, v]) => JSON.stringify(call.args[k]) === JSON.stringify(v));
      return window.__e2e?.callsOf(c).find(matches) ?? null;
    },
    [cmd, args ?? null] as const,
    { timeout: timeoutMs },
  );
  return (await handle.jsonValue()) as E2ECall;
}

/** Emits a Tauri event to the page (see E2EApi.emit). */
export function emit(page: Page, event: string, payload?: unknown): Promise<void> {
  return page.evaluate(([e, p]) => window.__e2e!.emit(e, p), [event, payload] as const);
}

export function settings(page: Page): Promise<Settings> {
  return page.evaluate(() => window.__e2e!.settings);
}

export function setSettings(page: Page, patch: Partial<Settings>): Promise<Settings> {
  return page.evaluate((p) => window.__e2e!.setSettings(p), patch);
}

/** Inspects paths through the fake (same ids the page gets) without logging a call. */
export function makeItems(page: Page, paths: string[]): Promise<ItemInfo[]> {
  return page.evaluate((p) => window.__e2e!.makeItems(p), paths);
}

/** Makes `inspect_paths` return exactly `items` (e.g. [] for the error path). */
export function inspectReturns(page: Page, items: ItemInfo[]): Promise<void> {
  return page.evaluate((list) => window.__e2e!.setInspectOverride(() => list), items);
}

export function resetInspect(page: Page): Promise<void> {
  return page.evaluate(() => window.__e2e!.setInspectOverride(null));
}

export function setInspectDelay(page: Page, ms: number): Promise<void> {
  return page.evaluate((m) => window.__e2e!.setInspectDelay(m), ms);
}

export function setApplyOutcome(page: Page, outcome: ApplyOutcome | null): Promise<void> {
  return page.evaluate((o) => window.__e2e!.setApplyOutcome(o), outcome);
}

export function failNext(page: Page, cmd: CommandName, message: string): Promise<void> {
  return page.evaluate(([c, m]) => window.__e2e!.failNext(c, m), [cmd, message] as const);
}

// ---- editor mailbox / handoff FSM -----------------------------------------

export function pushEditorCmd(page: Page, cmd: EditorCmd): Promise<number> {
  return page.evaluate((c) => window.__e2e!.pushEditorCmd(c), cmd);
}

export function simulateOpen(
  page: Page,
  items: ItemInfo[] | string[],
  view: EditorView = 'edit',
  opts: SimulateOpenOptions = {},
): Promise<SimulateOpenResult> {
  return page.evaluate(([i, v, o]) => window.__e2e!.simulateOpen(i, v, o), [items, view, opts] as const);
}

export function simulateClose(
  page: Page,
  then: CollapseThen = 'hide',
  opts: SimulateCloseOptions = {},
): Promise<SimulateCloseResult> {
  return page.evaluate(([t, o]) => window.__e2e!.simulateClose(t, o), [then, opts] as const);
}

export function waitForAck(page: Page, session: number, stage: AckStage, timeoutMs = 5000): Promise<boolean> {
  return page.evaluate(([s, st, t]) => window.__e2e!.waitForAck(s, st, t), [session, stage, timeoutMs] as const);
}

export function editorState(page: Page): Promise<E2EEditorState> {
  return page.evaluate(() => window.__e2e!.editor);
}
