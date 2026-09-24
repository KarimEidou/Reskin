import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { ApplyOutcome, ApplyRequest, IconFrame, ItemInfo } from '$lib/ipc/types';
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

function makeDeps(frames: Record<string, IconFrame[]>, outcome: () => ApplyOutcome): SessionDeps & {
  applied: ApplyRequest[];
} {
  const applied: ApplyRequest[] = [];
  return {
    applied,
    decode,
    encode: async (s) => `data:image/png;base64,${b64(await encodePng(s.data, s.width, s.height))}`,
    commands: {
      itemFrames: vi.fn(async (id: string) => frames[id] ?? []),
      readProject: vi.fn(async () => '{}'),
      applyIcon: vi.fn(async (req: ApplyRequest) => {
        applied.push(req);
        return outcome();
      }),
      applyIconElevated: vi.fn(async () => outcome()),
      restore: vi.fn(async () => ({ restored: 1, failed: [], needsElevation: 0 })),
      exportFile: vi.fn(async () => 'C:\\out.ico'),
      librarySave: vi.fn(async (e) => ({ id: 'lib1', name: e.name, thumb: e.thumb, updatedAt: 0, bytes: 1 })),
      libraryLoad: vi.fn(async () => '{}'),
      autosave: vi.fn(async () => {}),
      autosaveLoad: vi.fn(async () => null),
      editorClose: vi.fn(async () => {}),
    } as unknown as SessionDeps['commands'],
  };
}

const applied = (): ApplyOutcome => ({ type: 'applied', entries: [], landed: false });

describe('EditorSession', () => {
  let red: IconFrame;
  let blue: IconFrame;
  beforeEach(async () => {
    red = { width: 32, height: 32, png: await pngOf(32, 32, [255, 0, 0, 255]) };
    blue = { width: 48, height: 48, png: await pngOf(48, 48, [0, 0, 255, 255]) };
  });

  it('classifies targets', () => {
    expect(isTarget(item('a'))).toBe(true);
    expect(isTarget(item('img', { kind: 'image', modes: [] }))).toBe(false);
  });

  it('queues targets, loads the first icon and keeps each design when switching', async () => {
    const deps = makeDeps({ a: [red], b: [blue] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a'), item('b')]);
    expect(s.view).toBe('edit');
    expect(s.queue.map((q) => q.info.id)).toEqual(['a', 'b']);
    expect(s.currentIndex).toBe(0);
    expect(s.original?.width).toBe(32);
    const center = () => {
      const c = s.engine.composite();
      const i = (256 * c.width + 256) * 4;
      return Array.from(c.data.slice(i, i + 4));
    };
    expect(center()).toEqual([255, 0, 0, 255]);

    // Paint the whole of design A green, switch to B and back.
    const layer = s.engine.activeLayer!;
    s.engine.editLayerPixels(layer.id, 'test', (surf) => {
      for (let i = 0; i < surf.data.length; i += 4) surf.data.set([0, 255, 0, 255], i);
    });
    await s.select(1);
    expect(center()).toEqual([0, 0, 255, 255]);
    await s.select(0);
    expect(center()).toEqual([0, 255, 0, 255]);
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
    expect(deps.commands.autosave).toHaveBeenCalledWith(null);
    expect(s.busy).toBeNull();
    s.dispose();
  });

  it('turns needsElevation into a pending prompt and can approve it', async () => {
    let n = 0;
    const deps = makeDeps({ a: [red] }, () =>
      n++ === 0 ? { type: 'needsElevation', ticket: 't1', reason: 'Public Desktop' } : applied(),
    );
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a', { access: 'needsElevation', modes: ['inPlace', 'personalCopy'] })]);
    await s.apply();
    expect(s.elevation).toMatchObject({ ticket: 't1', mode: 'inPlace' });
    const out = await s.approveElevation();
    expect(out?.type).toBe('applied');
    expect(deps.commands.applyIconElevated).toHaveBeenCalledWith('t1');
    expect(s.elevation).toBeNull();
    s.dispose();
  });

  it('an image with no target starts a standalone design; later images become layers', async () => {
    const deps = makeDeps({ img: [blue], img2: [red] }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('img', { kind: 'image', modes: [] })]);
    expect(s.queue).toHaveLength(0);
    expect(s.view).toBe('edit');
    const before = s.engine.doc.layers.length;
    await s.openItems([item('img2', { kind: 'image', modes: [] })]);
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
    expect(res).toEqual({ applied: 2, failed: 0 });
    expect(applyRecipe).toHaveBeenCalledTimes(2);
    expect(deps.applied.map((r) => r.item)).toEqual(['b', 'c']);
    expect(deps.applied.every((r) => r.flourish === false)).toBe(true);
    expect(s.currentIndex).toBe(0);
    expect(s.queue.map((q) => q.status)).toEqual(['editing', 'applied', 'applied']);
    s.dispose();
  });
});

describe('EditorSession robustness', () => {
  it('does not switch to Edit if the view changed while loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const red = { width: 8, height: 8, png: await pngOf(8, 8, [255, 0, 0, 255]) };
    const deps = makeDeps({ a: [red] }, applied);
    const slow = deps.commands.itemFrames as unknown as ReturnType<typeof vi.fn>;
    slow.mockImplementationOnce(async () => {
      await gate;
      return [red];
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
    const f = async (c: [number, number, number, number]) => [{ width: 8, height: 8, png: await pngOf(8, 8, c) }];
    const deps = makeDeps({ a: await f([255, 0, 0, 255]), b: await f([0, 255, 0, 255]), c: await f([0, 0, 255, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a'), item('b'), item('c')]);
    await Promise.all([s.select(1), s.select(2), s.select(0)]);
    expect(s.currentIndex).toBe(0);
    expect(s.queue.filter((q) => q.project !== null).length).toBeGreaterThanOrEqual(2);
    s.dispose();
  });
});

describe('EditorSession style recipes', () => {
  const recipe = (label: string): StyleRecipe => ({ label, apply: vi.fn() });

  async function queued(): Promise<{ s: EditorSession; deps: ReturnType<typeof makeDeps> }> {
    const f = async (c: [number, number, number, number]) => [{ width: 8, height: 8, png: await pngOf(8, 8, c) }];
    const deps = makeDeps({ a: await f([255, 0, 0, 255]), b: await f([0, 255, 0, 255]), c: await f([0, 0, 255, 255]) }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a'), item('b'), item('c')]);
    return { s, deps };
  }

  it('belongs to the current item: switching shows each item its own recipe', async () => {
    const { s } = await queued();
    const neon = recipe('Neon');
    s.recipe = neon;
    await s.select(1);
    expect(s.recipe).toBeNull();
    // A panel chains onto the current item's recipe, not onto the other item's.
    s.recipe = chainRecipes(s.recipe, filterRecipe('invert', 'Invert', {}));
    expect(s.recipe.label).toBe('Invert');
    const invert = s.recipe;
    await s.select(0);
    expect(s.recipe).toBe(neon);
    expect(chainRecipes(s.recipe, filterRecipe('grayscale', 'Grayscale', {})).label).toBe('Neon + Grayscale');
    await s.select(1);
    expect(s.recipe).toBe(invert);
    s.dispose();
  });

  it('a new design starts without one (standalone image or project, New blank, Library, recovered autosave)', async () => {
    const project = await new Engine().serialize();
    const blue = [{ width: 8, height: 8, png: await pngOf(8, 8, [0, 0, 255, 255]) }];
    const deps = makeDeps({ img: blue }, applied);
    (deps.commands.libraryLoad as ReturnType<typeof vi.fn>).mockResolvedValue(project);
    (deps.commands.readProject as ReturnType<typeof vi.fn>).mockResolvedValue(project);
    const s = new EditorSession(deps, new Engine());
    const designs: [string, () => Promise<void>][] = [
      ['image', () => s.openItems([item('img', { kind: 'image', modes: [] })])],
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

  it('removing the current item shows the next one\'s recipe; removing the last one forgets it', async () => {
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
    const red = [{ width: 8, height: 8, png: await pngOf(8, 8, [255, 0, 0, 255]) }];
    const deps = makeDeps({ a: red, img: red }, applied);
    const s = new EditorSession(deps, new Engine());
    await s.openItems([item('a')]);
    const look = recipe('Look');
    s.recipe = look;
    await s.openItems([item('img', { kind: 'image', modes: [] })]);
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
    expect(res).toEqual({ applied: 2, failed: 0 });
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
    s.previewRecipe = { preview, recipe: () => chainRecipes(s.recipe, filterRecipe('invert', 'Invert', {})) };
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
    expect(res).toEqual({ applied: 2, failed: 0 });
    expect(look.apply).not.toHaveBeenCalled();
    expect(tuned.apply).toHaveBeenCalledTimes(2);
    expect(preview.state).toBe('committed');
    expect(s.recipe).toBe(tuned);
    s.dispose();
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
    s.dispose();
    expect(FakeWorker.spawned.every((w) => w.terminated)).toBe(true);
    await expect(pending).rejects.toSatisfy(isCancelled);
    expect(s.engine.subscriberCount).toBe(0);
    // Asking afterwards neither restarts a worker nor runs anything.
    await expect(s.panels.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null })).rejects.toSatisfy(isCancelled);
    await expect(s.filters.backdrop(null, 16)).rejects.toSatisfy(isFilterCancelled);
    expect(FakeWorker.spawned).toHaveLength(2);
  });

  it('never starts a worker for a session disposed before using one', async () => {
    const s = new EditorSession(makeDeps({}, applied), new Engine());
    s.dispose();
    s.dispose();
    await expect(s.panels.request({ op: 'sticker', id: 'star', size: 16, box: 12, color: null, outline: null })).rejects.toSatisfy(isCancelled);
    await expect(s.filters.backdrop(null, 16)).rejects.toSatisfy(isFilterCancelled);
    expect(FakeWorker.spawned).toHaveLength(0);
  });
});
