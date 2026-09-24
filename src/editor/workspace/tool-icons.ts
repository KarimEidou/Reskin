// Lucide icons for the rail's tools and the options bar's choices
// (per-icon imports keep the bundle small).

import type { ToolId } from '$engine/index';
import type { IconComponent } from '$lib/ui/types';
import Blend from '@lucide/svelte/icons/blend';
import Brush from '@lucide/svelte/icons/brush';
import Circle from '@lucide/svelte/icons/circle';
import CircleDashed from '@lucide/svelte/icons/circle-dashed';
import Eraser from '@lucide/svelte/icons/eraser';
import Hand from '@lucide/svelte/icons/hand';
import Heart from '@lucide/svelte/icons/heart';
import Hexagon from '@lucide/svelte/icons/hexagon';
import Minus from '@lucide/svelte/icons/minus';
import Move from '@lucide/svelte/icons/move';
import MoveUpRight from '@lucide/svelte/icons/move-up-right';
import PaintBucket from '@lucide/svelte/icons/paint-bucket';
import Pencil from '@lucide/svelte/icons/pencil';
import Pipette from '@lucide/svelte/icons/pipette';
import Shapes from '@lucide/svelte/icons/shapes';
import Square from '@lucide/svelte/icons/square';
import SquareDashed from '@lucide/svelte/icons/square-dashed';
import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
import SquareDot from '@lucide/svelte/icons/square-dot';
import SquareMinus from '@lucide/svelte/icons/square-minus';
import SquarePlus from '@lucide/svelte/icons/square-plus';
import SquareRoundCorner from '@lucide/svelte/icons/square-round-corner';
import Squircle from '@lucide/svelte/icons/squircle';
import Star from '@lucide/svelte/icons/star';
import TextAlignCenter from '@lucide/svelte/icons/text-align-center';
import TextAlignEnd from '@lucide/svelte/icons/text-align-end';
import TextAlignStart from '@lucide/svelte/icons/text-align-start';
import Type from '@lucide/svelte/icons/type';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';

export const TOOL_ICONS: Record<ToolId, IconComponent> = {
  move: Move,
  selectRect: SquareDashed,
  selectEllipse: CircleDashed,
  brush: Brush,
  pencil: Pencil,
  eraser: Eraser,
  fill: PaintBucket,
  gradient: Blend,
  shape: Shapes,
  text: Type,
  eyedropper: Pipette,
  hand: Hand,
  zoom: ZoomIn,
};

/** Icons referenced by `icon` keys in options-schema.ts. */
export const CHOICE_ICONS: Record<string, IconComponent> = {
  selReplace: SquareDashedMousePointer,
  selAdd: SquarePlus,
  selSubtract: SquareMinus,
  selIntersect: SquareDot,
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
