// Shared prop types for the UI components.

import type { Component } from 'svelte';

/**
 * Any icon component accepting a size — in practice a per-icon Lucide
 * import: `import Brush from '@lucide/svelte/icons/brush'`.
 */
export type IconComponent = Component<{
  size?: number | string;
  strokeWidth?: number | string;
  class?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export type ControlSize = 'sm' | 'md' | 'lg';

/** Icon pixel size that matches each control size (UI.md: 18 px at the default size). */
export const ICON_SIZE: Record<ControlSize, number> = { sm: 16, md: 18, lg: 20 };

/** Lucide stroke width used throughout the UI (UI.md). */
export const ICON_STROKE = 1.75;

export interface Option<T extends string = string> {
  value: T;
  label: string;
  icon?: IconComponent;
  disabled?: boolean;
}
