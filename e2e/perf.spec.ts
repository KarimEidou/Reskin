// M6 performance (docs/ARCHITECTURE.md, "Performance").
//
// With the CPU throttled 4× (Chromium, through CDP), the morph of the open
// handoff, the collapse, and the box's hover → armed → absorb must never
// block the main thread for more than 50 ms — no long task
// (PerformanceObserver) and no gap between two animation frames longer than
// that — and must animate at 55 fps or better (median frame ≤ 18.2 ms).
// Idle, neither page runs an animation frame, an animation or any rendering
// work at all.
//
// A handoff's motion is timed from the moment its animations play (the
// morph frame's `data-transition`) to its end. What comes before it shows
// a picture that is already on screen — the editor gets ready while hidden
// or behind the box proxy, and the first frame of a morph is the picture
// it starts from — so it is waiting, not jank; how long the open waited is
// printed with its numbers.
//
// Timing depends on the machine: each timed scenario runs up to three times
// on a freshly loaded page and the best attempt counts; every attempt's
// numbers are printed and attached to the test. Work that only exists in
// the test — the fake backend's (tauri-mock.ts stands in for Rust on the
// page's own thread) and Playwright's injected scripts — is done before
// measuring wherever it can be, and the timed handoffs are driven from
// here, one command at a time, as Rust drives them (see `openHandoff`).

import type { Browser, CDPSession, Page } from '@playwright/test';
import type { EditorView, ItemInfo, Rect } from '../src/lib/ipc/types';
import {
  BoxDriver,
  calls,
  expect,
  makeItems,
  openPage,
  pushEditorCmd,
  SAMPLE_PATHS,
  settings,
  simulateClose,
  simulateOpen,
  test,
  waitForAck,
  waitForCall,
} from './support/fixtures';

// One worker runs these one after another: they would compete for the CPU.
test.describe.configure({ mode: 'default' });
// Playwright's trace recording works on the page's own thread.
test.use({ trace: 'off' });

const CPU_THROTTLE = 4;
/** No main-thread task may take longer. */
const LONG_TASK_MS = 50;
/**
 * Frame timestamps sit on the display's 60 Hz grid, so three frame
 * intervals read as 50.0 or 50.1 ms.
 */
const VSYNC_JITTER_MS = 0.5;
/** 55 fps. */
const MEDIAN_FRAME_MS = 18.2;
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 2000;
/** How long an idle page is watched. */
const IDLE_MS = 2000;
/** Tasks an idle page may run in IDLE_MS (the test's own probes included). */
const IDLE_TASKS_MS = 20;

// ---- the in-page probe -----------------------------------------------------------

interface PerfProbe {
  /** Every long task since the page started (page clock, ms). */
  longTasks: Array<{ start: number; duration: number }>;
  /** When each handoff's animations started to play (page clock, ms). */
  motionStarts: number[];
  /** Animation-frame callbacks the page itself ran (the sampler's excluded). */
  pageFrames: number;
  /** Frame timestamps collected while sampling. */
  samples: number[];
  sampling: boolean;
  /** Collects the timestamp of every frame from now on; returns `performance.now()`. */
  startSampling(): number;
  stopSampling(): number;
}

declare global {
  interface Window {
    __perf?: PerfProbe;
  }
}

/** Installed before any page script (addInitScript), so it must be self-contained. */
function installProbe(): void {
  const raf = window.requestAnimationFrame.bind(window);
  const probe: PerfProbe = {
    longTasks: [],
    motionStarts: [],
    pageFrames: 0,
    samples: [],
    sampling: false,
    startSampling() {
      probe.samples = [];
      probe.sampling = true;
      const sample = (t: number) => {
        if (!probe.sampling) return;
        probe.samples.push(t);
        raf(sample);
      };
      raf(sample);
      return performance.now();
    },
    stopSampling() {
      probe.sampling = false;
      return performance.now();
    },
  };
  window.__perf = probe;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) probe.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  // The editor's morph frame sets `data-transition` as its animations play.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target instanceof HTMLElement && r.target.dataset.transition) probe.motionStarts.push(performance.now());
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-transition'] });
  window.requestAnimationFrame = (callback) =>
    raf((t) => {
      probe.pageFrames++;
      callback(t);
    });
}

// ---- measuring ----------------------------------------------------------------------

/** A stretch of the page clock (ms). */
interface Span {
  from: number;
  to: number;
}

interface Measurement {
  /** Longest main-thread task running in the span (0: none over 50 ms). */
  longestTask: number;
  /** Longest gap between two frames over the span. */
  longestFrame: number;
  /** Median frame over the animation. */
  medianFrame: number;
  frames: number;
  /** What happened before the motion started, for the report (e.g. how long the open waited for its view). */
  note?: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : Infinity;
}

function frameGaps(samples: number[], span: Span): number[] {
  const inside = samples.filter((t) => t >= span.from && t <= span.to);
  return inside.slice(1).map((t, i) => t - inside[i]!);
}

/** Reads the probe: long tasks and frames over `whole`, the median frame over `animation`. */
async function measure(page: Page, whole: Span, animation: Span): Promise<Measurement> {
  const { longTasks, samples } = await page.evaluate(() => ({
    longTasks: window.__perf!.longTasks,
    samples: window.__perf!.samples,
  }));
  const tasks = longTasks.filter((t) => t.start + t.duration > whole.from && t.start <= whole.to).map((t) => t.duration);
  const animated = frameGaps(samples, animation);
  return {
    longestTask: Math.max(0, ...tasks),
    longestFrame: Math.max(0, ...frameGaps(samples, whole)),
    medianFrame: median(animated),
    frames: animated.length + 1,
  };
}

/** How far over budget (0: within). */
function excess(m: Measurement): number {
  return (
    Math.max(0, m.longestTask - LONG_TASK_MS) +
    Math.max(0, m.longestFrame - LONG_TASK_MS - VSYNC_JITTER_MS) +
    Math.max(0, m.medianFrame - MEDIAN_FRAME_MS) * 10
  );
}

const ms = (v: number) => `${v.toFixed(1)} ms`;

function summary(m: Measurement): string {
  return (
    `longest task ${m.longestTask > 0 ? ms(m.longestTask) : `≤ ${LONG_TASK_MS} ms`}, ` +
    `longest frame ${ms(m.longestFrame)}, median frame ${ms(m.medianFrame)} ` +
    `(${(1000 / m.medianFrame).toFixed(0)} fps over ${m.frames} frames)${m.note ? `; ${m.note}` : ''}`
  );
}

function report(line: string): void {
  console.log(line);
  test.info().annotations.push({ type: 'perf', description: line });
}

/** Runs `attempt` until one is within budget (at most ATTEMPTS times) and asserts the best. */
async function bestOf(name: string, attempt: () => Promise<Measurement>): Promise<void> {
  const results: Measurement[] = [];
  for (let n = 1; n <= ATTEMPTS; n++) {
    const m = await attempt();
    results.push(m);
    report(`perf ${name} #${n}: ${summary(m)} ${excess(m) === 0 ? '✓' : '✗'}`);
    if (excess(m) === 0) break;
    // Let a burst of load on a shared machine pass before trying again.
    if (n < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
  }
  const best = results.reduce((a, b) => (excess(b) < excess(a) ? b : a));
  expect(best.longestTask, `${name}: long task`).toBeLessThanOrEqual(LONG_TASK_MS);
  expect(best.longestFrame, `${name}: longest frame`).toBeLessThanOrEqual(LONG_TASK_MS + VSYNC_JITTER_MS);
  expect(best.medianFrame, `${name}: median frame`).toBeLessThanOrEqual(MEDIAN_FRAME_MS);
}

async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Runs `work` with the CPU throttled; returns what it returns. */
async function throttled<T>(cpu: CDPSession, work: () => Promise<T>): Promise<T> {
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  try {
    return await work();
  } finally {
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

/** Waits until the page's main thread has been idle for `quietMs` (its timers fire on time). */
async function settle(page: Page, quietMs = 400): Promise<void> {
  await page.evaluate(async (quiet) => {
    const tick = 25;
    let since = performance.now();
    for (;;) {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, tick));
      const now = performance.now();
      if (now - t > tick + 12) since = now;
      else if (now - since >= quiet) return;
    }
  }, quietMs);
}

/** Loads Playwright's injected scripts (main world and utility world) before anything is measured. */
async function warmUpPlaywright(page: Page): Promise<void> {
  await page.waitForFunction(() => true, undefined, { polling: 'raf' });
  await expect(page.locator('body')).toBeAttached();
}

/**
 * Makes the fake backend compute what it caches (Rust reads it off the
 * page's thread): the wallpaper, and the frames of `items`.
 */
async function warmUpFake(page: Page, items: ItemInfo[] = []): Promise<void> {
  await page.evaluate(async (ids) => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> } })
      .__TAURI_INTERNALS__;
    await tauri.invoke('wallpaper');
    for (const item of ids) await tauri.invoke('item_frames', { item });
  }, items.map((i) => i.id));
}

/**
 * A freshly loaded editor page, booted and done with its idle preloading,
 * with `paths` inspected (the items, their frames cached).
 */
async function freshEditor(page: Page, paths: string[] = [], config: Parameters<typeof openPage>[2] = {}): Promise<ItemInfo[]> {
  await openPage(page, 'editor', config);
  await warmUpPlaywright(page);
  const items = paths.length > 0 ? await makeItems(page, paths) : [];
  await warmUpFake(page, items);
  // The pre-warmed editor loads its lazy parts 1.5 s after boot (App.svelte).
  await page.waitForFunction(() => performance.now() > 2000);
  await settle(page);
  return items;
}

const designLoaded = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __reskinSession: { hasDesign: boolean } }).__reskinSession.hasDesign);

/** Opens the editor on `items`, unthrottled, and waits until everything settled; returns the session. */
async function openedOn(page: Page, items: ItemInfo[]): Promise<number> {
  const { session } = await simulateOpen(page, items, 'edit', { morph: true });
  await designLoaded(page);
  await afterOpen(page);
  return session;
}

/** Waits until the open editor is done with what it does after an open. */
async function afterOpen(page: Page): Promise<void> {
  // The lazy parts load 300 ms after the open (App.svelte).
  await page.waitForTimeout(500);
  await settle(page);
}

function ackTime(page: Page, stage: string): Promise<number> {
  return page.evaluate((s) => window.__e2e!.acks.findLast((a) => a.stage === s)!.t, stage);
}

/** When the animations of the handoff step sent at `since` started to play (page clock). */
async function motionStart(page: Page, since: number): Promise<number> {
  const t = await page.evaluate((from) => window.__perf!.motionStarts.find((m) => m >= from), since);
  expect(t, 'the handoff animated').toBeDefined();
  return t!;
}

const now = (page: Page) => page.evaluate(() => performance.now());

// ---- the handoff, driven the way Rust drives it ----------------------------------
//
// Rust (windows/morph.rs) runs the handoff from its own process: each
// command reaches the page in a task of its own, after the ack before it.
// The fake backend's simulateOpen / simulateClose run Rust's side on the
// page's thread, where an ack and the next command share one task (the frame
// that acks `revealed` would also start the expand), so the timed handoffs
// push every command from here.

/** Where the box is (the default box size, as the fake backend puts it). */
const BOX_RECT: Rect = { x: 32, y: 32, w: 148, h: 148 };
/** Rust crossfades when the proxy is not drawn within this long (morph.rs). */
const PREPARE_TIMEOUT_MS = 400;

/** Rust's open handoff with the morph; returns its session and when Expand was sent (page clock). */
async function openHandoff(page: Page, items: ItemInfo[], view: EditorView): Promise<{ session: number; expand: number }> {
  const session = await page.evaluate(() => Math.max(window.__e2e!.editor.session, ...window.__e2e!.acks.map((a) => a.session)) + 1);
  await pushEditorCmd(page, {
    type: 'prepare',
    session,
    boxRect: BOX_RECT,
    items,
    view,
    settings: await settings(page),
    morph: true,
  });
  expect(await waitForAck(page, session, 'prepared', PREPARE_TIMEOUT_MS), 'the proxy is drawn in time').toBe(true);
  await pushEditorCmd(page, { type: 'reveal', session });
  expect(await waitForAck(page, session, 'revealed'), 'revealed').toBe(true);
  const expand = await now(page);
  await pushEditorCmd(page, { type: 'expand', session, morph: true });
  expect(await waitForAck(page, session, 'expanded'), 'expanded').toBe(true);
  return { session, expand };
}

/** Rust's close handoff with the morph, the box coming back empty. */
async function closeHandoff(page: Page, session: number): Promise<void> {
  await pushEditorCmd(page, { type: 'collapse', session, boxRect: BOX_RECT, then: 'hide', icon: null, morph: true });
  expect(await waitForAck(page, session, 'collapsed'), 'collapsed').toBe(true);
  await pushEditorCmd(page, { type: 'clear', session });
  expect(await waitForAck(page, session, 'cleared'), 'cleared').toBe(true);
}

/** Opens `items` in `view` (none: the Start view) with the morph, throttled, and measures its motion. */
async function measureOpen(page: Page, cpu: CDPSession, items: ItemInfo[], view: EditorView): Promise<Measurement> {
  const { expand } = await throttled(cpu, async () => {
    await startSampling(page);
    const open = await openHandoff(page, items, view);
    await stopSampling(page);
    return open;
  });
  const from = await motionStart(page, expand);
  const expanded = await ackTime(page, 'expanded');
  const span = { from, to: expanded };
  return { ...(await measure(page, span, span)), note: `the morph started ${ms(from - expand)} after Expand` };
}

/** Closes the editor open in `session` with the morph, throttled, and measures its motion and the Clear after it. */
async function measureClose(page: Page, cpu: CDPSession, session: number): Promise<Measurement> {
  const collapse = await throttled(cpu, async () => {
    const collapse = await startSampling(page);
    await closeHandoff(page, session);
    await stopSampling(page);
    return collapse;
  });
  const from = await motionStart(page, collapse);
  const collapsed = await ackTime(page, 'collapsed');
  const cleared = await ackTime(page, 'cleared');
  const m = await measure(page, { from, to: cleared }, { from, to: collapsed });
  return { ...m, note: `the collapse started ${ms(from - collapse)} after Collapse` };
}

const startSampling = (page: Page) => page.evaluate(() => window.__perf!.startSampling());
const stopSampling = (page: Page) => page.evaluate(() => window.__perf!.stopSampling());

test.describe('under 4× CPU throttling', () => {
  test.beforeEach(async ({ page }) => {
    test.slow();
    await page.addInitScript(installProbe);
  });

  test('the open handoff morphs without long tasks at 55+ fps', async ({ page }) => {
    const cpu = await cdp(page);
    await bestOf('open morph', async () => {
      // A real item: its design loads and the Edit workspace mounts behind
      // the proxy, then its icon rides the morph onto the canvas.
      const items = await freshEditor(page, [SAMPLE_PATHS.steam]);
      const m = await measureOpen(page, cpu, items, 'edit');
      await expect(page.getByTestId('workspace')).toBeVisible();
      return m;
    });
  });

  test('the collapse morphs without long tasks at 55+ fps', async ({ page }) => {
    const cpu = await cdp(page);
    await bestOf('collapse morph', async () => {
      const items = await freshEditor(page, [SAMPLE_PATHS.steam]);
      return measureClose(page, cpu, await openedOn(page, items));
    });
  });

  // The morph with the smallest view, on its own.
  test('the open handoff to the Start view morphs without long tasks at 55+ fps', async ({ page }) => {
    const cpu = await cdp(page);
    await bestOf('open morph (Start view)', async () => {
      await freshEditor(page);
      return measureOpen(page, cpu, [], 'start');
    });
  });

  test('the collapse from the Start view morphs without long tasks at 55+ fps', async ({ page }) => {
    const cpu = await cdp(page);
    await bestOf('collapse morph (Start view)', async () => {
      await freshEditor(page);
      const { session } = await openHandoff(page, [], 'start');
      await afterOpen(page);
      return measureClose(page, cpu, session);
    });
  });

  test('the box hovers, arms and absorbs without long tasks at 55+ fps', async ({ page }) => {
    const cpu = await cdp(page);
    const paths = [SAMPLE_PATHS.steam];
    await bestOf('box hover → armed → absorb', async () => {
      const box = await BoxDriver.open(page);
      await warmUpPlaywright(page);
      await makeItems(page, paths);
      await box.expectStatic();
      await settle(page);
      const span = await throttled(cpu, async () => {
        const from = await startSampling(page);
        await box.hit.hover();
        await box.expectState('hover');
        await page.waitForTimeout(400);
        await box.dragEnter(paths);
        await box.expectState('armed');
        await page.waitForTimeout(600);
        await box.drop(paths, { x: 20, y: 130 });
        await box.waitForVisualState('absorbing');
        await waitForCall(page, 'open_editor');
        return { from, to: await stopSampling(page) };
      });
      return measure(page, span, span);
    });
  });
});

test.describe('idle', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installProbe);
  });

  /** Watches the page for IDLE_MS: frame callbacks, running animations and rendering work. */
  async function watchIdle(page: Page) {
    const devtools = await cdp(page);
    await devtools.send('Performance.enable');
    const metrics = async () => {
      const { metrics: list } = await devtools.send('Performance.getMetrics');
      return (name: string) => list.find((m) => m.name === name)?.value ?? 0;
    };
    // Only one metric read falls between `before` and `after`, and its own
    // cost (it walks the whole DOM) is measured first and taken off: the
    // test's probing is not the page's work.
    const frames = await page.evaluate(() => window.__perf!.pageFrames);
    const first = await metrics();
    const before = await metrics();
    const probeMs = (before('TaskDuration') - first('TaskDuration')) * 1000;
    await page.waitForTimeout(IDLE_MS);
    const after = await metrics();
    const seen = await page.evaluate(
      (f) => ({
        pageFrames: window.__perf!.pageFrames - f,
        animations: document
          .getAnimations()
          .filter((a) => a.playState === 'running' || a.pending)
          .map((a) => {
            const target = (a.effect as KeyframeEffect | null)?.target;
            const what =
              a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : 'script';
            return `${target?.className ?? '?'}: ${what}`;
          }),
      }),
      frames,
    );
    await devtools.send('Performance.disable');
    const idle = {
      ...seen,
      styleRecalcs: after('RecalcStyleCount') - before('RecalcStyleCount'),
      layouts: after('LayoutCount') - before('LayoutCount'),
      taskMs: Math.max(0, (after('TaskDuration') - before('TaskDuration')) * 1000 - probeMs),
    };
    report(
      `perf idle ${new URL(page.url()).pathname}: ${idle.pageFrames} frame callbacks, ` +
        `${idle.animations.length} running animations, ${idle.styleRecalcs} style recalcs, ` +
        `${idle.layouts} layouts, ${ms(idle.taskMs)} of tasks in ${IDLE_MS} ms (probing: ${ms(probeMs)})`,
    );
    return idle;
  }

  function expectIdle(idle: Awaited<ReturnType<typeof watchIdle>>): void {
    expect(idle.pageFrames, 'animation-frame callbacks').toBe(0);
    expect(idle.animations, 'running animations').toEqual([]);
    expect(idle.styleRecalcs, 'style recalcs').toBe(0);
    expect(idle.layouts, 'layouts').toBe(0);
    expect(idle.taskMs, 'main-thread tasks (ms)').toBeLessThan(IDLE_TASKS_MS);
  }

  test('the idle box runs no frames, no animations and no rendering', async ({ page }) => {
    const box = await BoxDriver.open(page);
    await box.expectStatic();
    await settle(page);
    expectIdle(await watchIdle(page));
  });

  test('the idle editor (Edit view) runs no frames, no animations and no rendering', async ({ page }) => {
    await openedOn(page, await freshEditor(page, [SAMPLE_PATHS.steam]));
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    expectIdle(await watchIdle(page));
  });
});

test.describe('the morph frame', () => {
  type TraceEvent = { name: string; ph: string; ts: number; args?: { elementCount?: number } };

  /**
   * `elementCount` of every style recalc while `run` runs (Chromium trace,
   * between user-timing marks around it).
   */
  async function recalcsDuring(browser: Browser, page: Page, run: () => Promise<void>): Promise<number[]> {
    await browser.startTracing(page, { categories: ['devtools.timeline', 'blink.user_timing'] });
    let events: TraceEvent[] = [];
    try {
      await page.evaluate(() => performance.mark('perf:from'));
      await run();
      await page.evaluate(() => performance.mark('perf:to'));
    } finally {
      events = (JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents: TraceEvent[] }).traceEvents;
    }
    const mark = (name: string) => events.find((e) => e.name === name)?.ts;
    const [from, to] = [mark('perf:from'), mark('perf:to')];
    // Without its marks the trace would pass vacuously.
    expect(from, 'trace marks').toBeDefined();
    expect(to, 'trace marks').toBeDefined();
    return events
      .filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X' && e.ts >= from! && e.ts <= to!)
      .map((e) => e.args?.elementCount ?? 0);
  }

  const viewSize = (page: Page) => page.evaluate(() => document.querySelectorAll('[data-view-host] *').length);

  /**
   * No recalc restyled the view (of `view` elements): half of them or more.
   * A change every element of the view inherits restyles nearly all of them
   * (not every one is counted); a targeted change, a few dozen.
   */
  function expectNoViewRestyle(recalcs: number[], view: number): void {
    const whole = recalcs.filter((n) => n >= view / 2);
    expect(whole, `style recalcs of ≥ ${view / 2} elements: ${recalcs.join(', ')}`).toEqual([]);
  }

  test('a collapse never restyles the whole view', async ({ page, browser }) => {
    await openedOn(page, await freshEditor(page, [SAMPLE_PATHS.steam]));
    const view = await viewSize(page);
    expect(view).toBeGreaterThan(200);
    const recalcs = await recalcsDuring(browser, page, async () => {
      expect((await simulateClose(page, 'hide', { morph: true })).timedOut).toEqual([]);
    });
    // Neither the page's `data-stage` change as the collapse starts (the
    // rule hiding floating layers is keyed on them, App.svelte) nor hiding
    // the panel at the end (its content rests unrendered, content-visibility,
    // until the next open) restyles the view.
    expectNoViewRestyle(recalcs, view);
    // …and the next open renders the view again.
    await simulateOpen(page, [SAMPLE_PATHS.notes], 'edit', { morph: true });
    await designLoaded(page);
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('an open morph never restyles the whole view', async ({ page, browser }) => {
    const items = await freshEditor(page, [SAMPLE_PATHS.steam]);
    const session = 1;
    await pushEditorCmd(page, { type: 'prepare', session, boxRect: BOX_RECT, items, view: 'edit', settings: await settings(page), morph: true });
    expect(await waitForAck(page, session, 'prepared')).toBe(true);
    await pushEditorCmd(page, { type: 'reveal', session });
    expect(await waitForAck(page, session, 'revealed')).toBe(true);
    // The view gets ready behind the proxy: laid out and drawn, transparent
    // (checked by its layout alone: how the panel is kept from showing is
    // what this test is about).
    await designLoaded(page);
    await expect.poll(() => page.getByTestId('canvas').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(100);
    await settle(page);
    const view = await viewSize(page);
    expect(view).toBeGreaterThan(200);
    const recalcs = await recalcsDuring(browser, page, async () => {
      await pushEditorCmd(page, { type: 'expand', session, morph: true });
      expect(await waitForAck(page, session, 'expanded')).toBe(true);
    });
    // Showing the panel changes three elements (not `visibility`, which
    // every element of the view would inherit).
    expectNoViewRestyle(recalcs, view);
  });

  test('a morphing panel takes neither the pointer nor the focus, without going inert', async ({ page }) => {
    // Half speed: the collapse runs about a second.
    await freshEditor(page, [], { settings: { animationSpeed: 0.5 } });
    const { session } = await simulateOpen(page, [], 'start');
    const panel = page.getByTestId('editor-panel');
    // `inert` would restyle every element of the panel as a morph starts.
    await panel.evaluate((el) => {
      const w = window as unknown as { __inert: number };
      w.__inert = 0;
      new MutationObserver(() => w.__inert++).observe(el, { attributes: true, attributeFilter: ['inert'] });
    });
    const close = page.getByRole('button', { name: 'Close editor' });
    const at = (await close.boundingBox())!;
    await pushEditorCmd(page, {
      type: 'collapse',
      session,
      boxRect: { x: 32, y: 32, w: 148, h: 148 },
      then: 'hide',
      icon: null,
      morph: true,
    });
    await expect(page.locator('html')).toHaveAttribute('data-stage', 'animating');
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    const focused = await close.evaluate((el) => {
      (el as HTMLElement).focus();
      return document.activeElement === el;
    });
    // Both happened while the panel animated.
    expect(await page.locator('html').getAttribute('data-stage')).toBe('animating');
    expect(focused).toBe(false);
    expect(await waitForAck(page, session, 'collapsed')).toBe(true);
    expect(await calls(page, 'editor_close')).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as { __inert: number }).__inert)).toBe(0);
  });
});
