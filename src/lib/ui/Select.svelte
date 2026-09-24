<!-- Labelled native <select>, styled to match the other controls. -->
<script lang="ts" generics="T extends string">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import type { ControlSize, Option } from './types';

  interface Props {
    value?: T;
    options: ReadonlyArray<Option<T>>;
    label: string;
    hideLabel?: boolean;
    size?: ControlSize;
    disabled?: boolean;
    onchange?: (value: T) => void;
  }

  let {
    value = $bindable(),
    options,
    label,
    hideLabel = false,
    size = 'md',
    disabled = false,
    onchange,
  }: Props = $props();

  const id = $props.id();
</script>

<div class="select size-{size}" class:disabled>
  <label for="{id}-select" class:sr-only={hideLabel}>{label}</label>
  <div class="control">
    <select id="{id}-select" bind:value {disabled} onchange={() => value !== undefined && onchange?.(value)}>
      {#each options as option (option.value)}
        <option value={option.value} disabled={option.disabled}>{option.label}</option>
      {/each}
    </select>
    <span class="chevron" aria-hidden="true"><ChevronDown size={14} /></span>
  </div>
</div>

<style>
  .select {
    --h: var(--control-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .size-sm {
    --h: var(--control-sm);
  }
  .size-lg {
    --h: var(--control-lg);
  }
  .disabled {
    opacity: 0.5;
  }
  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .control {
    position: relative;
  }
  select {
    width: 100%;
    height: var(--h);
    padding: 0 calc(var(--space-3) + 18px) 0 var(--space-3);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-md);
    appearance: none;
    box-shadow: var(--inset-highlight);
    transition: background-color var(--fade-1) linear;
  }
  select:hover:not(:disabled) {
    background: var(--control-fill-hover);
  }
  select:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: var(--focus-offset);
  }
  option {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .chevron {
    position: absolute;
    top: 50%;
    right: var(--space-3);
    display: grid;
    color: var(--text-3);
    transform: translateY(-50%);
    pointer-events: none;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
