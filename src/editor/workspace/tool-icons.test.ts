import { describe, expect, it } from 'vitest';
import { TOOL_META, TOOL_ORDER, type ToolId } from '$engine/index';
import { TOOL_OPTION_SPECS, choiceValue } from './options-schema';
import { TOOL_LUCIDE, toolIconOf } from './tool-icons';

describe('tool icons', () => {
  it('have a component for every icon the engine names', () => {
    for (const id of TOOL_ORDER) {
      const { name, icon } = toolIconOf(id);
      expect(name, id).toBe(TOOL_META[id].icon);
      expect(icon, id).toBe(TOOL_LUCIDE[name]);
    }
  });

  it('have a component in every variant the options bar can choose', () => {
    for (const id of TOOL_ORDER) {
      for (const spec of TOOL_OPTION_SPECS[id as ToolId]) {
        if (spec.kind !== 'choice') continue;
        for (const o of spec.options) {
          const { name, icon } = toolIconOf(id, { [spec.key]: choiceValue(spec, o.value) });
          expect(TOOL_LUCIDE[name], `${id}.${spec.key}=${o.value} → ${name}`).toBe(icon);
        }
      }
    }
  });

  it('follow the options: dodge ↔ burn, blur ↔ sharpen, freehand ↔ polygonal lasso', () => {
    expect(toolIconOf('dodgeBurn', { mode: 'dodge' }).name).toBe('sun');
    expect(toolIconOf('dodgeBurn', { mode: 'burn' }).name).toBe('moon');
    expect(toolIconOf('blurSharpen', { mode: 'blur' }).name).toBe('droplets');
    expect(toolIconOf('blurSharpen', { mode: 'sharpen' }).name).toBe('triangle');
    expect(toolIconOf('lasso', { kind: 'freehand' }).name).toBe('lasso');
    expect(toolIconOf('lasso', { kind: 'polygon' }).name).toBe('lasso-select');
    expect(toolIconOf('lasso', { kind: 'polygon' }).icon).not.toBe(toolIconOf('lasso').icon);
  });
});
