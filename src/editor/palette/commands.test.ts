import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, TOOL_ORDER, Viewport } from '$engine/index';
import type { Settings } from '$lib/ipc/types';
import { defaultSettings } from '$lib/settings/defaults';
import type { EditorSession } from '../state/session.svelte';
import {
  availableCommands,
  commandForKey,
  compileBindings,
  createCommands,
  GROUP_ORDER,
  type Command,
  type CommandContext,
  type KeyEventInfo,
} from './commands';

interface FakeSession {
  engine: Engine;
  view: string;
  hasDesign: boolean;
  busy: null | { label: string; progress: number | null };
  canApply: boolean;
  modes: string[];
  queue: Array<{ status: string }>;
  recipe: unknown;
  original: unknown;
  compare: 'off' | 'hold' | 'split';
  sidebarTab: string;
  navigate: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  saveToLibrary: ReturnType<typeof vi.fn>;
  exportAs: ReturnType<typeof vi.fn>;
  copyToClipboard: ReturnType<typeof vi.fn>;
  applyStyleToAll: ReturnType<typeof vi.fn>;
  newBlank: ReturnType<typeof vi.fn>;
  requestClose: ReturnType<typeof vi.fn>;
}

let session: FakeSession;
let current: Settings;
let ctx: CommandContext;
let commands: Command[];

function fakeSession(): FakeSession {
  const s: FakeSession = {
    engine: new Engine(),
    view: 'edit',
    hasDesign: true,
    busy: null,
    canApply: true,
    modes: ['inPlace', 'personalCopy'],
    queue: [{ status: 'editing' }],
    recipe: null,
    original: null,
    compare: 'off',
    sidebarTab: 'layers',
    navigate: vi.fn((v: string) => {
      s.view = v;
    }),
    apply: vi.fn(async () => null),
    saveToLibrary: vi.fn(async () => null),
    exportAs: vi.fn(async () => null),
    copyToClipboard: vi.fn(async () => true),
    applyStyleToAll: vi.fn(async () => ({ applied: 0, failed: 0 })),
    newBlank: vi.fn(),
    requestClose: vi.fn(async () => {}),
  };
  return s;
}

function press(k: string, mods: Partial<KeyEventInfo> = {}): KeyEventInfo {
  const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : '';
  return { key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null, ...mods };
}

const byId = (id: string) => commands.find((c) => c.id === id)!;

beforeEach(() => {
  session = fakeSession();
  current = defaultSettings();
  ctx = {
    session: session as unknown as EditorSession,
    settings: () => current,
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      current = { ...current, ...patch };
      return current;
    }),
    theme: () => (current.theme === 'light' ? 'light' : 'dark'),
    openPalette: vi.fn(() => {}),
    openShortcuts: vi.fn(() => {}),
    openImage: vi.fn(async () => {}),
    restoreAll: vi.fn(async () => {}),
    refreshIcons: vi.fn(async () => {}),
    openReleases: vi.fn(async () => {}),
    saveToLibrary: vi.fn(async () => null),
  };
  commands = createCommands(session.engine.tools);
});

describe('registry', () => {
  it('has unique ids and known groups', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of commands) expect(GROUP_ORDER).toContain(c.group);
  });

  it('covers every tool with its engine shortcut', () => {
    for (const id of TOOL_ORDER) {
      const cmd = byId(`tool.${id}`);
      expect(cmd.keys).toBe(session.engine.tools[id].shortcut);
      expect(cmd.label).toContain(session.engine.tools[id].label);
    }
  });

  it('does not bind one shortcut twice', () => {
    const seen = new Map<string, string>();
    for (const c of commands) {
      for (const k of [c.keys, ...(c.altKeys ?? [])].filter(Boolean) as string[]) {
        expect(seen.get(k), `${k} bound by ${seen.get(k)} and ${c.id}`).toBeUndefined();
        seen.set(k, c.id);
      }
    }
  });

  it('switches tools and returns to the editor', () => {
    session.view = 'library';
    byId('tool.brush').run(ctx);
    expect(session.engine.selectedToolId).toBe('brush');
    expect(session.navigate).toHaveBeenCalledWith('edit');
  });

  it('hides design commands until a design exists', () => {
    session.hasDesign = false;
    session.view = 'start';
    const ids = availableCommands(commands, ctx).map((c) => c.id);
    expect(ids).not.toContain('tool.brush');
    expect(ids).not.toContain('apply');
    expect(ids).not.toContain('go.edit');
    expect(ids).toContain('app.openImage');
    expect(ids).toContain('go.library');
    expect(ids).not.toContain('go.start');
  });

  it('offers only the apply modes the item supports, after the default one', () => {
    const ids = availableCommands(commands, ctx).map((c) => c.id);
    expect(ids).toContain('apply');
    expect(ids).toContain('apply.personalCopy');
    expect(ids).not.toContain('apply.newShortcut');
    byId('apply.personalCopy').run(ctx);
    expect(session.apply).toHaveBeenCalledWith({ mode: 'personalCopy' });
  });

  it('runs undo / redo on the engine', () => {
    const e = session.engine;
    e.addLayer();
    expect(byId('edit.undo').when!(ctx)).toBe(true);
    expect(byId('edit.redo').when!(ctx)).toBe(false);
    byId('edit.undo').run(ctx);
    expect(e.canRedo).toBe(true);
    byId('edit.redo').run(ctx);
    expect(e.canRedo).toBe(false);
  });

  it('zooms only with an attached viewport', () => {
    expect(byId('view.fit').when!(ctx)).toBe(false);
    const vp = new Viewport({ viewWidth: 400, viewHeight: 300 });
    session.engine.attachViewport(vp);
    expect(byId('view.fit').when!(ctx)).toBe(true);
    byId('view.actual').run(ctx);
    expect(vp.zoom).toBe(1);
    byId('view.zoomIn').run(ctx);
    expect(vp.zoom).toBeGreaterThan(1);
    byId('view.fit').run(ctx);
    expect(vp.zoom).toBeLessThan(1);
  });

  it('toggles settings through updateSettings', async () => {
    current = { ...current, theme: 'dark', sounds: false, motion: 'system' };
    let ids = availableCommands(commands, ctx).map((c) => c.id);
    expect(ids).toContain('settings.themeLight');
    expect(ids).not.toContain('settings.themeDark');
    await byId('settings.themeLight').run(ctx);
    await byId('settings.soundsOn').run(ctx);
    await byId('settings.reduceMotion').run(ctx);
    expect(current).toMatchObject({ theme: 'light', sounds: true, motion: 'reduced' });
    ids = availableCommands(commands, ctx).map((c) => c.id);
    expect(ids).toContain('settings.themeDark');
    expect(ids).toContain('settings.soundsOff');
    expect(ids).toContain('settings.fullMotion');
  });

  it('opens sidebar tabs', () => {
    session.view = 'history';
    byId('panel.effects').run(ctx);
    expect(session.sidebarTab).toBe('effects');
    expect(session.view).toBe('edit');
  });

  it('toggles the split compare and pixel-art mode', () => {
    session.original = {};
    byId('view.compare').run(ctx);
    expect(session.compare).toBe('split');
    byId('view.compare').run(ctx);
    expect(session.compare).toBe('off');
    byId('view.pixelArt').run(ctx);
    expect(session.engine.doc.pixelArt).toEqual({ grid: current.pixelGrid });
    byId('view.pixelArt').run(ctx);
    expect(session.engine.doc.pixelArt).toBeNull();
  });
});

describe('commandForKey', () => {
  let bindings: ReturnType<typeof compileBindings>;
  beforeEach(() => {
    bindings = compileBindings(commands);
  });

  it('finds tools, undo/redo and the palette', () => {
    expect(commandForKey(bindings, press('b'), ctx)?.id).toBe('tool.brush');
    expect(commandForKey(bindings, press('G', { shiftKey: true }), ctx)?.id).toBe('tool.gradient');
    expect(commandForKey(bindings, press('g'), ctx)?.id).toBe('tool.fill');
    expect(commandForKey(bindings, press('M', { shiftKey: true }), ctx)?.id).toBe('tool.selectEllipse');
    session.engine.addLayer();
    expect(commandForKey(bindings, press('z', { ctrlKey: true }), ctx)?.id).toBe('edit.undo');
    session.engine.undo();
    expect(commandForKey(bindings, press('y', { ctrlKey: true }), ctx)?.id).toBe('edit.redo');
    expect(commandForKey(bindings, press('Z', { ctrlKey: true, shiftKey: true }), ctx)?.id).toBe('edit.redo');
    expect(commandForKey(bindings, press('k', { ctrlKey: true }), ctx)?.id).toBe('app.palette');
    expect(commandForKey(bindings, { ...press('?', { shiftKey: true }), code: 'Slash' }, ctx)?.id).toBe('app.shortcuts');
  });

  it('skips unavailable commands', () => {
    expect(commandForKey(bindings, press('z', { ctrlKey: true }), ctx)).toBeNull(); // nothing to undo
    session.hasDesign = false;
    expect(commandForKey(bindings, press('b'), ctx)).toBeNull();
  });

  it('ignores bare keys while typing or in menus, but not Ctrl+K', () => {
    const input = { closest: (s: string) => (s.includes('input') ? {} : null) };
    const menu = { closest: (s: string) => (s.includes('role="menu"') ? {} : null) };
    expect(commandForKey(bindings, press('b', { target: input }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('b', { target: menu }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('a', { ctrlKey: true, target: input }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('a', { ctrlKey: true, target: menu }), ctx)?.id).toBe('edit.selectAll');
    expect(commandForKey(bindings, press('k', { ctrlKey: true, target: input }), ctx)?.id).toBe('app.palette');
  });

  it('never throws on a failing predicate', () => {
    const broken: Command = {
      id: 'x',
      label: 'x',
      group: 'App',
      keys: 'Ctrl+Q',
      when: () => {
        throw new Error('boom');
      },
      run: () => {},
    };
    expect(commandForKey(compileBindings([broken]), press('q', { ctrlKey: true }), ctx)).toBeNull();
    expect(availableCommands([broken], ctx)).toEqual([]);
  });
});
