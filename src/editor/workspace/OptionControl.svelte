<!--
  One tool option in the options bar, rendered from its spec: a pill
  slider, a toggle chip, a segmented control or a dropdown.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Select from '$lib/ui/Select.svelte';
  import type { Option } from '$lib/ui/types';
  import { choiceKey, choiceValue, type OptionSpec } from './options-schema';
  import PillSlider from './PillSlider.svelte';
  import { CHOICE_ICONS } from './tool-icons';

  interface Props {
    spec: OptionSpec;
    value: unknown;
    onchange: (value: unknown) => void;
  }

  let { spec, value, onchange }: Props = $props();

  const choiceOptions = $derived<Option[]>(
    spec.kind === 'choice'
      ? spec.options.map((o) => ({ value: o.value, label: o.label, icon: o.icon ? CHOICE_ICONS[o.icon] : undefined }))
      : [],
  );
</script>

{#if spec.kind === 'slider'}
  <PillSlider {spec} value={typeof value === 'number' ? value : spec.min} {onchange} />
{:else if spec.kind === 'toggle'}
  <button
    type="button"
    class="chip"
    aria-pressed={value === true}
    data-option={spec.key}
    onclick={() => onchange(value !== true)}
  >
    <span class="tick" aria-hidden="true"><Check size={12} strokeWidth={2.5} /></span>
    {spec.label}
  </button>
{:else if spec.dropdown}
  <div class="labelled" data-option={spec.key}>
    <span class="caption" aria-hidden="true">{spec.label}</span>
    <Select
      size="sm"
      label={spec.label}
      hideLabel
      options={choiceOptions}
      value={choiceKey(value)}
      onchange={(v) => onchange(choiceValue(spec, v))}
    />
  </div>
{:else}
  <div class="labelled" data-option={spec.key}>
    {#if !spec.iconOnly && !spec.hideCaption}<span class="caption" aria-hidden="true">{spec.label}</span>{/if}
    <SegmentedControl
      size="sm"
      label={spec.label}
      iconOnly={spec.iconOnly}
      options={choiceOptions}
      value={choiceKey(value)}
      onchange={(v) => onchange(choiceValue(spec, v))}
    />
  </div>
{/if}

<style>
  .chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    height: var(--control-sm);
    padding: 0 10px 0 8px;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .chip:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .chip:active {
    background: var(--surface-active);
  }
  .chip:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .tick {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: transparent;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--text);
  }
  .chip[aria-pressed='true'] .tick {
    border-color: transparent;
    background: var(--accent);
    color: var(--on-accent);
  }

  .labelled {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .labelled :global(.select) {
    width: 118px;
  }
  .caption {
    color: var(--text-3);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
</style>
