// The sidebar's tabs and how their panels load. Layers (the default tab)
// ships with the sidebar; every other panel is a separate chunk loaded on
// first use (and prefetched when the editor is idle), which keeps the
// editor's initial JS small.

import type { Component } from 'svelte';
import History from '@lucide/svelte/icons/history';
import Layers from '@lucide/svelte/icons/layers';
import Palette from '@lucide/svelte/icons/palette';
import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Squircle from '@lucide/svelte/icons/squircle';
import Sticker from '@lucide/svelte/icons/sticker';
import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
import type { TabItem } from '$lib/ui/Tabs.svelte';
import type { SidebarTab } from '../state/session.svelte';

export interface SidebarTabItem extends TabItem {
  id: SidebarTab;
}

export const SIDEBAR_TABS: readonly SidebarTabItem[] = [
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'color', label: 'Color', icon: Palette },
  { id: 'adjust', label: 'Adjust', icon: SlidersHorizontal },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'styles', label: 'Styles', icon: WandSparkles },
  { id: 'backdrop', label: 'Backdrop', icon: Squircle },
  { id: 'stickers', label: 'Stickers', icon: Sticker },
  { id: 'history', label: 'History', icon: History },
];

export type LazyTab = Exclude<SidebarTab, 'layers'>;

export const PANEL_LOADERS: Record<LazyTab, () => Promise<{ default: Component }>> = {
  color: () => import('./color/ColorPanel.svelte'),
  adjust: () => import('./adjust/AdjustPanel.svelte'),
  effects: () => import('./effects/EffectsPanel.svelte'),
  styles: () => import('./styles/StylesPanel.svelte'),
  backdrop: () => import('./backdrop/BackdropPanel.svelte'),
  stickers: () => import('./stickers/StickersPanel.svelte'),
  history: () => import('./history/HistoryPanel.svelte'),
};
