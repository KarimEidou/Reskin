// How the tool rail groups the engine's tools (docs/UI.md "Tool rail").
// Pure data, unit tested against the engine's TOOL_ORDER.

import { TOOL_META, TOOL_ORDER, type ToolId } from '$engine/index';

export interface RailGroup {
  id: string;
  /** Accessible name of the group's flyout. */
  label: string;
  tools: readonly ToolId[];
}

/**
 * Rail layout, top to bottom. A group with several tools shows its current
 * tool and a flyout with the others. `sections` separate clusters with a
 * hairline: transform & select · paint · fill & shapes & text · view.
 */
export const RAIL_SECTIONS: readonly (readonly RailGroup[])[] = [
  [
    { id: 'move', label: 'Move', tools: ['move'] },
    { id: 'select', label: 'Selection tools', tools: ['selectRect', 'selectEllipse', 'lasso', 'magicWand'] },
  ],
  [
    { id: 'brush', label: 'Brush tools', tools: ['brush', 'spray'] },
    { id: 'pencil', label: 'Pencil', tools: ['pencil'] },
    { id: 'eraser', label: 'Eraser', tools: ['eraser'] },
  ],
  [
    { id: 'fill', label: 'Fill tools', tools: ['fill', 'gradient'] },
    { id: 'shape', label: 'Shapes', tools: ['shape'] },
    { id: 'text', label: 'Text', tools: ['text'] },
    { id: 'eyedropper', label: 'Eyedropper', tools: ['eyedropper'] },
    { id: 'stamp', label: 'Sticker stamp', tools: ['stamp'] },
    { id: 'retouch', label: 'Retouch tools', tools: ['smudge', 'blurSharpen', 'dodgeBurn'] },
  ],
  [{ id: 'view', label: 'View tools', tools: ['hand', 'zoom'] }],
];

export const RAIL_GROUPS: readonly RailGroup[] = RAIL_SECTIONS.flat();

/** The group a tool belongs to. */
export function groupOf(tool: ToolId): RailGroup {
  const g = RAIL_GROUPS.find((group) => group.tools.includes(tool));
  if (!g) throw new Error(`tool ${tool} is not on the rail`);
  return g;
}

/** Every rail tool in rail order (must equal the engine's TOOL_ORDER). */
export function railOrder(): ToolId[] {
  return RAIL_GROUPS.flatMap((g) => [...g.tools]);
}

/** Tools the engine knows that the rail does not show (should be none). */
export function missingFromRail(order: readonly ToolId[] = TOOL_ORDER): ToolId[] {
  const shown = new Set(railOrder());
  return order.filter((t) => !shown.has(t));
}

/** Tools that paint strokes and therefore take the symmetry settings. */
export const SYMMETRY_TOOLS: readonly ToolId[] = TOOL_ORDER.filter((id) => TOOL_META[id].usesSymmetry);

/** Selection tools (the options bar adds the Selection menu: select all, invert, feather, grow…). */
export const SELECTION_TOOLS: readonly ToolId[] = ['selectRect', 'selectEllipse', 'lasso', 'magicWand'];
