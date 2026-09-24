import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, TOOL_META, TOOL_ORDER, type ToolId } from '$engine/index';
import type { Settings } from '$lib/ipc/types';
import { defaultSettings } from '$lib/settings/defaults';
import type { EditorSession } from '../state/session.svelte';
import { STAGE_KEYS } from '../workspace/keys';
import { refinePrompt } from '../workspace/refine.svelte';
import { stage, type StageController } from '../workspace/stage.svelte';
import {
  availableCommands,
  commandForKey,
  commandKeys,
  compileBindings,
  createCommands,
  GROUP_ORDER,
  keyCycle,
  toolForKey,
  type Command,
  type CommandContext,
  type KeyEventInfo,
} from './commands';
import { parseCombo } from './keys';

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
/** Detaches a fake canvas stage a test attached. */
let detachStage: (() => void) | null = null;

afterEach(() => {
  detachStage?.();
  detachStage = null;
});

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
    newBlank: vi.fn(async () => {}),
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

  it('binds every key chord once, across the registry and the canvas stage', () => {
    // Chords compare parsed ("Ctrl++" and "Ctrl+=" are the same keys).
    const chord = (k: string) => JSON.stringify(parseCombo(k));
    const seen = new Map<string, string>();
    for (const k of STAGE_KEYS) {
      expect(seen.get(chord(k)), `${k} listed twice by the stage`).toBeUndefined();
      seen.set(chord(k), `the stage (${k})`);
    }
    for (const c of commands) {
      for (const k of commandKeys(c)) {
        expect(seen.get(chord(k)), `${k} bound by ${seen.get(chord(k))} and ${c.id}`).toBeUndefined();
        seen.set(chord(k), c.id);
      }
    }
    // The view and colour keys are the registry's.
    for (const k of ['Ctrl+0', 'Ctrl+1', 'Ctrl+=', 'Ctrl+-', 'K', 'X', 'D']) expect(seen.get(chord(k))).toMatch(/^(view|color)\./);
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

  it('drives the canvas stage, only while one is mounted', () => {
    expect(byId('view.fit').when!(ctx)).toBe(false);
    const calls: string[] = [];
    const controller: StageController = {
      fit: () => calls.push('fit'),
      actualSize: () => calls.push('actual'),
      zoomStep: (d) => calls.push(d > 0 ? 'in' : 'out'),
      setZoom: () => {},
      docRect: () => null,
      focus: () => {},
    };
    detachStage = stage.attach(controller);
    for (const id of ['view.fit', 'view.actual', 'view.zoomIn', 'view.zoomOut', 'view.keylines', 'view.grid']) {
      expect(byId(id).when!(ctx), id).toBe(true);
    }
    byId('view.actual').run(ctx);
    byId('view.zoomIn').run(ctx);
    byId('view.zoomOut').run(ctx);
    byId('view.fit').run(ctx);
    expect(calls).toEqual(['actual', 'in', 'out', 'fit']);
    const { keylines, grid } = stage;
    byId('view.keylines').run(ctx);
    byId('view.grid').run(ctx);
    expect([stage.keylines, stage.grid]).toEqual([!keylines, !grid]);
    // Not while another page shows.
    session.view = 'library';
    expect(byId('view.fit').when!(ctx)).toBe(false);
  });

  it('swaps and resets the colours', () => {
    const e = session.engine;
    e.setColor('primary', { r: 255, g: 0, b: 0, a: 1 });
    byId('color.swap').run(ctx);
    expect(e.secondary).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    byId('color.reset').run(ctx);
    expect([e.primary, e.secondary]).toEqual([
      { r: 0, g: 0, b: 0, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    ]);
  });

  it('selects the layer pixels and asks how far to refine the selection', () => {
    const e = session.engine;
    const layer = e.activeLayer!;
    e.editLayerPixels(layer.id, 'Paint', (surface) => {
      for (let y = 10; y < 20; y++) for (let x = 30; x < 50; x++) surface.data[(y * surface.width + x) * 4 + 3] = 255;
    });
    // Refining needs a selection.
    for (const kind of ['feather', 'grow', 'shrink', 'border']) expect(byId(`edit.${kind}Selection`).when!(ctx)).toBe(false);
    session.view = 'library';
    byId('edit.selectLayerPixels').run(ctx);
    expect(session.view).toBe('edit');
    const m = e.doc.selection!;
    expect([m.data[15 * m.width + 40], m.data[15 * m.width + 60]]).toEqual([255, 0]);
    expect(e.historyEntries.at(-1)?.label).toBe('Select layer pixels');

    for (const kind of ['feather', 'grow', 'shrink', 'border'] as const) {
      expect(byId(`edit.${kind}Selection`).when!(ctx)).toBe(true);
      byId(`edit.${kind}Selection`).run(ctx);
      expect(refinePrompt.kind).toBe(kind);
    }
    refinePrompt.close();
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

describe('tool keys', () => {
  it('share a key within the engine groups of several tools', () => {
    expect(keyCycle('selectRect')).toEqual(['selectRect', 'selectEllipse']);
    expect(keyCycle('brush')).toEqual(['brush', 'spray']);
    expect(keyCycle('smudge')).toEqual(['smudge', 'blurSharpen', 'dodgeBurn']);
    // Keys of other group members, and tools of no group, pick just their tool.
    for (const id of ['selectEllipse', 'spray', 'blurSharpen', 'dodgeBurn', 'lasso', 'fill', 'hand'] as const) {
      expect(keyCycle(id)).toBeNull();
    }
    expect(TOOL_META.smudge.shortcut).toBe('R');
  });

  it('pressed again, a group key moves on to the next tool of its group', () => {
    const again = (pressed: ToolId, from: ToolId) => toolForKey(pressed, from, true);
    expect(again('smudge', 'smudge')).toBe('blurSharpen');
    expect(again('smudge', 'blurSharpen')).toBe('dodgeBurn');
    expect(again('smudge', 'dodgeBurn')).toBe('smudge');
    expect(again('selectRect', 'selectRect')).toBe('selectEllipse');
    expect(again('brush', 'brush')).toBe('spray');
    // Keys of one tool, and tools outside the key's group, never cycle.
    expect(again('selectRect', 'lasso')).toBe('selectRect');
    expect(again('blurSharpen', 'smudge')).toBe('blurSharpen');
    expect(again('lasso', 'lasso')).toBe('lasso');
    // A first press selects the key's own tool.
    expect(toolForKey('smudge', 'brush', false)).toBe('smudge');
    expect(toolForKey('brush', 'brush', false)).toBe('brush');
    expect(toolForKey('smudge', 'blurSharpen', false)).toBe('smudge');
  });

  it('the shortcut cycles on repeated presses, the palette entry selects exactly its tool', () => {
    const e = session.engine;
    const r = byId('tool.smudge');
    const b = byId('tool.brush');
    // The brush is selected, but not by B: B keeps it.
    expect(e.selectedToolId).toBe('brush');
    b.runKey!(ctx);
    expect(e.selectedToolId).toBe('brush');
    b.runKey!(ctx);
    expect(e.selectedToolId).toBe('spray');
    r.runKey!(ctx);
    expect(e.selectedToolId).toBe('smudge');
    r.runKey!(ctx);
    expect(e.selectedToolId).toBe('blurSharpen');
    r.runKey!(ctx);
    expect(e.selectedToolId).toBe('dodgeBurn');
    r.runKey!(ctx);
    expect(e.selectedToolId).toBe('smudge');
    // Another way of choosing a tool in between ends the cycle.
    e.setTool('blurSharpen');
    r.runKey!(ctx);
    expect(e.selectedToolId).toBe('smudge');
    r.run(ctx);
    expect(e.selectedToolId).toBe('smudge');
    r.run(ctx);
    expect(e.selectedToolId).toBe('smudge');
  });

  it('offers the new tools with their engine shortcuts', () => {
    const bindings = compileBindings(commands);
    const shortcuts: Array<[string, Partial<KeyEventInfo>, string]> = [
      ['l', {}, 'tool.lasso'],
      ['w', {}, 'tool.magicWand'],
      ['a', {}, 'tool.spray'],
      ['s', {}, 'tool.stamp'],
      ['r', {}, 'tool.smudge'],
      ['R', { shiftKey: true }, 'tool.blurSharpen'],
      ['o', {}, 'tool.dodgeBurn'],
    ];
    for (const [k, mods, id] of shortcuts) expect(commandForKey(bindings, press(k, mods), ctx)?.id, k).toBe(id);
  });
});

describe('commandForKey', () => {
  let bindings: ReturnType<typeof compileBindings>;
  beforeEach(() => {
    bindings = compileBindings(commands);
  });

  it('leaves keys something else already handled', () => {
    expect(commandForKey(bindings, press('b'), ctx)?.id).toBe('tool.brush');
    expect(commandForKey(bindings, press('b', { defaultPrevented: true }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('k', { ctrlKey: true, defaultPrevented: true }), ctx)).toBeNull();
  });

  it('maps K, X and D to keylines and the colour chips', () => {
    detachStage = stage.attach({
      fit: () => {},
      actualSize: () => {},
      zoomStep: () => {},
      setZoom: () => {},
      docRect: () => null,
      focus: () => {},
    });
    expect(commandForKey(bindings, press('k'), ctx)?.id).toBe('view.keylines');
    expect(commandForKey(bindings, press('x'), ctx)?.id).toBe('color.swap');
    expect(commandForKey(bindings, press('d'), ctx)?.id).toBe('color.reset');
    expect(commandForKey(bindings, press('0', { ctrlKey: true }), ctx)?.id).toBe('view.fit');
    expect(commandForKey(bindings, { ...press('=', { ctrlKey: true }), code: 'Equal' }, ctx)?.id).toBe('view.zoomIn');
    // Out of sight on another page, they do nothing.
    session.view = 'library';
    expect(commandForKey(bindings, press('x'), ctx)).toBeNull();
    expect(commandForKey(bindings, press('k'), ctx)).toBeNull();
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

  it('keeps design-changing shortcuts to the Edit view', () => {
    session.engine.addLayer();
    session.view = 'library';
    // A tool letter, Ctrl+Z, a layer command or Save & Apply on another page do nothing…
    expect(commandForKey(bindings, press('b'), ctx)).toBeNull();
    expect(commandForKey(bindings, press('z', { ctrlKey: true }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('j', { ctrlKey: true }), ctx)).toBeNull();
    expect(commandForKey(bindings, press('Enter', { ctrlKey: true, code: 'Enter' }), ctx)).toBeNull();
    // …while app-level and non-destructive shortcuts still work there.
    expect(commandForKey(bindings, press('k', { ctrlKey: true }), ctx)?.id).toBe('app.palette');
    expect(commandForKey(bindings, press('s', { ctrlKey: true }), ctx)?.id).toBe('library.save');
    // The palette still offers the tools (and switches to Edit when run).
    expect(availableCommands(commands, ctx).map((c) => c.id)).toContain('tool.brush');
    session.view = 'edit';
    expect(commandForKey(bindings, press('b'), ctx)?.id).toBe('tool.brush');
    expect(commandForKey(bindings, press('Enter', { ctrlKey: true, code: 'Enter' }), ctx)?.id).toBe('apply');
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
