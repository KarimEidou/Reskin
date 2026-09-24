import { describe, expect, it, vi } from 'vitest';
import type { AckStage, EditorCmd, Settings } from '$lib/ipc/types';
import { defaultSettings } from '$lib/settings/defaults';
import {
  isHandoffCmd,
  MorphController,
  type CollapseCmd,
  type HandoffCmd,
  type MorphIssue,
  type MorphPhase,
  type MorphSurface,
  type PrepareCmd,
} from './MorphController';

const settings: Settings = defaultSettings();
const rect = { x: 32, y: 32, w: 148, h: 148 };

const prepare = (session: number): PrepareCmd => ({
  type: 'prepare',
  session,
  boxRect: rect,
  items: [],
  view: 'start',
  settings,
  morph: true,
});
const reveal = (session: number): HandoffCmd => ({ type: 'reveal', session });
const expand = (session: number, morph = true): HandoffCmd => ({ type: 'expand', session, morph });
const collapse = (session: number, over: Partial<CollapseCmd> = {}): CollapseCmd => ({
  type: 'collapse',
  session,
  boxRect: rect,
  then: 'hide',
  icon: null,
  morph: true,
  ...over,
});
const clear = (session: number): HandoffCmd => ({ type: 'clear', session });

type Log = string[];

function fakeSurface(log: Log, over: Partial<MorphSurface> = {}): MorphSurface {
  return {
    prepare: vi.fn(async (cmd: PrepareCmd) => void log.push(`surface:prepare:${cmd.session}`)),
    reveal: vi.fn(() => void log.push('surface:reveal')),
    expand: vi.fn(async (morph: boolean) => void log.push(`surface:expand:${morph}`)),
    collapse: vi.fn(async (cmd: CollapseCmd) => void log.push(`surface:collapse:${cmd.then}`)),
    clear: vi.fn(() => void log.push('surface:clear')),
    nextFrame: vi.fn(async () => void log.push('nextFrame')),
    frames: vi.fn(async () => void log.push('frames')),
    ...over,
  };
}

function setup(over: Partial<MorphSurface> = {}, timeouts = {}) {
  const log: Log = [];
  const acks: Array<[number, AckStage]> = [];
  const phases: MorphPhase[] = [];
  const issues: MorphIssue[] = [];
  const surface = fakeSurface(log, over);
  const controller = new MorphController({
    surface,
    ack: (session, stage) => {
      acks.push([session, stage]);
      log.push(`ack:${session}:${stage}`);
    },
    timeouts: { prepare: 40, prepareFrames: 20, swapFrame: 20, reveal: 20, expand: 60, collapse: 60, settle: 20, ...timeouts },
    onPhase: (p) => phases.push(p),
    onIssue: (i) => issues.push(i),
  });
  return { controller, surface, log, acks, phases, issues };
}

const never = () => new Promise<never>(() => {});

describe('MorphController', () => {
  it('runs a full open/close cycle in protocol order', async () => {
    const { controller, log, acks, phases } = setup();
    expect(await controller.handle(prepare(1))).toBe('done');
    expect(controller.phase).toBe('prepared');
    expect(await controller.handle(reveal(1))).toBe('done');
    expect(controller.visible).toBe(true);
    expect(await controller.handle(expand(1))).toBe('done');
    expect(controller.phase).toBe('open');
    expect(await controller.handle(collapse(1, { then: 'fly' }))).toBe('done');
    expect(await controller.handle(clear(1))).toBe('done');
    expect(controller.phase).toBe('cleared');
    expect(controller.visible).toBe(false);

    expect(acks).toEqual([
      [1, 'prepared'],
      [1, 'revealed'],
      [1, 'expanded'],
      [1, 'collapsed'],
      [1, 'cleared'],
    ]);
    expect(log).toEqual([
      'surface:prepare:1',
      'frames',
      'ack:1:prepared',
      // The swaps with the box, each on the next frame.
      'nextFrame',
      'surface:reveal',
      'frames',
      'ack:1:revealed',
      'surface:expand:true',
      'ack:1:expanded',
      'surface:collapse:fly',
      'frames',
      'ack:1:collapsed',
      'nextFrame',
      'surface:clear',
      'frames',
      'ack:1:cleared',
    ]);
    expect(phases).toEqual([
      'preparing',
      'prepared',
      'revealed',
      'expanding',
      'open',
      'collapsing',
      'collapsed',
      'clearing',
      'cleared',
    ]);
  });

  it('swaps pictures with the box on a frame: the proxy shows, and goes, only then', async () => {
    const frameCalls: Array<() => void> = [];
    const { controller, surface, acks } = setup(
      { nextFrame: () => new Promise<void>((resolve) => frameCalls.push(resolve)) },
      { swapFrame: 5000 },
    );
    await controller.handle(prepare(1));
    // Prepared: the proxy is laid out and held, nothing painted yet.
    expect(surface.reveal).not.toHaveBeenCalled();
    const revealed = controller.handle(reveal(1));
    await vi.waitFor(() => expect(frameCalls).toHaveLength(1));
    expect(surface.reveal).not.toHaveBeenCalled();
    // The frame comes: the proxy shows in it (the box stops painting in its
    // own next frame), then the ack once that frame is on screen.
    frameCalls[0]!();
    expect(await revealed).toBe('done');
    expect(surface.reveal).toHaveBeenCalledTimes(1);
    await controller.handle(expand(1));
    await controller.handle(collapse(1));
    const cleared = controller.handle(clear(1));
    await vi.waitFor(() => expect(frameCalls).toHaveLength(2));
    expect(surface.clear).not.toHaveBeenCalled();
    frameCalls[1]!();
    expect(await cleared).toBe('done');
    expect(surface.clear).toHaveBeenCalledTimes(1);
    expect(acks.map(([, stage]) => stage)).toEqual(['prepared', 'revealed', 'expanded', 'collapsed', 'cleared']);
  });

  it('swaps anyway when the frame never comes', async () => {
    const { controller, surface, acks, issues } = setup({ nextFrame: never });
    await controller.handle(prepare(1));
    expect(await controller.handle(reveal(1))).toBe('done');
    expect(surface.reveal).toHaveBeenCalledTimes(1);
    await controller.handle(expand(1));
    await controller.handle(collapse(1));
    expect(await controller.handle(clear(1))).toBe('done');
    expect(surface.clear).toHaveBeenCalledTimes(1);
    expect(acks.map(([, stage]) => stage)).toEqual(['prepared', 'revealed', 'expanded', 'collapsed', 'cleared']);
    expect(issues.map((i) => `${i.step}:${i.kind}`)).toEqual(['frames:timeout', 'frames:timeout']);
  });

  it('passes the morph flag through (crossfade fallback)', async () => {
    const { controller, surface, acks } = setup();
    await controller.handle(prepare(1));
    // Rust skips waiting for Revealed when Prepared came late, but still sends Reveal first.
    await controller.handle(expand(1, false));
    expect(surface.expand).toHaveBeenCalledWith(false);
    expect(acks.map(([, s]) => s)).toEqual(['prepared', 'expanded']);
  });

  it('ignores commands for other sessions', async () => {
    const { controller, surface, acks } = setup();
    await controller.handle(prepare(2));
    expect(await controller.handle(reveal(1))).toBe('stale');
    expect(await controller.handle(expand(3))).toBe('stale');
    expect(await controller.handle(collapse(1))).toBe('stale');
    expect(await controller.handle(clear(1))).toBe('stale');
    expect(await controller.handle(prepare(1))).toBe('stale');
    expect(surface.expand).not.toHaveBeenCalled();
    expect(surface.collapse).not.toHaveBeenCalled();
    expect(surface.clear).not.toHaveBeenCalled();
    expect(surface.prepare).toHaveBeenCalledTimes(1);
    expect(acks).toEqual([[2, 'prepared']]);
    expect(controller.session).toBe(2);
  });

  it('a newer Prepare supersedes an open session', async () => {
    const { controller, acks } = setup();
    await controller.handle(prepare(1));
    await controller.handle(reveal(1));
    await controller.handle(expand(1));
    await controller.handle(prepare(2));
    expect(await controller.handle(collapse(1))).toBe('stale');
    expect(await controller.handle(reveal(2))).toBe('done');
    expect(acks.at(-1)).toEqual([2, 'revealed']);
  });

  it('rejects steps out of protocol order', async () => {
    const { controller, surface } = setup();
    expect(await controller.handle(expand(0))).toBe('stale');
    await controller.handle(prepare(1));
    await controller.handle(expand(1));
    // A Reveal that arrives after Expand is meaningless.
    expect(await controller.handle(reveal(1))).toBe('stale');
    await controller.handle(collapse(1));
    await controller.handle(clear(1));
    // A late duplicate after the close is only re-acked, never replayed.
    expect(await controller.handle(expand(1))).toBe('repeated');
    expect(surface.expand).toHaveBeenCalledTimes(1);
    expect(await controller.handle(collapse(1))).toBe('repeated');
    expect(surface.collapse).toHaveBeenCalledTimes(1);
  });

  it('re-acks repeated commands without redoing them', async () => {
    const { controller, surface, acks } = setup();
    await controller.handle(prepare(4));
    expect(await controller.handle(prepare(4))).toBe('repeated');
    await controller.handle(reveal(4));
    expect(await controller.handle(reveal(4))).toBe('repeated');
    await controller.handle(expand(4));
    await controller.handle(collapse(4));
    await controller.handle(clear(4));
    expect(await controller.handle(clear(4))).toBe('repeated');
    expect(surface.prepare).toHaveBeenCalledTimes(1);
    expect(surface.clear).toHaveBeenCalledTimes(1);
    expect(acks.filter(([, s]) => s === 'cleared')).toHaveLength(2);
    expect(acks.filter(([, s]) => s === 'prepared')).toHaveLength(2);
  });

  it('acks even when a step hangs (hidden window, stuck decode)', async () => {
    const { controller, acks, issues } = setup({ prepare: never, frames: never });
    const t0 = Date.now();
    expect(await controller.handle(prepare(1))).toBe('done');
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(40);
    expect(took).toBeLessThan(1000);
    expect(acks).toEqual([[1, 'prepared']]);
    expect(issues.map((i) => `${i.step}:${i.kind}`)).toEqual(['prepare:timeout', 'frames:timeout']);
  });

  it('acks after an animation overruns its time box', async () => {
    const { controller, acks, issues } = setup({ expand: never, collapse: never });
    await controller.handle(prepare(1));
    await controller.handle(reveal(1));
    await controller.handle(expand(1));
    await controller.handle(collapse(1));
    expect(acks.map(([, s]) => s)).toEqual(['prepared', 'revealed', 'expanded', 'collapsed']);
    expect(issues.map((i) => `${i.step}:${i.kind}`)).toEqual(['expand:timeout', 'collapse:timeout']);
  });

  it('acks after a step throws and reports it', async () => {
    const boom = new Error('boom');
    const { controller, acks, issues } = setup({
      expand: () => {
        throw boom;
      },
      clear: async () => {
        throw boom;
      },
    });
    await controller.handle(prepare(1));
    await controller.handle(expand(1));
    await controller.handle(collapse(1));
    await controller.handle(clear(1));
    expect(acks.map(([, s]) => s)).toEqual(['prepared', 'expanded', 'collapsed', 'cleared']);
    expect(issues).toEqual([
      { session: 1, step: 'expand', kind: 'error', error: boom },
      { session: 1, step: 'clear', kind: 'error', error: boom },
    ]);
  });

  it('a page that never prepared still completes a close', async () => {
    const { controller, surface, acks } = setup();
    expect(await controller.handle(collapse(7))).toBe('done');
    expect(await controller.handle(clear(7))).toBe('done');
    expect(surface.collapse).toHaveBeenCalledTimes(1);
    expect(acks).toEqual([
      [7, 'collapsed'],
      [7, 'cleared'],
    ]);
  });

  it('survives a failing ack', async () => {
    const issues: MorphIssue[] = [];
    const controller = new MorphController({
      surface: fakeSurface([]),
      ack: () => Promise.reject(new Error('ipc down')),
      timeouts: { prepareFrames: 10 },
      onIssue: (i) => issues.push(i),
    });
    expect(await controller.handle(prepare(1))).toBe('done');
    expect(issues).toMatchObject([{ step: 'prepare', kind: 'error' }]);
  });

  it('drops a step whose session was superseded while it ran', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const acks: Array<[number, AckStage]> = [];
    const controller = new MorphController({
      surface: fakeSurface([], { prepare: (cmd) => (cmd.session === 1 ? gate : undefined) }),
      ack: (s, st) => void acks.push([s, st]),
      timeouts: { prepare: 5000, prepareFrames: 10 },
    });
    const first = controller.handle(prepare(1));
    // The mailbox is sequential, but a direct caller could overlap.
    await controller.handle(prepare(2));
    release();
    expect(await first).toBe('stale');
    expect(acks).toEqual([[2, 'prepared']]);
  });

  it('recognises handoff commands', () => {
    const cmds: EditorCmd[] = [
      prepare(1),
      reveal(1),
      expand(1),
      collapse(1),
      clear(1),
      { type: 'navigate', view: 'library' },
      { type: 'heartbeat' },
      { type: 'addItems', items: [] },
      { type: 'smokeCycle', item: 'x' },
    ];
    expect(cmds.map(isHandoffCmd)).toEqual([true, true, true, true, true, false, false, false, false]);
  });
});
