// The set of tools an Engine owns, with their typed options.

import type { Tool, ToolId } from './types';
import type { BrushOptions } from './brush';
import { createBrushTool, createEraserTool } from './brush';
import type { PencilOptions } from './pencil';
import { createPencilTool } from './pencil';
import type { FillOptions } from './fill';
import { createFillTool } from './fill';
import type { GradientToolOptions } from './gradient';
import { createGradientTool } from './gradient';
import type { ShapeOptions } from './shape';
import { createShapeTool } from './shape';
import type { TextToolOptions } from './text';
import { createTextTool } from './text';
import type { EyedropperOptions } from './eyedropper';
import { createEyedropperTool } from './eyedropper';
import type { TransformOptions } from './transform';
import { createTransformTool } from './transform';
import type { SelectOptions } from './select';
import { createEllipseSelectTool, createRectSelectTool } from './select';
import type { ZoomOptions } from './view-tools';
import { createHandTool, createZoomTool } from './view-tools';

/** Options type of every tool. */
export interface ToolOptionsMap {
  move: TransformOptions;
  selectRect: SelectOptions;
  selectEllipse: SelectOptions;
  brush: BrushOptions;
  pencil: PencilOptions;
  eraser: BrushOptions;
  fill: FillOptions;
  gradient: GradientToolOptions;
  shape: ShapeOptions;
  text: TextToolOptions;
  eyedropper: EyedropperOptions;
  hand: object;
  zoom: ZoomOptions;
}

export type ToolSet = { [K in ToolId]: Tool<ToolOptionsMap[K]> };

/** Rail order (see docs/UI.md). */
export const TOOL_ORDER: readonly ToolId[] = [
  'move',
  'selectRect',
  'selectEllipse',
  'brush',
  'pencil',
  'eraser',
  'fill',
  'gradient',
  'shape',
  'text',
  'eyedropper',
  'hand',
  'zoom',
];

/** Fresh tool instances (tools keep per-gesture state, so one set per engine). */
export function createTools(): ToolSet {
  return {
    move: createTransformTool(),
    selectRect: createRectSelectTool(),
    selectEllipse: createEllipseSelectTool(),
    brush: createBrushTool(),
    pencil: createPencilTool(),
    eraser: createEraserTool(),
    fill: createFillTool(),
    gradient: createGradientTool(),
    shape: createShapeTool(),
    text: createTextTool(),
    eyedropper: createEyedropperTool(),
    hand: createHandTool(),
    zoom: createZoomTool(),
  };
}

export type ToolOptionsState = { [K in ToolId]: ToolOptionsMap[K] };

export function defaultToolOptions(tools: ToolSet): ToolOptionsState {
  const out = {} as Record<ToolId, object>;
  for (const id of TOOL_ORDER) out[id] = tools[id].defaultOptions();
  return out as ToolOptionsState;
}

export function isToolId(v: unknown): v is ToolId {
  return (TOOL_ORDER as readonly unknown[]).includes(v);
}
