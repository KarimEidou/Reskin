// Anchored positioning for tooltips, popovers and menus (pure maths).

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement = Side | `${Side}-${Exclude<Align, 'center'>}`;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionOptions {
  placement?: Placement;
  /** Gap between anchor and floating element (px). */
  offset?: number;
  /** Minimum distance from the viewport edges (px). */
  padding?: number;
  /** Flip to the opposite side when the preferred one lacks room. */
  flip?: boolean;
}

export interface PositionResult {
  x: number;
  y: number;
  /** The placement actually used (after flipping). */
  placement: Placement;
  side: Side;
  /** Space available on the chosen side, for max-height / max-width. */
  available: number;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

export function parsePlacement(p: Placement): { side: Side; align: Align } {
  const [side, align] = p.split('-') as [Side, Align | undefined];
  return { side, align: align ?? 'center' };
}

function spaceOn(side: Side, anchor: Box, viewport: Size, padding: number, offset: number): number {
  switch (side) {
    case 'top':
      return anchor.y - offset - padding;
    case 'bottom':
      return viewport.height - (anchor.y + anchor.height) - offset - padding;
    case 'left':
      return anchor.x - offset - padding;
    case 'right':
      return viewport.width - (anchor.x + anchor.width) - offset - padding;
  }
}

const clampTo = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/**
 * Positions a `floating` box next to `anchor` inside `viewport` (all in the
 * same coordinate space, typically CSS px of the window): picks the side
 * (flipping when needed), aligns along the other axis and shifts the result
 * back into the viewport.
 */
export function computePosition(
  anchor: Box,
  floating: Size,
  viewport: Size,
  opts: PositionOptions = {},
): PositionResult {
  const offset = opts.offset ?? 6;
  const padding = opts.padding ?? 8;
  const preferred = parsePlacement(opts.placement ?? 'bottom');
  let side = preferred.side;
  const need = side === 'top' || side === 'bottom' ? floating.height : floating.width;
  if (opts.flip !== false) {
    const here = spaceOn(side, anchor, viewport, padding, offset);
    const there = spaceOn(OPPOSITE[side], anchor, viewport, padding, offset);
    if (here < need && there > here) side = OPPOSITE[side];
  }
  const align = preferred.align;
  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? anchor.y - offset - floating.height : anchor.y + anchor.height + offset;
    x =
      align === 'start'
        ? anchor.x
        : align === 'end'
          ? anchor.x + anchor.width - floating.width
          : anchor.x + (anchor.width - floating.width) / 2;
    x = clampTo(x, padding, viewport.width - padding - floating.width);
    y = clampTo(y, padding, viewport.height - padding - floating.height);
  } else {
    x = side === 'left' ? anchor.x - offset - floating.width : anchor.x + anchor.width + offset;
    y =
      align === 'start'
        ? anchor.y
        : align === 'end'
          ? anchor.y + anchor.height - floating.height
          : anchor.y + (anchor.height - floating.height) / 2;
    y = clampTo(y, padding, viewport.height - padding - floating.height);
    x = clampTo(x, padding, viewport.width - padding - floating.width);
  }
  const placement = (align === 'center' ? side : `${side}-${align}`) as Placement;
  return {
    x: Math.round(x),
    y: Math.round(y),
    placement,
    side,
    available: Math.max(0, spaceOn(side, anchor, viewport, padding, offset)),
  };
}
