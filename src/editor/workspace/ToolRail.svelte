<!--
  The tool rail (left): every engine tool, grouped as in docs/UI.md, as a
  vertical toolbar (one tab stop; ↑/↓/Home/End move between tools, →
  opens a group's flyout), with the colour chips at the bottom (tab stops
  of their own, which the arrows leave alone).
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
  /** Each slot's tool button (RailGroup). */
  const RAIL_TOOL = 'button[data-rail-tool]';

  /** The arrows move between the tools; keys on the colour chips (or a flyout trigger) are theirs. */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || !(e.target instanceof Element) || !e.target.matches(RAIL_TOOL)) return;
    const next = rovingIndex(
      e.key,
      tabStop,
      RAIL_GROUPS.map(() => false),
      'vertical',
    );
    if (next === null) return;
    e.preventDefault();
    focusIndex = next;
    toolbar?.querySelectorAll<HTMLButtonElement>(RAIL_TOOL)[next]?.focus();
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
    /* Slot height and the space around section hairlines (RailGroup). */
    --rail-slot: 36px;
    --rail-sep: 5px;
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
    margin: var(--rail-sep) 0;
    background: var(--divider);
  }
  /* The small editor (S) keeps every tool and the colour chips in view. */
  @media (max-height: 700px) {
    .rail {
      --rail-slot: 30px;
      --rail-sep: 2px;
    }
  }
  .spacer {
    flex: 1 0 8px;
  }
</style>
