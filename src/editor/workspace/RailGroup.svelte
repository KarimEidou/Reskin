<!--
  One slot of the tool rail. A single tool is a toggle button; a group
  shows its current tool plus a corner triangle, and opens a flyout with
  the others on right-click, a long press, → or Alt+↓.
-->
<script lang="ts">
  import type { ToolId } from '$engine/index';
  import Menu, { type MenuEntry } from '$lib/ui/Menu.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';
  import type { RailGroup } from './tool-groups';
  import { TOOL_ICONS } from './tool-icons';

  interface Props {
    group: RailGroup;
    /** Roving tabindex: this slot is the rail's tab stop. */
    tabStop: boolean;
    onfocusslot: () => void;
  }

  let { group, tabStop, onfocusslot }: Props = $props();

  const session = getSession();
  const engine = session.engine;
  const LONG_PRESS_MS = 380;

  const selected = $derived.by(() => {
    void session.rev.tool;
    return engine.selectedToolId;
  });
  /** The tool this slot shows: the selected one if it is in the group, else the last used. */
  let remembered = $state<ToolId | null>(null);
  const shown = $derived<ToolId>(
    group.tools.includes(selected) ? selected : (remembered ?? group.tools[0]!),
  );
  const active = $derived(group.tools.includes(selected));
  const multi = $derived(group.tools.length > 1);
  const tool = $derived(engine.tools[shown]);
  const Icon = $derived(TOOL_ICONS[shown]);

  $effect(() => {
    if (group.tools.includes(selected)) remembered = selected;
  });

  let flyoutTrigger: HTMLElement | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  const items: MenuEntry[] = $derived(
    group.tools.map((id) => ({
      id,
      label: engine.tools[id].label,
      icon: TOOL_ICONS[id],
      shortcut: engine.tools[id].shortcut,
      checked: id === selected,
    })),
  );

  /** Opens the flyout; from the keyboard, with the first tool focused. */
  function openFlyout(fromKeyboard = false): void {
    if (!flyoutTrigger) return;
    if (fromKeyboard) {
      // The menu opens on ↓ with its first item focused.
      flyoutTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    } else {
      flyoutTrigger.click();
    }
  }

  function choose(id: ToolId): void {
    remembered = id;
    engine.setTool(id);
  }

  function onClick(): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    choose(shown);
  }

  function onPointerDown(e: PointerEvent): void {
    suppressClick = false;
    if (!multi || e.button !== 0) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      suppressClick = true;
      openFlyout();
    }, LONG_PRESS_MS);
  }

  function cancelPress(): void {
    clearTimeout(pressTimer);
  }

  function onContextMenu(e: MouseEvent): void {
    if (!multi) return;
    e.preventDefault();
    openFlyout();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!multi) return;
    if (e.key === 'ArrowRight' || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      openFlyout(true);
    }
  }

  function captureTrigger(node: HTMLElement) {
    flyoutTrigger = node;
    return () => {
      if (flyoutTrigger === node) flyoutTrigger = null;
    };
  }
</script>

<div class="slot" class:active>
  <Tooltip text={multi ? `${tool.label} — hold for more` : tool.label} shortcut={tool.shortcut} placement="right">
    <button
      type="button"
      class="tool"
      aria-label={tool.label}
      aria-pressed={active}
      aria-keyshortcuts={tool.shortcut}
      tabindex={tabStop ? 0 : -1}
      data-rail-tool={shown}
      data-testid="tool-{shown}"
      onclick={onClick}
      onpointerdown={onPointerDown}
      onpointerup={cancelPress}
      onpointerleave={cancelPress}
      oncontextmenu={onContextMenu}
      onkeydown={onKeyDown}
      onfocus={onfocusslot}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  </Tooltip>
  {#if multi}
    <Menu label={group.label} {items} placement="right-start" onselect={(id) => choose(id as ToolId)}>
      {#snippet trigger(props)}
        <button
          {...props}
          {@attach captureTrigger}
          type="button"
          class="more"
          tabindex="-1"
          aria-label="More {group.label.toLowerCase()}"
        >
          <svg viewBox="0 0 6 6" width="6" height="6" aria-hidden="true"><path d="M6 0V6H0Z" /></svg>
        </button>
      {/snippet}
    </Menu>
  {/if}
</div>

<style>
  .slot {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    height: 36px;
  }

  .tool {
    display: grid;
    place-items: center;
    width: 36px;
    height: 34px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear,
      box-shadow var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .tool:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tool:active {
    transform: scale(0.94);
  }
  .tool:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .tool[aria-pressed='true'] {
    border-color: rgb(var(--accent-rgb) / 0.35);
    background: linear-gradient(180deg, rgb(var(--accent-rgb) / 0.26), rgb(var(--accent-rgb) / 0.16));
    color: var(--accent-text);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.08),
      0 1px 6px rgb(var(--accent-rgb) / 0.18);
  }

  .more {
    position: absolute;
    top: 1px;
    right: 2px;
    bottom: 1px;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    width: 10px;
    padding: 0 1px 3px 0;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: default;
  }
  .more path {
    fill: currentColor;
  }
  .slot.active .more {
    color: var(--accent-text);
  }
  .more:hover {
    color: var(--text);
  }
</style>
