<!--
  Button. Variants: primary (accent fill), secondary (subtle fill + border),
  ghost (no chrome until hovered), danger. Sizes sm / md / lg. `loading`
  swaps the leading icon for a spinner and disables the button.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Spinner from './Spinner.svelte';
  import { ICON_SIZE, type ControlSize, type IconComponent } from './types';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: ControlSize;
    loading?: boolean;
    /** Leading icon. */
    icon?: IconComponent;
    /** Trailing icon (e.g. a chevron). */
    iconRight?: IconComponent;
    fullWidth?: boolean;
    children?: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon: Icon,
    iconRight: IconRight,
    fullWidth = false,
    type = 'button',
    disabled = false,
    children,
    class: className,
    ...rest
  }: Props = $props();

  const iconSize = $derived(ICON_SIZE[size]);
</script>

<button
  {...rest}
  {type}
  class={['btn', `btn-${variant}`, `btn-${size}`, { full: fullWidth, 'icon-only': !children }, className]}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
>
  {#if loading}
    <Spinner size={iconSize} label="" />
  {:else if Icon}
    <Icon size={iconSize} aria-hidden="true" />
  {/if}
  {#if children}<span class="label">{@render children()}</span>{/if}
  {#if IconRight}<IconRight size={iconSize} aria-hidden="true" />{/if}
</button>

<style>
  .btn {
    --btn-h: var(--control-md);
    --btn-px: var(--space-3);
    --btn-bg: var(--control-fill);
    --btn-bg-hover: var(--control-fill-hover);
    --btn-bg-active: var(--control-fill-active);
    --btn-fg: var(--text);
    --btn-border: var(--control-border);

    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    height: var(--btn-h);
    padding: 0 var(--btn-px);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-md);
    background: var(--btn-bg);
    color: var(--btn-fg);
    font-family: var(--font-ui);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: 1;
    white-space: nowrap;
    cursor: default;
    user-select: none;
    box-shadow: var(--inset-highlight);
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear,
      color var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .btn:hover:not(:disabled) {
    background: var(--btn-bg-hover);
  }
  .btn:active:not(:disabled) {
    background: var(--btn-bg-active);
    transform: scale(0.98);
  }
  .btn:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: var(--focus-offset);
  }
  .btn:disabled {
    opacity: 0.45;
  }
  .btn[aria-busy='true'] {
    opacity: 0.8;
  }

  .btn-sm {
    --btn-h: var(--control-sm);
    --btn-px: var(--space-2);
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
  }
  .btn-lg {
    --btn-h: var(--control-lg);
    --btn-px: var(--space-4);
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }
  .icon-only {
    width: var(--btn-h);
    padding: 0;
  }
  .full {
    display: flex;
    width: 100%;
  }

  .btn-primary {
    --btn-bg: var(--accent);
    --btn-bg-hover: var(--accent-hover);
    --btn-bg-active: var(--accent-pressed);
    --btn-fg: var(--on-accent);
    --btn-border: rgb(var(--accent-rgb) / 0.2);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.18),
      0 1px 2px rgb(var(--accent-dark-rgb) / 0.4);
  }
  .btn-ghost {
    --btn-bg: transparent;
    --btn-bg-hover: var(--surface-hover);
    --btn-bg-active: var(--surface-active);
    --btn-border: transparent;
    --btn-fg: var(--text-2);
    box-shadow: none;
  }
  .btn-ghost:hover:not(:disabled) {
    color: var(--text);
  }
  .btn-danger {
    --btn-bg: var(--danger);
    --btn-bg-hover: rgb(var(--danger-rgb) / 0.88);
    --btn-bg-active: rgb(var(--danger-rgb) / 0.78);
    --btn-fg: var(--on-danger);
    --btn-border: transparent;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
