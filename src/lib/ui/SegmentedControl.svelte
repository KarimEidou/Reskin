<!--
  Single-choice segmented control (a radio group): arrows move the
  selection, Home/End jump, a sliding indicator marks the choice. With
  `iconOnly`, labels become accessible names and tooltips.
-->
<script lang="ts" generics="T extends string">
  import { rovingIndex } from './focus';
  import Tooltip from './Tooltip.svelte';
  import { ICON_SIZE, ICON_STROKE, type ControlSize, type Option } from './types';

  interface Props {
    value?: T;
    options: ReadonlyArray<Option<T>>;
    /** Accessible name of the group. */
    label: string;
    size?: ControlSize;
    iconOnly?: boolean;
    disabled?: boolean;
    fullWidth?: boolean;
    onchange?: (value: T) => void;
  }

  let {
    value = $bindable(),
    options,
    label,
    size = 'md',
    iconOnly = false,
    disabled = false,
    fullWidth = false,
    onchange,
  }: Props = $props();

  const buttons: HTMLButtonElement[] = $state([]);
  const selected = $derived(options.findIndex((o) => o.value === value));
  const focusIndex = $derived(selected >= 0 ? selected : options.findIndex((o) => !o.disabled));

  function select(i: number): void {
    const option = options[i];
    if (!option || option.disabled || disabled) return;
    buttons[i]?.focus();
    if (option.value === value) return;
    value = option.value;
    onchange?.(option.value);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const next = rovingIndex(
      e.key,
      focusIndex,
      options.map((o) => !!o.disabled || disabled),
      'both',
    );
    if (next === null) return;
    e.preventDefault();
    select(next);
  }
</script>

<div
  class="seg size-{size}"
  class:full={fullWidth}
  class:icon-only={iconOnly}
  role="radiogroup"
  aria-label={label}
  aria-disabled={disabled || undefined}
  tabindex="-1"
  onkeydown={onKeyDown}
  style:--count={options.length}
  style:--index={Math.max(0, selected)}
>
  {#if selected >= 0}<span class="indicator" aria-hidden="true"></span>{/if}
  {#each options as option, i (option.value)}
    {#snippet segment()}
      <button
        bind:this={buttons[i]}
        type="button"
        role="radio"
        aria-checked={option.value === value}
        aria-label={iconOnly ? option.label : undefined}
        tabindex={i === focusIndex ? 0 : -1}
        disabled={disabled || option.disabled}
        onclick={() => select(i)}
      >
        {#if option.icon}<option.icon size={ICON_SIZE[size]} strokeWidth={ICON_STROKE} aria-hidden="true" />{/if}
        {#if !iconOnly}<span>{option.label}</span>{/if}
      </button>
    {/snippet}
    {#if iconOnly}
      <Tooltip text={option.label} describe={false}>{@render segment()}</Tooltip>
    {:else}
      {@render segment()}
    {/if}
  {/each}
</div>

<style>
  .seg {
    --h: var(--control-md);
    position: relative;
    display: inline-grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    height: var(--h);
    padding: 2px;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    isolation: isolate;
  }
  .size-sm {
    --h: var(--control-sm);
  }
  .size-lg {
    --h: var(--control-lg);
  }
  .full {
    display: grid;
    width: 100%;
  }
  .seg:focus {
    outline: none;
  }

  .indicator {
    position: absolute;
    z-index: -1;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc((100% - 4px) / var(--count));
    border-radius: calc(var(--radius-md) - 2px);
    background: var(--surface-3);
    box-shadow:
      var(--shadow-1),
      var(--inset-highlight);
    transform: translateX(calc(100% * var(--index)));
    transition: transform var(--dur-spring) var(--ease-spring);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    min-width: 0;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: default;
    transition: color var(--fade-1) linear;
  }
  .icon-only button {
    padding: 0 var(--space-2);
  }
  button span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:hover:not(:disabled) {
    color: var(--text);
  }
  button[aria-checked='true'] {
    color: var(--text);
  }
  button:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -1px;
  }
  button:disabled {
    opacity: 0.4;
  }
</style>
