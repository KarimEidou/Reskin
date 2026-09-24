// Lucide icons for the rail's tools and the options bar's choices
// (per-icon imports keep the bundle small). The engine names each tool's
// icon, depending on its options (TOOL_META / toolIcon: kebab-case Lucide
// names); TOOL_LUCIDE maps every name it can return to its component.

import { TOOL_META, toolIcon, type ToolId, type ToolOptionsMap } from '$engine/index';
import type { IconComponent } from '$lib/ui/types';
import Blend from '@lucide/svelte/icons/blend';
import Circle from '@lucide/svelte/icons/circle';
import CircleDashed from '@lucide/svelte/icons/circle-dashed';
import Droplets from '@lucide/svelte/icons/droplets';
import Eraser from '@lucide/svelte/icons/eraser';
import Hand from '@lucide/svelte/icons/hand';
import Heart from '@lucide/svelte/icons/heart';
import Hexagon from '@lucide/svelte/icons/hexagon';
import Lasso from '@lucide/svelte/icons/lasso';
import LassoSelect from '@lucide/svelte/icons/lasso-select';
import Minus from '@lucide/svelte/icons/minus';
import Moon from '@lucide/svelte/icons/moon';
import Move from '@lucide/svelte/icons/move';
import MoveUpRight from '@lucide/svelte/icons/move-up-right';
import PaintBucket from '@lucide/svelte/icons/paint-bucket';
import Paintbrush from '@lucide/svelte/icons/paintbrush';
import Pencil from '@lucide/svelte/icons/pencil';
import Pipette from '@lucide/svelte/icons/pipette';
import Pointer from '@lucide/svelte/icons/pointer';
import Shapes from '@lucide/svelte/icons/shapes';
import SprayCan from '@lucide/svelte/icons/spray-can';
import Square from '@lucide/svelte/icons/square';
import SquareDashed from '@lucide/svelte/icons/square-dashed';
import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
import SquareDot from '@lucide/svelte/icons/square-dot';
import SquareMinus from '@lucide/svelte/icons/square-minus';
import SquarePlus from '@lucide/svelte/icons/square-plus';
import SquareRoundCorner from '@lucide/svelte/icons/square-round-corner';
import Squircle from '@lucide/svelte/icons/squircle';
import Stamp from '@lucide/svelte/icons/stamp';
import Star from '@lucide/svelte/icons/star';
import Sun from '@lucide/svelte/icons/sun';
import TextAlignCenter from '@lucide/svelte/icons/text-align-center';
import TextAlignEnd from '@lucide/svelte/icons/text-align-end';
import TextAlignStart from '@lucide/svelte/icons/text-align-start';
import Triangle from '@lucide/svelte/icons/triangle';
import Type from '@lucide/svelte/icons/type';
import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';

/** Every icon name the engine's tools use (TOOL_META icons and toolIcon's variants). */
export const TOOL_LUCIDE: Readonly<Partial<Record<string, IconComponent>>> = {
  move: Move,
  'square-dashed': SquareDashed,
  'circle-dashed': CircleDashed,
  lasso: Lasso,
  'lasso-select': LassoSelect,
  'wand-sparkles': WandSparkles,
  paintbrush: Paintbrush,
  'spray-can': SprayCan,
  pencil: Pencil,
  eraser: Eraser,
  'paint-bucket': PaintBucket,
  blend: Blend,
  shapes: Shapes,
  type: Type,
  pipette: Pipette,
  stamp: Stamp,
  pointer: Pointer,
  droplets: Droplets,
  triangle: Triangle,
  sun: Sun,
  moon: Moon,
  hand: Hand,
  'zoom-in': ZoomIn,
};

/** The Lucide name and component of a tool's icon with its current options. */
export function toolIconOf<K extends ToolId>(
  id: K,
  options?: Partial<ToolOptionsMap[K]>,
): { name: string; icon: IconComponent } {
  const name = toolIcon(id, options);
  const icon = TOOL_LUCIDE[name] ?? TOOL_LUCIDE[TOOL_META[id].icon];
  return icon ? { name, icon } : { name: 'circle', icon: Circle };
}

/** Icons referenced by `icon` keys in options-schema.ts. */
export const CHOICE_ICONS: Record<string, IconComponent> = {
  selReplace: SquareDashedMousePointer,
  selAdd: SquarePlus,
  selSubtract: SquareMinus,
  selIntersect: SquareDot,
  lassoFreehand: Lasso,
  lassoPolygon: LassoSelect,
  alignLeft: TextAlignStart,
  alignCenter: TextAlignCenter,
  alignRight: TextAlignEnd,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  shapeRect: Square,
  shapeRounded: SquareRoundCorner,
  shapeSquircle: Squircle,
  shapeEllipse: Circle,
  shapePolygon: Hexagon,
  shapeStar: Star,
  shapeHeart: Heart,
  shapeLine: Minus,
  shapeArrow: MoveUpRight,
};
