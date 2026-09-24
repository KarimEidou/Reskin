// Playwright helpers for the panels harness (node side, used by
// e2e/panels.spec.ts and e2e/presets.spec.ts). Everything about the page
// goes through the real UI or the e2e-exposed session
// (globalThis.__reskinSession).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { E2EConfig } from '../../../testing/e2e-api';
import type { SidebarTab } from '../../state/session.svelte';

export const SHOTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../e2e/__screenshots__');

/** Opens the harness (fake backend config, optional `?item=` / `?blank`) and waits for the design. */
export async function openHarness(page: Page, url: string, config: E2EConfig = {}, query = ''): Promise<void> {
  await page.addInitScript((c) => {
    window.__E2E_CONFIG__ = c;
  }, config);
  await page.goto(url + query);
  await expect(page.locator('main[data-ready="true"]')).toBeAttached({ timeout: 30_000 });
}

export function sidebar(page: Page): Locator {
  return page.getByTestId('sidebar');
}

/** Selects a sidebar tab by clicking it (tabs are named by their label). */
export async function openTab(page: Page, tab: SidebarTab): Promise<void> {
  await sidebar(page).locator(`[role="tab"][data-tab="${tab}"]`).click();
  await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
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
