<!--
  Dropdown menu button. Keyboard: ↓/Enter/Space open on the first item, ↑
  on the last; ↑/↓/Home/End move, typing jumps to a label, Enter/Space
  choose, Escape closes (focus returns to the trigger), Tab closes.
    <Menu label="More" iconOnly icon={Ellipsis} items={[…]} onselect={(id) => …} />
  A custom trigger gets every prop it needs (spread them onto a button):
    <Menu {items} label="Export" onselect={…}>
      {#snippet trigger(props)}<Button {...props}>Export</Button>{/snippet}
    </Menu>
-->
<script module lang="ts">
  import type { IconComponent } from './types';

  export interface MenuAction {
    id: string;
    label: string;
    icon?: IconComponent;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    /** Makes it a checkable item (menuitemcheckbox). */
    checked?: boolean;
  }

  export type MenuEntry = MenuAction | { separator: true } | { heading: string };

  export interface MenuTriggerProps {
    id: string;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
    disabled: boolean;
    onclick: (e: MouseEvent) => void;
    onkeydown: (e: KeyboardEvent) => void;
    [attachment: symbol]: (node: HTMLElement) => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { createAttachmentKey } from 'svelte/attachments';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Button from './Button.svelte';
  import { dismissable, floating, portal } from './floating';
  import { rovingIndex, typeaheadIndex } from './focus';
  import IconButton from './IconButton.svelte';
  import Kbd from './Kbd.svelte';
  import type { Placement } from './position';
  import type { ControlSize } from './types';

  interface Props {
    items: readonly MenuEntry[];
    /** Trigger text, or its accessible name when `iconOnly`. */
    label: string;
    icon?: IconComponent;
    iconOnly?: boolean;
    variant?: 'ghost' | 'secondary' | 'primary';
    size?: ControlSize;
    placement?: Placement;
    disabled?: boolean;
    onselect: (id: string) => void;
    trigger?: Snippet<[MenuTriggerProps]>;
  }

  let {
    items,
    label,
    icon,
    iconOnly = false,
    variant = 'ghost',
    size = 'md',
    placement = 'bottom-start',
    disabled = false,
    onselect,
    trigger,
  }: Props = $props();

  const uid = $props.id();
  const attach = createAttachmentKey();
  let open = $state(false);
  /** Index into `actions` of the focused item (-1 = the menu itself). */
  let active = $state(-1);
  let triggerEl: HTMLElement | null = null;
  let menuEl: HTMLDivElement | undefined = $state();
  const itemEls: HTMLButtonElement[] = $state([]);
  let typed = '';
  let typedTimer: ReturnType<typeof setTimeout> | undefined;

  const isAction = (e: MenuEntry): e is MenuAction => 'id' in e;
  const actions = $derived(items.filter(isAction));
  const disabledFlags = $derived(actions.map((a) => !!a.disabled));

  function openMenu(focus: 'first' | 'last' | 'menu'): void {
    open = true;
    active = focus === 'menu' ? -1 : (rovingIndex(focus === 'first' ? 'Home' : 'End', 0, disabledFlags) ?? -1);
  }

  function closeMenu(returnFocus: boolean): void {
    open = false;
    active = -1;
    if (returnFocus) triggerEl?.focus();
  }

  function choose(action: MenuAction): void {
    if (action.disabled) return;
    closeMenu(true);
    onselect(action.id);
  }

  function onTriggerKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    }
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      closeMenu(false);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
      e.preventDefault();
      choose(actions[active]!);
      return;
    }
    const next = rovingIndex(e.key, active < 0 ? -1 : active, disabledFlags, 'vertical');
    if (next !== null) {
      e.preventDefault();
      active = active < 0 && e.key === 'ArrowUp' ? (rovingIndex('End', 0, disabledFlags) ?? next) : next;
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      clearTimeout(typedTimer);
      typed += e.key;
      typedTimer = setTimeout(() => (typed = ''), 600);
      const hit = typeaheadIndex(
        typed,
        Math.max(0, active),
        actions.map((a) => a.label),
        disabledFlags,
      );
      if (hit !== null) active = hit;
    }
  }

  // Move DOM focus with the active item (or to the menu itself).
  $effect(() => {
    if (!open || !menuEl) return;
    const target = active >= 0 ? itemEls[active] : menuEl;
    target?.focus();
  });

  const triggerProps: MenuTriggerProps = $derived({
    id: `${uid}-trigger`,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? `${uid}-menu` : undefined,
    disabled,
    onclick: () => (open ? closeMenu(false) : openMenu('menu')),
    onkeydown: onTriggerKey,
    [attach]: (node: HTMLElement) => {
      triggerEl = node;
    },
  });
</script>

{#if trigger}
  {@render trigger(triggerProps)}
{:else if iconOnly}
  <IconButton {label} icon={icon ?? Ellipsis} {size} {variant} tooltip={open ? false : label} {...triggerProps} />
{:else}
  <Button {variant} {size} {icon} iconRight={ChevronDown} {...triggerProps}>{label}</Button>
{/if}

{#if open}
  <div
    bind:this={menuEl}
    class="menu"
    id="{uid}-menu"
    role="menu"
    aria-labelledby="{uid}-trigger"
    tabindex="-1"
    onkeydown={onMenuKey}
    {@attach portal()}
    {@attach floating({ anchor: () => triggerEl, placement, offset: 4 })}
    {@attach dismissable((reason) => closeMenu(reason === 'escape'), () => [triggerEl])}
  >
    {#each items as entry, i (i)}
      {#if 'separator' in entry}
        <div class="separator" role="separator"></div>
      {:else if 'heading' in entry}
        <div class="heading" role="presentation">{entry.heading}</div>
      {:else}
        {@const index = actions.indexOf(entry)}
        <button
          bind:this={itemEls[index]}
          type="button"
          role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={entry.checked}
          tabindex="-1"
          class="item"
          class:danger={entry.danger}
          class:active={index === active}
          disabled={entry.disabled}
          onclick={() => choose(entry)}
          onpointermove={() => {
            if (!entry.disabled && active !== index) active = index;
          }}
        >
          <span class="lead" aria-hidden="true">
            {#if entry.checked}<Check size={15} />{:else if entry.icon}<entry.icon size={15} />{/if}
          </span>
          <span class="text">{entry.label}</span>
          {#if entry.shortcut}<Kbd keys={entry.shortcut} size="sm" />{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    z-index: var(--z-menu);
    min-width: 200px;
    max-height: max(120px, var(--available, 100vh));
    overflow: auto;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-popover);
    transition:
      opacity var(--fade-1) linear,
      scale var(--dur-2) var(--ease-decelerate);
    transform-origin: top left;
  }
  .menu:focus {
    outline: none;
  }
  @starting-style {
    .menu {
      opacity: 0;
      scale: 0.97;
    }
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    height: 30px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--text-md);
    text-align: left;
    cursor: default;
  }
  .item.active {
    background: var(--surface-hover);
  }
  .item:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring-inset);
  }
  .item:disabled {
    color: var(--text-disabled);
  }
  .danger {
    color: var(--danger);
  }
  .danger.active {
    background: rgb(var(--danger-rgb) / 0.12);
  }
  .lead {
    display: grid;
    place-items: center;
    width: 16px;
    color: var(--text-2);
  }
  .danger .lead {
    color: inherit;
  }
  .text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .separator {
    height: 1px;
    margin: var(--space-1) var(--space-1);
    background: var(--divider);
  }
  .heading {
    padding: var(--space-1-5) var(--space-2) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
</style>
