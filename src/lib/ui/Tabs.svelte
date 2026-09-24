<!--
  Tabs with automatic activation: arrows / Home / End move between tabs,
  a sliding ink bar marks the active one. The panel snippet receives the
  active tab id:
    <Tabs {tabs} bind:value label="Panels">{#snippet children(id)}…{/snippet}</Tabs>
-->
<script module lang="ts">
  import type { IconComponent } from './types';

  export interface TabItem {
    id: string;
    label: string;
    icon?: IconComponent;
    disabled?: boolean;
    /** Small count/marker after the label. */
    badge?: string | number;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { rovingIndex } from './focus';
  import { ICON_STROKE } from './types';

  interface Props {
    tabs: readonly TabItem[];
    value?: string;
    /** Accessible name of the tab list. */
    label: string;
    size?: 'sm' | 'md';
    onchange?: (id: string) => void;
    /** Panel content for the active tab. */
    children?: Snippet<[string]>;
  }

  let { tabs, value = $bindable(), label, size = 'md', onchange, children }: Props = $props();

  const uid = $props.id();
  const buttons: HTMLButtonElement[] = $state([]);
  let list: HTMLDivElement | undefined = $state();
  let ink = $state({ x: 0, w: 0 });

  const active = $derived(Math.max(0, tabs.findIndex((t) => t.id === value)));
  const activeId = $derived(tabs[active]?.id ?? '');

  function activate(i: number, focus: boolean): void {
    const tab = tabs[i];
    if (!tab || tab.disabled) return;
    if (focus) buttons[i]?.focus();
    if (tab.id === value) return;
    value = tab.id;
    onchange?.(tab.id);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const next = rovingIndex(
      e.key,
      active,
      tabs.map((t) => !!t.disabled),
      'horizontal',
    );
    if (next === null) return;
    e.preventDefault();
    activate(next, true);
  }

  // Keep the ink bar under the active tab (also when labels reflow).
  $effect(() => {
    const el = buttons[active];
    if (!el || !list) return;
    const measure = () => (ink = { x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  });
</script>

<div class="tabs size-{size}">
  <div class="list" role="tablist" aria-label={label} tabindex="-1" bind:this={list} onkeydown={onKeyDown}>
    {#each tabs as tab, i (tab.id)}
      <button
        bind:this={buttons[i]}
        id="{uid}-tab-{i}"
        type="button"
        role="tab"
        aria-selected={i === active}
        aria-controls="{uid}-panel"
        tabindex={i === active ? 0 : -1}
        disabled={tab.disabled}
        onclick={() => activate(i, false)}
      >
        {#if tab.icon}<tab.icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />{/if}
        <span>{tab.label}</span>
        {#if tab.badge !== undefined}<span class="badge">{tab.badge}</span>{/if}
      </button>
    {/each}
    <span class="ink" aria-hidden="true" style:width="{ink.w}px" style:transform="translateX({ink.x}px)"></span>
  </div>
  {#if children}
    <div class="panel" id="{uid}-panel" role="tabpanel" aria-labelledby="{uid}-tab-{active}" tabindex="0">
      {@render children(activeId)}
    </div>
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .list {
    position: relative;
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--divider);
  }
  .list:focus {
    outline: none;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-lg);
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: default;
    transition:
      color var(--fade-1) linear,
      background-color var(--fade-1) linear;
  }
  .size-sm button {
    height: var(--control-md);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
  }
  button:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  button[aria-selected='true'] {
    color: var(--text);
  }
  button:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  button:disabled {
    opacity: 0.4;
  }
  .badge {
    min-width: 18px;
    padding: 1px 5px;
    border-radius: var(--radius-full);
    background: var(--surface-3);
    color: var(--text-2);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    text-align: center;
  }
  .ink {
    position: absolute;
    bottom: -1px;
    left: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
    transition:
      transform var(--dur-spring) var(--ease-spring),
      width var(--dur-spring) var(--ease-spring);
  }
  .panel {
    flex: 1;
    min-height: 0;
  }
  .panel:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
</style>
