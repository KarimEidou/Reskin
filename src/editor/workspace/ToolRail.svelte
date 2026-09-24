<!--
  The tool rail (left): every engine tool, grouped as in docs/UI.md, as a
  vertical toolbar (one tab stop; ↑/↓/Home/End move between tools, →
  opens a group's flyout), with the colour chips at the bottom.
-->
<script lang="ts">
  import { rovingIndex } from '$lib/ui/focus';
  import { getSession } from '../state/context';
  import ColorChips from './ColorChips.svelte';
  import RailGroup from './RailGroup.svelte';
  import { RAIL_GROUPS, RAIL_SECTIONS } from './tool-groups';

  const session = getSession();
  const engine = session.engine;

  const selected = $derived.by(() => {
    void session.rev.tool;
    return engine.selectedToolId;
  });
  const activeIndex = $derived(Math.max(0, RAIL_GROUPS.findIndex((g) => g.tools.includes(selected))));
  /** Slot that holds the tab stop (the last focused one, else the active tool). */
  let focusIndex = $state<number | null>(null);
  const tabStop = $derived(focusIndex ?? activeIndex);
  let toolbar: HTMLDivElement | undefined = $state();

  const indexOf = (groupId: string) => RAIL_GROUPS.findIndex((g) => g.id === groupId);

  function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const next = rovingIndex(
      e.key,
      tabStop,
      RAIL_GROUPS.map(() => false),
      'vertical',
    );
    if (next === null) return;
    e.preventDefault();
    focusIndex = next;
    toolbar?.querySelectorAll<HTMLButtonElement>('button[data-rail-tool]')[next]?.focus();
  }
</script>

<div
  bind:this={toolbar}
  class="rail"
  role="toolbar"
  aria-label="Tools"
  aria-orientation="vertical"
  tabindex="-1"
  onkeydown={onKeyDown}
  data-testid="tool-rail"
>
  {#each RAIL_SECTIONS as section, si (si)}
    {#if si > 0}<div class="sep" role="separator"></div>{/if}
    {#each section as group (group.id)}
      <RailGroup {group} tabStop={tabStop === indexOf(group.id)} onfocusslot={() => (focusIndex = indexOf(group.id))} />
    {/each}
  {/each}
  <div class="spacer"></div>
  <ColorChips />
</div>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    height: 100%;
    min-height: 0;
    padding: 8px 0 12px;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .rail:focus {
    outline: none;
  }
  .sep {
    flex: none;
    width: 22px;
    height: 1px;
    margin: 5px 0;
    background: var(--divider);
  }
  .spacer {
    flex: 1 0 8px;
  }
</style>
