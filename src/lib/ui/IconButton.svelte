<!--
  Square icon-only button with a required accessible label, shown as a
  tooltip (optionally with its shortcut). `pressed` makes it a toggle
  button (aria-pressed). `focusableWhenDisabled` keeps a disabled button
  focusable (aria-disabled, clicks ignored): for toolbar actions that become
  unavailable because they were just used (Undo, Delete), where a natively
  disabled button would drop keyboard focus to the page.
-->
<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { Placement } from './position';
  import Tooltip from './Tooltip.svelte';
  import { ICON_SIZE, ICON_STROKE, type ControlSize, type IconComponent } from './types';

  interface Props extends Omit<HTMLButtonAttributes, 'children' | 'aria-label'> {
    /** Accessible name (also the default tooltip). */
    label: string;
    icon: IconComponent;
    size?: ControlSize;
    variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
    /** Toggle state; leave undefined for a plain button. */
    pressed?: boolean;
    /** Tooltip text (defaults to the label); false = no tooltip. */
    tooltip?: string | false;
    shortcut?: string;
    placement?: Placement;
    /** Disabled, it stays focusable (aria-disabled) and ignores clicks. */
    focusableWhenDisabled?: boolean;
  }

  let {
    label,
    icon: Icon,
    size = 'md',
    variant = 'ghost',
    pressed,
    tooltip,
    shortcut,
    placement = 'top',
    type = 'button',
    class: className,
    disabled = false,
    focusableWhenDisabled = false,
    onclick,
    ...rest
  }: Props = $props();

  const unavailable = $derived(!!disabled && focusableWhenDisabled);

  const tip = $derived(tooltip === false ? label : (tooltip ?? label));
</script>

<!-- The Tooltip stays mounted when `tooltip` turns false (e.g. a menu
     trigger while its menu is open): unwrapping would re-create the button
     and drop its focus. -->
<Tooltip text={tip} {shortcut} {placement} describe={tip !== label} disabled={tooltip === false}>
  <button
    {...rest}
    {type}
    class={['icon-btn', `v-${variant}`, `s-${size}`, className]}
    aria-label={label}
    aria-pressed={pressed}
    disabled={disabled && !unavailable}
    aria-disabled={unavailable || undefined}
    onclick={(e) => {
      if (unavailable) e.preventDefault();
      else onclick?.(e);
    }}
  >
    <Icon size={ICON_SIZE[size]} strokeWidth={ICON_STROKE} aria-hidden="true" />
  </button>
</Tooltip>

<style>
  .icon-btn {
    --ib: var(--control-md);
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--ib);
    height: var(--ib);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .s-sm {
    --ib: var(--control-sm);
    border-radius: var(--radius-sm);
  }
  .s-lg {
    --ib: var(--control-lg);
  }
  .icon-btn:hover:not(:disabled, [aria-disabled='true']) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .icon-btn:active:not(:disabled, [aria-disabled='true']) {
    background: var(--surface-active);
    transform: scale(0.94);
  }
  .icon-btn:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .icon-btn:disabled,
  .icon-btn[aria-disabled='true'] {
    opacity: 0.4;
  }
  .icon-btn[aria-pressed='true'] {
    background: var(--surface-selected);
    color: var(--accent-text);
  }

  .v-secondary {
    background: var(--control-fill);
    border-color: var(--control-border);
    box-shadow: var(--inset-highlight);
  }
  .v-secondary:hover:not(:disabled, [aria-disabled='true']) {
    background: var(--control-fill-hover);
  }
  .v-primary {
    background: var(--accent);
    color: var(--on-accent);
  }
  .v-primary:hover:not(:disabled, [aria-disabled='true']) {
    background: var(--accent-hover);
    color: var(--on-accent);
  }
  .v-danger {
    color: var(--danger);
  }
  .v-danger:hover:not(:disabled, [aria-disabled='true']) {
    background: rgb(var(--danger-rgb) / 0.14);
    color: var(--danger);
  }
</style>
