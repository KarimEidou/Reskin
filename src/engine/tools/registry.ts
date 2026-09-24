// The set of tools an Engine owns, with their typed options, and static
// metadata (label, shortcut, icon, group) the tool rail can be built from
// without an engine.

import type { Tool, ToolGroup, ToolId } from './types';
import type { BrushOptions, BrushTool } from './brush';
import { createBrushTool, createEraserTool } from './brush';
import type { PencilOptions, PencilTool } from './pencil';
import { createPencilTool } from './pencil';
import type { FillOptions, FillTool } from './fill';
import { createFillTool } from './fill';
import type { GradientTool, GradientToolOptions } from './gradient';
import { createGradientTool } from './gradient';
import type { ShapeOptions, ShapeTool } from './shape';
import { createShapeTool } from './shape';
import type { TextTool, TextToolOptions } from './text';
import { createTextTool } from './text';
import type { EyedropperOptions, EyedropperTool } from './eyedropper';
import { createEyedropperTool } from './eyedropper';
import type { TransformOptions, TransformTool } from './transform';
import { createTransformTool } from './transform';
import type { MarqueeTool, SelectOptions } from './select';
import { createEllipseSelectTool, createRectSelectTool } from './select';
import type { LassoOptions, LassoTool } from './lasso';
import { createLassoTool } from './lasso';
import type { MagicWandOptions, MagicWandTool } from './wand';
import { createMagicWandTool } from './wand';
import type { SprayOptions, SprayTool } from './spray';
import { createSprayTool } from './spray';
import type { SmudgeOptions, SmudgeTool } from './smudge';
import { createSmudgeTool } from './smudge';
import type { BlurSharpenOptions, BlurSharpenTool } from './blur-sharpen';
import { createBlurSharpenTool } from './blur-sharpen';
import type { DodgeBurnOptions, DodgeBurnTool } from './dodge-burn';
import { createDodgeBurnTool } from './dodge-burn';
import type { StampOptions, StampTool } from './stamp';
import { createStampTool } from './stamp';
import type { HandTool, ZoomOptions, ZoomTool } from './view-tools';
import { createHandTool, createZoomTool } from './view-tools';

/** Options type of every tool. */
export interface ToolOptionsMap {
  move: TransformOptions;
  selectRect: SelectOptions;
  selectEllipse: SelectOptions;
  lasso: LassoOptions;
  magicWand: MagicWandOptions;
  brush: BrushOptions;
  spray: SprayOptions;
  pencil: PencilOptions;
  eraser: BrushOptions;
  fill: FillOptions;
  gradient: GradientToolOptions;
  shape: ShapeOptions;
  text: TextToolOptions;
  eyedropper: EyedropperOptions;
  stamp: StampOptions;
  smudge: SmudgeOptions;
  blurSharpen: BlurSharpenOptions;
  dodgeBurn: DodgeBurnOptions;
  hand: object;
  zoom: ZoomOptions;
}

/** What every entry of a ToolSet must be: a Tool over that tool's options. */
export type ToolContract = { [K in ToolId]: Tool<ToolOptionsMap[K]> };

/**
 * The concrete tool instances of an engine (`engine.tools`), so tool-specific
 * state is typed: `engine.tools.move.params` (pending transform),
 * `engine.tools.lasso.polygon` (polygon being built)…
 */
export interface ToolSet extends ToolContract {
  move: TransformTool;
  selectRect: MarqueeTool;
  selectEllipse: MarqueeTool;
  lasso: LassoTool;
  magicWand: MagicWandTool;
  brush: BrushTool;
  spray: SprayTool;
  pencil: PencilTool;
  eraser: BrushTool;
  fill: FillTool;
  gradient: GradientTool;
  shape: ShapeTool;
  text: TextTool;
  eyedropper: EyedropperTool;
  stamp: StampTool;
  smudge: SmudgeTool;
  blurSharpen: BlurSharpenTool;
  dodgeBurn: DodgeBurnTool;
  hand: HandTool;
  zoom: ZoomTool;
}

/** Rail order (see docs/UI.md). */
export const TOOL_ORDER: readonly ToolId[] = [
  'move',
  'selectRect',
  'selectEllipse',
  'lasso',
  'magicWand',
  'brush',
  'spray',
  'pencil',
  'eraser',
  'fill',
  'gradient',
  'shape',
  'text',
  'eyedropper',
  'stamp',
  'smudge',
  'blurSharpen',
  'dodgeBurn',
  'hand',
  'zoom',
];

/** Fresh tool instances (tools keep per-gesture state, so one set per engine). */
export function createTools(): ToolSet {
  return {
    move: createTransformTool(),
    selectRect: createRectSelectTool(),
    selectEllipse: createEllipseSelectTool(),
    lasso: createLassoTool(),
    magicWand: createMagicWandTool(),
    brush: createBrushTool(),
    spray: createSprayTool(),
    pencil: createPencilTool(),
    eraser: createEraserTool(),
    fill: createFillTool(),
    gradient: createGradientTool(),
    shape: createShapeTool(),
    text: createTextTool(),
    eyedropper: createEyedropperTool(),
    stamp: createStampTool(),
    smudge: createSmudgeTool(),
    blurSharpen: createBlurSharpenTool(),
    dodgeBurn: createDodgeBurnTool(),
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

/** Static description of a tool for the rail, tooltips and shortcuts. */
export interface ToolMeta {
  id: ToolId;
  label: string;
  /** Default shortcut proposal, e.g. 'L', 'Shift+R' (shown in tooltips). */
  shortcut: string;
  /** Lucide icon name (kebab-case); see `toolIcon` for mode-dependent icons. */
  icon: string;
  /** Tools of one group can share a rail slot with a flyout; null = own slot. */
  group: ToolGroup | null;
  /** Painting tool that replicates strokes through the symmetry settings. */
  usesSymmetry: boolean;
}

function buildMeta(): Readonly<Record<ToolId, Readonly<ToolMeta>>> {
  const tools = createTools();
  const out = {} as Record<ToolId, Readonly<ToolMeta>>;
  for (const id of TOOL_ORDER) {
    const t = tools[id] as Tool<object>;
    out[id] = Object.freeze({
      id,
      label: t.label,
      shortcut: t.shortcut,
      icon: t.icon ?? 'circle',
      group: t.group ?? null,
      usesSymmetry: t.usesSymmetry,
    });
  }
  return Object.freeze(out);
}

/** Metadata of every tool, keyed by id (iterate with TOOL_ORDER for the rail). */
export const TOOL_META: Readonly<Record<ToolId, Readonly<ToolMeta>>> = buildMeta();

/**
 * The icon to show for a tool with its current options: dodge/burn shows
 * 'moon' in burn mode, the lasso 'lasso-select' in polygon mode… Falls
 * back to `TOOL_META[id].icon`.
 */
export function toolIcon<K extends ToolId>(id: K, options?: Partial<ToolOptionsMap[K]>): string {
  if (id === 'dodgeBurn' && (options as Partial<DodgeBurnOptions> | undefined)?.mode === 'burn') return 'moon';
  if (id === 'lasso' && (options as Partial<LassoOptions> | undefined)?.kind === 'polygon') return 'lasso-select';
  if (id === 'blurSharpen' && (options as Partial<BlurSharpenOptions> | undefined)?.mode === 'sharpen') return 'triangle';
  return TOOL_META[id].icon;
}
