<!--
  "More options" popover of the options bar: every option of the active
  tool with full-size controls (sliders with exact number entry), including
  the ones the bar has no room for.
-->
<script lang="ts">
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import type { Option } from '$lib/ui/types';
  import NumberEntry from './NumberEntry.svelte';
  import {
    choiceKey,
    choiceValue,
    formatOption,
    fromDisplay,
    toDisplay,
    type ChoiceSpec,
    type OptionSpec,
    type SliderSpec,
  } from './options-schema';
  import { CHOICE_ICONS } from './tool-icons';

  interface Props {
    /** e.g. "Brush" — names the popover. */
    toolLabel: string;
    specs: readonly OptionSpec[];
    options: Record<string, unknown>;
    onchange: (key: string, value: unknown) => void;
    /** Hide the trigger (every option is already in the bar). */
    hideTrigger?: boolean;
  }

  let { toolLabel, specs, options, onchange, hideTrigger = false }: Props = $props();

  let open = $state(false);
  let trigger: HTMLElement | undefined = $state();

  const choices = (spec: ChoiceSpec): Option[] =>
    spec.options.map((o) => ({ value: o.value, label: o.label, icon: o.icon ? CHOICE_ICONS[o.icon] : undefined }));

  function num(key: string): number {
    const v = options[key];
    return typeof v === 'number' ? v : 0;
  }

  /** Slider / field value (display units) → the option, snapped and clamped. */
  const setSlider = (spec: SliderSpec, display: number) => onchange(spec.key, fromDisplay(spec, display));
</script>

<span class="more" class:hidden={hideTrigger}>
  <IconButton
    icon={SlidersHorizontal}
    label="More {toolLabel.toLowerCase()} options"
    size="sm"
    aria-expanded={open}
    aria-haspopup="dialog"
    onclick={(e) => {
      trigger = e.currentTarget;
      open = !open;
    }}
  />
</span>

<Popover bind:open anchor={trigger} label="{toolLabel} options" placement="bottom-end" width="280px" initialFocus="first">
  <div class="panel">
    <h3 class="title">{toolLabel}</h3>
    {#each specs as spec (spec.key + spec.label)}
      {#if spec.kind === 'slider'}
        <div class="field">
          <span class="caption" aria-hidden="true">{spec.label}</span>
          <div class="slider-row">
            <div class="range">
              <Slider
                label={spec.label}
                hideLabel
                min={toDisplay(spec, spec.min)}
                max={toDisplay(spec, spec.max)}
                step={spec.step}
                format={(v) => formatOption(spec, fromDisplay(spec, v))}
                value={toDisplay(spec, num(spec.key))}
                oninput={(v) => setSlider(spec, v)}
              />
            </div>
            <NumberEntry
              label={spec.label}
              unit={spec.unit}
              min={toDisplay(spec, spec.min)}
              max={toDisplay(spec, spec.max)}
              step={spec.step}
              value={toDisplay(spec, num(spec.key))}
              onchange={(v) => setSlider(spec, v)}
            />
          </div>
        </div>
      {:else if spec.kind === 'toggle'}
        <Toggle size="sm" label={spec.label} checked={options[spec.key] === true} onchange={(v) => onchange(spec.key, v)} />
      {:else if spec.dropdown}
        <Select
          size="sm"
          label={spec.label}
          options={choices(spec)}
          value={choiceKey(options[spec.key])}
          onchange={(v) => onchange(spec.key, choiceValue(spec, v))}
        />
      {:else}
        <div class="field">
          <span class="caption">{spec.label}</span>
          <SegmentedControl
            size="sm"
            fullWidth
            label={spec.label}
            iconOnly={spec.iconOnly}
            options={choices(spec)}
            value={choiceKey(options[spec.key])}
            onchange={(v) => onchange(spec.key, choiceValue(spec, v))}
          />
        </div>
      {/if}
    {/each}
  </div>
</Popover>

<style>
  .more {
    display: inline-flex;
    flex: none;
  }
  /* Keeps its place when unused, so the options bar never reflows around it. */
  .more.hidden {
    visibility: hidden;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .title {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .caption {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .slider-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .range {
    flex: 1;
    min-width: 0;
  }
</style>
