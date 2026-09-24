// The editor's command registry: everything the command palette lists and
// every global keyboard shortcut. Commands are plain data + functions over a
// `CommandContext` (the session plus a few shell actions), so the registry
// and the key dispatcher are unit tested without a DOM.

import type { EditorView, Settings } from '$lib/ipc/types';
import type { PixelGrid } from '$engine/doc/types';
import type { ToolId } from '$engine/tools/types';
import { TOOL_META, TOOL_ORDER } from '$engine/tools/registry';
import type { EditorSession, SidebarTab } from '../state/session.svelte';
import { refinePrompt, type RefineKind } from '../workspace/refine.svelte';
import { stage } from '../workspace/stage.svelte';
import { isBareKey, isTypingTarget, isWidgetTarget, matchesCombo, parseCombo, type KeyCombo, type KeyLike } from './keys';

export type CommandGroup =
  | 'Tools'
  | 'Edit'
  | 'Canvas'
  | 'Apply & export'
  | 'Go to'
  | 'Panels'
  | 'Settings'
  | 'App';

/** Display order of the groups (palette sections, shortcuts overlay). */
export const GROUP_ORDER: readonly CommandGroup[] = [
  'Apply & export',
  'Tools',
  'Edit',
  'Canvas',
  'Panels',
  'Go to',
  'Settings',
  'App',
];

/** What commands can reach: the session and a few shell-level actions. */
export interface CommandContext {
  session: EditorSession;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): Promise<unknown>;
  /** The theme currently applied (after resolving "system"). */
  theme(): 'dark' | 'light';
  openPalette(): void;
  openShortcuts(): void;
  /** File picker → open or add the picked images/shortcuts. */
  openImage(): Promise<void>;
  /** A blank design (asks first when the open one has unsaved edits). */
  newBlank(): Promise<void>;
  /** Asks for confirmation, then restores every icon Reskin changed. */
  restoreAll(): Promise<void>;
  refreshIcons(): Promise<void>;
  openReleases(): Promise<void>;
  /** Saves the design to the Library (and refreshes views listing it). */
  saveToLibrary(): Promise<unknown>;
}

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Primary shortcut (shown in the palette and tooltips). */
  keys?: string;
  /** Extra shortcuts that run the same command. */
  altKeys?: readonly string[];
  /** Synonyms the palette search also matches. */
  keywords?: readonly string[];
  /** Fires even while typing in a text field (e.g. Ctrl+K). */
  global?: boolean;
  /** Keeps firing while the key is held (undo, zoom). */
  repeatable?: boolean;
  /**
   * The shortcut only fires in the Edit view, where its effect is visible
   * (a tool letter or Ctrl+Z pressed on the Library page must not change
   * the design out of sight). The palette still lists the command.
   */
  editOnly?: boolean;
  /** Available right now? (palette lists it / shortcut fires). */
  when?(ctx: CommandContext): boolean;
  run(ctx: CommandContext): unknown;
  /**
   * What the shortcut does when it differs from choosing the command in the
   * palette (a repeated tool key cycles through its group).
   */
  runKey?(ctx: CommandContext): unknown;
}

/** The label and shortcut of each tool, as the engine defines them. */
export type ToolInfo = Readonly<Record<ToolId, { readonly label: string; readonly shortcut: string }>>;

const SIDEBAR_TABS: ReadonlyArray<readonly [SidebarTab, string, readonly string[]]> = [
  ['layers', 'Layers', ['stack', 'blend', 'opacity']],
  ['color', 'Color', ['colour', 'palette', 'picker', 'hex']],
  ['adjust', 'Adjust', ['filters', 'hue', 'brightness', 'blur', 'sharpen']],
  ['effects', 'Effects', ['shadow', 'glow', 'outline', 'layer style']],
  ['styles', 'Styles', ['presets', 'glass', 'neon', 'pastel']],
  ['backdrop', 'Backdrop', ['background', 'shape', 'squircle', 'plate']],
  ['stickers', 'Stickers', ['emoji', 'stamp']],
  ['history', 'History', ['undo history', 'steps']],
];

const VIEWS: ReadonlyArray<readonly [EditorView, string, string | undefined, readonly string[]]> = [
  ['start', 'Start page', undefined, ['home', 'open', 'drop']],
  ['systemIcons', 'System icons', undefined, ['this pc', 'recycle bin', 'network', 'control panel']],
  ['library', 'Library', undefined, ['saved designs']],
  ['history', 'History', undefined, ['changes', 'undo', 'restore']],
  ['settings', 'Settings', 'Ctrl+,', ['preferences', 'options']],
  ['about', 'About Reskin', undefined, ['version', 'releases', 'licenses']],
];

// ---- predicates ---------------------------------------------------------------

const editing = (c: CommandContext) => c.session.hasDesign;
const inEditView = (c: CommandContext) => c.session.hasDesign && c.session.view === 'edit';
const idle = (c: CommandContext) => c.session.busy === null;
const canvas = (c: CommandContext) => inEditView(c) && stage.ready;
const hasSelection = (c: CommandContext) => editing(c) && c.session.engine.doc.selection !== null;

function toEdit(c: CommandContext): void {
  if (c.session.view !== 'edit') c.session.navigate('edit');
}

/** Synonyms for the tools (their id and label always match). */
const TOOL_KEYWORDS: Partial<Record<ToolId, readonly string[]>> = {
  move: ['transform', 'rotate', 'scale', 'nudge'],
  selectRect: ['marquee', 'selection'],
  selectEllipse: ['marquee', 'circle', 'selection'],
  lasso: ['freehand', 'polygonal', 'selection'],
  magicWand: ['select colour', 'color', 'selection'],
  brush: ['paint'],
  spray: ['airbrush', 'paint'],
  eraser: ['rubber'],
  fill: ['paint bucket', 'flood'],
  shape: ['rectangle', 'ellipse', 'star', 'polygon', 'arrow'],
  eyedropper: ['pick colour', 'color picker', 'sample'],
  stamp: ['sticker', 'emoji'],
  smudge: ['finger', 'retouch'],
  blurSharpen: ['soften', 'retouch'],
  dodgeBurn: ['lighten', 'darken', 'exposure', 'retouch'],
  hand: ['pan'],
  zoom: ['magnify'],
};

/**
 * The tools a key cycles through: tools of one engine group share the key
 * of the group's first tool (M the marquees, B brush and spray, R the
 * retouch tools; docs/UI.md "Tool rail"). Null for a key of one tool.
 */
export function keyCycle(id: ToolId): readonly ToolId[] | null {
  const group = TOOL_META[id].group;
  if (!group) return null;
  const members = TOOL_ORDER.filter((t) => TOOL_META[t].group === group);
  return members.length > 1 && members[0] === id ? members : null;
}

/**
 * The tool a press of `pressed`'s shortcut selects: that tool, or, when the
 * same key selected the current tool (`repeated`) and it is a group's key,
 * the next tool of the group — repeated presses cycle: R Smudge, R Blur /
 * Sharpen, R Dodge / Burn, R Smudge… A first press never cycles, so B on
 * a brush picked from the rail keeps the brush.
 */
export function toolForKey(pressed: ToolId, selected: ToolId, repeated: boolean): ToolId {
  const cycle = repeated ? keyCycle(pressed) : null;
  const at = cycle ? cycle.indexOf(selected) : -1;
  return cycle && at >= 0 ? cycle[(at + 1) % cycle.length]! : pressed;
}

/** Shortcuts of the selection commands (the options bar's Selection menu shows them too). */
export const SELECTION_KEYS = { selectAll: 'Ctrl+A', deselect: 'Ctrl+D', invert: 'Ctrl+Shift+I' } as const;

const REFINE_COMMANDS: ReadonlyArray<readonly [RefineKind, string, readonly string[]]> = [
  ['feather', 'Feather selection…', ['soften', 'blur edge']],
  ['grow', 'Grow selection…', ['expand', 'enlarge']],
  ['shrink', 'Shrink selection…', ['contract', 'reduce']],
  ['border', 'Border selection…', ['edge', 'outline', 'ring']],
];

const MODE_LABEL = {
  inPlace: 'Save & Apply (change in place)',
  newShortcut: 'Save & Apply as a new desktop shortcut',
  personalCopy: 'Save & Apply to a personal copy',
} as const;

/** Builds the registry. `tools` gives tool labels/shortcuts (engine.tools). */
export function createCommands(tools: ToolInfo): Command[] {
  const list: Command[] = [];

  // ---- apply & export ---------------------------------------------------------
  list.push(
    {
      id: 'apply',
      label: 'Save & Apply',
      group: 'Apply & export',
      keys: 'Ctrl+Enter',
      editOnly: true,
      keywords: ['apply', 'change icon', 'save'],
      when: (c) => editing(c) && c.session.canApply,
      run: (c) => c.session.apply(),
    },
    ...(['newShortcut', 'personalCopy'] as const).map(
      (mode): Command => ({
        id: `apply.${mode}`,
        label: MODE_LABEL[mode],
        group: 'Apply & export',
        keywords: ['apply', mode === 'personalCopy' ? 'public desktop copy' : 'shortcut'],
        when: (c) => editing(c) && c.session.canApply && c.session.modes.includes(mode) && c.session.modes[0] !== mode,
        run: (c) => c.session.apply({ mode }),
      }),
    ),
    {
      id: 'apply.styleToAll',
      label: 'Apply style to all queued icons',
      group: 'Apply & export',
      keywords: ['batch', 'queue'],
      when: (c) =>
        editing(c) &&
        idle(c) &&
        c.session.recipe !== null &&
        c.session.queue.filter((q) => q.status !== 'applied').length > 1,
      run: (c) => c.session.applyStyleToAll(),
    },
    {
      id: 'library.save',
      label: 'Save to Library',
      group: 'Apply & export',
      keys: 'Ctrl+S',
      keywords: ['keep', 'design'],
      when: editing,
      run: (c) => c.saveToLibrary(),
    },
    {
      id: 'export.ico',
      label: 'Export as .ico…',
      group: 'Apply & export',
      keys: 'Ctrl+Shift+E',
      keywords: ['save as', 'icon file'],
      when: editing,
      run: (c) => c.session.exportAs('ico'),
    },
    {
      id: 'export.png',
      label: 'Export as .png…',
      group: 'Apply & export',
      keywords: ['save as', 'image'],
      when: editing,
      run: (c) => c.session.exportAs('png'),
    },
    {
      id: 'export.project',
      label: 'Export project (.reskin)…',
      group: 'Apply & export',
      keywords: ['save as', 'file'],
      when: editing,
      run: (c) => c.session.exportAs('project'),
    },
    {
      id: 'export.clipboard',
      label: 'Copy icon to clipboard',
      group: 'Apply & export',
      keys: 'Ctrl+Shift+C',
      keywords: ['png', 'paste'],
      when: editing,
      run: (c) => c.session.copyToClipboard(),
    },
  );

  // ---- tools --------------------------------------------------------------------
  /**
   * The tool the last tool key selected (and which key), so pressing it
   * again cycles; `left` once another tool was selected since (the rail,
   * the palette), which ends the cycle even if that tool comes back.
   */
  let lastKey: { pressed: ToolId; selected: ToolId; left: boolean; stop: () => void } | null = null;
  for (const id of TOOL_ORDER) {
    const tool = tools[id];
    list.push({
      id: `tool.${id}`,
      label: `${tool.label} tool`,
      group: 'Tools',
      keys: tool.shortcut || undefined,
      editOnly: true,
      keywords: [id, ...(TOOL_KEYWORDS[id] ?? [])],
      when: editing,
      run: (c) => {
        toEdit(c);
        c.session.engine.setTool(id);
      },
      runKey: (c) => {
        const engine = c.session.engine;
        const current = engine.selectedToolId;
        const repeated = lastKey !== null && !lastKey.left && lastKey.pressed === id && lastKey.selected === current;
        lastKey?.stop();
        const tool = toolForKey(id, current, repeated);
        engine.setTool(tool);
        const key = { pressed: id, selected: tool, left: false, stop: () => {} };
        key.stop = engine.subscribe((e) => {
          if (e.kind !== 'tool' || engine.selectedToolId === tool) return;
          key.left = true;
          key.stop();
        });
        lastKey = key;
      },
    });
  }

  // ---- edit ---------------------------------------------------------------------
  list.push(
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      keys: 'Ctrl+Z',
      editOnly: true,
      repeatable: true,
      when: (c) => editing(c) && c.session.engine.canUndo,
      run: (c) => c.session.engine.undo(),
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      keys: 'Ctrl+Y',
      editOnly: true,
      altKeys: ['Ctrl+Shift+Z'],
      repeatable: true,
      when: (c) => editing(c) && c.session.engine.canRedo,
      run: (c) => c.session.engine.redo(),
    },
    {
      id: 'edit.selectAll',
      label: 'Select all',
      group: 'Edit',
      keys: SELECTION_KEYS.selectAll,
      keywords: ['selection'],
      when: inEditView,
      run: (c) => c.session.engine.selectAll(),
    },
    {
      id: 'edit.deselect',
      label: 'Deselect',
      group: 'Edit',
      keys: SELECTION_KEYS.deselect,
      keywords: ['selection', 'clear selection'],
      when: (c) => inEditView(c) && c.session.engine.doc.selection !== null,
      run: (c) => c.session.engine.deselect(),
    },
    {
      id: 'edit.invertSelection',
      label: 'Invert selection',
      group: 'Edit',
      keys: SELECTION_KEYS.invert,
      keywords: ['selection', 'inverse'],
      when: (c) => inEditView(c) && c.session.engine.doc.selection !== null,
      run: (c) => c.session.engine.invertSelection(),
    },
    {
      id: 'edit.selectLayerPixels',
      label: 'Select layer pixels',
      group: 'Edit',
      keywords: ['selection', 'alpha', 'opacity', 'transparency'],
      when: (c) => editing(c) && c.session.engine.activeLayer !== null,
      run: (c) => {
        toEdit(c);
        c.session.engine.selectByAlpha();
      },
    },
    ...REFINE_COMMANDS.map(
      ([kind, label, keywords]): Command => ({
        id: `edit.${kind}Selection`,
        label,
        group: 'Edit',
        keywords: ['selection', ...keywords],
        when: hasSelection,
        run: (c) => {
          toEdit(c);
          refinePrompt.open(kind);
        },
      }),
    ),
    {
      id: 'layer.new',
      label: 'New layer',
      group: 'Edit',
      keys: 'Ctrl+Shift+N',
      editOnly: true,
      keywords: ['add layer'],
      when: editing,
      run: (c) => {
        toEdit(c);
        c.session.engine.addLayer();
      },
    },
    {
      id: 'layer.duplicate',
      label: 'Duplicate layer',
      group: 'Edit',
      keys: 'Ctrl+J',
      editOnly: true,
      keywords: ['copy layer'],
      when: (c) => editing(c) && c.session.engine.activeLayer !== null,
      run: (c) => c.session.engine.duplicateLayer(),
    },
    {
      id: 'layer.mergeDown',
      label: 'Merge layer down',
      group: 'Edit',
      keys: 'Ctrl+E',
      editOnly: true,
      keywords: ['combine'],
      when: (c) => editing(c) && c.session.engine.doc.layers.length > 1,
      run: (c) => c.session.engine.mergeDown(),
    },
    {
      id: 'layer.flatten',
      label: 'Flatten image',
      group: 'Edit',
      keywords: ['merge all layers'],
      when: (c) => editing(c) && c.session.engine.doc.layers.length > 1,
      run: (c) => c.session.engine.flatten(),
    },
    {
      id: 'color.swap',
      label: 'Swap primary and secondary colours',
      group: 'Edit',
      keys: 'X',
      editOnly: true,
      keywords: ['color', 'foreground', 'background'],
      when: editing,
      run: (c) => c.session.engine.swapColors(),
    },
    {
      id: 'color.reset',
      label: 'Reset colours to black and white',
      group: 'Edit',
      keys: 'D',
      editOnly: true,
      keywords: ['color', 'default colors'],
      when: editing,
      run: (c) => c.session.engine.resetColors(),
    },
  );

  // ---- canvas -------------------------------------------------------------------
  list.push(
    {
      id: 'view.fit',
      label: 'Zoom to fit',
      group: 'Canvas',
      keys: 'Ctrl+0',
      keywords: ['fit to screen', 'zoom'],
      when: canvas,
      run: () => stage.fit(),
    },
    {
      id: 'view.actual',
      label: 'Actual size (100 %)',
      group: 'Canvas',
      keys: 'Ctrl+1',
      keywords: ['zoom 100', 'one to one'],
      when: canvas,
      run: () => stage.actualSize(),
    },
    {
      id: 'view.zoomIn',
      label: 'Zoom in',
      group: 'Canvas',
      keys: 'Ctrl++',
      repeatable: true,
      keywords: ['magnify', 'enlarge'],
      when: canvas,
      run: () => stage.zoomIn(),
    },
    {
      id: 'view.zoomOut',
      label: 'Zoom out',
      group: 'Canvas',
      keys: 'Ctrl+-',
      repeatable: true,
      keywords: ['reduce'],
      when: canvas,
      run: () => stage.zoomOut(),
    },
    {
      id: 'view.keylines',
      label: 'Toggle keyline guides',
      group: 'Canvas',
      keys: 'K',
      editOnly: true,
      keywords: ['guides', 'windows icon grid', 'safe area'],
      when: canvas,
      run: () => stage.toggleKeylines(),
    },
    {
      id: 'view.grid',
      label: 'Toggle pixel grid',
      group: 'Canvas',
      keywords: ['grid lines', 'pixels'],
      when: canvas,
      run: () => stage.toggleGrid(),
    },
    {
      id: 'view.compare',
      label: 'Toggle before / after split view',
      group: 'Canvas',
      keywords: ['compare', 'original', 'split'],
      when: (c) => inEditView(c) && c.session.original !== null,
      run: (c) => {
        c.session.compare = c.session.compare === 'split' ? 'off' : 'split';
      },
    },
    {
      id: 'view.pixelArt',
      label: 'Toggle pixel-art mode',
      group: 'Canvas',
      keywords: ['pixel grid', 'nearest neighbour', 'retro'],
      when: editing,
      run: (c) => {
        const engine = c.session.engine;
        engine.setPixelArt(engine.doc.pixelArt ? null : (c.settings().pixelGrid as PixelGrid));
      },
    },
  );

  // ---- panels --------------------------------------------------------------------
  for (const [tab, name, keywords] of SIDEBAR_TABS) {
    list.push({
      id: `panel.${tab}`,
      label: `Show ${name} panel`,
      group: 'Panels',
      keywords,
      when: editing,
      run: (c) => {
        toEdit(c);
        c.session.sidebarTab = tab;
      },
    });
  }

  // ---- go to ------------------------------------------------------------------------
  list.push({
    id: 'go.edit',
    label: 'Go to the editor',
    group: 'Go to',
    keywords: ['edit', 'canvas', 'design'],
    when: (c) => editing(c) && c.session.view !== 'edit',
    run: (c) => c.session.navigate('edit'),
  });
  for (const [view, name, keys, keywords] of VIEWS) {
    list.push({
      id: `go.${view}`,
      label: `Go to ${name}`,
      group: 'Go to',
      keys,
      keywords,
      when: (c) => c.session.view !== view,
      run: (c) => c.session.navigate(view),
    });
  }

  // ---- settings -----------------------------------------------------------------
  list.push(
    {
      id: 'settings.themeLight',
      label: 'Use the light theme',
      group: 'Settings',
      keywords: ['appearance', 'mode'],
      when: (c) => c.theme() === 'dark',
      run: (c) => c.updateSettings({ theme: 'light' }),
    },
    {
      id: 'settings.themeDark',
      label: 'Use the dark theme',
      group: 'Settings',
      keywords: ['appearance', 'mode', 'night'],
      when: (c) => c.theme() === 'light',
      run: (c) => c.updateSettings({ theme: 'dark' }),
    },
    {
      id: 'settings.themeSystem',
      label: 'Follow the Windows theme',
      group: 'Settings',
      keywords: ['appearance', 'system', 'automatic'],
      when: (c) => c.settings().theme !== 'system',
      run: (c) => c.updateSettings({ theme: 'system' }),
    },
    {
      id: 'settings.soundsOn',
      label: 'Turn sounds on',
      group: 'Settings',
      keywords: ['audio', 'sfx'],
      when: (c) => !c.settings().sounds,
      run: (c) => c.updateSettings({ sounds: true }),
    },
    {
      id: 'settings.soundsOff',
      label: 'Turn sounds off',
      group: 'Settings',
      keywords: ['audio', 'mute', 'silent'],
      when: (c) => c.settings().sounds,
      run: (c) => c.updateSettings({ sounds: false }),
    },
    {
      id: 'settings.reduceMotion',
      label: 'Reduce motion',
      group: 'Settings',
      keywords: ['animation', 'accessibility'],
      when: (c) => c.settings().motion !== 'reduced',
      run: (c) => c.updateSettings({ motion: 'reduced' }),
    },
    {
      id: 'settings.fullMotion',
      label: 'Allow animations (motion follows Windows)',
      group: 'Settings',
      keywords: ['animation', 'motion'],
      when: (c) => c.settings().motion === 'reduced',
      run: (c) => c.updateSettings({ motion: 'system' }),
    },
    {
      id: 'settings.accentOn',
      label: 'Use the Windows accent colour',
      group: 'Settings',
      keywords: ['color', 'tint'],
      when: (c) => !c.settings().useAccent,
      run: (c) => c.updateSettings({ useAccent: true }),
    },
    {
      id: 'settings.accentOff',
      label: 'Use the Reskin violet accent',
      group: 'Settings',
      keywords: ['color', 'brand'],
      when: (c) => c.settings().useAccent,
      run: (c) => c.updateSettings({ useAccent: false }),
    },
  );

  // ---- app ------------------------------------------------------------------------
  list.push(
    {
      id: 'app.palette',
      label: 'Show all commands',
      group: 'App',
      keys: 'Ctrl+K',
      altKeys: ['Ctrl+Shift+P'],
      global: true,
      keywords: ['command palette', 'search'],
      run: (c) => c.openPalette(),
    },
    {
      id: 'app.shortcuts',
      label: 'Keyboard shortcuts',
      group: 'App',
      keys: '?',
      keywords: ['help', 'keys', 'hotkeys'],
      run: (c) => c.openShortcuts(),
    },
    {
      id: 'app.openImage',
      label: 'Open image or shortcut…',
      group: 'App',
      keys: 'Ctrl+O',
      keywords: ['import', 'file', 'picture'],
      when: idle,
      run: (c) => c.openImage(),
    },
    {
      id: 'app.newBlank',
      label: 'New blank icon',
      group: 'App',
      keys: 'Ctrl+N',
      keywords: ['empty', 'create', 'draw'],
      when: idle,
      run: (c) => c.newBlank(),
    },
    {
      id: 'app.restoreAll',
      label: 'Restore all original icons…',
      group: 'App',
      keywords: ['reset', 'undo everything', 'revert'],
      when: idle,
      run: (c) => c.restoreAll(),
    },
    {
      id: 'app.refreshIcons',
      label: 'Refresh desktop icons',
      group: 'App',
      keywords: ['icon cache', 'explorer', 'reload'],
      run: (c) => c.refreshIcons(),
    },
    {
      id: 'app.releases',
      label: 'Open the Releases page',
      group: 'App',
      keywords: ['download', 'update', 'github'],
      run: (c) => c.openReleases(),
    },
    {
      id: 'app.close',
      label: 'Close the editor',
      group: 'App',
      keywords: ['hide', 'back to box', 'exit'],
      run: (c) => c.session.requestClose(),
    },
  );

  return list;
}

/** Commands available now (palette list), in registry order. */
export function availableCommands(commands: readonly Command[], ctx: CommandContext): Command[] {
  return commands.filter((c) => {
    try {
      return c.when?.(ctx) ?? true;
    } catch {
      return false;
    }
  });
}

/** Every shortcut of a command (primary first). */
export function commandKeys(cmd: Command): string[] {
  return [...(cmd.keys ? [cmd.keys] : []), ...(cmd.altKeys ?? [])];
}

// ---- key dispatch --------------------------------------------------------------------

interface CompiledBinding {
  combo: KeyCombo;
  command: Command;
}

/** Pre-parses every shortcut of the registry. */
export function compileBindings(commands: readonly Command[]): CompiledBinding[] {
  const out: CompiledBinding[] = [];
  for (const command of commands) {
    for (const keys of commandKeys(command)) out.push({ combo: parseCombo(keys), command });
  }
  return out;
}

export interface KeyEventInfo extends KeyLike {
  repeat?: boolean;
  /** Something already handled the key (`KeyboardEvent.defaultPrevented`). */
  defaultPrevented?: boolean;
  /** The focused element (event target). */
  target?: unknown;
}

/**
 * The command a keydown should run, or null. Keys something else already
 * handled are left alone. Shortcuts without Ctrl/Alt never fire while
 * typing or inside widgets with their own letter keys (menus, listboxes);
 * `global` commands always may. `editOnly` shortcuts need the Edit view.
 */
export function commandForKey(
  bindings: readonly CompiledBinding[],
  e: KeyEventInfo,
  ctx: CommandContext,
): Command | null {
  if (e.defaultPrevented) return null;
  const target = e.target as Parameters<typeof isTypingTarget>[0];
  const typing = isTypingTarget(target);
  const widget = isWidgetTarget(target);
  const editView = ctx.session.view === 'edit';
  for (const { combo, command } of bindings) {
    if (!matchesCombo(combo, e)) continue;
    if (command.editOnly && !editView) continue;
    if (!command.global) {
      if (typing) continue;
      if (widget && isBareKey(combo)) continue;
    }
    let ok = true;
    try {
      ok = command.when?.(ctx) ?? true;
    } catch {
      ok = false;
    }
    if (ok) return command;
  }
  return null;
}
