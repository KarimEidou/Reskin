// Lazily loaded views: rarely used pages stay out of the editor's initial
// bundle and are fetched on first use (or preloaded while the editor idles
// after opening).

import type { Component } from 'svelte';

export type LazyView = 'welcome' | 'systemIcons' | 'library' | 'history' | 'settings';

const LOADERS: Record<LazyView, () => Promise<{ default: Component }>> = {
  welcome: () => import('./WelcomeView.svelte'),
  systemIcons: () => import('./SystemIconsView.svelte'),
  library: () => import('./LibraryView.svelte'),
  history: () => import('./HistoryView.svelte'),
  settings: () => import('./SettingsView.svelte'),
};

const loaded = $state<Partial<Record<LazyView, Component>>>({});
const inflight = new Map<LazyView, Promise<Component | null>>();

export function isLazyView(view: string): view is LazyView {
  return view in LOADERS;
}

/** Loads a view (once); resolves with its component, or null on failure. */
export function loadView(view: LazyView): Promise<Component | null> {
  const done = loaded[view];
  if (done) return Promise.resolve(done);
  let p = inflight.get(view);
  if (!p) {
    p = LOADERS[view]()
      .then((m) => {
        loaded[view] = m.default;
        return m.default;
      })
      .catch((e: unknown) => {
        console.error(`[editor] could not load the ${view} view`, e);
        inflight.delete(view);
        return null;
      });
    inflight.set(view, p);
  }
  return p;
}

/** The view's component if it is loaded already (reactive). */
export function loadedView(view: LazyView): Component | null {
  return loaded[view] ?? null;
}

/** Fetches every lazy view in the background. */
export function preloadViews(): void {
  for (const view of Object.keys(LOADERS) as LazyView[]) void loadView(view);
}
