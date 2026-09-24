// Playwright helpers for the sidebar panel specs (panels.spec.ts,
// presets.spec.ts): they run in the real editor page (editor.html of the
// e2e build) after the open handoff, and drive everything through the UI
// or the e2e-exposed session (globalThis.__reskinSession).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { SidebarTab } from '../src/editor/state/session.svelte';
import { expect, openPage, SAMPLE_PATHS, simulateOpen, type E2EConfig } from './support/fixtures';

export const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__screenshots__');

/** Opens editor.html and the open handoff with the item at `path`; waits for its design in the Edit view. */
export async function openEditor(page: Page, config: E2EConfig = {}, path: string = SAMPLE_PATHS.steam): Promise<void> {
  await openPage(page, 'editor', config);
  await openItem(page, path);
}

/** Runs the open handoff with the item at `path` on an editor page that is already loaded. */
export async function openItem(page: Page, path: string = SAMPLE_PATHS.steam): Promise<void> {
  await simulateOpen(page, [path]);
  await page.waitForFunction(() => (globalThis as any).__reskinSession?.hasDesign === true, null, { timeout: 30_000 });
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByTestId('layer-row').first()).toBeVisible();
}

export function sidebar(page: Page): Locator {
  return page.getByTestId('sidebar');
}

/** The canvas stage. */
export function canvas(page: Page): Locator {
  return page.getByTestId('canvas');
}

/** Selects a sidebar tab by clicking it (tabs are named by their label). */
export async function openTab(page: Page, tab: SidebarTab): Promise<void> {
  await sidebar(page).locator(`[role="tab"][data-tab="${tab}"]`).click();
  await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
}

/** Page coordinates of a document point on the canvas. */
export async function docToPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await canvas(page).boundingBox())!;
  const vp = await page.evaluate(() => {
    const v = (globalThis as any).__reskinSession.engine.viewport;
    return { panX: v.panX as number, panY: v.panY as number, scale: v.scale as number };
  });
  return { x: box.x + vp.panX + x * vp.scale, y: box.y + vp.panY + y * vp.scale };
}

/** FNV-1a hash of the composite (whole design) — equal hashes = identical pixels. */
export function compositeHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (globalThis as any).__reskinSession;
    const d: Uint8ClampedArray = s.engine.composite().data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 16777619);
    return `${d.length}:${(h >>> 0).toString(16)}`;
  });
}

/** FNV-1a hash of one layer's pixels (the active layer by default). */
export function layerHash(page: Page, id?: string): Promise<string> {
  return page.evaluate((layerId) => {
    const s = (globalThis as any).__reskinSession;
    const l = layerId ? s.engine.getLayer(layerId) : s.engine.activeLayer;
    const d: Uint8ClampedArray = l.kind === 'raster' ? l.surface.data : l.cache.data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 16777619);
    return `${d.length}:${(h >>> 0).toString(16)}`;
  }, id ?? null);
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  kind: string;
  effects: string[];
}

/** Layers bottom → top. */
export function layers(page: Page): Promise<LayerInfo[]> {
  return page.evaluate(() =>
    (globalThis as any).__reskinSession.engine.doc.layers.map((l: any) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      kind: l.kind,
      effects: l.effects.map((e: any) => e.type),
    })),
  );
}

export function history(page: Page): Promise<{ labels: string[]; index: number; canRedo: boolean }> {
  return page.evaluate(() => {
    const e = (globalThis as any).__reskinSession.engine;
    return { labels: e.historyEntries.map((h: any) => h.label), index: e.historyIndex, canRedo: e.canRedo };
  });
}

/** Screenshot attached to the report; saved to e2e/__screenshots__ with RESKIN_SCREENSHOTS=1. */
export async function shoot(target: Page | Locator, info: TestInfo, name: string): Promise<void> {
  const png = await target.screenshot({ animations: 'disabled' });
  await info.attach(name, { body: png, contentType: 'image/png' });
  if (process.env.RESKIN_SCREENSHOTS === '1') {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, name), png);
  }
}
