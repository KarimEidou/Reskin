import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PNG } from 'pngjs';
import type { ApplyOutcome, ApplyRequest, HistoryEntry, IconFrame, ItemInfo, LibrarySave } from '$lib/ipc/types';
import { toast, type ToastOptions } from '$lib/ui/toasts.svelte';
import { Engine, Surface, encodePng } from '$engine/index';
import { isFilterCancelled } from '$engine/filters/client';
import { chainRecipes, filterRecipe } from '../panels/styles/recipe';
import { isCancelled } from '../panels/worker/client';
import { EditorSession, isTarget, type SessionDeps, type StyleRecipe } from './session.svelte';

vi.mock('$lib/sound/synth', () => ({ play: vi.fn() }));
vi.mock('$lib/ui/toasts.svelte', () => ({ toast: vi.fn() }));

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function pngOf(w: number, h: number, rgba: [number, number, number, number]): Promise<string> {
  const s = new Surface(w, h);
  for (let i = 0; i < s.data.length; i += 4) s.data.set(rgba, i);
  return b64(await encodePng(s.data, w, h));
}

function decode(png: string): Promise<Surface> {
  const raw = png.startsWith('data:') ? png.slice(png.indexOf(',') + 1) : png;
  const img = PNG.sync.read(Buffer.from(raw, 'base64'));
  return Promise.resolve(new Surface(img.width, img.height, new Uint8ClampedArray(img.data)));
}

function item(id: string, over: Partial<ItemInfo> = {}): ItemInfo {
  return {
    id,
    kind: 'shortcut',
    name: id,
    path: `C:\\Users\\me\\Desktop\\${id}.lnk`,
    target: null,
    location: 'userDesktop',
    access: 'writable',
    modes: ['inPlace'],
    icon: null,
    iconSource: 'resource',
    customIcon: false,
    reskinned: false,
    storeApp: false,
    systemIcon: null,
    notes: [],
    ...over,
  };
}

const image = (id: string) => item(id, { kind: 'image', modes: [], path: `C:\\Users\\me\\Pictures\\${id}.png` });

type Outcome = (req: ApplyRequest) => ApplyOutcome;

function makeDeps(frames: Record<string, IconFrame[]>, outcome: Outcome): SessionDeps & {
  applied: ApplyRequest[];
  /** What `inspect_paths` finds, by path. */
  inspected: Map<string, ItemInfo>;
} {
  const applied: ApplyRequest[] = [];
  const inspected = new Map<string, ItemInfo>();
  let library = 0;
  return {
    applied,
    inspected,
    decode,
    encode: async (s) => `data:image/png;base64,${b64(await encodePng(s.data, s.width, s.height))}`,
    commands: {
      inspectPaths: vi.fn(async (paths: string[]) => paths.flatMap((p) => inspected.get(p) ?? [])),
      inspectSystemIcon: vi.fn(async (id: string) => {
        throw new Error(`no system icon ${id}`);
      }),
      itemFrames: vi.fn(async (id: string) => frames[id] ?? []),
      readProject: vi.fn(async () => '{}'),
      applyIcon: vi.fn(async (req: ApplyRequest) => {
        applied.push(req);
        return outcome(req);
      }),
      applyIconElevated: vi.fn(async () => outcome({} as ApplyRequest)),
      restore: vi.fn(async () => ({ restored: 1, failed: [], needsElevation: 0 })),
      exportFile: vi.fn(async () => 'C:\\out.reskin'),
      librarySave: vi.fn(async (e: LibrarySave) => ({ id: e.id ?? `lib${++library}`, name: e.name, thumb: e.thumb, updatedAt: 0, bytes: 1 })),
      libraryLoad: vi.fn(async () => '{}'),
      autosave: vi.fn(async () => {}),
      autosaveLoad: vi.fn(async () => null),
      editorClose: vi.fn(async () => {}),
    } as unknown as SessionDeps['commands'],
  };
}

const historyEntry = (id: string) => ({ id }) as HistoryEntry;
const applied: Outcome = () => ({ type: 'applied', entries: [], landed: false });

/** A promise with its resolve function, for driving async order by hand. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Paints the whole active layer one colour: one history step. */
function paint(s: EditorSession, rgba: [number, number, number, number] = [0, 255, 0, 255]): void {
  s.engine.editLayerPixels(s.engine.activeLayer!.id, 'Paint', (surf) => {
    for (let i = 0; i < surf.data.length; i += 4) surf.data.set(rgba, i);
  });
}

/**
 * Whether the engine holds `doc` (as a boolean: a failing `toBe` on two
 * documents would print megabytes of pixels and take minutes).
 */
const holds = (s: EditorSession, doc: unknown) => s.engine.doc === doc;

/** The composite's centre pixel. */
function center(s: EditorSession): number[] {
  const c = s.engine.composite();
  const i = ((c.height >> 1) * c.width + (c.width >> 1)) * 4;
  return Array.from(c.data.slice(i, i + 4));
}

const toasts = () => vi.mocked(toast).mock.calls.map(([o]) => o as ToastOptions);

async function frameOf(c: [number, number, number, number], size = 8): Promise<IconFrame[]> {
  return [{ width: size, height: size, png: await pngOf(size, size, c) }];
}

async function queuedDeps(outcome: Outcome = applied) {
  return makeDeps(
    { a: await frameOf([255, 0, 0, 255]), b: await frameOf([0, 255, 0, 255]), c: await frameOf([0, 0, 255, 255]) },
    outcome,
  );
}

async function queued(outcome: Outcome = applied): Promise<{ s: EditorSession; deps: Awaited<ReturnType<typeof queuedDeps>> }> {
  const deps = await queuedDeps(outcome);
  const s = new EditorSession(deps, new Engine());
  await s.openItems([item('a'), item('b'), item('c')]);
  return { s, deps };
}

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

describe('EditorSession', () => {
  let red: IconFrame;
  let blue: IconFrame;
  beforeEach(async () => {
    red = { width: 32, height: 32, png: await pngOf(32, 32, [255, 0, 0, 255]) };
    blue = { width: 48, height: 48, png: await pngOf(48, 48, [0, 0, 255, 255]) };
  });

  it('classifies targets', () => {
    expect(isTarget(item('a'))).toBe(true);
    expect(isTarget(image('img'))).toBe(false);
  });

  it('queues targets, loads the first icon and keeps each design when switching', async () => {
    const deps = makeDeps({ a: [red], b: [blue] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a'), item('b')]);
    expect(s.view).toBe('edit');
    expect(s.queue.map((q) => q.info.id)).toEqual(['a', 'b']);
    expect(s.currentIndex).toBe(0);
    expect(s.original?.width).toBe(32);
    expect(center(s)).toEqual([255, 0, 0, 255]);

    paint(s);
    await s.select(1);
    expect(center(s)).toEqual([0, 0, 255, 255]);
    await s.select(0);
    expect(center(s)).toEqual([0, 255, 0, 255]);
    expect(s.queue[1]!.project).not.toBeNull();
    s.dispose();
  });

  it('applies with every configured size and records the outcome', async () => {
    const deps = makeDeps({ a: [red] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    const out = await s.apply({ flourish: false });
    expect(out?.type).toBe('applied');
    expect(deps.applied).toHaveLength(1);
    const req = deps.applied[0]!;
    expect(req.mode).toBe('inPlace');
    expect(req.flourish).toBe(false);
    expect(req.images.map((i) => i.size)).toContain(256);
    expect(req.images.map((i) => i.size)).toContain(16);
    expect(s.current?.status).toBe('applied');
    expect(s.busy).toBeNull();
    s.dispose();
  });

  it('turns needsElevation into a pending prompt and can approve it', async () => {
    let n = 0;
    const deps = makeDeps({ a: [red] }, () =>
      n++ === 0 ? { type: 'needsElevation', ticket: 't1', reason: 'Public Desktop' } : applied({} as ApplyRequest),
    );
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a', { access: 'needsElevation', modes: ['inPlace', 'personalCopy'] })]);
    await s.apply();
    expect(s.elevation).toMatchObject({ batch: false, requests: [{ ticket: 't1', mode: 'inPlace', reason: 'Public Desktop' }] });
    expect(s.elevation!.requests[0]!.entry).toBe(s.current);
    await s.approveElevation();
    expect(deps.commands.applyIconElevated).toHaveBeenCalledWith('t1');
    expect(s.elevation).toBeNull();
    expect(s.current?.status).toBe('applied');
    s.dispose();
  });

  it('a personal copy instead sends the same icon in personalCopy mode', async () => {
    let n = 0;
    const deps = makeDeps({ a: [red] }, () =>
      n++ === 0 ? { type: 'needsElevation', ticket: 't1', reason: '' } : applied({} as ApplyRequest),
    );
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a', { access: 'needsElevation', modes: ['inPlace', 'personalCopy'] })]);
    await s.apply();
    await s.personalCopy();
    expect(deps.applied.map((r) => r.mode)).toEqual(['inPlace', 'personalCopy']);
    expect(deps.applied[1]!.images).toEqual(deps.applied[0]!.images);
    expect(deps.applied[1]!.flourish).toBe(true);
    expect(deps.commands.applyIconElevated).not.toHaveBeenCalled();
    expect(s.current?.status).toBe('applied');
    s.dispose();
  });

  it('an image with no target starts a standalone design; later images become layers', async () => {
    const deps = makeDeps({ img: [blue], img2: [red] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([image('img')]);
    expect(s.queue).toHaveLength(0);
    expect(s.view).toBe('edit');
    const before = s.engine.doc.layers.length;
    await s.openItems([image('img2')]);
    expect(s.engine.doc.layers.length).toBe(before + 1);
    expect(s.canApply).toBe(false);
    s.dispose();
  });

  it('applies the current style to every other queued item', async () => {
    const deps = makeDeps({ a: [red], b: [blue], c: [blue] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a'), item('b'), item('c')]);
    const applyRecipe = vi.fn();
    s.recipe = { label: 'Test style', apply: applyRecipe };
    const res = await s.applyStyleToAll();
    expect(res).toEqual({ applied: 2, failed: 0, needsElevation: 0 });
    expect(applyRecipe).toHaveBeenCalledTimes(2);
    expect(deps.applied.map((r) => r.item)).toEqual(['b', 'c']);
    expect(deps.applied.every((r) => r.flourish === false)).toBe(true);
    expect(s.currentIndex).toBe(0);
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'applied', 'applied']);
    s.dispose();
  });
});

describe('EditorSession Save & Apply in a queue', () => {
  it('keeps the editor and the queue: the item is applied and the next one opens; the last one flourishes', async () => {
    const { s, deps } = await queued();
    paint(s);
    await s.apply();
    expect(deps.applied.map((r) => [r.item, r.flourish])).toEqual([['a', false]]);
    expect(s.queue.map((q) => q.status)).toEqual(['applied', 'editing', 'pending']);
    expect(s.currentIndex).toBe(1);
    // The applied item keeps its design.
    await s.select(0);
    expect(center(s)).toEqual([0, 255, 0, 255]);
    await s.select(1);
    await s.apply();
    expect(s.currentIndex).toBe(2);
    await s.apply();
    expect(deps.applied.map((r) => [r.item, r.flourish])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
    expect(s.queue.map((q) => q.status)).toEqual(['applied', 'applied', 'applied']);
    s.dispose();
  });

  it('design sources in the queue wait for nothing: the last target flourishes, and none of them opens', async () => {
    const deps = await queuedDeps();
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    await s.importSources([{ kind: 'image', name: 'Sketch', surface: new Surface(8, 8) }], 'queue');
    await s.openItems([item('b')]);
    expect(s.queue.map((q) => q.info.name)).toEqual(['a', 'Sketch', 'b']);
    // "Apply style to all" leaves the design source alone too.
    expect(s.styleTargets.map((q) => q.info.name)).toEqual(['b']);
    await s.apply();
    // Past the design source, on to the next target.
    expect(s.currentIndex).toBe(2);
    await s.apply();
    expect(deps.applied.map((r) => [r.item, r.flourish])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(s.currentIndex).toBe(2);
    expect(s.queue.map((q) => q.status)).toEqual(['applied', 'pending', 'applied']);
    s.dispose();
  });

  it('moves on to the next item not applied yet, from the end back to the start', async () => {
    const { s, deps } = await queued();
    await s.select(2);
    await s.apply();
    expect(s.currentIndex).toBe(0);
    await s.apply();
    expect(s.currentIndex).toBe(1);
    expect(deps.applied.map((r) => r.flourish)).toEqual([false, false]);
    s.dispose();
  });

  it('a failed apply stays on the item, with the reason', async () => {
    const { s } = await queued(() => ({ type: 'failed', message: 'Read-only', hint: 'Clear the attribute' }));
    await s.apply();
    expect(s.currentIndex).toBe(0);
    expect(s.current).toMatchObject({ status: 'failed', problem: 'Read-only — Clear the attribute' });
    s.dispose();
  });

  it('while the editor stays open, a toast offers Undo for 6 s; Undo puts the icon back', async () => {
    const { s, deps } = await queued(() => ({ type: 'applied', entries: [historyEntry('h1'), historyEntry('h2')], landed: false }));
    s.interactive = true;
    await s.apply();
    const offer = toasts().find((t) => t.action);
    expect(offer).toMatchObject({ kind: 'success', message: 'Applied to a.', timeout: 6000, action: { label: 'Undo' } });
    expect(s.queue[0]!.info.reskinned).toBe(true);
    await offer!.action!.run();
    expect(vi.mocked(deps.commands.restore).mock.calls.map(([t]) => t)).toEqual([
      { type: 'entry', id: 'h1' },
      { type: 'entry', id: 'h2' },
    ]);
    expect(s.queue[0]).toMatchObject({ status: 'editing', outcome: null, unsaved: true });
    expect(s.queue[0]!.info.reskinned).toBe(false);
    expect(toasts().at(-1)).toMatchObject({ message: 'Undid the change to a.', kind: 'success' });
    s.dispose();
  });

  it('an Undo that could not restore everything says so and keeps the item applied', async () => {
    const { s, deps } = await queued(() => ({ type: 'applied', entries: [historyEntry('h1')], landed: false }));
    vi.mocked(deps.commands.restore).mockResolvedValueOnce({ restored: 0, failed: ['locked'], needsElevation: 0 });
    s.interactive = true;
    await s.apply();
    await expect(toasts().find((t) => t.action)!.action!.run()).rejects.toThrow('locked');
    expect(s.queue[0]!.status).toBe('applied');
    s.dispose();
  });

  it('after the flourish (editor hidden) the box offers Undo, not a toast', async () => {
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    await s.apply();
    expect(deps.applied[0]!.flourish).toBe(true);
    expect(toasts()).toEqual([]);
    s.dispose();
  });

  it('a Store app shortcut applies as a classic shortcut (Explorer ignores its own icon)', async () => {
    const store = item('store', { storeApp: true, modes: ['inPlace', 'newShortcut'] });
    const deps = makeDeps({ store: await frameOf([1, 2, 3, 255]), a: await frameOf([4, 5, 6, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([store]);
    expect(s.modes).toEqual(['newShortcut', 'inPlace']);
    await s.apply();
    expect(deps.applied.map((r) => r.mode)).toEqual(['newShortcut']);
    // The batch uses it too.
    s.reset();
    await s.openItems([item('a'), store]);
    s.recipe = { label: 'Look', apply: vi.fn() };
    await s.applyStyleToAll();
    expect(deps.applied.map((r) => [r.item, r.mode])).toEqual([
      ['store', 'newShortcut'],
      ['store', 'newShortcut'],
    ]);
    s.dispose();
  });
});

describe('EditorSession robustness', () => {
  it('does not switch to Edit if the view changed while loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const red = await frameOf([255, 0, 0, 255]);
    const deps = makeDeps({ a: red }, applied);
    const slow = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    slow.mockImplementationOnce(async () => {
      await gate;
      return red;
    });
    const s = new EditorSession(deps, new Engine());
    const opening = s.openItems([item('a')]);
    s.navigate('library');
    release();
    await opening;
    expect(s.view).toBe('library');
    s.dispose();
  });

  it('serialises item switches', async () => {
    const { s } = await queued();
    await Promise.all([s.select(1), s.select(2), s.select(0)]);
    expect(s.currentIndex).toBe(0);
    expect(s.queue.filter((q) => q.project !== null).length).toBeGreaterThanOrEqual(2);
    s.dispose();
  });

  it('the user cannot switch or remove items while a job runs or an item is loading', async () => {
    const { s, deps } = await queued();
    s.busy = { label: 'Applying 1 of 2', progress: 0 };
    expect(s.queueLocked).toBe(true);
    expect(await s.switchTo(1)).toBe(false);
    expect(await s.remove(1)).toBe(false);
    expect(s.currentIndex).toBe(0);
    expect(s.queue).toHaveLength(3);
    s.busy = null;

    const gate = deferred();
    const frames = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    const green = await frameOf([0, 255, 0, 255]);
    frames.mockImplementationOnce(async () => {
      await gate.promise;
      return green;
    });
    const loading = s.switchTo(1);
    expect(s.queueLocked).toBe(true);
    expect(s.canApply).toBe(false);
    expect(await s.switchTo(2)).toBe(false);
    expect(await s.apply()).toBeNull();
    expect(await s.applyStyleToAll()).toEqual({ applied: 0, failed: 0, needsElevation: 0 });
    gate.resolve();
    expect(await loading).toBe(true);
    expect(s.currentIndex).toBe(1);
    expect(s.queueLocked).toBe(false);
    expect(await s.remove(2)).toBe(true);
    expect(s.queue.map((q) => q.info.id)).toEqual(['a', 'b']);
    s.dispose();
  });

  it('designToken changes when a switch starts and again once the design is in', async () => {
    const { s, deps } = await queued();
    const gate = deferred();
    const frames = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    const green = await frameOf([0, 255, 0, 255]);
    frames.mockImplementationOnce(async () => {
      await gate.promise;
      return green;
    });
    const start = s.designToken;
    expect(s.isOpenDesign(start)).toBe(true);
    const oldDoc = s.engine.doc;
    const switching = s.select(1);
    await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(2));
    // Put away already, not replaced yet: work for the old design must stop.
    expect(holds(s, oldDoc)).toBe(true);
    expect(s.designToken).toBe(start + 1);
    expect(s.isOpenDesign(start)).toBe(false);
    // Work started now has nothing to land on either.
    const mid = s.designToken;
    expect(s.isOpenDesign(mid)).toBe(false);
    gate.resolve();
    await switching;
    expect(holds(s, oldDoc)).toBe(false);
    expect(s.designToken).toBe(start + 2);
    expect(s.isOpenDesign(mid)).toBe(false);
    expect(s.isOpenDesign(s.designToken)).toBe(true);
    s.dispose();
  });

  it('an icon asked for while another design is on its way in lands on neither', async () => {
    const { s, deps } = await queued();
    const gate = deferred();
    const frames = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    const green = await frameOf([0, 255, 0, 255]);
    const white = await frameOf([255, 255, 255, 255]);
    frames
      .mockImplementationOnce(async () => {
        await gate.promise;
        return green;
      })
      .mockImplementationOnce(async () => white);
    const oldDoc = s.engine.doc;
    const switching = s.select(1);
    await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(2));
    // "a" is put away, "b" still loading: the icon arrives right away.
    expect(await s.addAsLayer(image('logo'))).toBe(false);
    expect(oldDoc.layers.map((l) => l.name)).toEqual(['a']);
    gate.resolve();
    await switching;
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['b']);
    await s.select(0);
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['a']);
    s.dispose();
  });

  it('a switch fails rather than lose a design that could not be kept', async () => {
    const { s } = await queued();
    paint(s, [9, 9, 9, 255]);
    vi.spyOn(s, 'encodeProject').mockRejectedValueOnce(new Error('The project encoder failed'));
    await expect(s.select(1)).rejects.toThrow('encoder failed');
    expect(s.currentIndex).toBe(0);
    expect(s.queue[1]!.status).toBe('pending');
    expect(center(s)).toEqual([9, 9, 9, 255]);
    expect(s.unsaved).toBe(true);
    // Once it can be kept, the switch goes through and the design is kept.
    await s.select(1);
    await s.select(0);
    expect(center(s)).toEqual([9, 9, 9, 255]);
    s.dispose();
  });

  it('an icon that arrives after another design opened is not added to it', async () => {
    const { s, deps } = await queued();
    const gate = deferred();
    const frames = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    const white = await frameOf([255, 255, 255, 255]);
    frames.mockImplementationOnce(async () => {
      await gate.promise;
      return white;
    });
    const adding = s.addAsLayer(image('logo'));
    await s.select(1);
    const layers = s.engine.doc.layers.length;
    gate.resolve();
    expect(await adding).toBe(false);
    expect(s.engine.doc.layers.length).toBe(layers);
    await s.select(0);
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['a']);
    s.dispose();
  });

  it('a switch whose design cannot be loaded leaves the open one as it was', async () => {
    const { s } = await queued();
    paint(s);
    s.queue[1]!.project = '{"format":"reskin","version":1';
    await expect(s.select(1)).rejects.toThrow();
    expect(s.currentIndex).toBe(0);
    expect(s.queue[1]!.status).toBe('pending');
    expect(center(s)).toEqual([0, 255, 0, 255]);
    expect(s.engine.historyEntries.map((h) => h.label)).toEqual(['Paint']);
    expect(await s.switchTo(2)).toBe(true);
    expect(s.item?.id).toBe('c');
    s.dispose();
  });
});

describe('EditorSession designs without a target', () => {
  it('a target dropped on a design without one takes it over, history and all', async () => {
    const deps = makeDeps({ img: await frameOf([0, 0, 255, 255], 48), a: await frameOf([255, 0, 0, 255], 32) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([image('img')]);
    paint(s, [9, 9, 9, 255]);
    const doc = s.engine.doc;
    expect(s.canApply).toBe(false);
    await s.openItems([item('a'), item('b')]);
    expect(s.queue.map((q) => [q.info.id, q.status])).toEqual([
      ['a', 'editing'],
      ['b', 'pending'],
    ]);
    expect(s.currentIndex).toBe(0);
    expect(holds(s, doc)).toBe(true);
    expect(center(s)).toEqual([9, 9, 9, 255]);
    expect(s.engine.historyEntries.map((h) => h.label)).toEqual(['Paint']);
    expect(s.engine.doc.meta.source).toEqual({ kind: 'shortcut', name: 'a', path: item('a').path });
    await vi.waitFor(() => expect(s.original?.width).toBe(32));
    expect(s.canApply).toBe(true);
    s.dispose();
  });

  it('"Apply this design": a queued design source gives its place to the target', async () => {
    const deps = makeDeps({ img: await frameOf([0, 0, 255, 255]), img2: await frameOf([1, 1, 1, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([image('img')]);
    paint(s, [9, 9, 9, 255]);
    // "Queue as new item": the open design keeps an entry of its own.
    expect(await s.importSources([{ kind: 'item', info: image('img2') }], 'queue')).toBe(1);
    expect(s.queue.map((q) => [q.info.id, q.status])).toEqual([
      ['img', 'editing'],
      ['img2', 'pending'],
    ]);
    expect(s.currentIndex).toBe(0);
    expect(await s.importSources([{ kind: 'item', info: item('a') }], 'adopt')).toBe(0);
    expect(s.queue.map((q) => [q.info.id, q.status])).toEqual([
      ['a', 'editing'],
      ['img2', 'pending'],
    ]);
    expect(center(s)).toEqual([9, 9, 9, 255]);
    expect(s.engine.canUndo).toBe(true);
    expect(s.canApply).toBe(true);
    s.dispose();
  });

  it('"Apply this design" to a shortcut waiting in the queue takes its place, unless it has a design of its own', async () => {
    const deps = makeDeps({ img: await frameOf([0, 0, 255, 255]), a: await frameOf([255, 0, 0, 255]), b: await frameOf([0, 255, 0, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([image('img')]);
    paint(s, [9, 9, 9, 255]);
    await s.importSources([{ kind: 'item', info: item('a') }, { kind: 'item', info: item('b') }], 'queue');
    // b is opened (it has a design of its own now); a still waits.
    await s.select(2);
    await s.select(0);
    expect(s.canAdopt(item('a'))).toBe(true);
    expect(s.canAdopt(item('b'))).toBe(false);
    expect(s.canAdopt(image('img2'))).toBe(false);
    expect(await s.importSources([{ kind: 'item', info: item('b') }, { kind: 'item', info: item('a') }], 'adopt')).toBe(0);
    expect(s.queue.map((q) => [q.info.id, q.status])).toEqual([
      ['a', 'editing'],
      ['b', 'editing'],
    ]);
    expect(s.currentIndex).toBe(0);
    expect(center(s)).toEqual([9, 9, 9, 255]);
    expect(s.canApply).toBe(true);
    expect(s.canAdopt(item('c'))).toBe(false);
    await s.select(1);
    expect(center(s)).toEqual([0, 255, 0, 255]);
    s.dispose();
  });

  it('queueing a target instead keeps the design as an item of its own, and nothing is lost', async () => {
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    s.newBlank();
    paint(s, [7, 7, 7, 255]);
    expect(await s.importSources([{ kind: 'item', info: item('a') }], 'queue')).toBe(1);
    expect(s.queue.map((q) => [q.info.name, q.info.kind, q.status])).toEqual([
      ['Untitled', 'project', 'editing'],
      ['a', 'shortcut', 'pending'],
    ]);
    await s.select(1);
    expect(center(s)).toEqual([255, 0, 0, 255]);
    await s.select(0);
    expect(center(s)).toEqual([7, 7, 7, 255]);
    expect(s.canApply).toBe(false);
    s.dispose();
  });

  it('layers: pictures, images and other items’ icons join the open design; a project joins the queue', async () => {
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]), b: await frameOf([0, 255, 0, 255]), logo: await frameOf([1, 2, 3, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    const picture = new Surface(8, 8);
    const added = await s.importSources(
      [
        { kind: 'item', info: item('b') },
        { kind: 'item', info: image('logo') },
        { kind: 'item', info: item('p', { kind: 'project', modes: [] }) },
        { kind: 'image', name: 'Pasted image', surface: picture },
      ],
      'layer',
    );
    expect(added).toBe(1);
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['a', 'b', 'logo', 'Pasted image']);
    expect(s.queue.map((q) => q.info.id)).toEqual(['a', 'p']);
    expect(s.currentIndex).toBe(0);
    s.dispose();
  });

  it('pictures and projects queued as new items replace nothing', async () => {
    const project = await new Engine().serialize();
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]) }, applied);
    vi.mocked(deps.commands.readProject).mockResolvedValue(project);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    paint(s);
    const picture = new Surface(16, 16);
    picture.fill(3, 4, 5, 255);
    await s.importSources(
      [
        { kind: 'image', name: 'Pasted image', surface: picture },
        { kind: 'item', info: item('p', { kind: 'project', modes: [], path: 'C:\\p.reskin' }) },
      ],
      'queue',
    );
    expect(s.queue.map((q) => q.info.name)).toEqual(['a', 'Pasted image', 'p']);
    expect(s.currentIndex).toBe(0);
    expect(center(s)).toEqual([0, 255, 0, 255]);
    await s.select(1);
    expect(center(s)).toEqual([3, 4, 5, 255]);
    await s.select(2);
    expect(deps.commands.readProject).toHaveBeenCalledWith('p');
    await s.select(0);
    expect(center(s)).toEqual([0, 255, 0, 255]);
    s.dispose();
  });

  it('a picture added as a layer keeps the work in progress; Undo takes back just the picture', async () => {
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    // An adjustment being tuned in its panel.
    const preview = s.engine.beginPreview('Invert', { layerId: s.engine.activeLayer!.id })!;
    preview.update((surface) => surface.fill(10, 20, 30, 255));
    s.previewRecipe = { preview, recipe: () => chainRecipes(s.recipe, filterRecipe('invert', 'Invert', {}, 512)) };
    await s.importSources([{ kind: 'image', name: 'Pasted image', surface: new Surface(8, 8) }], 'layer');
    expect(preview.state).toBe('committed');
    expect(s.recipe?.label).toBe('Invert');
    expect(s.engine.historyEntries.map((e) => e.label)).toEqual(['Invert', 'Import Pasted image']);
    s.engine.undo();
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['a']);
    expect(center(s)).toEqual([10, 20, 30, 255]);
    s.dispose();
  });

  it('with nothing open, imports simply open', async () => {
    const deps = makeDeps({ a: await frameOf([255, 0, 0, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    const picture = new Surface(16, 16);
    picture.fill(3, 4, 5, 255);
    await s.importSources([{ kind: 'image', name: 'Pasted image', surface: picture }], 'queue');
    expect(s.hasDesign).toBe(true);
    expect(s.view).toBe('edit');
    expect(s.queue).toHaveLength(0);
    expect(s.engine.doc.layers.map((l) => l.name)).toEqual(['Pasted image']);
    expect(s.engine.canUndo).toBe(false);
    s.reset();
    expect(await s.importSources([{ kind: 'item', info: item('a') }], 'layer')).toBe(1);
    expect(s.item?.id).toBe('a');
    s.dispose();
  });
});

describe('EditorSession style recipes', () => {
  const recipe = (label: string): StyleRecipe => ({ label, apply: vi.fn() });

  it('belongs to the current item: switching shows each item its own recipe', async () => {
    const { s } = await queued();
    const neon = recipe('Neon');
    s.recipe = neon;
    await s.select(1);
    expect(s.recipe).toBeNull();
    // A panel chains onto the current item's recipe, not onto the other item's.
    s.recipe = chainRecipes(s.recipe, filterRecipe('invert', 'Invert', {}, 512));
    expect(s.recipe.label).toBe('Invert');
    const invert = s.recipe;
    await s.select(0);
    expect(s.recipe).toBe(neon);
    expect(chainRecipes(s.recipe, filterRecipe('grayscale', 'Grayscale', {}, 512)).label).toBe('Neon + Grayscale');
    await s.select(1);
    expect(s.recipe).toBe(invert);
    s.dispose();
  });

  it('a new design starts without one (standalone image or project, New blank, Library, recovered autosave)', async () => {
    const project = await new Engine().serialize();
    const blue = await frameOf([0, 0, 255, 255]);
    const deps = makeDeps({ img: blue }, applied);
    (deps.commands.libraryLoad as ReturnType<typeof vi.fn>).mockResolvedValue(project);
    (deps.commands.readProject as ReturnType<typeof vi.fn>).mockResolvedValue(project);
    const s = new EditorSession(deps, new Engine());
    const designs: [string, () => Promise<void>][] = [
      ['image', () => s.openItems([image('img')])],
      ['project', () => s.openItems([item('p', { kind: 'project', modes: [] })])],
      ['blank', async () => s.newBlank()],
      ['library', () => s.openLibraryDesign('lib1')],
      ['autosave', () => s.restoreAutosave(project)],
    ];
    for (const [what, open] of designs) {
      s.reset();
      s.recipe = recipe('Old look');
      await open();
      expect(s.recipe, what).toBeNull();
    }
    s.dispose();
  });

  it("removing the current item shows the next one's recipe; removing the last one forgets it", async () => {
    const { s } = await queued();
    s.recipe = recipe('Look of A');
    await s.select(1);
    s.recipe = recipe('Look of B');
    await s.remove(1);
    expect(s.queue.map((q) => q.info.id)).toEqual(['a', 'c']);
    expect(s.item?.id).toBe('c');
    expect(s.recipe).toBeNull();
    await s.select(0);
    expect(s.recipe?.label).toBe('Look of A');
    await s.remove(1);
    expect(s.recipe?.label).toBe('Look of A');
    await s.remove(0);
    expect(s.hasDesign).toBe(false);
    expect(s.recipe).toBeNull();
    s.dispose();
  });

  it('adding an image to the current design keeps its recipe', async () => {
    const red = await frameOf([255, 0, 0, 255]);
    const deps = makeDeps({ a: red, img: red }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    const look = recipe('Look');
    s.recipe = look;
    await s.openItems([image('img')]);
    expect(s.recipe).toBe(look);
    s.dispose();
  });

  it('"Apply style to all" replays the current item\'s recipe; the styled items keep it', async () => {
    const { s, deps } = await queued();
    s.recipe = recipe('Look of A');
    await s.select(1);
    const look = recipe('Look of B');
    s.recipe = look;
    const res = await s.applyStyleToAll();
    expect(res).toEqual({ applied: 2, failed: 0, needsElevation: 0 });
    expect(look.apply).toHaveBeenCalledTimes(2);
    expect(deps.applied.map((r) => [r.item, r.designName])).toEqual([
      ['a', 'Look of B'],
      ['c', 'Look of B'],
    ]);
    expect(s.currentIndex).toBe(1);
    expect(s.recipe).toBe(look);
    await s.select(0);
    expect(s.recipe).toBe(look);
    s.dispose();
  });

  it('"Apply style to all" leaves the current design alone, undo history included', async () => {
    const { s } = await queued();
    paint(s, [1, 1, 1, 255]);
    paint(s, [2, 2, 2, 255]);
    const doc = s.engine.doc;
    s.recipe = recipe('Look');
    await s.applyStyleToAll();
    expect(holds(s, doc)).toBe(true);
    expect(s.engine.historyIndex).toBe(2);
    s.engine.undo();
    expect(center(s)).toEqual([1, 1, 1, 255]);
    s.dispose();
  });

  it('keeps an adjustment still being previewed when switching items', async () => {
    const { s } = await queued();
    const layer = s.engine.activeLayer!;
    const preview = s.engine.beginPreview('Adjust: Test', { layerId: layer.id })!;
    preview.update((surface) => surface.fill(10, 20, 30, 255));
    await s.select(1);
    expect(preview.state).toBe('committed');
    await s.select(0);
    const c = s.engine.composite();
    expect(Array.from(c.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    s.dispose();
  });

  it('a kept preview adds its step to the recipe of its own design', async () => {
    const { s } = await queued();
    s.recipe = recipe('Neon');
    const preview = s.engine.beginPreview('Invert', { layerId: s.engine.activeLayer!.id })!;
    preview.update((surface) => surface.fill(10, 20, 30, 255));
    s.previewRecipe = { preview, recipe: () => chainRecipes(s.recipe, filterRecipe('invert', 'Invert', {}, 512)) };
    await s.select(1);
    expect(s.previewRecipe).toBeNull();
    expect(s.recipe).toBeNull();
    await s.select(0);
    expect(s.recipe?.label).toBe('Neon + Invert');
    // A preview that is cancelled, or kept without a registered step, leaves the recipe alone.
    const other = s.engine.beginPreview('Blur')!;
    other.update((surface) => surface.fill(1, 2, 3, 255));
    s.previewRecipe = { preview: other, recipe: () => recipe('Wrong') };
    other.cancel();
    expect(s.keepPreview()).toBe(false);
    s.engine.beginPreview('Sharpen')!.update((surface) => surface.fill(4, 5, 6, 255));
    expect(s.keepPreview()).toBe(true);
    expect(s.recipe?.label).toBe('Neon + Invert');
    s.dispose();
  });

  it('"Apply style to all" includes an adjustment still being tuned', async () => {
    const { s } = await queued();
    const look = recipe('Neon');
    s.recipe = look;
    const preview = s.engine.beginPreview('Invert')!;
    preview.update((surface) => surface.fill(10, 20, 30, 255));
    const tuned = recipe('Neon + Invert');
    s.previewRecipe = { preview, recipe: () => tuned };
    const res = await s.applyStyleToAll();
    expect(res).toEqual({ applied: 2, failed: 0, needsElevation: 0 });
    expect(look.apply).not.toHaveBeenCalled();
    expect(tuned.apply).toHaveBeenCalledTimes(2);
    expect(preview.state).toBe('committed');
    expect(s.recipe).toBe(tuned);
    s.dispose();
  });
});

describe('EditorSession "Apply style to all" and administrator approval', () => {
  const byItem =
    (outcomes: Record<string, ApplyOutcome>): Outcome =>
    (req) =>
      (req.mode !== 'personalCopy' && outcomes[req.item]) || { type: 'applied', entries: [historyEntry(`h-${req.item}`)], landed: false };
  const admin = (ticket: string): ApplyOutcome => ({ type: 'needsElevation', ticket, reason: 'Access is denied.' });

  async function batch(outcomes: Record<string, ApplyOutcome>, modes: Record<string, ItemInfo['modes']> = {}) {
    const deps = makeDeps(
      { a: await frameOf([1, 0, 0, 255]), b: await frameOf([2, 0, 0, 255]), c: await frameOf([3, 0, 0, 255]), d: await frameOf([4, 0, 0, 255]) },
      byItem(outcomes),
    );
    const s = new EditorSession(deps, new Engine());
    await s.openItems(['a', 'b', 'c', 'd'].map((id) => item(id, modes[id] ? { modes: modes[id] } : {})));
    s.recipe = { label: 'Look', apply: vi.fn() };
    return { s, deps };
  }

  it('asks about every item that needs approval at once; Allow runs their tickets in turn', async () => {
    const { s, deps } = await batch({ b: admin('t-b'), c: admin('t-c') });
    expect(await s.applyStyleToAll()).toEqual({ applied: 1, failed: 0, needsElevation: 2 });
    expect(s.elevation?.batch).toBe(true);
    expect(s.elevation?.requests.map((r) => [r.entry.info.id, r.ticket])).toEqual([
      ['b', 't-b'],
      ['c', 't-c'],
    ]);
    expect(s.queue.map((q) => [q.status, q.problem])).toEqual([
      ['editing', null],
      ['failed', 'Needs administrator approval'],
      ['failed', 'Needs administrator approval'],
      ['applied', null],
    ]);
    expect(toasts().at(-1)).toMatchObject({ kind: 'warning', message: 'Applied to 1; 0 failed. 2 need administrator approval.' });
    vi.mocked(deps.commands.applyIconElevated).mockImplementation(async (ticket: string) => ({
      type: 'applied',
      entries: [historyEntry(ticket)],
      landed: false,
    }));
    await s.approveElevation();
    expect(vi.mocked(deps.commands.applyIconElevated).mock.calls.map(([t]) => t)).toEqual(['t-b', 't-c']);
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'applied', 'applied', 'applied']);
    expect(s.elevation).toBeNull();
    expect(s.busy).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ kind: 'success', message: 'Applied to 2 more icons.' });
    s.dispose();
  });

  it('declining Windows’ prompt stops asking about the rest', async () => {
    const { s, deps } = await batch({ b: admin('t-b'), c: admin('t-c') });
    await s.applyStyleToAll();
    vi.mocked(deps.commands.applyIconElevated).mockResolvedValue({ type: 'cancelled' });
    await s.approveElevation();
    expect(deps.commands.applyIconElevated).toHaveBeenCalledTimes(1);
    expect(s.queue[1]).toMatchObject({ status: 'failed', problem: 'Administrator approval was declined' });
    expect(s.queue[2]).toMatchObject({ status: 'failed', problem: 'Needs administrator approval' });
    expect(toasts().at(-1)).toMatchObject({ kind: 'error', message: 'Applied to 0 of 2 icons.' });
    s.dispose();
  });

  it('personal copies instead, for the items that allow one, with the icons already made', async () => {
    const shared: ItemInfo['modes'] = ['inPlace', 'personalCopy'];
    const { s, deps } = await batch({ b: admin('t-b'), c: admin('t-c') }, { b: shared });
    await s.applyStyleToAll();
    const images = deps.applied.find((r) => r.item === 'b')!.images;
    await s.personalCopy();
    const copies = deps.applied.filter((r) => r.mode === 'personalCopy');
    expect(copies.map((r) => [r.item, r.flourish])).toEqual([['b', false]]);
    expect(copies[0]!.images).toBe(images);
    expect(deps.commands.applyIconElevated).not.toHaveBeenCalled();
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'applied', 'failed', 'applied']);
    s.dispose();
  });

  it('keeps why an item failed on the item', async () => {
    const { s } = await batch({
      b: { type: 'failed', message: 'The shortcut is read-only.', hint: 'Clear its Read-only attribute.' },
      c: { type: 'unsupported', reason: 'Windows ignores icons on this kind of link.' },
    });
    expect(await s.applyStyleToAll()).toEqual({ applied: 1, failed: 2, needsElevation: 0 });
    expect(s.queue.map((q) => q.problem)).toEqual([
      null,
      'The shortcut is read-only. — Clear its Read-only attribute.',
      'Windows ignores icons on this kind of link.',
      null,
    ]);
    expect(s.elevation).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ kind: 'error', message: 'Applied to 1; 2 failed.' });
    s.dispose();
  });

  it('an item whose design cannot be made is not applied, and says why', async () => {
    const { s, deps } = await batch({});
    vi.spyOn(s, 'encodeProject').mockRejectedValueOnce(new Error('Out of memory'));
    expect(await s.applyStyleToAll()).toEqual({ applied: 2, failed: 1, needsElevation: 0 });
    expect(deps.applied.map((r) => r.item)).toEqual(['c', 'd']);
    expect(s.queue.map((q) => [q.status, q.problem])).toEqual([
      ['editing', null],
      ['failed', 'Out of memory'],
      ['applied', null],
      ['applied', null],
    ]);
    s.dispose();
  });

  it('offers Undo for the batch while the editor is open', async () => {
    const { s, deps } = await batch({});
    s.interactive = true;
    await s.applyStyleToAll();
    const offer = toasts().at(-1)!;
    expect(offer).toMatchObject({ kind: 'success', message: 'Applied "Look" to 3 more icons.', action: { label: 'Undo' } });
    await offer.action!.run();
    expect(vi.mocked(deps.commands.restore).mock.calls.map(([t]) => t)).toEqual(
      ['h-b', 'h-c', 'h-d'].map((id) => ({ type: 'entry', id })),
    );
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'editing', 'editing', 'editing']);
    s.dispose();
  });
});

describe('EditorSession Library', () => {
  it('saves over the Library design it came from or was saved as; "Save as new" adds another', async () => {
    const { s, deps } = await queued();
    const saves = () => vi.mocked(deps.commands.librarySave).mock.calls.map(([e]) => [e.id, e.name]);
    expect((await s.saveToLibrary('A'))?.id).toBe('lib1');
    expect(s.libraryId).toBe('lib1');
    paint(s);
    await s.saveToLibrary();
    await s.saveToLibrary('A copy', { asNew: true });
    expect(s.libraryId).toBe('lib2');
    // Saved, the design goes by its Library name.
    expect(saves()).toEqual([
      [null, 'A'],
      ['lib1', 'A'],
      [null, 'A copy'],
    ]);
    expect(s.engine.doc.meta.name).toBe('A copy');
    // Each queued design keeps its own.
    await s.select(1);
    expect(s.libraryId).toBeNull();
    await s.select(0);
    expect(s.libraryId).toBe('lib2');
    s.forgetLibraryDesign('lib2');
    expect(s.libraryId).toBeNull();
    s.dispose();
  });

  it('updates keep the Library name; a rename says so, and so does the toast', async () => {
    const { s, deps } = await queued();
    const saves = () => vi.mocked(deps.commands.librarySave).mock.calls.map(([e]) => [e.id, e.name]);
    await s.saveToLibrary('Mono');
    expect(toasts().at(-1)).toMatchObject({ message: 'Saved "Mono" to the Library.', kind: 'success' });
    expect([s.libraryId, s.libraryName]).toEqual(['lib1', 'Mono']);
    paint(s);
    await s.saveToLibrary();
    expect(toasts().at(-1)!.message).toBe('Updated "Mono" in the Library.');
    await s.saveToLibrary('Mono v2');
    expect(toasts().at(-1)!.message).toBe('Updated "Mono" in the Library, now named "Mono v2".');
    expect(saves()).toEqual([
      [null, 'Mono'],
      ['lib1', 'Mono'],
      ['lib1', 'Mono v2'],
    ]);
    expect([s.libraryName, s.engine.doc.meta.name]).toEqual(['Mono v2', 'Mono v2']);
    s.dispose();
  });

  it('a Library design renamed while its design waits in the queue: the design takes the new name', async () => {
    const { s, deps } = await queued();
    await s.saveToLibrary('Mono');
    await s.select(1);
    s.libraryDesignRenamed('lib1', 'Night');
    expect(s.queue[0]!.libraryName).toBe('Night');
    await s.select(0);
    expect([s.libraryId, s.libraryName, s.engine.doc.meta.name]).toEqual(['lib1', 'Night', 'Night']);
    expect(s.unsaved).toBe(false);
    // Saving it again updates the design under its new name, not the old one.
    await s.saveToLibrary();
    expect(vi.mocked(deps.commands.librarySave).mock.calls.at(-1)![0]).toMatchObject({ id: 'lib1', name: 'Night' });
    s.dispose();
  });

  it('opening a Library design replaces the current item’s design but keeps its target', async () => {
    const project = await new Engine().serialize();
    const { s, deps } = await queued();
    vi.mocked(deps.commands.libraryLoad).mockResolvedValue(project);
    const original = s.original;
    await s.openLibraryDesign('lib7', 'Neon');
    expect(s.item?.id).toBe('a');
    expect(s.original).toBe(original);
    expect(s.engine.doc.meta.name).toBe('Neon');
    expect(s.engine.doc.meta.source).toEqual({ kind: 'shortcut', name: 'a', path: item('a').path });
    expect([s.libraryId, s.libraryName]).toEqual(['lib7', 'Neon']);
    expect(s.unsaved).toBe(false);
    expect(s.engine.canUndo).toBe(false);
    s.dispose();
  });
});

describe('EditorSession autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const writes = (deps: { commands: SessionDeps['commands'] }) =>
    (deps.commands.autosave as Mock).mock.calls.map(([d]) => d as string | null);

  it('keeps only unsaved changes: opening and closing an item leaves nothing behind', async () => {
    const { s, deps } = await queued();
    await vi.advanceTimersByTimeAsync(5000);
    await s.requestClose();
    expect(s.unsaved).toBe(false);
    expect(writes(deps)).toEqual([]);

    paint(s);
    expect(s.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    await s.flushAutosave();
    expect(writes(deps)).toHaveLength(1);
    expect(JSON.parse(writes(deps)[0]!).meta.source.path).toBe(item('a').path);
    await s.requestClose();
    expect(writes(deps)).toHaveLength(1);
    // Undone back to where it was loaded: nothing unsaved.
    s.engine.undo();
    expect(s.unsaved).toBe(false);
    s.dispose();
  });

  it('a flush keeps the design as it is then: the reset of the next open cannot take it back', async () => {
    const { s, deps } = await queued();
    paint(s, [9, 9, 9, 255]);
    const flushed = s.flushAutosave();
    // A close Rust started: the editor opens again at once (Prepare resets it).
    s.reset();
    await s.openItems([item('b')]);
    await flushed;
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes(deps)).toHaveLength(1);
    const kept = JSON.parse(writes(deps)[0]!);
    expect(kept.meta.source.path).toBe(item('a').path);
    s.dispose();
  });

  it('continuous editing still autosaves at least every 10 s', async () => {
    const { s, deps } = await queued();
    for (let t = 0; t < 25; t++) {
      paint(s, [t, t, t, 255]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.waitFor(() => expect(writes(deps).length).toBeGreaterThanOrEqual(2));
    s.dispose();
  });

  it('unsaved changes are written before another design opens; that one only when it changes', async () => {
    const { s, deps } = await queued();
    paint(s, [5, 5, 5, 255]);
    await s.select(1);
    expect(writes(deps)).toHaveLength(1);
    expect(writes(deps)[0]).toBe(s.queue[0]!.project);
    await vi.advanceTimersByTimeAsync(5000);
    await s.flushAutosave();
    expect(writes(deps)).toHaveLength(1);
    // Back on it, it is still unsaved.
    await s.select(0);
    expect(s.unsaved).toBe(true);
    s.dispose();
  });

  it('a design saved to the Library, exported or applied leaves the autosave to other unsaved work', async () => {
    const { s, deps } = await queued();
    paint(s, [5, 5, 5, 255]);
    await s.select(1);
    paint(s, [6, 6, 6, 255]);
    await s.flushAutosave();
    await s.saveToLibrary('B');
    // B is safe now: the autosave keeps A's unsaved design.
    expect(writes(deps).at(-1)).toBe(s.queue[0]!.project);
    expect(s.unsaved).toBe(false);
    await s.select(0);
    expect(await s.exportAs('project')).toBe('C:\\out.reskin');
    expect(writes(deps).at(-1)).toBe('');
    paint(s, [7, 7, 7, 255]);
    await s.flushAutosave();
    await s.apply();
    expect(writes(deps).at(-1)).toBe('');
    s.dispose();
  });

  it('an item applied by "Apply style to all" leaves the autosave to what is still unsaved; its Undo takes it back', async () => {
    const { s, deps } = await queued();
    s.interactive = true;
    await s.select(1);
    paint(s, [5, 5, 5, 255]);
    // b's unsaved design is written as it is put away.
    await s.select(0);
    expect(writes(deps)).toEqual([s.queue[1]!.project]);
    s.recipe = { label: 'Look', apply: vi.fn() };
    await s.applyStyleToAll();
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'applied', 'applied']);
    expect(writes(deps).at(-1)).toBe('');
    // Undone: b's design (now the style's) is unsaved work again.
    await toasts().at(-1)!.action!.run();
    expect(s.queue[1]!.unsaved).toBe(true);
    expect(writes(deps).at(-1)).toBe(s.queue[1]!.project);
    s.dispose();
  });

  it('restoring a recovered design brings its item back into the queue', async () => {
    const draftDeps = await queuedDeps();
    const maker = new EditorSession(draftDeps, new Engine());
    await maker.openItems([item('b')]);
    paint(maker, [8, 8, 8, 255]);
    const draft = await maker.encodeProject();
    maker.dispose();

    const deps = await queuedDeps();
    deps.inspected.set(item('b').path, item('b'));
    const s = new EditorSession(deps, new Engine());
    await s.restoreAutosave(draft);
    expect(deps.commands.inspectPaths).toHaveBeenCalledWith([item('b').path]);
    expect(s.queue.map((q) => q.info.id)).toEqual(['b']);
    expect(s.view).toBe('edit');
    expect(center(s)).toEqual([8, 8, 8, 255]);
    expect(s.original?.width).toBe(8);
    expect(s.unsaved).toBe(true);
    expect(s.canApply).toBe(true);
    // Answered: this session's own work from now on.
    expect(writes(deps)).toEqual([null, draft]);
    s.dispose();
  });

  it('a recovered system-icon design finds its system icon again', async () => {
    const recycle = item('bin', { kind: 'systemIcon', name: 'Recycle Bin (full)', path: '::{645FF040}', systemIcon: 'recycleBinFull' });
    const deps = await queuedDeps();
    vi.mocked(deps.commands.inspectSystemIcon).mockImplementation(async (id) =>
      id === 'recycleBinFull' ? recycle : item(id, { kind: 'systemIcon', path: '::{645FF040}', name: `Other ${id}` }),
    );
    const engine = new Engine();
    engine.newDocument({ name: 'Bin', source: { kind: 'systemIcon', name: recycle.name, path: recycle.path } });
    const s = new EditorSession(deps, new Engine());
    await s.restoreAutosave(await engine.serialize());
    expect(s.item?.id).toBe('bin');
    expect(deps.commands.inspectPaths).not.toHaveBeenCalled();
    s.dispose();
  });

  it('a recovered design whose item is gone opens on its own; with a design open it joins the queue', async () => {
    const deps = await queuedDeps();
    const engine = new Engine();
    engine.newDocument({ name: 'Lost', source: { kind: 'shortcut', name: 'gone', path: 'C:\\gone.lnk' } });
    const draft = await engine.serialize();
    const s = new EditorSession(deps, new Engine());
    await s.restoreAutosave(draft);
    expect(s.queue).toHaveLength(0);
    expect(s.hasDesign).toBe(true);
    expect(s.unsaved).toBe(true);
    s.reset();
    await s.openItems([item('a')]);
    await s.restoreAutosave(draft);
    expect(s.queue.map((q) => [q.info.name, q.info.kind])).toEqual([
      ['a', 'shortcut'],
      ['Lost', 'project'],
    ]);
    expect(s.currentIndex).toBe(1);
    s.dispose();
  });

  it('offers no blank draft, and Discard answers the offer', async () => {
    const deps = await queuedDeps();
    const s = new EditorSession(deps, new Engine());
    vi.mocked(deps.commands.autosaveLoad).mockResolvedValueOnce('  ');
    expect(await s.recoverable()).toBeNull();
    vi.mocked(deps.commands.autosaveLoad).mockRejectedValueOnce(new Error('damaged'));
    expect(await s.recoverable()).toBeNull();
    await s.discardAutosave();
    expect(writes(deps)).toEqual([null]);
    vi.mocked(deps.commands.autosave).mockRejectedValueOnce(new Error('locked'));
    await expect(s.discardAutosave()).rejects.toThrow('locked');
    s.dispose();
  });

  it('serializes off the main thread with the session’s encoder, which ends with it', async () => {
    const { s } = await queued();
    const json = await s.encodeProject();
    expect(JSON.parse(json).meta.name).toBe('a');
    s.dispose();
    await expect(s.encodeProject()).rejects.toThrow('closed');
  });
});

describe('EditorSession workers', () => {
  class FakeWorker {
    static spawned: FakeWorker[] = [];
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() {
      FakeWorker.spawned.push(this);
    }
    postMessage(): void {}
    terminate(): void {
      this.terminated = true;
    }
  }

  beforeEach(() => {
    FakeWorker.spawned = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts them on first use and ends them with the session', async () => {
    const s = new EditorSession(makeDeps({}, applied), new Engine());
    expect(FakeWorker.spawned).toHaveLength(0);
    const panels = s.panels;
    expect(s.panels).toBe(panels);
    expect(panels.mode).toBe('worker');
    expect(s.filters.mode).toBe('worker');
    expect(FakeWorker.spawned).toHaveLength(2);
    const pending = panels.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null });
    const encoding = s.encodeProject();
    expect(FakeWorker.spawned).toHaveLength(3);
    s.dispose();
    expect(FakeWorker.spawned.every((w) => w.terminated)).toBe(true);
    await expect(pending).rejects.toSatisfy(isCancelled);
    await expect(encoding).rejects.toThrow('closed');
    expect(s.engine.subscriberCount).toBe(0);
    // Asking afterwards neither restarts a worker nor runs anything.
    await expect(s.panels.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null })).rejects.toSatisfy(isCancelled);
    await expect(s.filters.backdrop(null, 16)).rejects.toSatisfy(isFilterCancelled);
    expect(FakeWorker.spawned).toHaveLength(3);
  });

  it('never starts a worker for a session disposed before using one', async () => {
    const s = new EditorSession(makeDeps({}, applied), new Engine());
    s.dispose();
    s.dispose();
    await expect(s.panels.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null })).rejects.toSatisfy(isCancelled);
    await expect(s.filters.backdrop(null, 16)).rejects.toSatisfy(isFilterCancelled);
    await expect(s.encodeProject()).rejects.toThrow('closed');
    expect(FakeWorker.spawned).toHaveLength(0);
  });
});
