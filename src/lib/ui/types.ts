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

/** Icon pixel size that matches each control size. */
export const ICON_SIZE: Record<ControlSize, number> = { sm: 14, md: 16, lg: 18 };

export interface Option<T extends string = string> {
  value: T;
  label: string;
  icon?: IconComponent;
  disabled?: boolean;
}
