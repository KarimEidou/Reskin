import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { TOOL_META, TOOL_ORDER, createTools, defaultToolOptions, isToolId, toolIcon } from './registry';
import { Engine } from '../engine';

describe('tool registry', () => {
  it('describes every tool once, with unique shortcuts', () => {
    const tools = createTools();
    expect(Object.keys(tools).sort()).toEqual([...TOOL_ORDER].sort());
    expect(new Set(TOOL_ORDER).size).toBe(TOOL_ORDER.length);
    const shortcuts = TOOL_ORDER.map((id) => TOOL_META[id].shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    for (const id of TOOL_ORDER) {
      const m = TOOL_META[id];
      expect(m.id).toBe(id);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.label).toBe(tools[id].label);
      expect(m.shortcut).toBe(tools[id].shortcut);
      expect(m.usesSymmetry).toBe(tools[id].usesSymmetry);
      expect(isToolId(id)).toBe(true);
    }
    expect(isToolId('laser')).toBe(false);
  });

  it('proposes shortcuts, groups and symmetry for the new tools', () => {
    expect(TOOL_META.lasso.shortcut).toBe('L');
    expect(TOOL_META.magicWand.shortcut).toBe('W');
    expect(TOOL_META.stamp.shortcut).toBe('S');
    expect(TOOL_META.smudge.group).toBe('retouch');
    expect(TOOL_META.blurSharpen.group).toBe('retouch');
    expect(TOOL_META.dodgeBurn.group).toBe('retouch');
    expect(TOOL_META.selectRect.group).toBe('marquee');
    expect(TOOL_META.spray.group).toBe('brush');
    expect(TOOL_META.lasso.group).toBeNull();
    for (const id of ['spray', 'smudge', 'blurSharpen', 'dodgeBurn', 'stamp'] as const) {
      expect(TOOL_META[id].usesSymmetry).toBe(true);
    }
    expect(TOOL_META.lasso.usesSymmetry).toBe(false);
  });

  it('icon hints are real Lucide icon names', () => {
    const require = createRequire(import.meta.url);
    const icons = join(dirname(require.resolve('@lucide/svelte')), 'icons');
    const names = new Set(TOOL_ORDER.map((id) => TOOL_META[id].icon));
    names.add(toolIcon('dodgeBurn', { mode: 'burn' }));
    names.add(toolIcon('lasso', { kind: 'polygon' }));
    names.add(toolIcon('blurSharpen', { mode: 'sharpen' }));
    for (const n of names) expect(existsSync(join(icons, `${n}.svelte`)), n).toBe(true);
    expect(toolIcon('dodgeBurn', { mode: 'burn' })).toBe('moon');
    expect(toolIcon('dodgeBurn')).toBe('sun');
  });

  it('every tool has default options and the engine accepts every id', () => {
    const tools = createTools();
    const opts = defaultToolOptions(tools);
    const e = new Engine();
    for (const id of TOOL_ORDER) {
      expect(opts[id]).toBeTypeOf('object');
      e.setTool(id);
      expect(e.toolId).toBe(id);
      expect(e.cursor.css.length).toBeGreaterThan(0);
    }
    expect(opts.spray).toMatchObject({ radius: 24, density: 0.5, seed: 1 });
    expect(opts.stamp.stamp).toBeNull();
    expect(opts.magicWand).toMatchObject({ tolerance: 32, contiguous: true, sampleMerged: false, antialias: true });
  });
});
