import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { ApplyOutcome, ApplyRequest, IconFrame, ItemInfo } from '$lib/ipc/types';
import { Engine, Surface, encodePng } from '$engine/index';
import { EditorSession, isTarget, type SessionDeps } from './session.svelte';

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
