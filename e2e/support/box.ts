// Page object for the floating box (box.html) in the e2e build.

import { expect, type Locator, type Page } from '@playwright/test';
import type { FlightPhase } from '../../src/lib/ipc/types';
import type { BoxVisualState } from '../../src/lib/ui/box-geometry';
import { emit, openPage, type E2EConfig } from './e2e';

type Point = { x: number; y: number };

export class BoxDriver {
  /** `<main>` with data-state / data-ready / data-skin. */
  readonly root: Locator;
  /** The focusable role=button hit area. */
  readonly hit: Locator;
  /** BoxVisual's root (its own data-state is the *visual* state). */
  readonly visual: Locator;
  readonly badge: Locator;
  readonly icon: Locator;
  readonly ring: Locator;
  readonly undo: Locator;

  constructor(readonly page: Page) {
    this.root = page.locator('main.box-page');
    this.hit = this.root.locator('.hit');
    this.visual = this.root.locator('.bv');
    this.badge = this.visual.locator('.badge');
    this.icon = this.visual.locator('img.icon');
    this.ring = this.visual.locator('svg.ring');
    this.undo = this.root.getByRole('button', { name: 'Undo' });
  }

  /** Opens box.html with an optional fake-backend config and waits for boot. */
  static async open(page: Page, config: E2EConfig = {}): Promise<BoxDriver> {
    // Playwright's mouse starts at (0, 0) — right over the box, which sits in
    // the page's top-left corner — and Chromium would report a hover.
    await page.mouse.move(600, 400);
    await openPage(page, 'box', config);
    return new BoxDriver(page);
  }

  /** Moves the pointer away from the box (it lives in the top-left corner). */
  async pointerAway(): Promise<void> {
    await this.page.mouse.move(600, 400);
  }

  async expectState(state: BoxVisualState, timeout?: number): Promise<void> {
    await expect(this.root).toHaveAttribute('data-state', state, timeout ? { timeout } : undefined);
  }

  state(): Promise<string | null> {
    return this.root.getAttribute('data-state');
  }

  /** A CSS px point in the box window as Tauri reports drops: PHYSICAL px. */
  async physical(at: Point = { x: 74, y: 74 }): Promise<Point> {
    const dpr = await this.page.evaluate(() => window.devicePixelRatio);
    return { x: at.x * dpr, y: at.y * dpr };
  }

  async dragEnter(paths: string[], at?: Point): Promise<void> {
    await emit(this.page, 'tauri://drag-enter', { paths, position: await this.physical(at) });
  }

  async dragOver(at?: Point): Promise<void> {
    await emit(this.page, 'tauri://drag-over', { position: await this.physical(at) });
  }

  async dragLeave(): Promise<void> {
    await emit(this.page, 'tauri://drag-leave', null);
  }

  async drop(paths: string[], at?: Point): Promise<void> {
    await emit(this.page, 'tauri://drag-drop', { paths, position: await this.physical(at) });
  }

  async flight(phase: FlightPhase, icon: string | null = null, message: string | null = null): Promise<void> {
    await emit(this.page, 'box:flight', { phase, icon, durationMs: 420, message });
  }

  async progress(done: number, total: number): Promise<void> {
    await emit(this.page, 'box:progress', { done, total });
  }

  /** Number of CSS/WAAPI animations currently running on the page. */
  runningAnimations(): Promise<number> {
    return this.page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running' || a.pending).length,
    );
  }

  /** Waits until nothing animates any more (transitions settled). */
  async expectStatic(timeout = 4000): Promise<void> {
    await expect.poll(() => this.runningAnimations(), { timeout }).toBe(0);
  }
}
